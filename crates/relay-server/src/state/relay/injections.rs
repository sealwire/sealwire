//! Which user rows the relay sent on the person's behalf, and what for.
//!
//! Keyed by what the provider hands back, never the relay's row id: a restart
//! rebuilds every transcript from provider history.

use std::collections::HashMap;

use crate::protocol::{HandoverCardView, InjectionKind, InjectionView, TranscriptEntryKind};

use super::transcript::TranscriptRecord;
use super::transcript_store::ThreadTranscript;

/// A user row, named so a history re-read still finds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MessageAnchor {
    /// The row's own id, for a provider that echoes back the id the relay sent (Claude).
    Item(String),
    /// The turn the row opened, for a provider that only keeps that stable (Codex).
    Turn(String),
}

impl MessageAnchor {
    pub(crate) fn encode(&self) -> String {
        match self {
            MessageAnchor::Item(id) => format!("item:{id}"),
            MessageAnchor::Turn(id) => format!("turn:{id}"),
        }
    }

    pub(crate) fn decode(value: &str) -> Option<Self> {
        if let Some(id) = value.strip_prefix("item:") {
            return Some(MessageAnchor::Item(id.to_string()));
        }
        value
            .strip_prefix("turn:")
            .map(|id| MessageAnchor::Turn(id.to_string()))
    }
}

pub(crate) fn injection_kind_name(kind: InjectionKind) -> &'static str {
    match kind {
        InjectionKind::HandoverRequest => "handover_request",
        InjectionKind::HandoverBrief => "handover_brief",
    }
}

pub(crate) fn injection_kind_from_name(name: &str) -> Option<InjectionKind> {
    match name {
        "handover_request" => Some(InjectionKind::HandoverRequest),
        "handover_brief" => Some(InjectionKind::HandoverBrief),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InjectedMessage {
    pub(crate) thread_id: String,
    pub(crate) anchor: MessageAnchor,
    pub(crate) kind: InjectionKind,
    pub(crate) handover_id: String,
    pub(crate) created_at: u64,
}

/// The lasting side of a handover. `state::Handover` is pruned once it has been
/// read; this is what its two cards are drawn from for as long as the rows exist.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HandoverMark {
    pub(crate) id: String,
    pub(crate) source_thread_id: String,
    pub(crate) target_thread_id: String,
    pub(crate) source_provider: String,
    pub(crate) target_provider: String,
    pub(crate) note: String,
    pub(crate) instruction: String,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Clone, Debug)]
enum Match {
    Anchor(MessageAnchor),
    /// Sent, but not yet tied to a row. Only ever the thread's latest user row, so
    /// an older message with the same words is never taken for it.
    Text(String),
}

#[derive(Debug, Default)]
pub(crate) struct Injections {
    handovers: HashMap<String, HandoverMark>,
    anchored: HashMap<String, Vec<InjectedMessage>>,
    pending: HashMap<String, Vec<(String, InjectionKind, String)>>,
}

impl Injections {
    pub(crate) fn load(handovers: Vec<HandoverMark>, messages: Vec<InjectedMessage>) -> Self {
        let mut injections = Self::default();
        for handover in handovers {
            injections.put_handover(handover);
        }
        for message in messages {
            injections.anchor(message);
        }
        injections
    }

    pub(crate) fn handover(&self, id: &str) -> Option<&HandoverMark> {
        self.handovers.get(id)
    }

    pub(crate) fn put_handover(&mut self, handover: HandoverMark) {
        self.handovers.insert(handover.id.clone(), handover);
    }

    pub(crate) fn expect(&mut self, thread_id: &str, text: &str, kind: InjectionKind, id: &str) {
        self.pending
            .entry(thread_id.to_string())
            .or_default()
            .push((text.to_string(), kind, id.to_string()));
    }

    pub(crate) fn forget_pending(&mut self, thread_id: &str, kind: InjectionKind, id: &str) {
        if let Some(pending) = self.pending.get_mut(thread_id) {
            pending.retain(|(_, k, handover)| !(*k == kind && handover == id));
            if pending.is_empty() {
                self.pending.remove(thread_id);
            }
        }
    }

    pub(crate) fn anchor(&mut self, message: InjectedMessage) {
        self.forget_pending(&message.thread_id, message.kind, &message.handover_id);
        let messages = self.anchored.entry(message.thread_id.clone()).or_default();
        messages.retain(|existing| existing.anchor != message.anchor);
        messages.push(message);
    }

    /// Whether any row carries, or is about to carry, this handover.
    pub(crate) fn marks_any_row(&self, handover_id: &str) -> bool {
        self.anchored
            .values()
            .flatten()
            .any(|message| message.handover_id == handover_id)
            || self
                .pending
                .values()
                .flatten()
                .any(|(_, _, id)| id == handover_id)
    }

