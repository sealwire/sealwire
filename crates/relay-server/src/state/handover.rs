//! The relay-owned record of one handover: session A wrote up where its work
//! stood and gave it to session B.
//!
//! It exists for one reason — a handover is ACCEPTED before it is delivered, and
//! the minutes in between are a real turn on a real model. Without a record, an
//! accepted handover has no owner but a `tokio::spawn`: a restart loses it
//! silently, and a failure has nowhere to be seen. So this is the operation, not
//! a card: it is what the restore side reconciles and what the composer reads
//! its failure from.
//!
//! What it deliberately is NOT is an `Ask`. Nothing here waits for the target to
//! answer, nothing is delivered back, and the source is never woken. `Done` means
//! the target was handed the summary — that is the end of it.

use serde::{Deserialize, Serialize};

use super::unix_now;

/// Where one handover has got to.
///
/// `Failed` is the serde sink for an unknown name as well as the default, so a
/// record written by a future build decodes to something TERMINAL. The persisted
/// state is one document: a hard decode error on a single unknown status would
/// discard every restored thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub(crate) enum HandoverStatus {
    /// Accepted. The source is writing the handover, or it is on its way.
    Working,
    /// The target has it. Nothing further happens.
    Done,
    #[default]
    Failed,
}

impl HandoverStatus {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, HandoverStatus::Done | HandoverStatus::Failed)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            HandoverStatus::Working => "working",
            HandoverStatus::Done => "done",
            HandoverStatus::Failed => "failed",
        }
    }
}

impl From<HandoverStatus> for String {
    fn from(status: HandoverStatus) -> Self {
        status.as_str().to_string()
    }
}

impl From<String> for HandoverStatus {
    fn from(value: String) -> Self {
        match value.as_str() {
            "working" => HandoverStatus::Working,
            "done" => HandoverStatus::Done,
            _ => HandoverStatus::Failed,
        }
    }
}

/// `Default` + `#[serde(default)]` give forward-compat: a record written by a
/// future build still decodes, missing fields fall back, unknown ones are ignored.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Handover {
    pub(crate) id: String,
    /// The session that handed the work away. Every failure is reported against
    /// THIS thread — it is the composer the command was typed into.
    pub(crate) source_thread_id: String,
    pub(crate) target_thread_id: String,
    /// Whether this handover started the target itself.
    ///
    /// Load-bearing for the failure wording: a session that exists only because of
    /// a handover that never arrived is an orphan the person has to be told about
    /// by name, while somebody else's session is simply untouched.
    pub(crate) target_started: bool,
    /// The device that asked, when one did. Provenance in the state file, NOT an
    /// authorization input: what a device can be fenced against is the source
    /// thread's workspace, and that is what `acknowledge_handover` checks.
    pub(crate) device_id: Option<String>,
    pub(crate) status: HandoverStatus,
    pub(crate) error: Option<String>,
    /// Whether the person has been shown how this ended.
    ///
    /// A read receipt, nothing more: the record stays either way. Without it the
    /// relay re-pushes the same failure on every snapshot and fights the composer's
    /// own "a new attempt retires the last one's line".
    pub(crate) acknowledged: bool,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

impl Handover {
    pub(crate) fn new(
        id: String,
        source_thread_id: String,
        target_thread_id: String,
        target_started: bool,
        device_id: Option<String>,
    ) -> Self {
        let now = unix_now();
        Self {
            id,
            source_thread_id,
            target_thread_id,
            target_started,
            device_id,
            status: HandoverStatus::Working,
            error: None,
            // A success has nothing to say, so it starts already answered for.
            acknowledged: false,
            created_at: now,
            updated_at: now,
        }
    }

    /// Terminal is final, for the same reason an ask's is: the delivery and a
    /// restart-time reconciliation can race, and the later write would otherwise
    /// replace what really happened.
    fn settle(&mut self, status: HandoverStatus) {
        if self.status.is_terminal() {
            return;
        }
        self.status = status;
        self.updated_at = unix_now();
    }

    pub(crate) fn finish(&mut self) {
        if self.status.is_terminal() {
            return;
        }
        // Nothing to report: the target has it and the source has moved on.
        self.acknowledged = true;
        self.settle(HandoverStatus::Done);
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() {
            return;
        }
        self.error = Some(error.into());
        self.acknowledged = false;
        self.settle(HandoverStatus::Failed);
    }

    /// Does this still want the person's attention?
    ///
    /// The only records that go on the wire. A handover that worked is not news,
    /// and one whose failure has been read is not news twice.
    pub(crate) fn needs_attention(&self) -> bool {
        !self.status.is_terminal() || (self.status == HandoverStatus::Failed && !self.acknowledged)
    }

    pub(crate) fn view(&self) -> crate::protocol::HandoverView {
        crate::protocol::HandoverView {
            id: self.id.clone(),
            source_thread_id: self.source_thread_id.clone(),
            target_thread_id: self.target_thread_id.clone(),
            target_started: self.target_started,
            status: self.status.as_str().to_string(),
            error: self.error.clone(),
            updated_at: self.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handover() -> Handover {
        Handover::new(
            "handover-1".into(),
            "source".into(),
            "target".into(),
            true,
            Some("dev".into()),
        )
    }

    #[test]
    fn a_delivered_handover_asks_for_nothing_and_a_failed_one_asks_once() {
        let mut done = handover();
        done.finish();
        assert!(
            !done.needs_attention(),
            "a handover that worked is not news"
        );

        let mut failed = handover();
        failed.fail("the target was busy");
        assert!(failed.needs_attention());
        assert_eq!(failed.view().error.as_deref(), Some("the target was busy"));

        failed.acknowledged = true;
        assert!(
            !failed.needs_attention(),
            "re-pushing a failure the person has read fights the composer's own clear",
        );
    }

    #[test]
    fn an_accepted_handover_is_on_the_wire_before_it_has_an_outcome() {
        // It is the operation, not a card: the person was told it was under way, so
        // something has to be able to say so — and to be reconciled if nothing does.
        let live = handover();
        assert!(live.needs_attention());
        assert_eq!(live.view().status, "working");
    }

    #[test]
    fn a_late_failure_does_not_overwrite_how_it_really_ended() {
        let mut settled = handover();
        settled.finish();
        settled.fail("the relay restarted");
        assert_eq!(settled.status, HandoverStatus::Done);
        assert_eq!(settled.error, None);
    }

    #[test]
    fn a_record_with_no_status_decodes_terminal() {
        // One unreadable status must not throw away the whole state file.
        let decoded: Handover = serde_json::from_str("{}").expect("decodes");
        assert!(decoded.status.is_terminal());
        let future: HandoverStatus =
            serde_json::from_str("\"some_future_state\"").expect("an unknown name must decode");
        assert!(future.is_terminal());
    }

    #[test]
    fn known_names_round_trip_and_only_working_is_live() {
        for status in [
            HandoverStatus::Working,
            HandoverStatus::Done,
            HandoverStatus::Failed,
        ] {
            let wire = serde_json::to_string(&status).expect("encodes");
            assert_eq!(
                serde_json::from_str::<HandoverStatus>(&wire).expect("decodes"),
                status
            );
            assert_eq!(status.is_terminal(), status != HandoverStatus::Working);
        }
    }
}
