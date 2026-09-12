//! The relay-owned record of one ask: session A handed session B a message and
//! is waiting for the answer.
//!
//! The asking agent owns the loop, so this record holds no flow — just who asked
//! whom, what came back, and whether the answer has been handed over yet.
//!
//! Two invariants, both copied from review jobs for the same reasons:
//!  1. terminal is final (`set_status` refuses to move off it),
//!  2. only terminal asks persist — an in-flight one has nothing watching it
//!     after a restart, so restoring it would show work nobody is doing.
//!
//! Unlike a review, an ask locks neither thread. That is the point: both sides
//! stay open so a person can read them and take over.

use serde::{Deserialize, Serialize};

use relay_api::delegation::AskStatus;

use super::unix_now;

/// `Default` + `#[serde(default)]` give forward-compat: a record written by a
/// future build still decodes, missing fields fall back, unknown ones are
/// ignored. Only TERMINAL asks are ever written.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Ask {
    pub(crate) id: String,
    /// The session that asked.
    pub(crate) asker_thread_id: String,
    /// The session that was asked. Set as soon as the ask is recorded — an ask
    /// with no peer is never stored, because the tool call that creates one only
    /// returns after the peer has the message.
    pub(crate) peer_thread_id: String,
    pub(crate) peer_provider: String,
    pub(crate) peer_model: Option<String>,
    /// Kept so a finished card can say what the peer actually ran at. The view
    /// carries it too: without it nobody can reconstruct the configuration.
    pub(crate) peer_effort: Option<String>,
    /// What was sent. Recorded so the pair is auditable from the card alone —
    /// the person never typed it, an agent did.
    pub(crate) message: String,
    /// The peer's last assistant message at the moment it was asked.
    ///
    /// Without it the sweeper cannot tell "has not started yet" from "finished":
    /// a peer that has not picked up the turn still looks idle, and its PREVIOUS
    /// reply would be captured as the answer to this ask.
    pub(crate) baseline_item_id: Option<String>,
    /// The turn this ask dispatched.
    ///
    /// Load-bearing: a peer can be typed into by a person while an ask is open,
    /// and THAT reply is also "newer than the baseline". Only the turn id says
    /// which question a reply answers.
    pub(crate) turn_id: Option<String>,
    /// Whether the peer has already been asked to summarise for the asker.
    ///
    /// One nudge, then take the last message: a peer that ignores the request
    /// twice is not going to start, and asking forever would hold the asker
    /// asleep.
    pub(crate) nudged: bool,
    /// What came back.
    pub(crate) answer: Option<String>,
    pub(crate) status: AskStatus,
    pub(crate) error: Option<String>,
    /// Whether the answer has been handed back to the asker yet.
    ///
    /// The asker is woken ONCE, when nothing it asked for is still running — so
    /// at most one delivery is ever pending per asker and no queue is needed.
    /// This flag is what makes that delivery exactly-once across a retry.
    pub(crate) delivered: bool,
    pub(crate) cwd: String,
    pub(crate) asked_at: u64,
    pub(crate) updated_at: u64,
}

impl Ask {
    pub(crate) fn new(
        id: String,
        asker_thread_id: String,
        peer_thread_id: String,
        peer_provider: String,
        peer_model: Option<String>,
        peer_effort: Option<String>,
        message: String,
        cwd: String,
        baseline_item_id: Option<String>,
    ) -> Self {
        let now = unix_now();
        Self {
            id,
            asker_thread_id,
            peer_thread_id,
            peer_provider,
            peer_model,
            peer_effort,
            message,
            baseline_item_id,
            turn_id: None,
            nudged: false,
            answer: None,
            status: AskStatus::Working,
            error: None,
            delivered: false,
            cwd,
            asked_at: now,
            updated_at: now,
        }
    }

    /// Terminal is final. A user stop and the peer's own completion race each
    /// other; without this guard the later write would reopen a settled ask and
    /// the asker would be woken for work it was already told about.
    pub(crate) fn set_status(&mut self, status: AskStatus) {
        if self.status.is_terminal() {
            return;
        }
        self.status = status;
        self.updated_at = unix_now();
    }

