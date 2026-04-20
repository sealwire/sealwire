use serde_json::{json, Value};

use crate::protocol::{
    ApprovalDecision, ApprovalDecisionInput, ApprovalRequestView, ApprovalScope,
};

#[derive(Clone, Debug)]
pub struct PendingApproval {
    pub request_id: String,
    pub raw_request_id: Value,
    pub kind: ApprovalKind,
    pub thread_id: String,
    pub summary: String,
    pub detail: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub context_preview: Option<String>,
    pub requested_permissions: Option<Value>,
    pub available_decisions: Vec<String>,
    pub supports_session_scope: bool,
}

impl PendingApproval {
    pub fn to_view(&self) -> ApprovalRequestView {
        ApprovalRequestView {
            request_id: self.request_id.clone(),
            kind: self.kind.as_str().to_string(),
            summary: self.summary.clone(),
            detail: self.detail.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            context_preview: self.context_preview.clone(),
            requested_permissions: self.requested_permissions.clone(),
            available_decisions: self.available_decisions.clone(),
            supports_session_scope: self.supports_session_scope,
        }
    }

    pub fn decision_payload(&self, input: &ApprovalDecisionInput) -> Value {
        match self.kind {
            ApprovalKind::Command => json!({
                "decision": match (input.decision, input.scope.unwrap_or(ApprovalScope::Once)) {
                    (ApprovalDecision::Approve, ApprovalScope::Session) => "acceptForSession",
                    (ApprovalDecision::Approve, ApprovalScope::Once) => "accept",
                    (ApprovalDecision::Deny, _) => "decline",
                    (ApprovalDecision::Cancel, _) => "cancel",
                }
            }),
            ApprovalKind::FileChange => json!({
                "decision": match (input.decision, input.scope.unwrap_or(ApprovalScope::Once)) {
                    (ApprovalDecision::Approve, ApprovalScope::Session) => "acceptForSession",
                    (ApprovalDecision::Approve, ApprovalScope::Once) => "accept",
                    (ApprovalDecision::Deny, _) => "decline",
                    (ApprovalDecision::Cancel, _) => "cancel",
                }
            }),
            ApprovalKind::Permissions => {
                if matches!(input.decision, ApprovalDecision::Approve) {
                    json!({
                        "permissions": self.requested_permissions.clone().unwrap_or_else(|| json!({})),
                        "scope": match input.scope.unwrap_or(ApprovalScope::Once) {
                            ApprovalScope::Once => "turn",
                            ApprovalScope::Session => "session",
                        }
                    })
                } else {
                    json!({
                        "permissions": {},
                        "scope": "turn"
                    })
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ApprovalKind {
    Command,
    FileChange,
    Permissions,
}

impl ApprovalKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ApprovalKind::Command => "command_execution",
            ApprovalKind::FileChange => "file_change",
            ApprovalKind::Permissions => "permissions",
        }
    }
}
