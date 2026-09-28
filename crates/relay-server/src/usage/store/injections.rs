//! Handover marks: which user rows were sent on the person's behalf.
//!
//! Best-effort like the rest of the store: a failed write costs a card, never a turn.

use rusqlite::{params, Connection};
use tracing::warn;

use crate::state::{
    injection_kind_from_name, injection_kind_name, HandoverMark, InjectedMessage, MessageAnchor,
};

use super::UsageStore;

impl UsageStore {
    fn with_conn<T>(
        &self,
        what: &str,
        run: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Option<T> {
        let conn = self.conn.as_ref()?;
        let Ok(conn) = conn.lock() else {
            warn!("database mutex poisoned; skipping {what}");
            return None;
        };
        run(&conn)
            .map_err(|error| warn!(%error, "database: {what} failed"))
            .ok()
    }

    pub(crate) fn save_handover_mark(&self, handover: &HandoverMark) {
        self.with_conn("save handover", |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO handover (id, source_thread_id, target_thread_id,
                     source_provider, target_provider, note, instruction, status, error,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    handover.id,
                    handover.source_thread_id,
                    handover.target_thread_id,
                    handover.source_provider,
                    handover.target_provider,
                    handover.note,
                    handover.instruction,
                    handover.status,
                    handover.error,
                    handover.created_at as i64,
                    handover.updated_at as i64,
                ],
            )
        });
    }

    pub(crate) fn record_injected_message(&self, message: &InjectedMessage) {
        self.with_conn("record injected message", |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO injected_message (thread_id, anchor, kind, handover_id,
                     created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    message.thread_id,
                    message.anchor.encode(),
                    injection_kind_name(message.kind),
                    message.handover_id,
                    message.created_at as i64,
                ],
            )
        });
    }

    /// Everything recorded, after failing any handover the last run left under way:
    /// nothing drives one across a restart.
    pub(crate) fn load_injections(
        &self,
        restart_reason: &str,
    ) -> (Vec<HandoverMark>, Vec<InjectedMessage>) {
        self.with_conn("load injections", |conn| {
            conn.execute(
                "UPDATE handover SET status = 'failed', error = ?1 WHERE status = 'working'",
                [restart_reason],
            )?;
            let handovers = conn
                .prepare(
                    "SELECT id, source_thread_id, target_thread_id, source_provider,
                            target_provider, note, instruction, status, error, created_at,
                            updated_at
                     FROM handover ORDER BY created_at, id",
                )?
                .query_map([], |row| {
                    Ok(HandoverMark {
                        id: row.get(0)?,
                        source_thread_id: row.get(1)?,
                        target_thread_id: row.get(2)?,
                        source_provider: row.get(3)?,
                        target_provider: row.get(4)?,
                        note: row.get(5)?,
                        instruction: row.get(6)?,
                        status: row.get(7)?,
                        error: row.get(8)?,
                        created_at: row.get::<_, i64>(9)? as u64,
                        updated_at: row.get::<_, i64>(10)? as u64,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let messages = conn
                .prepare(
                    "SELECT thread_id, anchor, kind, handover_id, created_at
                     FROM injected_message ORDER BY created_at, thread_id",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter_map(|(thread_id, anchor, kind, handover_id, created_at)| {
                    Some(InjectedMessage {
                        thread_id,
                        anchor: MessageAnchor::decode(&anchor)?,
                        kind: injection_kind_from_name(&kind)?,
                        handover_id,
                        created_at: created_at as u64,
                    })
                })
                .collect();
            Ok((handovers, messages))
        })
        .unwrap_or_default()
    }

    pub(crate) fn forget_handover_mark(&self, handover_id: &str) {
        self.with_conn("forget handover", |conn| {
            conn.execute("DELETE FROM handover WHERE id = ?1", [handover_id])
        });
    }

    pub(crate) fn forget_thread_injections(&self, thread_id: &str) {
        self.with_conn("forget thread injections", |conn| {
            conn.execute(
                "DELETE FROM injected_message WHERE thread_id = ?1",
                [thread_id],
            )?;
            conn.execute(
                "DELETE FROM handover
                 WHERE id NOT IN (SELECT handover_id FROM injected_message)",
                [],
            )
        });
    }
}
