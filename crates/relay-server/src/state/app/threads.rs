use super::*;

impl AppState {
    pub async fn list_threads(
        &self,
        limit: usize,
        device_id: Option<String>,
    ) -> Result<ThreadsResponse, String> {
        // Read reviewer ids before the provider fetch so we can request a larger
        // page from each provider. If the newest N slots are all reviewer threads
        // we would return fewer than `limit` normal threads otherwise.
        let reviewer_count = {
            let relay = self.relay.read().await;
            relay.reviewer_thread_ids().len()
        };
        let fetch_limit = limit.saturating_add(reviewer_count);

        let mut all_threads = Vec::new();
        for (provider_name, bridge) in &self.providers {
            match bridge.list_threads(fetch_limit).await {
                Ok(mut threads) => {
                    for thread in &mut threads {
                        thread.provider = provider_name.clone();
                    }
                    all_threads.extend(threads);
                }
                Err(error) => {
                    self.push_runtime_log(
                        "warn",
                        format!("Failed to list {provider_name} threads: {error}"),
                    )
                    .await;
                }
            }
        }
        let mut relay = self.relay.write().await;
        let allowed_roots = relay.allowed_roots.clone();
        let device_scope = device_id
            .as_deref()
            .map(|id| relay.device_path_scope(id))
            .unwrap_or_default();
        for thread in &mut all_threads {
            if thread.cwd.is_empty() {
                if let Some(cwd) = relay.thread_cwd(&thread.id) {
                    thread.cwd = cwd;
                }
            }
        }
        // Reviewer threads are owned by their review (surfaced through the
        // Reviewer panel), not peer sessions — keep them out of the thread list
        // ENTIRELY, even while the reviewer is briefly the active thread during
        // the review handoff. The user should never see a transient reviewer
        // "conversation" pop into navigation; the review's status and result live
        // only in the Reviewer tab (which fetches the reviewer transcript by id
        // directly when you click in).
        let reviewer_ids = relay.reviewer_thread_ids();
        let mut threads = relay
            .filter_deleted_threads(all_threads)
            .into_iter()
            .filter(|thread| path_within_device_scope(&thread.cwd, &device_scope, &allowed_roots))
            .filter(|thread| !reviewer_ids.contains(&thread.id))
            .collect::<Vec<_>>();

        // Preserve the active thread even when no provider lists it yet. A
        // deferred-start Claude session lives under a synthetic `claude-pending-`
        // id until its first turn promotes it to a real SDK session, so the
        // bridge's `list_threads` can't return it. Without this, starting a blank
        // session (or any later thread-list refresh) would drop the conversation
        // the user is actively viewing — it would never appear in the sidebar.
        // ...but never re-add a reviewer thread: it must stay hidden from nav even
        // when it is the active thread mid-review.
        if let Some(active_id) = relay.active_thread_id.clone() {
            if !reviewer_ids.contains(&active_id)
                && !threads.iter().any(|thread| thread.id == active_id)
            {
                if let Some(active_thread) = relay
                    .threads
                    .iter()
                    .find(|thread| thread.id == active_id)
                    .filter(|thread| {
                        path_within_device_scope(&thread.cwd, &device_scope, &allowed_roots)
                    })
                    .cloned()
                {
                    threads.push(active_thread);
                }
            }
        }

        // Replace the provider's session-file mtime — which any resume/selection
        // bumps to ~now (a no-prompt click spins up a live SDK session that
        // rewrites the session file) — with our honest last-activity timestamp,
        // for both ordering AND the displayed "last message" time. Threads we've
        // never resumed aren't tracked and keep their (never-polluted) provider
        // value.
        for thread in &mut threads {
            thread.updated_at = relay.thread_last_activity_or(&thread.id, thread.updated_at);
            thread.forked_from = relay.thread_forked_from(&thread.id);
        }
        sort_threads_by_recency(&mut threads);
        threads.truncate(limit);
        let response_threads = threads.clone();

        // The routing cache (relay.threads) must retain reviewer-thread rows even
        // though they are filtered from the nav-visible response. `find_thread_provider`
        // looks up threads by id in this cache, and a synthetic `claude-pending-…`
        // reviewer is only there (not yet in the provider's own thread list), so
        // losing its row would make it unroutable for `send_message_to_thread`.
        // We preserve any reviewer rows that were already cached here.
        let retained_reviewer_rows: Vec<_> = relay
            .threads
            .iter()
            .filter(|cached| reviewer_ids.contains(&cached.id))
            .cloned()
            .collect();
        let mut cached_threads = response_threads.clone();
        cached_threads.extend(retained_reviewer_rows);
        relay.threads = cached_threads;

        relay.notify();
        Ok(ThreadsResponse {
            threads: response_threads,
        })
    }

