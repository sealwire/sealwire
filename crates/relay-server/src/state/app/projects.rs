use super::*;

/// Hard bounds so a paired device can't bloat persisted Project state (names, count,
/// or arbitrary unloaded memberships). The full payload rides a dedicated fetch
/// channel, not the byte-budgeted snapshot, but persisted state still needs a ceiling.
const MAX_PROJECTS: usize = 256;
const MAX_PROJECT_NAME_CHARS: usize = 200;
const MAX_PROJECT_MEMBERSHIPS: usize = 10_000;

/// Best-effort by design: the user asked for a SESSION, and a project deleted
/// mid-dialog must not cost them one. Returns whether membership changed.
pub(super) fn attach_new_thread_to_project(
    relay: &mut RelayState,
    thread_id: &str,
    project_id: &str,
) -> bool {
    if !relay.thread_project_id.contains_key(thread_id)
        && relay.thread_project_id.len() >= MAX_PROJECT_MEMBERSHIPS
    {
        relay.push_log(
            "warn",
            format!(
                "Session {thread_id} started outside project {project_id}: membership limit reached ({MAX_PROJECT_MEMBERSHIPS})"
            ),
        );
        return false;
    }
    match relay.assign_thread_to_project(thread_id, project_id) {
        Ok(()) => true,
        Err(error) => {
            relay.push_log(
                "warn",
                format!("Session {thread_id} started outside project {project_id}: {error}"),
            );
            false
        }
    }
}

impl AppState {
    /// Manual Projects write path: create / rename / delete a Project, or assign /
    /// unassign a session. Returns the full post-action project list + membership so
    /// the calling client updates immediately, bumps `projects_revision`, and
    /// `notify()`s so passive clients re-sync (they refetch the dedicated payload on
    /// the bump). Projects are global (not device-scoped); `device_id` is actor-only.
    pub async fn project_action(
        &self,
        input: ProjectActionInput,
    ) -> Result<ProjectActionReceipt, String> {
        let actor = input
            .device_id
            .as_deref()
            .unwrap_or("local operator")
            .to_string();
        let action = match input.action {
            ProjectAction::Assign {
                thread_id,
                project_id,
            } => ProjectAction::Assign {
                thread_id: self.canonical_session_id(&thread_id).await?,
                project_id,
            },
            ProjectAction::Unassign { thread_id } => ProjectAction::Unassign {
                thread_id: self.canonical_session_id(&thread_id).await?,
            },
            other => other,
        };
        let mut relay = self.relay.write().await;
        let message = match action {
            ProjectAction::Create { name } => {
                let name = validate_project_name(name)?;
                if relay.projects.len() >= MAX_PROJECTS {
                    return Err(format!("project limit reached ({MAX_PROJECTS})"));
                }
                let project = relay.create_project(new_project_id(), name.clone());
                relay.push_log(
                    "info",
                    format!("Created project \"{name}\" ({}) [{actor}]", project.id),
                );
                format!("Created project \"{name}\".")
            }
            ProjectAction::Rename { project_id, name } => {
                let name = validate_project_name(name)?;
                relay.rename_project(&project_id, name.clone())?;
                relay.push_log(
                    "info",
                    format!("Renamed project {project_id} to \"{name}\" [{actor}]"),
                );
                format!("Renamed project to \"{name}\".")
            }
            ProjectAction::Delete { project_id } => {
                relay.delete_project(&project_id)?;
                relay.push_log("info", format!("Deleted project {project_id} [{actor}]"));
                "Project deleted.".to_string()
            }
            ProjectAction::Assign {
                thread_id,
                project_id,
            } => {
                if thread_id.len() > MAX_THREAD_ID_BYTES {
                    return Err(format!(
                        "thread id must be at most {MAX_THREAD_ID_BYTES} bytes"
                    ));
                }
                // Bound persisted membership: reject a NEW membership once the map is
                // full (an already-assigned session can still be reassigned).
                if !relay.thread_project_id.contains_key(&thread_id)
                    && relay.thread_project_id.len() >= MAX_PROJECT_MEMBERSHIPS
                {
                    return Err(format!(
                        "project membership limit reached ({MAX_PROJECT_MEMBERSHIPS})"
                    ));
                }
                relay.assign_thread_to_project(&thread_id, &project_id)?;
                relay.push_log(
                    "info",
                    format!("Assigned session {thread_id} to project {project_id} [{actor}]"),
                );
                "Session assigned to project.".to_string()
            }
            ProjectAction::Unassign { thread_id } => {
                relay.unassign_thread_from_project(&thread_id);
                relay.push_log("info", format!("Unassigned session {thread_id} [{actor}]"));
                "Session moved to Unassigned.".to_string()
            }
        };
        relay.bump_projects_revision();
        let receipt = ProjectActionReceipt {
            projects: relay.projects_view(),
            thread_project_id: relay.thread_project_id.clone(),
            message,
        };
        relay.notify();
        Ok(receipt)
    }

    /// The dedicated, uncompacted Projects payload (list + membership + revision),
    /// served on demand off the byte-budgeted snapshot (mirrors `reviews`).
    pub async fn fetch_projects(&self) -> crate::protocol::ProjectsResponse {
        self.relay.read().await.projects_response()
    }
}

fn validate_project_name(name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("project name must not be empty".to_string());
    }
    if name.chars().count() > MAX_PROJECT_NAME_CHARS {
        return Err(format!(
            "project name must be at most {MAX_PROJECT_NAME_CHARS} characters"
        ));
    }
    Ok(name)
}

/// Random, stable-shaped project id. Every Project is user-created with a fresh id.
///
/// **The `proj_` prefix is load-bearing, not decoration.** The sidebar's Project
/// switcher renders one project group alongside cwd groups in a single list, and
/// those group keys are the React keys and the virtualizer's `getItemKey`. A
/// project id that could equal a canonical cwd (an absolute path) would collide
/// and corrupt the list rather than merely mislabel a header. Keeping ids
/// server-generated and prefixed is what makes the two key spaces disjoint by
/// construction. If caller-chosen ids are ever accepted, namespace the pinned
/// group's key first — see `buildCwdGroupsWithPinnedProject` in
/// `frontend/shared/thread-groups.js` and the collision test beside it.
fn new_project_id() -> String {
    format!("proj_{:016x}", rand::random::<u64>())
}
