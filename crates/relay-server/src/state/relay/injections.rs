//! Which relay-sent prompts and recorded replies belong to a card.
//!
//! Keyed by what the provider hands back, never the relay's row id: a restart
//! rebuilds every transcript from provider history.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::protocol::{
    CardRow, DelegateCardView, ForkBranchPointView, ForkCardView, ForkCarriedView,
    GoalSettledCardView, GoalStepRefView, GoalStepView, GoalTurnCardView, HandoverCardView,
    InjectionCard, InjectionKind, InjectionView, ReviewCardView, ReviewFindingView,
    ReviewResultView, ReviewRoundView, TranscriptContentState, TranscriptEntryKind,
    TranscriptEntryView,
};

use super::transcript::TranscriptRecord;
use super::transcript_store::ThreadTranscript;

/// How much of a card's long body a read carries. Every list and snapshot row carries
/// its own copy, so they get the opening; a row's detail, opened on demand, the whole.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CardBodies {
    #[default]
    Preview,
    Whole,
}

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

const KIND_NAMES: [(InjectionKind, &str); 22] = [
    (InjectionKind::HandoverRequest, "handover_request"),
    (InjectionKind::HandoverSummary, "handover_summary"),
    (InjectionKind::HandoverBrief, "handover_brief"),
    (InjectionKind::ReviewRecap, "review_recap"),
    (InjectionKind::ReviewBrief, "review_brief"),
    (InjectionKind::ReviewCall, "review_call"),
    (InjectionKind::ReviewReply, "review_reply"),
    (InjectionKind::ReviewResult, "review_result"),
    (InjectionKind::ReviewCommit, "review_commit"),
    (InjectionKind::ReviewApproved, "review_approved"),
    (InjectionKind::ReviewEscalated, "review_escalated"),
    (InjectionKind::DelegateRequest, "delegate_request"),
    (InjectionKind::DelegateBrief, "delegate_brief"),
    (InjectionKind::DelegateCall, "delegate_call"),
    (InjectionKind::DelegateTask, "delegate_task"),
    (InjectionKind::DelegateNudge, "delegate_nudge"),
    (InjectionKind::DelegateAnswer, "delegate_answer"),
    (InjectionKind::DelegateReported, "delegate_reported"),
    (InjectionKind::GoalTurn, "goal_turn"),
    (InjectionKind::GoalSettled, "goal_settled"),
    (InjectionKind::ForkBrief, "fork_brief"),
    (InjectionKind::ForkStart, "fork_start"),
];

pub(crate) fn injection_kind_name(kind: InjectionKind) -> &'static str {
    KIND_NAMES
        .iter()
        .find(|(known, _)| *known == kind)
        .map(|(_, name)| *name)
        .unwrap_or_default()
}

pub(crate) fn injection_kind_from_name(name: &str) -> Option<InjectionKind> {
    KIND_NAMES
        .iter()
        .find(|(_, known)| *known == name)
        .map(|(kind, _)| *kind)
}

/// What a sent row was for: the handover or review it belongs to, and for a review
/// the round.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InjectionTag {
    pub(crate) kind: InjectionKind,
    pub(crate) ref_id: String,
    pub(crate) round: u32,
}

impl InjectionTag {
    pub(crate) fn handover(kind: InjectionKind, handover_id: &str) -> Self {
        Self {
            kind,
            ref_id: handover_id.to_string(),
            round: 0,
        }
    }

    pub(crate) fn review(kind: InjectionKind, review_id: &str, round: u32) -> Self {
        Self {
            kind,
            ref_id: review_id.to_string(),
            round,
        }
    }

    /// `seq` names the line or settlement within the goal's mark.
    pub(crate) fn goal(kind: InjectionKind, goal_id: &str, seq: u32) -> Self {
        Self {
            kind,
            ref_id: goal_id.to_string(),
            round: seq,
        }
    }

    pub(crate) fn fork(kind: InjectionKind, fork_id: &str) -> Self {
        Self {
            kind,
            ref_id: fork_id.to_string(),
            round: 0,
        }
    }

    /// One wake can hand back several asks; their ids share the row's one tag.
    pub(crate) fn delegate(kind: InjectionKind, ask_ids: &[String]) -> Self {
        Self {
            kind,
            ref_id: ask_ids.join(","),
            round: 0,
        }
    }

    pub(crate) fn ref_ids(&self) -> impl Iterator<Item = &str> {
        self.ref_id.split(',').filter(|id| !id.is_empty())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InjectedMessage {
    pub(crate) thread_id: String,
    pub(crate) anchor: MessageAnchor,
    pub(crate) tag: InjectionTag,
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
    /// Where each end ran when it was handed over: the fence for a session the relay
    /// no longer has on its thread page.
    pub(crate) source_cwd: String,
    pub(crate) target_cwd: String,
    /// Read off the summary once it is written, so no client parses agent prose.
    pub(crate) goal: Option<String>,
    pub(crate) state: Option<String>,
    pub(crate) next: Option<String>,
    /// The turn the summary started on the target; its end is when the item reads done.
    pub(crate) target_turn_id: Option<String>,
    pub(crate) finished_at: Option<u64>,
    /// `completed`, `failed`, `stopped`, or `interrupted` by a restart; `None` is unknown.
    pub(crate) outcome: Option<String>,
    pub(crate) result: Option<String>,
}

/// The lasting side of a review. `ReviewJob` is pruned and keeps only its latest
/// round; the cards need every round for as long as their rows exist.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ReviewMark {
    pub(crate) id: String,
    pub(crate) parent_thread_id: String,
    pub(crate) parent_provider: String,
    pub(crate) reviewer_provider: String,
    pub(crate) max_rounds: u32,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) decision: Option<String>,
    /// The review that took this one up with "One more round".
    #[serde(default)]
    pub(crate) continued_by: Option<String>,
    pub(crate) rounds: Vec<ReviewRoundView>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

impl ReviewMark {
    pub(crate) fn is_settled(&self) -> bool {
        matches!(
            self.status.as_str(),
            "complete" | "failed" | "escalated" | "cancelled"
        )
    }