    pub(crate) fn forget_handover(&mut self, handover_id: &str) {
        self.handovers.remove(handover_id);
    }

    pub(crate) fn forget_thread(&mut self, thread_id: &str) {
        self.anchored.remove(thread_id);
        self.pending.remove(thread_id);
        let referenced: std::collections::HashSet<&str> = self
            .anchored
            .values()
            .flatten()
            .map(|message| message.handover_id.as_str())
            .chain(
                self.pending
                    .values()
                    .flatten()
                    .map(|(_, _, id)| id.as_str()),
            )
            .collect();
        self.handovers
            .retain(|id, _| referenced.contains(id.as_str()));
    }

    /// Every mark `thread_id`'s rows could carry. The error can name either end and the
    /// note was typed into the source, so each goes wherever its end is hidden.
    pub(crate) fn for_thread(
        &self,
        thread_id: &str,
        title: impl Fn(&str) -> Option<String>,
        may_see: impl Fn(&str) -> bool,
    ) -> ThreadInjections {
        let named = |id: &str| id == thread_id || may_see(id);
        let view = |kind: InjectionKind, handover_id: &str| {
            let handover = self.handovers.get(handover_id)?;
            let (source, target) = (
                named(&handover.source_thread_id),
                named(&handover.target_thread_id),
            );
            let side = |visible: bool, id: &str| match visible {
                true => (id.to_string(), title(id)),
                false => (String::new(), None),
            };
            let (source_thread_id, source_title) = side(source, &handover.source_thread_id);
            let (target_thread_id, target_title) = side(target, &handover.target_thread_id);
            Some(InjectionView {
                kind,
                handover: HandoverCardView {
                    id: handover.id.clone(),
                    source_thread_id,
                    source_title,
                    source_provider: handover.source_provider.clone(),
                    target_thread_id,
                    target_title,
                    target_provider: handover.target_provider.clone(),
                    note: if source {
                        card_note(&handover.note)
                    } else {
                        String::new()
                    },
                    instruction: handover.instruction.clone(),
                    status: handover.status.clone(),
                    error: handover.error.clone().filter(|_| source && target),
                    created_at: handover.created_at,
                    updated_at: handover.updated_at,
                },
            })
        };
        let anchored = self.anchored.get(thread_id).into_iter().flatten();
        let pending = self.pending.get(thread_id).into_iter().flatten();
        let marks = anchored
            .filter_map(|message| {
                view(message.kind, &message.handover_id)
                    .map(|view| (Match::Anchor(message.anchor.clone()), view))
            })
            .chain(pending.filter_map(|(text, kind, id)| {
                view(*kind, id).map(|view| (Match::Text(text.clone()), view))
            }))
            .collect();
        ThreadInjections { marks }
    }
}

/// The card shows the note as a one-line command; the whole of it is in the prompt row.
/// Nothing trims this copy on the way out, and it rides on every marked row.
const CARD_NOTE_CHARS: usize = 500;

fn card_note(note: &str) -> String {
    match note.char_indices().nth(CARD_NOTE_CHARS) {
        Some((end, _)) => format!("{}…", &note[..end]),
        None => note.to_string(),
    }
}

/// One thread's marks, resolved once per read and applied row by row.
#[derive(Clone, Debug, Default)]
pub(crate) struct ThreadInjections {
    marks: Vec<(Match, InjectionView)>,
}

impl ThreadInjections {
    pub(crate) fn mark_for(
        &self,
        transcript: &ThreadTranscript,
        record: &TranscriptRecord,
    ) -> Option<InjectionView> {
        if self.marks.is_empty() || record.kind != TranscriptEntryKind::UserText {
            return None;
        }
        self.marks
            .iter()
            .find(|(matcher, _)| matches(matcher, transcript, record))
            .map(|(_, view)| view.clone())
    }
}

fn matches(matcher: &Match, transcript: &ThreadTranscript, record: &TranscriptRecord) -> bool {
    let user_rows = || {
        transcript
            .iter()
            .filter(|row| row.kind == TranscriptEntryKind::UserText && !row.withdrawn)
    };
    match matcher {
        Match::Anchor(MessageAnchor::Item(id)) => {
            record.row_id == *id
                || record.provider_item_id.as_deref() == Some(id.as_str())
                || transcript.resolve_provider(id) == Some(record.row_id.as_str())
        }
        // A person can steer into the same turn; only the row that opened it was ours.
        Match::Anchor(MessageAnchor::Turn(turn)) => {
            record.turn_id.as_deref() == Some(turn.as_str())
                && user_rows()
                    .find(|row| row.turn_id.as_deref() == Some(turn.as_str()))
                    .is_some_and(|first| first.row_id == record.row_id)
        }
        Match::Text(text) => {
            record.text.as_deref() == Some(text.as_str())
                && user_rows()
                    .last()
                    .is_some_and(|last| last.row_id == record.row_id)
        }
    }
}