    pub(crate) fn finish(&mut self, answer: impl Into<String>) {
        if self.status.is_terminal() {
            return;
        }
        self.answer = Some(answer.into());
        self.set_status(AskStatus::Done);
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() {
            return;
        }
        self.error = Some(error.into());
        self.set_status(AskStatus::Failed);
    }

    pub(crate) fn view(&self) -> crate::protocol::AskView {
        crate::protocol::AskView {
            id: self.id.clone(),
            asker_thread_id: self.asker_thread_id.clone(),
            peer_thread_id: self.peer_thread_id.clone(),
            peer_provider: self.peer_provider.clone(),
            peer_model: self.peer_model.clone(),
            peer_effort: self.peer_effort.clone(),
            message: self.message.clone(),
            answer: self.answer.clone(),
            status: self.status.as_str().to_string(),
            error: self.error.clone(),
            delivered: self.delivered,
            updated_at: self.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask() -> Ask {
        Ask::new(
            "ask-1".into(),
            "asker".into(),
            "peer".into(),
            "codex".into(),
            None,
            None,
            "fix the flaky test".into(),
            "/tmp".into(),
            None,
        )
    }

    #[test]
    fn a_cancelled_ask_cannot_be_reopened_by_a_late_answer() {
        let mut ask = ask();
        ask.set_status(AskStatus::Cancelled);
        // The peer finishes anyway, after the user already stopped it.
        ask.finish("here you go");
        assert_eq!(ask.status, AskStatus::Cancelled);
        assert_eq!(ask.answer, None, "a stopped ask has no answer to deliver");
    }

    #[test]
    fn a_late_failure_does_not_overwrite_how_it_really_ended() {
        let mut ask = ask();
        ask.finish("done");
        ask.fail("peer died");
        assert_eq!(ask.status, AskStatus::Done);
        assert_eq!(ask.error, None);
    }

    #[test]
    fn a_record_with_no_status_decodes_terminal() {
        let decoded: Ask = serde_json::from_str("{}").expect("decodes");
        assert!(decoded.status.is_terminal());
    }

    #[test]
    fn an_answer_starts_undelivered() {
        // The wake-up is exactly-once; `delivered` is what makes a retry safe.
        let mut ask = ask();
        ask.finish("answer");
        assert!(!ask.delivered);
        assert_eq!(ask.view().answer.as_deref(), Some("answer"));
    }
}

/// How much a setting lets an agent do. Higher is wider.
///
/// Only used to prove a peer is never granted more than its asker, so an unknown
/// value must rank as the WIDEST thing we know of — treating something we cannot
/// read as harmless is how a guard like this gets quietly defeated.
fn sandbox_rank(sandbox: &str) -> u8 {
    match sandbox {
        "read-only" => 0,
        "workspace-write" => 1,
        "danger-full-access" => 2,
        _ => u8::MAX,
    }
}

fn approval_rank(approval: &str) -> u8 {
    match approval {
        // The reviewer sentinel is the narrowest: the worker denies every
        // file-mutating tool for it.
        "review_read_only" => 0,
        "untrusted" => 1,
        "on-request" => 2,
        // Auto-accepts edits without asking.
        "never" => 3,
        "bypass" => 4,
        _ => u8::MAX,
    }
}

/// Is this session already allowed to do anything it likes?
///
/// The whole reason an agent asking another agent could be an escalation is that
/// the second one might be able to do more than the first. If the first one is
/// already unrestricted, there is nothing to escalate TO — so offering the tool
/// only here removes the problem rather than guarding against it.
pub(crate) fn session_is_unrestricted(approval: &str, sandbox: &str) -> bool {
    approval == "bypass" || sandbox == "danger-full-access"
}

/// Is `peer` allowed to do more than `asker`?
///
/// Handing work to an EXISTING session cannot narrow it — it belongs to someone
/// else and may be mid-conversation — so the only safe answer there is to refuse.
/// Silently re-configuring a session the user set to bypass would be its own
/// surprise.
pub(crate) fn peer_is_wider_than_asker(
    asker_approval: &str,
    asker_sandbox: &str,
    peer_approval: &str,
    peer_sandbox: &str,
) -> bool {
    approval_rank(peer_approval) > approval_rank(asker_approval)
        || sandbox_rank(peer_sandbox) > sandbox_rank(asker_sandbox)
}

/// What a peer thread runs as.
///
/// It inherits the asker's settings verbatim and cannot be given anything the
/// asker did not already have. Without this the tool is a sandbox escape: a
/// read-only session simply asks a full-access peer to do the writing for it.
///
/// Requests are accepted only when they NARROW. That direction is always safe
/// and lets an agent hand out something weaker than itself on purpose.
pub(crate) fn peer_thread_settings(
    asker_approval: &str,
    asker_sandbox: &str,
    requested_approval: Option<&str>,
    requested_sandbox: Option<&str>,
) -> (String, String) {
    let approval = requested_approval
        .filter(|wanted| approval_rank(wanted) <= approval_rank(asker_approval))
        .unwrap_or(asker_approval);
    let sandbox = requested_sandbox
        .filter(|wanted| sandbox_rank(wanted) <= sandbox_rank(asker_sandbox))
        .unwrap_or(asker_sandbox);
    (approval.to_string(), sandbox.to_string())
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    const APPROVALS: &[&str] = &[
        "review_read_only",
        "untrusted",
        "on-request",
        "never",
        "bypass",
    ];
    const SANDBOXES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

    #[test]
    fn a_peer_can_never_be_granted_more_than_its_asker() {
        // The whole security argument for letting an agent start another agent
        // without a confirmation card. Exhaustive, because one gap is an escape.
        for asker_approval in APPROVALS {
            for asker_sandbox in SANDBOXES {
                for wanted_approval in APPROVALS {
                    for wanted_sandbox in SANDBOXES {
                        let (approval, sandbox) = peer_thread_settings(
                            asker_approval,
                            asker_sandbox,
                            Some(wanted_approval),
                            Some(wanted_sandbox),
                        );
                        assert!(
                            approval_rank(&approval) <= approval_rank(asker_approval),
                            "{asker_approval}+{asker_sandbox} asked for {wanted_approval} \
and got {approval}",
                        );
                        assert!(
                            sandbox_rank(&sandbox) <= sandbox_rank(asker_sandbox),
                            "{asker_approval}+{asker_sandbox} asked for {wanted_sandbox} \
and got {sandbox}",
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn asking_for_nothing_inherits_exactly() {
        assert_eq!(
            peer_thread_settings("on-request", "workspace-write", None, None),
            ("on-request".to_string(), "workspace-write".to_string())
        );
    }

    #[test]
    fn a_narrower_request_is_honoured() {
        // Handing out something weaker than yourself is always safe, and is how
        // an agent asks for a read-only second opinion.
        assert_eq!(
            peer_thread_settings(
                "bypass",
                "danger-full-access",
                Some("untrusted"),
                Some("read-only")
            ),
            ("untrusted".to_string(), "read-only".to_string())
        );
    }

    #[test]
    fn a_value_we_cannot_read_is_treated_as_the_widest_thing_there_is() {
        // A future provider adds a policy name this build has never heard of.
        // Ranking it as harmless would let it through as a request; ranking it
        // widest means it is only ever inherited, never granted.
        let (approval, sandbox) = peer_thread_settings(
            "on-request",
            "workspace-write",
            Some("brand-new"),
            Some("brand-new"),
        );
        assert_eq!(approval, "on-request", "an unreadable request is refused");
        assert_eq!(sandbox, "workspace-write");

        // …and an asker already running under one keeps it rather than being
        // silently narrowed to something that might not work.
        let (approval, _) = peer_thread_settings("brand-new", "workspace-write", None, None);
        assert_eq!(approval, "brand-new");
    }
}
