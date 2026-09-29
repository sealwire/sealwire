//! Handover, review and delegate marks: which user rows were sent on the person's behalf.
//!
//! Best-effort like the rest of the store: a failed write costs a card, never a turn.

use rusqlite::{params, Connection};
use tracing::warn;

use crate::state::{
    injection_kind_from_name, injection_kind_name, DelegateMark, HandoverMark, InjectedMessage,
    InjectionTag, MessageAnchor, ReviewMark,
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

    pub(crate) fn save_review_mark(&self, review: &ReviewMark) {
        let body = match serde_json::to_string(review) {
            Ok(body) => body,
            Err(error) => {
                warn!(%error, "database: could not encode review {}", review.id);
                return;
            }
        };
        self.with_conn("save review", |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO review (id, body, updated_at) VALUES (?1, ?2, ?3)",
                params![review.id, body, review.updated_at as i64],
            )
        });
    }

    pub(crate) fn save_delegate_mark(&self, delegate: &DelegateMark) {
        let body = match serde_json::to_string(delegate) {
            Ok(body) => body,
            Err(error) => {
                warn!(%error, "database: could not encode delegate {}", delegate.id);
                return;
            }
        };
        self.with_conn("save delegate", |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO delegation (id, body, updated_at) VALUES (?1, ?2, ?3)",
                params![delegate.id, body, delegate.updated_at as i64],
            )
        });
    }

    pub(crate) fn record_injected_message(&self, message: &InjectedMessage) {
        self.with_conn("record injected message", |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO injected_message (thread_id, anchor, kind, ref_id,
                     round, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    message.thread_id,
                    message.anchor.encode(),
                    injection_kind_name(message.tag.kind),
                    message.tag.ref_id,
                    message.tag.round,
                    message.created_at as i64,
                ],
            )
        });
    }

    /// Everything recorded, after failing any handover or review the last run left
    /// under way: nothing drives one across a restart.
    pub(crate) fn load_injections(&self, restart_reason: &str) -> LoadedInjections {
        let loaded = self.with_conn("load injections", |conn| {
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
            let reviews = conn
                .prepare("SELECT id, body FROM review ORDER BY updated_at, id")?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter_map(
                    |(id, body)| match serde_json::from_str::<ReviewMark>(&body) {
                        Ok(review) => Some(review),
                        Err(error) => {
                            warn!(%error, "database: skipping unreadable review {id}");
                            None
                        }
                    },
                )
                .collect();
            let delegates = conn
                .prepare("SELECT id, body FROM delegation ORDER BY updated_at, id")?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter_map(
                    |(id, body)| match serde_json::from_str::<DelegateMark>(&body) {
                        Ok(delegate) => Some(delegate),
                        Err(error) => {
                            warn!(%error, "database: skipping unreadable delegate {id}");
                            None
                        }
                    },
                )
                .collect();
            let messages = conn
                .prepare(
                    "SELECT thread_id, anchor, kind, ref_id, round, created_at
                     FROM injected_message ORDER BY created_at, thread_id",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, u32>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter_map(|(thread_id, anchor, kind, ref_id, round, created_at)| {
                    Some(InjectedMessage {
                        thread_id,
                        anchor: MessageAnchor::decode(&anchor)?,
                        tag: InjectionTag {
                            kind: injection_kind_from_name(&kind)?,
                            ref_id,
                            round,
                        },
                        created_at: created_at as u64,
                    })
                })
                .collect();
            Ok(LoadedInjections {
                handovers,
                reviews,
                delegates,
                messages,
            })
        });
        let mut loaded = loaded.unwrap_or_default();
        let mut ended_undelivered = Vec::new();
        for review in loaded
            .reviews
            .iter_mut()
            .filter(|review| !review.is_settled())
        {
            review.status = "failed".to_string();
            review.error = Some(restart_reason.to_string());
            self.save_review_mark(review);
            if !review.rounds.iter().any(|round| round.delivered) {
                ended_undelivered.push(review.id.clone());
            }
        }
        // An ask with a peer survives a restart and its sweep settles the card; one that
        // never got a peer is failed on the way in (`restored_asks`), and so is its card.
        for delegate in loaded
            .delegates
            .iter_mut()
            .filter(|delegate| !delegate.is_settled() && delegate.peer_thread_id.is_empty())
        {
            delegate.status = "failed".to_string();
            delegate.error = Some(restart_reason.to_string());
            self.save_delegate_mark(delegate);
        }
        // Same as a live one ending with nothing handed back: the card it took up asks again.
        for review in loaded.reviews.iter_mut().filter(|review| {
            review
                .continued_by
                .as_ref()
                .is_some_and(|by| ended_undelivered.contains(by))
        }) {
            review.decision = None;
            review.continued_by = None;
            self.save_review_mark(review);
        }
        loaded
    }

    pub(crate) fn forget_mark(&self, ref_id: &str) {
        self.with_conn("forget mark", |conn| {
            conn.execute("DELETE FROM handover WHERE id = ?1", [ref_id])?;
            conn.execute("DELETE FROM review WHERE id = ?1", [ref_id])?;
            conn.execute("DELETE FROM delegation WHERE id = ?1", [ref_id])
        });
    }

    /// `orphaned`: the marks only this thread's rows carried.
    pub(crate) fn forget_thread_injections(&self, thread_id: &str, orphaned: &[String]) {
        self.with_conn("forget thread injections", |conn| {
            conn.execute(
                "DELETE FROM injected_message WHERE thread_id = ?1",
                [thread_id],
            )
        });
        for id in orphaned {
            self.forget_mark(id);
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct LoadedInjections {
    pub(crate) handovers: Vec<HandoverMark>,
    pub(crate) reviews: Vec<ReviewMark>,
    pub(crate) delegates: Vec<DelegateMark>,
    pub(crate) messages: Vec<InjectedMessage>,
}