    /// Replaces the round a retry began again, so a round is only ever listed once.
    pub(crate) fn begin_round(&mut self, round: ReviewRoundView) {
        self.rounds.retain(|existing| existing.round != round.round);
        self.rounds.push(round);
        self.rounds.sort_by_key(|existing| existing.round);
    }

    pub(crate) fn round_mut(&mut self, round: u32) -> Option<&mut ReviewRoundView> {
        self.rounds
            .iter_mut()
            .find(|existing| existing.round == round)
    }

    /// Which card the review's conversation ends on, by the same rule the loop picks
    /// it when it hands the result back. `job_status` because the mark trails the job.
    pub(crate) fn result_view(&self, job_status: &str) -> Option<ReviewResultView> {
        let last = self
            .rounds
            .iter()
            .rev()
            .find(|round| round.verdict.is_some())?;
        let kind = match job_status {
            "escalated" => InjectionKind::ReviewEscalated,
            "complete" if self.max_rounds > 1 && last.verdict.as_deref() == Some("approve") => {
                InjectionKind::ReviewApproved
            }
            _ => InjectionKind::ReviewResult,
        };
        let (rounds, _) = card_rounds(kind, last.round, &self.rounds, CardBodies::Preview);
        let rounds = rounds
            .into_iter()
            .map(|round| ReviewRoundView {
                reviewer_thread_id: String::new(),
                ..round
            })
            .collect();
        Some(ReviewResultView {
            kind,
            round: last.round,
            rounds,
        })
    }
}

/// The lasting side of an ask. `Ask` is pruned from the session file; its cards need
/// it for as long as their rows exist.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct DelegateMark {
    pub(crate) id: String,
    pub(crate) asker_thread_id: String,
    pub(crate) peer_thread_id: String,
    pub(crate) asker_provider: String,
    pub(crate) peer_provider: String,
    pub(crate) task: String,
    pub(crate) title: String,
    pub(crate) instruction: String,
    /// When the peer was handed the brief; until then the asker is still writing it.
    pub(crate) sent_at: Option<u64>,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) answer: Option<String>,
    pub(crate) cited: Vec<String>,
    pub(crate) answered_with_tool: bool,
    pub(crate) delivered: bool,
    pub(crate) asked_at: u64,
    pub(crate) finished_at: Option<u64>,
    pub(crate) updated_at: u64,
}

impl DelegateMark {
    pub(crate) fn is_settled(&self) -> bool {
        self.status != "working"
    }
}

/// The lasting side of a goal. `Goal` is rewritten in place and dropped once
/// cancelled; each turn line and settlement card needs the goal as it stood then.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct GoalMark {
    pub(crate) id: String,
    pub(crate) thread_id: String,
    pub(crate) provider: String,
    pub(crate) next_seq: u32,
    pub(crate) turns: Vec<GoalTurnMark>,
    pub(crate) settlements: Vec<GoalSettlementMark>,
    pub(crate) updated_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct GoalTurnMark {
    pub(crate) seq: u32,
    pub(crate) turn: u32,
    pub(crate) max_turns: u32,
    pub(crate) step: Option<GoalStepRefView>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct GoalSettlementMark {
    pub(crate) seq: u32,
    pub(crate) status: String,
    pub(crate) objective: String,
    pub(crate) turns: u32,
    pub(crate) max_turns: u32,
    pub(crate) steps: Vec<GoalStepView>,
    pub(crate) left_for_you: Vec<String>,
    pub(crate) report: String,
    pub(crate) options: Vec<String>,
    pub(crate) settled_at: u64,
    pub(crate) resolution: Option<String>,
}

impl GoalMark {
    pub(crate) fn take_seq(&mut self) -> u32 {
        self.next_seq = self.next_seq.saturating_add(1);
        self.next_seq
    }

    pub(crate) fn turn_mut(&mut self, seq: u32) -> Option<&mut GoalTurnMark> {
        self.turns.iter_mut().find(|turn| turn.seq == seq)
    }

    pub(crate) fn settlement_mut(&mut self, seq: u32) -> Option<&mut GoalSettlementMark> {
        self.settlements
            .iter_mut()
            .find(|settlement| settlement.seq == seq)
    }
}

/// What a fork's card is drawn from, written once as the fork is made.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct ForkMark {
    pub(crate) id: String,
    pub(crate) source_thread_id: String,
    pub(crate) target_thread_id: String,
    pub(crate) source_provider: String,
    pub(crate) target_provider: String,
    pub(crate) note: String,
    pub(crate) branch_point: Option<ForkBranchPointView>,
    pub(crate) carried: Option<ForkCarriedView>,
    pub(crate) created_at: u64,
}

/// The card shows the objective on one line; the panel has the whole of it.
const CARD_OBJECTIVE_CHARS: usize = 300;

