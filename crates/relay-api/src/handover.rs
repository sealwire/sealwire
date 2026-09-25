//! One session writing up where its work stands and handing it to another.
//!
//! Not a delegation with the reply left out. A delegation is a QUESTION: the
//! asker keeps its thread, waits, and is woken with an answer. A handover is the
//! opposite — the source is finished with the work and says so, and nothing is
//! ever handed back. That is why there is no record type here to match
//! `delegation::Ask`: nothing outlives the delivery, so there is nothing to
//! settle, sweep, or deliver a second time.

/// What a person asked for when they typed `/handover`.
///
/// Only a person ever sends one. There is no agent-facing tool: an agent that
/// wants another agent to do something delegates, and `delegate` is that.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandoverRequest {
    /// Hand to this existing session, or start one when absent.
    pub target_thread_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// What the person wants emphasised. May be empty, and usually is: the
    /// summary is written from what the source session already knows, so unlike
    /// a delegate's task there is nothing the user has to supply.
    pub note: String,
    /// The paired device that asked. A session claim is not a path-scope grant,
    /// so both threads still have to be inside this device's scope.
    pub device_id: Option<String>,
}

/// Why a handover could not be made. Every variant is already phrased for the
/// person who typed the command — this is what their composer shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoverError {
    /// The handing-over thread is gone, or is not one this device may see.
    NoSuchSource,
    /// The named target is gone, or is not one this device may see.
    NoSuchTarget,
    Failed(String),
}

impl HandoverError {
    pub fn message(&self) -> String {
        match self {
            HandoverError::NoSuchSource => "there is no such session".to_string(),
            HandoverError::NoSuchTarget => "there is no such agent to hand this to".to_string(),
            HandoverError::Failed(reason) => reason.clone(),
        }
    }
}