    pub async fn update_allowed_roots(
        &self,
        input: AllowedRootsInput,
    ) -> Result<AllowedRootsReceipt, String> {
        let allowed_roots = normalize_allowed_roots(input.allowed_roots)?;
        let mut relay = self.relay.write().await;
        let changed = relay.set_allowed_roots(allowed_roots.clone());

        if changed {
            let current_cwd = relay.current_cwd.clone();
            relay.push_log(
                "info",
                if allowed_roots.is_empty() {
                    "Cleared relay workspace restrictions. Any workspace can be started or resumed."
                        .to_string()
                } else {
                    format!("Updated relay allowed roots: {}.", allowed_roots.join(", "))
                },
            );
            if relay.active_thread_id.is_some()
                && !path_within_allowed_roots(&current_cwd, &allowed_roots)
            {
                relay.push_log(
                    "warn",
                    format!(
                        "Current session workspace {} is outside the configured allowed roots. New sends, starts, and resumes will be blocked until you switch back to an allowed directory.",
                        current_cwd
                    ),
                );
            }
            relay.notify();
        }

        Ok(AllowedRootsReceipt {
            allowed_roots,
            message: if changed {
                "Relay workspace restrictions saved.".to_string()
            } else {
                "Relay workspace restrictions were already up to date.".to_string()
            },
        })
    }

    /// Archive a thread (soft remove from local history). If the thread is the
    /// PARENT of reviewer thread(s), `delete_reviewers` decides their fate:
    /// `Some(true)` → permanently delete them (reviewer threads have no "archived"
    /// state of their own); `Some(false)`/`None` → keep them as normal, un-hidden
    /// threads. Archive is a soft, non-destructive operation, so a bodyless request
    /// (no explicit choice) DEFAULTS TO KEEP — only an explicit `true` permanently
    /// deletes. Either way the reviewer is never left stranded (hidden, no UI entry).
    /// The frontend always sends an explicit choice when reviewers are present, so
    /// this default only governs non-UI/bodyless callers. (Permanent delete, by
    /// contrast, defaults to cascade-delete — see `delete_thread_permanently`.)
    pub async fn archive_thread(
        &self,
        thread_id: &str,
        delete_reviewers: Option<bool>,
    ) -> Result<ThreadArchiveReceipt, String> {
        let _slot = self.acquire_session_slot()?;
        {
            // Don't let a user archive a thread that a running review owns (its
            // parent or reviewer). Terminal-review cleanup (delete) is unaffected
            // because the job is terminal by then, so the thread is not locked.
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
        }
        let reviewer_threads = {
            let relay = self.relay.read().await;
            relay.reviewer_threads_of_parent(thread_id)
        };
        let archived_active_thread = {
            let relay = self.relay.read().await;
            relay.can_archive_thread(thread_id)?
        };

        self.find_thread_provider(thread_id)
            .await?
            .1
            .archive_thread(thread_id)
            .await?;

        {
            let mut relay = self.relay.write().await;
            let removed = relay.remove_thread(thread_id);
            // The thread is gone — stop hiding it as a reviewer thread (no-op if it
            // wasn't one).
            relay.forget_reviewer_thread(thread_id);
            if archived_active_thread {
                relay.clear_active_session();
            }
            relay.push_log(
                "info",
                if archived_active_thread {
                    format!("Archived active thread {thread_id} from local history and cleared the current session.")
                } else {
                    format!("Archived thread {thread_id} from local history.")
                },
            );
            if removed {
                relay.notify();
            }
        }

        let mut message = "Session archived and removed from local history.".to_string();
        if !reviewer_threads.is_empty() {
            // Non-destructive default: keep (un-hide) reviewers unless told to delete.
            let delete = delete_reviewers.unwrap_or(false);
            let kept = self
                .handle_parent_reviewer_threads(reviewer_threads, delete)
                .await;
            if kept > 0 {
                message.push_str(&format!(
                    " ({kept} reviewer thread{} could not be deleted and {} kept as normal threads)",
                    if kept == 1 { "" } else { "s" },
                    if kept == 1 { "was" } else { "were" },
                ));
            }
        }

        let _ = self.list_threads(20, None).await;

        Ok(ThreadArchiveReceipt {
            thread_id: thread_id.to_string(),
            message,
        })
    }

