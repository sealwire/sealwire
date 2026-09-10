//! Pin → newer writes (after proven_at) → remembered proven → birth cwd. Candidates must be in enumerated, device-scoped `roots`.

use super::*;

impl AppState {
    /// Pin → writes newer than remembered proven → remembered proven → birth cwd (`None` device = relay-wide roots).
    pub(crate) async fn resolve_thread_workspace(
        &self,
        thread_id: &str,
        device_id: Option<&str>,
    ) -> Result<ResolvedWorkspace, ThreadWorkspaceError> {
        let (birth_cwd, relay_cwd, device_scope, allowed_roots, grants) = {
            let relay = self.relay.read().await;
            let birth_cwd = relay.thread_cwd(thread_id).ok_or_else(|| {
                ThreadWorkspaceError::Unresolvable(format!(
                    "cannot resolve the workspace of thread `{thread_id}`"
                ))
            })?;
            let device_scope = device_id
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(&birth_cwd, &device_scope, &relay.allowed_roots)
                .map_err(ThreadWorkspaceError::OutOfScope)?;
            (
                birth_cwd,
                relay.current_cwd.clone(),
                device_scope,
                relay.allowed_roots.clone(),
                relay.trust_grants(),
            )
        };

        let birth_cwd_exists = dir_exists(&birth_cwd);
        let (usable, gone) = resolve_workspace_cwd(
            &birth_cwd,
            &relay_cwd,
            &device_scope,
            &allowed_roots,
            &grants,
        )
        .await
        .into_readable()
        .ok_or_else(|| {
            ThreadWorkspaceError::Unresolvable(format!(
                "the workspace this thread ran in ({birth_cwd}) no longer exists, and \
no workspace related to it is available instead"
            ))
        })?;
        // PASSIVE, so it degrades rather than refusing: enumerating a repo's worktrees is
        // `git worktree list`, which is still git running in a directory nobody vouched
        // for. An ungranted tree simply reports no sibling roots — the picker shows fewer
        // rows instead of the relay executing an unfamiliar repo to populate them.
        let roots: Vec<WorkspaceRootView> = match self.admit(usable.as_str()).await.trusted() {
            Some(workspace) => list_worktrees_in(workspace)
                .await
                .into_iter()
                .filter(|root| path_within_device_scope(&root.path, &device_scope, &allowed_roots))
                .collect(),
            None => Vec::new(),
        };

        #[cfg(test)]
        {
            self.workspace_resolve_arrivals
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            drop(self.workspace_resolve_barrier.lock().await);
        }

        let (mut write_evidence, mut remembered) = {
            let relay = self.relay.read().await;
            (
                relay
                    .runtime_for_thread(thread_id)
                    .map(|runtime| thread_write_evidence(&runtime.transcript))
                    .unwrap_or_default(),
                relay.thread_workspace(thread_id),
            )
        };

        #[cfg(test)]
        {
            self.workspace_resolve_writeback_arrivals
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            drop(self.workspace_resolve_writeback_barrier.lock().await);
        }

        let root_paths: Vec<&str> = roots.iter().map(|root| root.path.as_str()).collect();
        let in_reach = |candidate: &str| -> Option<String> {
            roots
                .iter()
                .find(|root| paths_equivalent(&root.path, candidate))
                .filter(|root| path_within_device_scope(&root.path, &device_scope, &allowed_roots))
                .map(|root| root.path.clone())
        };
        let proven_root = |candidate: &str| -> Option<String> {
            in_reach(candidate).or_else(|| root_containing_writes(&[candidate.to_string()], &roots))
        };

        let mut retried_unpin = false;
        let (cwd, origin) = loop {
            let write_root = root_containing_writes(&write_evidence.paths, &roots);
            let writes_are_newer = match (
                write_root.as_ref(),
                write_evidence.newest_seq,
                remembered.proven.as_ref(),
                remembered.proven_at,
            ) {
                (None, _, _, _) => false,
                (Some(_), _, None, _) => true,
                (Some(_), Some(seq), Some(_), at) => seq > at.unwrap_or(0),
                (Some(_), None, Some(_), _) => false,
            };

            let mut persist: Option<(String, Option<u64>)> = None;
            let (mut cwd, mut origin) =
                if let Some(pinned) = remembered.pinned.as_deref().and_then(&in_reach) {
                    (pinned, WorkspaceOrigin::Pinned)
                } else if writes_are_newer {
                    let proven = write_root.expect("writes_are_newer requires a write root");
                    let same_enumerated_tree = remembered.proven.as_deref().is_some_and(|path| {
                        crate::state::nearest_enumerated_root(path, &root_paths).as_deref()
                            == Some(proven.as_str())
                    });
                    if !same_enumerated_tree {
                        persist = Some((proven.clone(), write_evidence.newest_seq));
                    }
                    (proven, WorkspaceOrigin::Proven)
                } else if let Some(remembered_root) =
                    remembered.proven.as_deref().and_then(&proven_root)
                {
                    (remembered_root, WorkspaceOrigin::Proven)
                } else if let Some(proven) = write_root {
                    persist = Some((proven.clone(), write_evidence.newest_seq));
                    (proven, WorkspaceOrigin::Proven)
                } else {
                    let cwd = usable.as_str().to_string();
                    match gone.clone() {
                        Some(gone) => (cwd, WorkspaceOrigin::Substituted { gone }),
                        None => (cwd, WorkspaceOrigin::Birth),
                    }
                };

            let mut remap_after_lock: Option<(String, WorkspaceOrigin)> = None;
            let mut retry_unpinned = false;
            {
                // String-only persist: path identity was decided outside this lock.
                let mut relay = self.relay.write().await;
                let live = relay.thread_workspace(thread_id);
                if let Some(pinned) = live.pinned.as_deref() {
                    if let Some(root) = roots
                        .iter()
                        .find(|root| root.path == pinned)
                        .map(|root| root.path.clone())
                        .or_else(|| crate::state::nearest_enumerated_root(pinned, &root_paths))
                    {
                        cwd = root;
                        origin = WorkspaceOrigin::Pinned;
                    } else {
                        remap_after_lock = Some((pinned.to_string(), WorkspaceOrigin::Pinned));
                    }
                } else if remembered.pinned.is_some() && !retried_unpin {
                    write_evidence = relay
                        .runtime_for_thread(thread_id)
                        .map(|runtime| thread_write_evidence(&runtime.transcript))
                        .unwrap_or_default();
                    remembered = live;
                    retry_unpinned = true;
                } else {
                    let live_is_newer = match (live.proven_at, remembered.proven_at) {
                        (Some(live_at), Some(snap_at)) => live_at > snap_at,
                        (Some(_), None) => true,
                        _ => false,
                    };
                    if live_is_newer {
                        if let Some(path) = live.proven.as_deref() {
                            if let Some(root) =
                                crate::state::nearest_enumerated_root(path, &root_paths)
                            {
                                cwd = root;
                                origin = WorkspaceOrigin::Proven;
                            } else {
                                remap_after_lock =
                                    Some((path.to_string(), WorkspaceOrigin::Proven));
                            }
                        }
                    } else if let Some((tree, at)) = persist {
                        if live.proven.as_deref() != Some(tree.as_str()) || live.proven_at != at {
                            relay.record_inferred_thread_workspace(thread_id, &tree, at);
                        }
                    }
                }
            }
            if retry_unpinned {
                retried_unpin = true;
                continue;
            }
            if let Some((path, remap_origin)) = remap_after_lock {
                let root = match &remap_origin {
                    WorkspaceOrigin::Pinned => in_reach(&path),
                    _ => proven_root(&path),
                };
                if let Some(root) = root {
                    cwd = root;
                    origin = remap_origin;
                }
            }
            break (cwd, origin);
        };

        // Passive path: only Trusted may run git. Restricted must stamp `restricted`
        // itself — `read_git_context_without_git` is also used inside Trusted collects.
        let git = match self.admit(&cwd).await {
            Admission::Trusted(workspace) => {
                super::git_context::collect_git_context(cwd.clone(), &workspace).await
            }
            Admission::Restricted(_) => WorkspaceGitContextView {
                restricted: true,
                ..super::git_context::read_git_context_without_git(cwd.clone()).await
            },
            Admission::Gone => WorkspaceGitContextView {
                cwd: cwd.clone(),
                ..WorkspaceGitContextView::default()
            },
        };

        Ok(ResolvedWorkspace {
            cwd,
            origin,
            git,
            roots,
            birth_cwd,
            birth_cwd_exists,
        })
    }

