use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::sync::Mutex;

use super::Session;

pub(super) const MAX_IDLE_PROCESSES: usize = 8;
const IDLE_TTL: Duration = Duration::from_secs(10 * 60);

pub(super) async fn reap(
    sessions: &Mutex<HashMap<String, Arc<Session>>>,
    keep: usize,
    ttl: Duration,
) {
    let candidates: Vec<_> = sessions.lock().await.values().cloned().collect();
    let mut ordered = Vec::new();
    for session in candidates {
        let last_used = session.runtime.lock().await.last_used;
        ordered.push((last_used, session));
    }
    ordered.sort_by_key(|(time, _)| *time);
    let mut remaining = ordered.len();
    for (last_used, session) in ordered {
        let expired = last_used.is_some_and(|time| time.elapsed() >= ttl);
        let closed = session
            .connection
            .closed
            .load(std::sync::atomic::Ordering::Acquire);
        if remaining <= keep && !expired && !closed {
            continue;
        }
        let Ok(_operation) = session.operation.try_lock() else {
            continue;
        };
        let runtime = session.runtime.lock().await;
        if runtime.turn.is_some() || !runtime.dialogs.is_empty() {
            continue;
        }
        let mut cache = sessions.lock().await;
        if Arc::strong_count(&session) > 2 {
            continue;
        }
        cache.remove(&session.record.id);
        drop(cache);
        drop(runtime);
        session.close().await;
        remaining -= 1;
        tracing::debug!(session = %session.record.id, "Reaped idle Pi process");
    }
}

pub(super) fn spawn(sessions: &Arc<Mutex<HashMap<String, Arc<Session>>>>, attach: &Arc<Mutex<()>>) {
    let sessions = Arc::downgrade(sessions);
    let attach = Arc::downgrade(attach);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let (Some(sessions), Some(attach)) = (sessions.upgrade(), attach.upgrade()) else {
                break;
            };
            let _attach = attach.lock().await;
            reap(&sessions, MAX_IDLE_PROCESSES, IDLE_TTL).await;
        }
    });
}