    /// Permanently delete a thread. If the thread is the PARENT of one or more
    /// (hidden) reviewer threads, `delete_reviewers` controls what happens to them:
    ///   - `Some(true)` / `None` (default): also delete each reviewer thread.
    ///   - `Some(false)`: keep them on disk but un-hide them — they become normal,
    ///     navigable threads.
    /// Either way, any in-memory review job that referenced a handled reviewer
    /// thread is dropped so the Reviewer panel can't show a card pointing at a
    /// deleted/promoted thread.
    pub async fn delete_thread_permanently(
        &self,
        thread_id: &str,
        delete_reviewers: Option<bool>,
    ) -> Result<ThreadDeleteReceipt, String> {
        let _slot = self.acquire_session_slot()?;
        {
            // Don't let a user delete a thread a running review owns. Terminal-
            // review cleanup (delete) is unaffected (job is terminal → not locked).
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
        }
        let reviewer_threads = {
            let relay = self.relay.read().await;
            relay.reviewer_threads_of_parent(thread_id)
        };

        // Delete the parent thread itself (no slot re-acquisition — we hold it).
        let mut receipt = self.delete_thread_inner(thread_id).await?;

        // Handle the parent's reviewer threads (delete or keep-as-normal).
        if !reviewer_threads.is_empty() {
            let delete = delete_reviewers.unwrap_or(true);
            let kept = self
                .handle_parent_reviewer_threads(reviewer_threads, delete)
                .await;
            let _ = self.list_threads(20, None).await;
            if kept > 0 {
                receipt.message.push_str(&format!(
                    " ({kept} reviewer thread{} could not be deleted and {} kept as normal threads)",
                    if kept == 1 { "" } else { "s" },
                    if kept == 1 { "was" } else { "were" },
                ));
            }
        }

        Ok(receipt)
    }

    /// Handle the reviewer threads owned by a parent that is being deleted or
    /// archived. `delete = true` permanently deletes each; `false` keeps them as
    /// normal (un-hidden) threads. A reviewer that CAN'T be deleted is un-hidden
    /// anyway, so it can never become a stranded, hidden, entryless thread — it
    /// becomes a normal thread the user can retry. Drops each handled reviewer's
    /// in-memory review job. Returns the number that could not be deleted (partial
    /// failure, only when `delete` is true).
    pub(super) async fn handle_parent_reviewer_threads(
        &self,
        reviewer_ids: Vec<String>,
        delete: bool,
    ) -> usize {
        let mut failed = 0usize;
        for reviewer_id in reviewer_ids {
            if delete {
                if let Err(error) = self.delete_thread_inner(&reviewer_id).await {
                    // Could not delete it — un-hide it rather than strand it.
                    self.push_runtime_log(
                        "warn",
                        format!(
                            "Could not delete reviewer thread {reviewer_id}: {error}; kept it as a \
normal thread instead."
                        ),
                    )
                    .await;
                    let mut relay = self.relay.write().await;
                    relay.forget_reviewer_thread(&reviewer_id);
                    relay.notify();
                    failed += 1;
                }
            } else {
                // Keep it, but stop hiding it: it becomes a normal, navigable thread.
                let mut relay = self.relay.write().await;
                relay.forget_reviewer_thread(&reviewer_id);
                relay.notify();
            }
            // Drop any stale in-memory review job referencing this reviewer.
            let mut relay = self.relay.write().await;
            relay.drop_review_jobs_for_reviewer(&reviewer_id);
            relay.drop_workflow_runs_for_reviewer(&reviewer_id);
            relay.notify();
        }
        failed
    }

    /// Core single-thread permanent delete (no session slot, no review-lock check,
    /// no reviewer-thread fan-out). Shared by `delete_thread_permanently` so it can
    /// delete the parent and each reviewer thread under one held slot.
    async fn delete_thread_inner(&self, thread_id: &str) -> Result<ThreadDeleteReceipt, String> {
        let deleted_active_thread = {
            let relay = self.relay.read().await;
            relay.can_delete_thread(thread_id)?
        };

        let delete_summary = self
            .find_thread_provider(thread_id)
            .await?
            .1
            .delete_thread_permanently(thread_id)
            .await?;

        {
            let mut relay = self.relay.write().await;
            if deleted_active_thread {
                relay.clear_active_session();
            }
            relay.mark_thread_deleted(thread_id);
            // The thread is gone — stop hiding it as a reviewer thread.
            relay.forget_reviewer_thread(thread_id);
            relay.push_log(
                "info",
                format!(
                    "{} local thread {thread_id} from provider storage ({} rollout file{} removed, provider row removed: {}).",
                    if deleted_active_thread {
                        "Permanently deleted active"
                    } else {
                        "Permanently deleted"
                    },
                    delete_summary.deleted_paths.len(),
                    if delete_summary.deleted_paths.len() == 1 { "" } else { "s" },
                    delete_summary.deleted_thread_row
                ),
            );
            relay.notify();
        }

        let _ = self.list_threads(20, None).await;

        Ok(ThreadDeleteReceipt {
            thread_id: thread_id.to_string(),
            message: if deleted_active_thread {
                "Active session permanently deleted from local provider storage.".to_string()
            } else {
                "Session permanently deleted from local provider storage.".to_string()
            },
        })
    }
}