fn goal_card(mark: &GoalMark, tag: &InjectionTag, bodies: CardBodies) -> Option<InjectionCard> {
    match tag.kind {
        InjectionKind::GoalTurn => {
            let turn = mark.turns.iter().find(|turn| turn.seq == tag.round)?;
            Some(InjectionCard::GoalTurn(GoalTurnCardView {
                goal_id: mark.id.clone(),
                turn: turn.turn,
                max_turns: turn.max_turns,
                step: turn.step.clone(),
            }))
        }
        InjectionKind::GoalSettled => {
            let settled = mark
                .settlements
                .iter()
                .find(|settlement| settlement.seq == tag.round)?;
            let (report, report_clipped) = card_body(&settled.report, CARD_BODY_CHARS, bodies);
            Some(InjectionCard::GoalSettled(GoalSettledCardView {
                goal_id: mark.id.clone(),
                thread_id: mark.thread_id.clone(),
                seq: settled.seq,
                status: settled.status.clone(),
                objective: clip_chars(&settled.objective, CARD_OBJECTIVE_CHARS),
                turns: settled.turns,
                max_turns: settled.max_turns,
                provider: mark.provider.clone(),
                steps: settled.steps.clone(),
                left_for_you: settled.left_for_you.clone(),
                report,
                report_clipped,
                options: settled.options.clone(),
                settled_at: settled.settled_at,
                resolution: settled.resolution.clone(),
            }))
        }
        _ => None,
    }
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
    reviews: HashMap<String, ReviewMark>,
    delegates: HashMap<String, DelegateMark>,
    goals: HashMap<String, GoalMark>,
    forks: HashMap<String, ForkMark>,
    anchored: HashMap<String, Vec<InjectedMessage>>,
    pending: HashMap<String, Vec<(String, InjectionTag)>>,
}