    #[cfg(test)]
    pub(crate) async fn hold_workspace_resolve_barrier(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.workspace_resolve_barrier.clone().lock_owned().await
    }

    #[cfg(test)]
    pub(crate) fn workspace_resolve_arrivals(&self) -> u64 {
        self.workspace_resolve_arrivals
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) async fn hold_workspace_resolve_writeback_barrier(
        &self,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        self.workspace_resolve_writeback_barrier
            .clone()
            .lock_owned()
            .await
    }

    #[cfg(test)]
    pub(crate) fn workspace_resolve_writeback_arrivals(&self) -> u64 {
        self.workspace_resolve_writeback_arrivals
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Pin (`Some`) or un-pin (`None`); only enumerated, in-scope trees, then re-resolve.
    pub async fn pin_thread_workspace(
        &self,
        input: ThreadWorkspaceInput,
    ) -> Result<ResolvedWorkspace, String> {
        let thread_id =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;
        if thread_id.len() > MAX_THREAD_ID_BYTES {
            return Err(format!(
                "thread id must be at most {MAX_THREAD_ID_BYTES} bytes"
            ));
        }
        let device_id = input.device_id.clone();
        // Promote pending ids first: pinning a `claude-pending-…` row would persist a dead key.
        let thread_id = self
            .relay
            .read()
            .await
            .resolve_promoted_thread_id(&thread_id);

        let current = self
            .resolve_thread_workspace(&thread_id, device_id.as_deref())
            .await
            .map_err(ThreadWorkspaceError::into_message)?;

        let pin = match non_empty(input.cwd) {
            None => None,
            Some(requested) => {
                // Store git's spelling, not the caller's string.
                let matched = current
                    .roots
                    .iter()
                    .find(|root| paths_equivalent(&root.path, &requested))
                    .ok_or_else(|| {
                        format!(
                            "{requested} is not one of this session's working trees; pick one \
of the trees the relay listed for it"
                        )
                    })?;
                // Scope is the actual boundary.
                let (device_scope, allowed_roots) = {
                    let relay = self.relay.read().await;
                    (
                        device_id
                            .as_deref()
                            .map(|id| relay.device_path_scope(id))
                            .unwrap_or_default(),
                        relay.allowed_roots.clone(),
                    )
                };
                ensure_path_within_device_scope(&matched.path, &device_scope, &allowed_roots)?;
                Some(matched.path.clone())
            }
        };

        {
            let mut relay = self.relay.write().await;
            if relay.set_thread_workspace(&thread_id, pin.as_deref()) {
                relay.push_log(
                    "info",
                    match pin.as_deref() {
                        Some(path) => format!(
                            "Session {thread_id}: working tree pinned to {path} by {}.",
                            short_device_id(device_id.as_deref().unwrap_or("local operator"))
                        ),
                        None => format!(
                            "Session {thread_id}: working tree un-pinned by {}.",
                            short_device_id(device_id.as_deref().unwrap_or("local operator"))
                        ),
                    },
                );
                relay.notify();
            }
        }

        self.resolve_thread_workspace(&thread_id, device_id.as_deref())
            .await
            .map_err(ThreadWorkspaceError::into_message)
    }
}

/// Unresolvable ≠ out of scope: the former is "unavailable", the latter is a refusal.
#[derive(Debug, Clone)]
pub(crate) enum ThreadWorkspaceError {
    /// No thread, no cwd, or nothing related to a vanished one survives.
    Unresolvable(String),
    /// The caller may not see this workspace.
    OutOfScope(String),
}

impl ThreadWorkspaceError {
    pub(crate) fn into_message(self) -> String {
        match self {
            Self::Unresolvable(message) | Self::OutOfScope(message) => message,
        }
    }
}

/// Landed write paths from the newest live record, plus that record's clock.
fn thread_write_evidence(transcript: &[crate::state::relay::TranscriptRecord]) -> WriteEvidence {
    let landed = |record: &crate::state::relay::TranscriptRecord| {
        record
            .tool
            .as_ref()
            .map(|tool| landed_write_paths(std::iter::once((tool, record.status.as_str()))))
            .unwrap_or_default()
    };
    let collect = |records: &[&crate::state::relay::TranscriptRecord]| {
        let mut best: Option<&crate::state::relay::TranscriptRecord> = None;
        for record in records {
            let chunk = landed(record);
            if chunk.is_empty() {
                continue;
            }
            let take = match (
                best.and_then(|current| current.last_live_upsert_revision),
                record.last_live_upsert_revision,
            ) {
                (None, _) if best.is_none() => true,
                (None, Some(_)) => true,
                (Some(current), Some(seq)) => seq > current,
                (Some(_), None) | (None, None) => false,
            };
            if take {
                best = Some(record);
            }
        }
        match best {
            Some(record) => WriteEvidence {
                paths: landed(record),
                newest_seq: record.last_live_upsert_revision,
            },
            None => WriteEvidence::default(),
        }
    };
    let recent: Vec<_> = transcript
        .iter()
        .rev()
        .take(WRITE_EVIDENCE_SCAN_LIMIT)
        .collect();
    let recent = collect(&recent);
    if !recent.paths.is_empty() {
        return recent;
    }
    let older: Vec<_> = transcript
        .iter()
        .rev()
        .skip(WRITE_EVIDENCE_SCAN_LIMIT)
        .take(WRITE_EVIDENCE_SCAN_LIMIT)
        .collect();
    collect(&older)
}

#[derive(Clone, Default)]
struct WriteEvidence {
    paths: Vec<String>,
    newest_seq: Option<u64>,
}
