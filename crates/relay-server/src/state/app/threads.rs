use super::*;

impl AppState {
    pub async fn list_threads(
        &self,
        limit: usize,
        device_id: Option<String>,
    ) -> Result<ThreadsResponse, String> {
        let mut all_threads = Vec::new();
        for (provider_name, bridge) in &self.providers {
            match bridge.list_threads(limit).await {
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
        let mut threads = relay
            .filter_deleted_threads(all_threads)
            .into_iter()
            .filter(|thread| path_within_device_scope(&thread.cwd, &device_scope, &allowed_roots))
            .collect::<Vec<_>>();
        sort_threads_by_recency(&mut threads);
        threads.truncate(limit);
        let response_threads = threads.clone();
        relay.threads = threads;
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

    pub async fn archive_thread(&self, thread_id: &str) -> Result<ThreadArchiveReceipt, String> {
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

        let _ = self.list_threads(20, None).await;

        Ok(ThreadArchiveReceipt {
            thread_id: thread_id.to_string(),
            message: "Session archived and removed from local history.".to_string(),
        })
    }

    pub async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<ThreadDeleteReceipt, String> {
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
