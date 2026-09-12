//! One agent session asking another to do something, and being woken when the
//! answer is ready.
//!
//! Records only — no traits, no driver. That absence is the design:
//!
//! **The asking agent is the loop.** It decides who to ask, what to ask, whether
//! to ask again, whether to stop, and when to come back to the user. The relay
//! carries messages and counts; it never reads what is being said. There is
//! nothing here for a private engine to drive, so there is no port and no
//! driver — an earlier draft had both, shaped around a one-shot
//! brief→work→report flow, and that flow is simply not what this is.
//!
//! Two consequences worth stating, because they are what the shape is for:
//!
//!  * **Direction does not matter.** "A designs, B implements" and "A implements,
//!    B reviews" are the same object; the difference is only what A wrote in the
//!    message. So there is no "worker" and no "reviewer" here, only a peer.
//!  * **Nothing blocks and nothing is locked.** The ask returns as soon as the
//!    peer has been handed the message. A carries on, or ends its turn and is
//!    woken later. Its thread stays open the whole time, so a person can read
//!    either side and take over.

use serde::{Deserialize, Serialize};

/// Where one ask has got to.
///
/// Deliberately small. An earlier draft had `Briefing`/`StartingWorker`/
/// `Reporting` — states that only exist when the relay is running a multi-step
/// flow of its own. It is not; those steps belong to the asking agent.
///
/// `Failed` is the serde sink for an unknown name as well as the default, so a
/// record written by a future build decodes to something TERMINAL. The persisted
/// state is one document: a hard decode error on a single unknown status would
/// discard every restored thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum AskStatus {
    /// The peer has the message and is working.
    Working,
    /// The peer finished and its answer is recorded.
    Done,
    #[default]
    Failed,
    /// Stopped by the user, or the asking thread went away.
    Cancelled,
}

impl AskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            AskStatus::Done | AskStatus::Failed | AskStatus::Cancelled
        )
    }

    /// The one representation: what clients read, and what is stored.
    pub fn as_str(self) -> &'static str {
        match self {
            AskStatus::Working => "working",
            AskStatus::Done => "done",
            AskStatus::Failed => "failed",
            AskStatus::Cancelled => "cancelled",
        }
    }
}

impl From<AskStatus> for String {
    fn from(status: AskStatus) -> Self {
        status.as_str().to_string()
    }
}

impl From<String> for AskStatus {
    fn from(value: String) -> Self {
        match value.as_str() {
            "working" => AskStatus::Working,
            "done" => AskStatus::Done,
            "cancelled" => AskStatus::Cancelled,
            _ => AskStatus::Failed,
        }
    }
}

/// What an agent asked for. The relay resolves the peer from this and never
/// looks at `message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskRequest {
    /// Reuse this peer thread if given; otherwise start a new one. Asking the
    /// same peer again is how a back-and-forth happens.
    pub peer_thread_id: Option<String>,
    /// `None` means "you choose" — which the relay reads as a DIFFERENT agent
    /// from the one asking, since a second opinion from the same model is worth
    /// less than one from another.
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub message: String,
}

/// Why an ask could not be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskError {
    /// The asking thread is gone, or is not allowed to ask.
    NoSuchAsker,
    /// The named peer thread is gone, or is not one this asker started.
    NoSuchPeer,
    /// The directory the asking session ran in no longer exists.
    WorkspaceGone,
    /// The asker is already at its limit — too many peers, or too many rounds.
    /// Carries the message to hand back, which is the agent's cue to stop.
    LimitReached(String),
    /// Everything else, already phrased for a human.
    Failed(String),
}

impl AskError {
    pub fn message(&self) -> String {
        match self {
            AskError::NoSuchAsker => "that session can no longer ask for help".to_string(),
            AskError::NoSuchPeer => "that agent is not one you started".to_string(),
            AskError::WorkspaceGone => {
                "the directory this session ran in no longer exists".to_string()
            }
            AskError::LimitReached(reason) => reason.clone(),
            AskError::Failed(reason) => reason.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_status_decodes_terminal() {
        // NOT unwrap_or_default: serde must SUCCEED, because one unreadable
        // status would otherwise throw away the whole state file.
        let decoded: AskStatus =
            serde_json::from_str("\"some_future_state\"").expect("an unknown name must decode");
        assert_eq!(decoded, AskStatus::Failed);
        assert!(decoded.is_terminal());
    }

    #[test]
    fn known_names_round_trip_and_only_working_is_live() {
        for status in [
            AskStatus::Working,
            AskStatus::Done,
            AskStatus::Failed,
            AskStatus::Cancelled,
        ] {
            let wire = serde_json::to_string(&status).expect("encodes");
            assert_eq!(
                serde_json::from_str::<AskStatus>(&wire).expect("decodes"),
                status
            );
            assert_eq!(status.is_terminal(), status != AskStatus::Working);
        }
    }
}