impl Injections {
    pub(crate) fn load(
        handovers: Vec<HandoverMark>,
        reviews: Vec<ReviewMark>,
        delegates: Vec<DelegateMark>,
        goals: Vec<GoalMark>,
        messages: Vec<InjectedMessage>,
    ) -> Self {
        let mut injections = Self::default();
        for goal in goals {
            injections.put_goal(goal);
        }
        for handover in handovers {
            injections.put_handover(handover);
        }
        for review in reviews {
            injections.put_review(review);
        }
        for delegate in delegates {
            injections.put_delegate(delegate);
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

    pub(crate) fn handovers(&self) -> impl Iterator<Item = &HandoverMark> {
        self.handovers.values()
    }

    /// Blanks a deleted session out of the handovers it was an end of, and returns
    /// those. The other end's rows still carry each one, so the mark itself stays.
    pub(crate) fn detach_handover_end(&mut self, thread_id: &str) -> Vec<HandoverMark> {
        let mut changed = Vec::new();
        for mark in self.handovers.values_mut() {
            let mut touched = false;
            for end in [&mut mark.source_thread_id, &mut mark.target_thread_id] {
                if end == thread_id {
                    end.clear();
                    touched = true;
                }
            }
            if touched {
                changed.push(mark.clone());
            }
        }
        changed
    }

    pub(crate) fn review(&self, id: &str) -> Option<&ReviewMark> {
        self.reviews.get(id)
    }

    pub(crate) fn put_review(&mut self, review: ReviewMark) {
        self.reviews.insert(review.id.clone(), review);
    }

    pub(crate) fn delegate(&self, id: &str) -> Option<&DelegateMark> {
        self.delegates.get(id)
    }

    pub(crate) fn put_delegate(&mut self, delegate: DelegateMark) {
        self.delegates.insert(delegate.id.clone(), delegate);
    }

    pub(crate) fn goal(&self, id: &str) -> Option<&GoalMark> {
        self.goals.get(id)
    }

    pub(crate) fn put_goal(&mut self, goal: GoalMark) {
        self.goals.insert(goal.id.clone(), goal);
    }

    pub(crate) fn put_fork(&mut self, fork: ForkMark) {
        self.forks.insert(fork.id.clone(), fork);
    }

    #[cfg(test)]
    pub(crate) fn fork(&self, id: &str) -> Option<&ForkMark> {
        self.forks.get(id)
    }

    /// Blanks a removed session out of the forks taken from it; the branches keep their cards.
    pub(crate) fn detach_fork_source(&mut self, thread_id: &str) -> Vec<ForkMark> {
        self.forks
            .values_mut()
            .filter(|mark| mark.source_thread_id == thread_id)
            .map(|mark| {
                mark.source_thread_id.clear();
                mark.clone()
            })
            .collect()
    }

    pub(crate) fn reviews_continued_by(&self, review_id: &str) -> Vec<String> {
        self.reviews
            .values()
            .filter(|review| review.continued_by.as_deref() == Some(review_id))
            .map(|review| review.id.clone())
            .collect()
    }

    pub(crate) fn expect(&mut self, thread_id: &str, text: &str, tag: InjectionTag) {
        self.pending
            .entry(thread_id.to_string())
            .or_default()
            .push((text.to_string(), tag));
    }

    pub(crate) fn forget_pending(&mut self, thread_id: &str, tag: &InjectionTag) {
        if let Some(pending) = self.pending.get_mut(thread_id) {
            pending.retain(|(_, existing)| existing != tag);
            if pending.is_empty() {
                self.pending.remove(thread_id);
            }
        }
    }

    pub(crate) fn anchor(&mut self, message: InjectedMessage) {
        self.forget_pending(&message.thread_id, &message.tag);
        let messages = self.anchored.entry(message.thread_id.clone()).or_default();
        messages.retain(|existing| existing.anchor != message.anchor);
        messages.push(message);
    }

    pub(crate) fn tag_at(&self, thread_id: &str, anchor: &MessageAnchor) -> Option<&InjectionTag> {
        self.anchored
            .get(thread_id)?
            .iter()
            .find(|message| message.anchor == *anchor)
            .map(|message| &message.tag)
    }

    pub(crate) fn has_anchored_tag(
        &self,
        thread_id: &str,
        kind: InjectionKind,
        ref_id: &str,
    ) -> bool {
        self.anchored.get(thread_id).is_some_and(|messages| {
            messages.iter().any(|message| {
                message.tag.kind == kind && message.tag.ref_ids().any(|id| id == ref_id)
            })
        })
    }

    #[cfg(test)]
    pub(crate) fn anchored_rows(&self, thread_id: &str) -> usize {
        self.anchored.get(thread_id).map_or(0, Vec::len)
    }

    fn referenced(&self) -> HashSet<&str> {
        self.anchored
            .values()
            .flatten()
            .flat_map(|message| message.tag.ref_ids())
            .chain(
                self.pending
                    .values()
                    .flatten()
                    .flat_map(|(_, tag)| tag.ref_ids()),
            )
            .collect()
    }

    /// Whether any row carries, or is about to carry, this handover or review.
    pub(crate) fn marks_any_row(&self, ref_id: &str) -> bool {
        self.referenced().contains(ref_id)
    }

    pub(crate) fn forget_mark(&mut self, ref_id: &str) {
        self.handovers.remove(ref_id);
        self.reviews.remove(ref_id);
        self.delegates.remove(ref_id);
        self.goals.remove(ref_id);
        self.forks.remove(ref_id);
    }

    /// Drops the thread's rows, and every mark only they carried. Returns those marks'
    /// ids; a mark no row has reached yet is left alone.
    pub(crate) fn forget_thread(&mut self, thread_id: &str) -> Vec<String> {
        let carried: HashSet<String> = self
            .anchored
            .remove(thread_id)
            .into_iter()
            .flatten()
            .map(|message| message.tag)
            .chain(
                self.pending
                    .remove(thread_id)
                    .into_iter()
                    .flatten()
                    .map(|(_, tag)| tag),
            )
            .flat_map(|tag| tag.ref_ids().map(str::to_string).collect::<Vec<_>>())
            .collect();
        let referenced = self.referenced();
        let orphaned: Vec<String> = carried
            .into_iter()
            .filter(|id| !referenced.contains(id.as_str()))
            .collect();
        for id in &orphaned {
            self.forget_mark(id);
        }
        orphaned
    }

    /// Every mark `thread_id`'s rows could carry. What names another thread, or could
    /// (an error), is left out wherever that thread is hidden from the reader.
    pub(crate) fn for_thread(
        &self,
        thread_id: &str,
        title: impl Fn(&str) -> Option<String>,
        may_see: impl Fn(&str) -> bool,
        bodies: CardBodies,
    ) -> ThreadInjections {
        let named = |id: &str| id == thread_id || may_see(id);
        let view = |tag: &InjectionTag| {
            let card = if tag.kind.is_review() {
                InjectionCard::Review(self.review_card(tag, &named, &title, bodies)?)
            } else if tag.kind.is_goal() {
                goal_card(self.goals.get(&tag.ref_id)?, tag, bodies)?
            } else if tag.kind.is_delegate() {
                InjectionCard::Delegate(self.delegate_cards(tag, &named, &title, bodies)?)
            } else if tag.kind.is_fork() {
                InjectionCard::Fork(fork_card(
                    self.forks.get(&tag.ref_id)?,
                    &named,
                    &title,
                    bodies,
                ))
            } else {
                InjectionCard::Handover(self.handover_card(&tag.ref_id, &named, &title)?)
            };
            Some(InjectionView {
                kind: tag.kind,
                card,
                text_clipped: false,
            })
        };
        let anchored = self.anchored.get(thread_id).into_iter().flatten();
        let pending = self.pending.get(thread_id).into_iter().flatten();
        let marks =
            anchored
                .filter_map(|message| {
                    view(&message.tag).map(|view| (Match::Anchor(message.anchor.clone()), view))
                })
                .chain(pending.filter_map(|(text, tag)| {
                    view(tag).map(|view| (Match::Text(text.clone()), view))
                }))
                .collect();
        ThreadInjections { marks, bodies }
    }

    fn handover_card(
        &self,
        handover_id: &str,
        named: &impl Fn(&str) -> bool,
        title: &impl Fn(&str) -> Option<String>,
    ) -> Option<HandoverCardView> {
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
        Some(HandoverCardView {
            id: handover.id.clone(),
            source_thread_id,
            source_title,
            source_provider: handover.source_provider.clone(),
            target_thread_id,
            target_title,
            target_provider: handover.target_provider.clone(),
            // Typed into the source, so it stays wherever the source is hidden.
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
        })
    }

    /// The asks a row draws: one, or an answer row's batch.
    fn delegate_cards(
        &self,
        tag: &InjectionTag,
        named: &impl Fn(&str) -> bool,
        title: &impl Fn(&str) -> Option<String>,
        bodies: CardBodies,
    ) -> Option<Vec<DelegateCardView>> {
        let cards: Vec<DelegateCardView> = tag
            .ref_ids()
            .filter_map(|id| self.delegates.get(id))
            .map(|mark| delegate_card(mark, tag.kind, named, title, bodies))
            .collect();
        (!cards.is_empty()).then_some(cards)
    }

    fn review_card(
        &self,
        tag: &InjectionTag,
        named: &impl Fn(&str) -> bool,
        title: &impl Fn(&str) -> Option<String>,
        bodies: CardBodies,
    ) -> Option<ReviewCardView> {
        let review = self.reviews.get(&tag.ref_id)?;
        let visible = |id: &str| !id.is_empty() && named(id);
        let parent = visible(&review.parent_thread_id);
        let reviewer = review
            .rounds
            .iter()
            .find(|round| round.round == tag.round)
            .or(review.rounds.last())
            .map(|round| round.reviewer_thread_id.as_str())
            .unwrap_or_default();
        let reviewers_visible = review
            .rounds
            .iter()
            .all(|round| visible(&round.reviewer_thread_id));
        let (rounds, findings_clipped) = card_rounds(tag.kind, tag.round, &review.rounds, bodies);
        let rounds = rounds
            .into_iter()
            .map(|mut round| {
                if !visible(&round.reviewer_thread_id) {
                    round.reviewer_thread_id.clear();
                }
                round
            })
            .collect();
        Some(ReviewCardView {
            id: review.id.clone(),
            round: tag.round,
            max_rounds: review.max_rounds,
            parent_thread_id: if parent {
                review.parent_thread_id.clone()
            } else {
                String::new()
            },
            parent_title: parent.then(|| title(&review.parent_thread_id)).flatten(),
            parent_provider: review.parent_provider.clone(),
            reviewer_thread_id: if visible(reviewer) {
                reviewer.to_string()
            } else {
                String::new()
            },
            reviewer_provider: review.reviewer_provider.clone(),
            status: review.status.clone(),
            error: review.error.clone().filter(|_| parent && reviewers_visible),
            decision: review.decision.clone(),
            rounds,
            findings_clipped,
        })
    }
}

/// A card gets only what it draws: its own round's findings, and for the last card what
/// each round fixed. A preview also bounds how many and how long; true when it cut any.
const CARD_FINDINGS: usize = 12;
const CARD_FINDING_CHARS: usize = 200;

fn card_rounds(
    kind: InjectionKind,
    row_round: u32,
    rounds: &[ReviewRoundView],
    bodies: CardBodies,
) -> (Vec<ReviewRoundView>, bool) {
    let last = rounds.last().map_or(0, |round| round.round);
    let mut budget = match bodies {
        CardBodies::Preview => CARD_FINDINGS,
        CardBodies::Whole => usize::MAX,
    };
    let mut clipped = false;
    let mut take = |findings: &[ReviewFindingView]| -> Vec<ReviewFindingView> {
        let kept: Vec<_> = findings
            .iter()
            .take(budget)
            .map(|finding| {
                let (text, cut) = card_body(&finding.text, CARD_FINDING_CHARS, bodies);
                ReviewFindingView {
                    text,
                    clipped: cut,
                    ..finding.clone()
                }
            })
            .collect();
        clipped |= kept.len() < findings.len() || kept.iter().any(|finding| finding.clipped);
        budget -= kept.len();
        kept
    };
    let bare = |round: &ReviewRoundView| ReviewRoundView {
        findings: Vec::new(),
        fixed: Vec::new(),
        change: None,
        verdict_note: None,
        ..round.clone()
    };
    let kept = rounds
        .iter()
        .filter_map(|round| {
            let mut kept = bare(round);
            match kind {
                InjectionKind::ReviewBrief if round.round == row_round => {
                    kept.findings = take(&round.findings);
                    kept.change = round.change.clone();
                }
                InjectionKind::ReviewResult | InjectionKind::ReviewReply
                    if round.round == row_round =>
                {
                    kept.findings = take(&round.findings);
                    kept.verdict_note = round.verdict_note.clone();
                }
                // Read only for how many of the card's findings the next round fixed.
                InjectionKind::ReviewResult if round.round == row_round + 1 => {}
                InjectionKind::ReviewApproved => {
                    kept.fixed = take(&round.fixed);
                    if round.round == last {
                        kept.findings = take(&round.findings);
                        kept.verdict_note = round.verdict_note.clone();
                    }
                }
                // What still stands; what got fixed is only counted.
                InjectionKind::ReviewEscalated => {
                    if round.round == last {
                        kept.findings = take(&round.findings);
                    }
                }
                _ => return None,
            }
            Some(kept)
        })
        .collect();
    (kept, clipped)
}

pub(crate) fn clip_chars(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

/// The card shows the note as a one-line command; the whole of it is in the prompt row.
/// Nothing trims this copy on the way out, and it rides on every marked row.
const CARD_NOTE_CHARS: usize = 500;

fn card_note(note: &str) -> String {
    clip_chars(note, CARD_NOTE_CHARS)
}

/// A preview of a brief, summary or report: about what a folded card shows. Answers keep
/// more; a snapshot clips both further (`compact_for_budget`).
const CARD_BODY_CHARS: usize = 2_000;
const CARD_ANSWER_CHARS: usize = 4_000;

/// The body as `bodies` asks for it, and whether it was cut.
fn card_body(text: &str, limit: usize, bodies: CardBodies) -> (String, bool) {
    match bodies {
        CardBodies::Preview if text.chars().nth(limit).is_some() => (clip_chars(text, limit), true),
        _ => (text.to_string(), false),
    }
}

fn fork_card(
    mark: &ForkMark,
    named: &impl Fn(&str) -> bool,
    title: &impl Fn(&str) -> Option<String>,
    bodies: CardBodies,
) -> ForkCardView {
    let source = !mark.source_thread_id.is_empty() && named(&mark.source_thread_id);
    // The note and the quoted message were both sent to the branch, so they stay
    // wherever the source is hidden; only the way back to it goes.
    let (note, note_clipped) = card_body(&mark.note, CARD_BODY_CHARS, bodies);
    ForkCardView {
        id: mark.id.clone(),
        source_thread_id: if source {
            mark.source_thread_id.clone()
        } else {
            String::new()
        },
        source_title: source.then(|| title(&mark.source_thread_id)).flatten(),
        source_provider: mark.source_provider.clone(),
        target_provider: mark.target_provider.clone(),
        note,
        note_clipped,
        branch_point: mark.branch_point.clone(),
        carried: mark.carried,
        created_at: mark.created_at,
    }
}

fn delegate_card(
    mark: &DelegateMark,
    kind: InjectionKind,
    named: &impl Fn(&str) -> bool,
    title: &impl Fn(&str) -> Option<String>,
    bodies: CardBodies,
) -> DelegateCardView {
    let visible = |id: &str| !id.is_empty() && named(id);
    let (asker, peer) = (
        visible(&mark.asker_thread_id),
        visible(&mark.peer_thread_id),
    );
    let side = |shown: bool, id: &str| match shown {
        true => (id.to_string(), title(id)),
        false => (String::new(), None),
    };
    let (asker_thread_id, asker_title) = side(asker, &mark.asker_thread_id);
    let (peer_thread_id, peer_title) = side(peer, &mark.peer_thread_id);
    // A reply that answered is its own text; a `report_back` call carries what it said.
    let draws_answer = match kind {
        InjectionKind::DelegateAnswer => true,
        InjectionKind::DelegateReported => mark.answered_with_tool,
        _ => false,
    };
    // A delegate call's card draws the brief itself; elsewhere it is the typed command.
    let task_chars = match kind {
        InjectionKind::DelegateCall => CARD_BODY_CHARS,
        _ => CARD_NOTE_CHARS,
    };
    let (task, task_clipped) = match asker {
        true => card_body(&mark.task, task_chars, bodies),
        false => (String::new(), false),
    };
    let (answer, answer_clipped) = match mark.answer.as_deref().filter(|_| draws_answer) {
        Some(answer) => {
            let (answer, cut) = card_body(answer, CARD_ANSWER_CHARS, bodies);
            (Some(answer), cut)
        }
        None => (None, false),
    };
    DelegateCardView {
        id: mark.id.clone(),
        asker_thread_id,
        asker_title,
        asker_provider: mark.asker_provider.clone(),
        peer_thread_id,
        peer_title,
        peer_provider: mark.peer_provider.clone(),
        // Typed into the asker, so it stays wherever the asker is hidden.
        task,
        task_clipped,
        title: mark.title.clone(),
        instruction: mark.instruction.clone(),
        status: mark.status.clone(),
        // A failure before any peer existed concerns the asker alone.
        error: mark
            .error
            .clone()
            .filter(|_| asker && (peer || mark.peer_thread_id.is_empty())),
        answer,
        answer_clipped,
        cited: if draws_answer {
            mark.cited.clone()
        } else {
            Vec::new()
        },
        answered_with_tool: mark.answered_with_tool,
        delivered: mark.delivered,
        asked_at: mark.asked_at,
        sent_at: mark.sent_at,
        finished_at: mark.finished_at,
    }
}

/// One thread's marks, resolved once per read and applied row by row.
#[derive(Clone, Debug, Default)]
pub(crate) struct ThreadInjections {
    marks: Vec<(Match, InjectionView)>,
    bodies: CardBodies,
}

impl ThreadInjections {
    /// Marks `view`, the row `record` serves, and for a list cuts a card body it carries
    /// as its text. Only rows drawn as that card: anywhere else the text is the message.
    pub(crate) fn apply(
        &self,
        transcript: &ThreadTranscript,
        record: &TranscriptRecord,
        view: &mut TranscriptEntryView,
    ) {
        view.injection = self.mark_for(transcript, record);
        // A provider's short copy (Codex history) cuts a text row's text, a tool row's tool.
        if record.cut && !view.needs_repair_after_cut(record.kind != TranscriptEntryKind::ToolCall)
        {
            view.content_state = TranscriptContentState::Full;
        }
        let (Some(mark), Some(text)) = (view.injection.as_mut(), view.text.as_mut()) else {
            return;
        };
        let Some(limit) = text_body_chars(mark, record.kind) else {
            return;
        };
        let (cut, clipped) = card_body(text, limit, self.bodies);
        if clipped {
            *text = cut;
            mark.text_clipped = true;
        }
    }

    pub(crate) fn mark_for(
        &self,
        transcript: &ThreadTranscript,
        record: &TranscriptRecord,
    ) -> Option<InjectionView> {
        if self.marks.is_empty() {
            return None;
        }
        self.marks
            .iter()
            .find(|(matcher, view)| {
                let right_kind = match view.kind {
                    InjectionKind::HandoverSummary
                    | InjectionKind::DelegateBrief
                    | InjectionKind::ReviewReply => record.kind == TranscriptEntryKind::AgentText,
                    InjectionKind::DelegateCall
                    | InjectionKind::ReviewCall
                    | InjectionKind::GoalSettled => {
                        record.kind == TranscriptEntryKind::ToolCall && record.status == "completed"
                    }
                    InjectionKind::DelegateReported => record.kind != TranscriptEntryKind::UserText,
                    // Whatever row the copy ended on.
                    InjectionKind::ForkStart => true,
                    _ => record.kind == TranscriptEntryKind::UserText,
                };
                right_kind && matches(matcher, transcript, record)
            })
            .map(|(_, view)| view.clone())
    }
}

/// How much of a row's text its card shows, when the card draws its body from it.
fn text_body_chars(mark: &InjectionView, kind: TranscriptEntryKind) -> Option<usize> {
    match mark.draws_row(kind)? {
        CardRow::Replaced => None,
        CardRow::TextBody if mark.kind == InjectionKind::DelegateReported => {
            Some(CARD_ANSWER_CHARS)
        }
        CardRow::TextBody => Some(CARD_BODY_CHARS),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn review(id: &str) -> ReviewMark {
        ReviewMark {
            id: id.to_string(),
            parent_thread_id: "parent".to_string(),
            reviewer_provider: "codex".to_string(),
            max_rounds: 2,
            status: "waiting_for_reviewer".to_string(),
            rounds: vec![ReviewRoundView {
                round: 1,
                reviewer_thread_id: "reviewer".to_string(),
                ..ReviewRoundView::default()
            }],
            ..ReviewMark::default()
        }
    }

    fn row(thread_id: &str, id: &str, kind: InjectionKind) -> InjectedMessage {
        InjectedMessage {
            thread_id: thread_id.to_string(),
            anchor: MessageAnchor::Item(format!("user:{thread_id}")),
            tag: InjectionTag::review(kind, id, 1),
            created_at: 1,
        }
    }

    /// A review is recorded when it is asked for, well before its first prompt lands.
    #[test]
    fn deleting_a_thread_keeps_a_review_no_row_has_reached_yet() {
        let mut injections = Injections::load(
            Vec::new(),
            vec![review("carried"), review("waiting")],
            Vec::new(),
            Vec::new(),
            vec![row("gone", "carried", InjectionKind::ReviewResult)],
        );

        assert_eq!(
            injections.forget_thread("gone"),
            vec!["carried".to_string()]
        );
        assert!(injections.review("carried").is_none());
        assert!(injections.review("waiting").is_some());
    }

    fn found(text: &str) -> ReviewFindingView {
        ReviewFindingView {
            severity: "high".to_string(),
            location: None,
            text: text.to_string(),
            clipped: false,
        }
    }

    /// Each row ships its own copy, so a card carries the text it draws and nothing else.
    #[test]
    fn a_card_carries_only_the_findings_it_draws() {
        let rounds = vec![
            ReviewRoundView {
                round: 1,
                findings: vec![found("first"), found("second")],
                findings_total: 2,
                change: Some("the change".to_string()),
                ..ReviewRoundView::default()
            },
            ReviewRoundView {
                round: 2,
                findings: vec![found("still")],
                findings_total: 1,
                fixed: vec![found("first")],
                fixed_total: 1,
                ..ReviewRoundView::default()
            },
        ];
        let texts = |rounds: &[ReviewRoundView]| {
            rounds
                .iter()
                .map(|round| {
                    let open: Vec<_> = round.findings.iter().map(|f| f.text.as_str()).collect();
                    let fixed: Vec<_> = round.fixed.iter().map(|f| f.text.as_str()).collect();
                    (round.round, open.join(","), fixed.join(","))
                })
                .collect::<Vec<_>>()
        };

        let draw = |kind, round| card_rounds(kind, round, &rounds, CardBodies::Preview).0;
        let result = draw(InjectionKind::ReviewResult, 1);
        assert_eq!(
            texts(&result),
            vec![
                (1, "first,second".into(), "".into()),
                (2, "".into(), "".into())
            ]
        );
        assert_eq!(
            result[1].fixed_total, 1,
            "the count survives for the folded line"
        );
        assert_eq!(result[0].change, None);

        let approved = draw(InjectionKind::ReviewApproved, 2);
        assert_eq!(
            texts(&approved),
            vec![
                (1, "".into(), "".into()),
                (2, "still".into(), "first".into())
            ]
        );
        let escalated = draw(InjectionKind::ReviewEscalated, 2);
        assert_eq!(
            texts(&escalated),
            vec![(1, "".into(), "".into()), (2, "still".into(), "".into())]
        );
        let brief = draw(InjectionKind::ReviewBrief, 1);
        assert_eq!(brief.len(), 1);
        assert_eq!(brief[0].change.as_deref(), Some("the change"));
        assert!(draw(InjectionKind::ReviewRecap, 0).is_empty());

        let many: Vec<_> = (0..30).map(|i| found(&"x".repeat(i * 20))).collect();
        let flooded = [ReviewRoundView {
            round: 1,
            findings: many,
            findings_total: 30,
            ..ReviewRoundView::default()
        }];
        let (flood, clipped) = card_rounds(
            InjectionKind::ReviewResult,
            1,
            &flooded,
            CardBodies::Preview,
        );
        assert!(clipped);
        assert_eq!(flood[0].findings.len(), CARD_FINDINGS);
        let (whole, clipped) =
            card_rounds(InjectionKind::ReviewResult, 1, &flooded, CardBodies::Whole);
        assert!(!clipped);
        assert_eq!(whole, flooded, "a detail carries every finding whole");
        assert_eq!(
            texts(&card_rounds(InjectionKind::ReviewResult, 1, &rounds, CardBodies::Whole).0),
            texts(&result),
            "and still only the ones its card draws"
        );
        assert!(flood[0]
            .findings
            .iter()
            .all(|f| f.text.chars().count() <= CARD_FINDING_CHARS + 1));
    }

    #[test]
    fn a_review_card_names_no_thread_its_reader_cannot_see() {
        let injections = Injections::load(
            Vec::new(),
            vec![ReviewMark {
                error: Some("failed in /elsewhere".to_string()),
                ..review("r")
            }],
            Vec::new(),
            Vec::new(),
            vec![row("parent", "r", InjectionKind::ReviewResult)],
        );
        let card = |may_see: bool| {
            injections
                .for_thread(
                    "parent",
                    |_| Some("title".to_string()),
                    |_| may_see,
                    CardBodies::Preview,
                )
                .marks
                .pop()
                .and_then(|(_, view)| view.review().cloned())
                .expect("the row is marked")
        };

        let open = card(true);
        assert_eq!(open.reviewer_thread_id, "reviewer");
        assert_eq!(open.rounds[0].reviewer_thread_id, "reviewer");
        assert!(open.error.is_some());

        let hidden = card(false);
        assert_eq!(
            hidden.parent_thread_id, "parent",
            "its own thread is always named"
        );
        assert_eq!(hidden.reviewer_thread_id, "");
        assert_eq!(hidden.rounds[0].reviewer_thread_id, "");
        assert_eq!(hidden.error, None);
    }

    #[test]
    fn a_fork_card_names_no_source_its_reader_cannot_see() {
        let mut injections = Injections::default();
        injections.put_fork(ForkMark {
            id: "f".to_string(),
            source_thread_id: "source".to_string(),
            target_thread_id: "branch".to_string(),
            note: "try cookies".to_string(),
            ..ForkMark::default()
        });
        injections.anchor(InjectedMessage {
            thread_id: "branch".to_string(),
            anchor: MessageAnchor::Item("user:branch".to_string()),
            tag: InjectionTag::fork(InjectionKind::ForkBrief, "f"),
            created_at: 1,
        });
        let card = |may_see: bool| {
            injections
                .for_thread(
                    "branch",
                    |_| Some("title".to_string()),
                    |_| may_see,
                    CardBodies::Preview,
                )
                .marks
                .pop()
                .and_then(|(_, view)| view.fork().cloned())
                .expect("the row is marked")
        };

        let open = card(true);
        assert_eq!(open.source_thread_id, "source");
        assert_eq!(open.source_title.as_deref(), Some("title"));
        let hidden = card(false);
        assert_eq!(hidden.source_thread_id, "");
        assert_eq!(hidden.source_title, None);
        assert_eq!(
            hidden.note, "try cookies",
            "the branch was sent the note itself"
        );
    }

    #[test]
    fn the_agents_panel_is_given_the_card_a_review_ends_on() {
        let finished = |round: u32, verdict: &str| ReviewRoundView {
            round,
            reviewer_thread_id: "reviewer".to_string(),
            verdict: Some(verdict.to_string()),
            findings: vec![found("still")],
            findings_total: 1,
            finished_at: Some(10),
            ..ReviewRoundView::default()
        };
        let mark = |max_rounds: u32, rounds: Vec<ReviewRoundView>| ReviewMark {
            max_rounds,
            rounds,
            ..review("r")
        };
        let card = |mark: &ReviewMark, status: &str| {
            mark.result_view(status)
                .map(|result| (result.kind, result.round))
        };
        use InjectionKind::{ReviewApproved, ReviewEscalated, ReviewResult};

        let single = mark(1, vec![finished(1, "approve")]);
        assert_eq!(card(&single, "complete"), Some((ReviewResult, 1)));
        let approved = mark(
            3,
            vec![finished(1, "needs_changes"), finished(2, "approve")],
        );
        assert_eq!(card(&approved, "complete"), Some((ReviewApproved, 2)));
        let exhausted = mark(
            2,
            vec![finished(1, "needs_changes"), finished(2, "needs_changes")],
        );
        assert_eq!(card(&exhausted, "escalated"), Some((ReviewEscalated, 2)));
        let fixing = mark(3, vec![finished(1, "needs_changes")]);
        assert_eq!(
            card(&fixing, "addressing_findings"),
            Some((ReviewResult, 1))
        );
        assert_eq!(card(&fixing, "failed"), Some((ReviewResult, 1)));
        let reading = mark(
            3,
            vec![
                finished(1, "needs_changes"),
                ReviewRoundView {
                    round: 2,
                    ..ReviewRoundView::default()
                },
            ],
        );
        assert_eq!(
            card(&reading, "waiting_for_reviewer"),
            Some((ReviewResult, 1))
        );
        assert_eq!(card(&review("r"), "waiting_for_reviewer"), None);

        let result = approved.result_view("complete").expect("a result");
        assert_eq!(
            result.rounds,
            card_rounds(ReviewApproved, 2, &approved.rounds, CardBodies::Preview)
                .0
                .into_iter()
                .map(|round| ReviewRoundView {
                    reviewer_thread_id: String::new(),
                    ..round
                })
                .collect::<Vec<_>>(),
            "the rounds the conversation's card draws, naming no reviewer thread"
        );
    }
}
