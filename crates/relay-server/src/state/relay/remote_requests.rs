//! Request sessions, their sequence windows, and the write ledger. The ledger is separate
//! from the result cache so that evicting a reply can never make a write run twice.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, OnceLock};

use rand::RngCore;

use super::{
    remote_action_cache_key, CachedRemoteActionResult, CachedRemoteActionState, RelayState,
};
use crate::state::{RemoteActionWait, RemoteActionWaitSource};

/// How long after signing an attempt may still be accepted. Four times the phone's 15 s reply
/// deadline, and twice the 30 s a cold provider catalog may hold the surface's queue.
pub(crate) const REMOTE_REQUEST_MAX_AGE_MS: u64 = 60_000;
/// How far ahead of the relay clock a phone's estimate may run (clock rate drift).
pub(crate) const REMOTE_REQUEST_MAX_FUTURE_MS: u64 = 5_000;
/// Automatic retries of one write stop this long after its first attempt.
pub(crate) const WRITE_RETRY_WINDOW_MS: u64 = 5 * 60 * 1000;
const REQUEST_SEQ_WINDOW: u64 = 256;
const MAX_REQUEST_SESSIONS_PER_DEVICE: usize = 4;
const REQUEST_SESSION_TTL_MS: u64 = 60 * 60 * 1000;
/// Kept from completion. Longer than any retry can arrive: the retry window plus the
/// freshness and clock allowances.
const WRITE_RECORD_RETENTION_MS: u64 = 10 * 60 * 1000;
const MAX_WRITE_RECORDS_PER_DEVICE: usize = 256;
/// Starts the clock well above zero so `now - window` never saturates into a pass.
const RELAY_CLOCK_ORIGIN_MS: u64 = 1_000_000_000;

pub(crate) const REUSED_ACTION_ID_ERROR: &str =
    "this action id was already used for a different action; nothing was run";
pub(crate) const WRITE_LEDGER_FULL_ERROR: &str =
    "this device has too many recent changes still on record; wait a few minutes and try again";
pub(crate) const OPERATION_CLOCK_ERROR: &str =
    "this request says it started later than the relay's clock allows; nothing was run";

/// Identifies this relay process. A write first sent to another boot is never re-run.
pub(crate) fn relay_boot_id() -> &'static str {
    static BOOT: OnceLock<String> = OnceLock::new();
    BOOT.get_or_init(|| random_hex(16))
}

/// Milliseconds on this process's monotonic clock. Phones estimate it, never wall time.
pub(crate) fn relay_clock_ms() -> u64 {
    static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
    let origin = ORIGIN.get_or_init(std::time::Instant::now);
    RELAY_CLOCK_ORIGIN_MS.saturating_add(origin.elapsed().as_millis() as u64)
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, Clone)]
pub(crate) struct RequestSession {
    device_id: String,
    peer_id: String,
    opened_ms: u64,
    expires_ms: u64,
    high_seq: u64,
    used: BTreeSet<u64>,
}

impl RequestSession {
    fn seq_is_unused(&self, seq: u64) -> bool {
        if seq == 0 {
            return false;
        }
        if seq > self.high_seq {
            return true;
        }
        self.high_seq - seq < REQUEST_SEQ_WINDOW && !self.used.contains(&seq)
    }

    fn use_seq(&mut self, seq: u64) {
        self.used.insert(seq);
        self.high_seq = self.high_seq.max(seq);
        let floor = self.high_seq.saturating_sub(REQUEST_SEQ_WINDOW - 1);
        self.used = self.used.split_off(&floor);
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RequestSessionGrant {
    pub(crate) sid: String,
    pub(crate) boot_id: String,
    pub(crate) relay_ms: u64,
    pub(crate) expires_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RequestClass {
    /// Declared side-effect free: a retry may run it again under a new authorization.
    Read,
    /// Everything not declared read-only. Runs at most once per (device, action id).
    Write,
    /// Heartbeat and watch: idempotent, answered by nobody, tracked by nothing.
    Untracked,
}

/// One signed attempt, after its signature checked out.
pub(crate) struct SignedRequestFacts<'a> {
    pub(crate) device_id: &'a str,
    pub(crate) peer_id: &'a str,
    pub(crate) sid: &'a str,
    pub(crate) boot_id: &'a str,
    pub(crate) seq: u64,
    pub(crate) sent_ms: u64,
    pub(crate) action_id: &'a str,
    pub(crate) action_kind: &'a str,
    pub(crate) class: RequestClass,
    pub(crate) digest: &'a str,
    pub(crate) op_boot: &'a str,
    pub(crate) op_t0: u64,
}

/// Keeps completion of an older write from touching a new reservation after re-pairing.
#[derive(Debug, Clone)]
pub(crate) struct ReservationToken(Arc<tokio::sync::Notify>);

impl ReservationToken {
    fn holds(&self, finished: &Arc<tokio::sync::Notify>) -> bool {
        Arc::ptr_eq(&self.0, finished)
    }
}

#[derive(Debug)]
pub(crate) enum RequestAdmission {
    /// Genuinely the phone's, but its session or clock is not good here. Not run, seq
    /// untouched; the phone re-claims and sends the same operation again.
    Reauthorize,
    /// Already used, outside the window, or from a retired connection. Silent.
    Duplicate,
    Run,
    Execute(ReservationToken),
    Replay(CachedRemoteActionResult),
    InFlight(RemoteActionWait),
    /// The write ran; its reply is no longer kept.
    AlreadyCompleted,
    /// Sent to another boot, or older than the retry window with no record here.
    OutcomeUnknown,
    Refused(&'static str),
}

#[derive(Debug, Clone)]
struct WriteRecord {
    action_kind: String,
    digest: String,
    op_boot: String,
    op_t0: u64,
    state: WriteState,
}

#[derive(Debug, Clone)]
enum WriteState {
    Running {
        finished: Arc<tokio::sync::Notify>,
        waiters: u64,
    },
    Done {
        done_ms: u64,
        waiters: u64,
    },
}

pub(crate) enum WaitOutcome {
    Result(CachedRemoteActionResult),
    /// A write that ran; its reply is no longer kept.
    AlreadyCompleted,
    /// A later asker took over, or there is nothing to answer.
    Superseded,
}

#[derive(Debug, Default)]
pub(crate) struct RemoteRequestBook {
    sessions: HashMap<String, RequestSession>,
    writes: HashMap<String, HashMap<String, WriteRecord>>,
}

impl RemoteRequestBook {
    pub(crate) fn clear(&mut self) {
        self.sessions.clear();
        self.writes.clear();
    }

    fn prune_sessions(&mut self, now_ms: u64) {
        self.sessions
            .retain(|_, session| session.expires_ms > now_ms);
    }

    fn prune_writes(&mut self, device_id: &str, now_ms: u64) {
        if let Some(records) = self.writes.get_mut(device_id) {
            records.retain(|_, record| match record.state {
                WriteState::Running { .. } => true,
                WriteState::Done { done_ms, .. } => {
                    done_ms.saturating_add(WRITE_RECORD_RETENTION_MS) >= now_ms
                }
            });
        }
    }
}

impl RelayState {
    pub fn open_request_session(
        &mut self,
        device_id: &str,
        peer_id: &str,
        now_ms: u64,
        now_secs: u64,
    ) -> Result<RequestSessionGrant, String> {
        if !self.paired_devices.contains_key(device_id) {
            return Err("device is not paired".to_string());
        }
        let book = &mut self.remote_requests;
        book.prune_sessions(now_ms);
        book.sessions
            .retain(|_, session| session.device_id != device_id || session.peer_id != peer_id);
        loop {
            let oldest = book
                .sessions
                .iter()
                .filter(|(_, session)| session.device_id == device_id)
                .min_by_key(|(_, session)| session.opened_ms)
                .map(|(sid, _)| sid.clone());
            let count = book
                .sessions
                .values()
                .filter(|session| session.device_id == device_id)
                .count();
            match oldest {
                Some(sid) if count >= MAX_REQUEST_SESSIONS_PER_DEVICE => {
                    book.sessions.remove(&sid);
                }
                _ => break,
            }
        }
        let sid = random_hex(16);
        book.sessions.insert(
            sid.clone(),
            RequestSession {
                device_id: device_id.to_string(),
                peer_id: peer_id.to_string(),
                opened_ms: now_ms,
                expires_ms: now_ms.saturating_add(REQUEST_SESSION_TTL_MS),
                high_seq: 0,
                used: BTreeSet::new(),
            },
        );
        Ok(RequestSessionGrant {
            sid,
            boot_id: relay_boot_id().to_string(),
            relay_ms: now_ms,
            expires_at: now_secs.saturating_add(REQUEST_SESSION_TTL_MS / 1000),
        })
    }

    /// A request session under a name the test chose, as a completed claim would open.
    #[cfg(test)]
    pub fn insert_request_session_for_test(&mut self, sid: &str, device_id: &str, peer_id: &str) {
        let now_ms = relay_clock_ms();
        self.remote_requests.sessions.insert(
            sid.to_string(),
            RequestSession {
                device_id: device_id.to_string(),
                peer_id: peer_id.to_string(),
                opened_ms: now_ms,
                expires_ms: now_ms.saturating_add(REQUEST_SESSION_TTL_MS),
                high_seq: 0,
                used: BTreeSet::new(),
            },
        );
    }

    /// What the hour running out does to a session, without waiting for it.
    #[cfg(test)]
    pub fn expire_request_session_for_test(&mut self, sid: &str) {
        if let Some(session) = self.remote_requests.sessions.get_mut(sid) {
            session.expires_ms = relay_clock_ms().saturating_sub(1);
        }
    }

    pub fn drop_request_sessions_for_peer(&mut self, peer_id: &str) {
        self.remote_requests
            .sessions
            .retain(|_, session| session.peer_id != peer_id);
    }

    pub(super) fn drop_request_sessions_except_peers(
        &mut self,
        online: &std::collections::HashSet<String>,
    ) {
        self.remote_requests
            .sessions
            .retain(|_, session| online.contains(&session.peer_id));
    }

    pub(super) fn forget_remote_requests_for_device(&mut self, device_id: &str) {
        self.remote_requests
            .sessions
            .retain(|_, session| session.device_id != device_id);
        if let Some(records) = self.remote_requests.writes.remove(device_id) {
            for record in records.into_values() {
                if let WriteState::Running { finished, .. } = record.state {
                    finished.notify_waiters();
                }
            }
        }
    }

    /// Session, clock, sequence, and the action's own record, in one critical section.
    /// Nothing is consumed unless the attempt gets an answer.
    pub(crate) fn admit_signed_request(
        &mut self,
        facts: &SignedRequestFacts<'_>,
        now_ms: u64,
        now_secs: u64,
    ) -> RequestAdmission {
        self.remote_requests.prune_sessions(now_ms);
        let session_matches = self
            .remote_requests
            .sessions
            .get(facts.sid)
            .is_some_and(|session| {
                session.device_id == facts.device_id && session.peer_id == facts.peer_id
            });
        if !session_matches
            || facts.boot_id != relay_boot_id()
            || !self.paired_devices.contains_key(facts.device_id)
        {
            return RequestAdmission::Reauthorize;
        }
        if facts.sent_ms.saturating_add(REMOTE_REQUEST_MAX_AGE_MS) < now_ms
            || facts.sent_ms > now_ms.saturating_add(REMOTE_REQUEST_MAX_FUTURE_MS)
        {
            return RequestAdmission::Reauthorize;
        }
        if !self.remote_requests.sessions[facts.sid].seq_is_unused(facts.seq) {
            return RequestAdmission::Duplicate;
        }
        let decision = self.admit_operation(facts, now_ms, now_secs);
        if let Some(session) = self.remote_requests.sessions.get_mut(facts.sid) {
            session.use_seq(facts.seq);
        }
        decision
    }

    fn admit_operation(
        &mut self,
        facts: &SignedRequestFacts<'_>,
        now_ms: u64,
        now_secs: u64,
    ) -> RequestAdmission {
        match facts.class {
            RequestClass::Untracked => RequestAdmission::Run,
            RequestClass::Read => match self.reserve_remote_action_with_digest(
                facts.device_id,
                facts.action_id,
                facts.action_kind,
                facts.digest,
                now_secs,
            ) {
                Ok(crate::state::RemoteActionReplayDecision::Execute) => {
                    match self
                        .recent_remote_actions
                        .get(&remote_action_cache_key(facts.device_id, facts.action_id))
                    {
                        Some(CachedRemoteActionState::InFlight { finished, .. }) => {
                            RequestAdmission::Execute(ReservationToken(Arc::clone(finished)))
                        }
                        _ => RequestAdmission::Refused(REUSED_ACTION_ID_ERROR),
                    }
                }
                Ok(crate::state::RemoteActionReplayDecision::Replay(result)) => {
                    RequestAdmission::Replay(result)
                }
                Ok(crate::state::RemoteActionReplayDecision::InFlight(wait)) => {
                    RequestAdmission::InFlight(wait)
                }
                Err(_) => RequestAdmission::Refused(REUSED_ACTION_ID_ERROR),
            },
            RequestClass::Write => self.admit_write(facts, now_ms),
        }
    }

    fn admit_write(&mut self, facts: &SignedRequestFacts<'_>, now_ms: u64) -> RequestAdmission {
        if facts.op_boot != relay_boot_id() {
            return RequestAdmission::OutcomeUnknown;
        }
        // Not `op_t0 <= sent_ms`: a retry signed after a re-claim counts from a new clock
        // estimate, which may sit a little behind the one the first attempt used.
        if facts.op_t0 > now_ms.saturating_add(REMOTE_REQUEST_MAX_FUTURE_MS) {
            return RequestAdmission::Refused(OPERATION_CLOCK_ERROR);
        }
        self.remote_requests.prune_writes(facts.device_id, now_ms);
        let cache_key = remote_action_cache_key(facts.device_id, facts.action_id);
        let records = self
            .remote_requests
            .writes
            .entry(facts.device_id.to_string())
            .or_default();
        if let Some(record) = records.get_mut(facts.action_id) {
            if record.action_kind != facts.action_kind
                || record.digest != facts.digest
                || record.op_boot != facts.op_boot
                || record.op_t0 != facts.op_t0
            {
                return RequestAdmission::Refused(REUSED_ACTION_ID_ERROR);
            }
            return match &mut record.state {
                WriteState::Running { finished, waiters } => {
                    *waiters += 1;
                    RequestAdmission::InFlight(RemoteActionWait {
                        finished: Arc::clone(finished),
                        ticket: *waiters,
                        source: RemoteActionWaitSource::WriteLedger,
                    })
                }
                WriteState::Done { .. } => match self.recent_remote_actions.get(&cache_key) {
                    Some(CachedRemoteActionState::Completed { result, .. })
                        if result.action_kind == facts.action_kind =>
                    {
                        RequestAdmission::Replay(result.clone())
                    }
                    _ => RequestAdmission::AlreadyCompleted,
                },
            };
        }
        if now_ms.saturating_sub(facts.op_t0) > WRITE_RETRY_WINDOW_MS {
            return RequestAdmission::OutcomeUnknown;
        }
        if records.len() >= MAX_WRITE_RECORDS_PER_DEVICE {
            return RequestAdmission::Refused(WRITE_LEDGER_FULL_ERROR);
        }
        let finished = Arc::new(tokio::sync::Notify::new());
        records.insert(
            facts.action_id.to_string(),
            WriteRecord {
                action_kind: facts.action_kind.to_string(),
                digest: facts.digest.to_string(),
                op_boot: facts.op_boot.to_string(),
                op_t0: facts.op_t0,
                state: WriteState::Running {
                    finished: Arc::clone(&finished),
                    waiters: 0,
                },
            },
        );
        RequestAdmission::Execute(ReservationToken(finished))
    }

    pub(crate) fn complete_remote_write(
        &mut self,
        device_id: &str,
        action_id: &str,
        token: &ReservationToken,
        result: CachedRemoteActionResult,
        now_secs: u64,
        now_ms: u64,
    ) {
        let Some(record) = self
            .remote_requests
            .writes
            .get_mut(device_id)
            .and_then(|records| records.get_mut(action_id))
        else {
            tracing::warn!(action_id, "a finished write no longer had its reservation");
            return;
        };
        let WriteState::Running { finished, waiters } = &record.state else {
            return;
        };
        if !token.holds(finished) {
            tracing::warn!(
                action_id,
                "a finished write found another attempt's reservation"
            );
            return;
        }
        let waiters = *waiters;
        record.state = WriteState::Done {
            done_ms: now_ms,
            waiters,
        };
        self.store_remote_action_result(device_id, action_id, result, now_secs);
        token.0.notify_waiters();
    }

    #[cfg(test)]
    pub fn remote_write_waiter_is_current(
        &self,
        device_id: &str,
        action_id: &str,
        ticket: u64,
    ) -> bool {
        match self
            .remote_requests
            .writes
            .get(device_id)
            .and_then(|records| records.get(action_id))
            .map(|record| &record.state)
        {
            Some(WriteState::Running { waiters, .. } | WriteState::Done { waiters, .. }) => {
                *waiters == ticket
            }
            None => false,
        }
    }

    /// What a waiter on the write ledger learns once woken, read in one look.
    pub(crate) fn remote_write_wait_outcome(
        &self,
        device_id: &str,
        action_id: &str,
        ticket: u64,
    ) -> WaitOutcome {
        let Some(record) = self
            .remote_requests
            .writes
            .get(device_id)
            .and_then(|records| records.get(action_id))
        else {
            return WaitOutcome::Superseded;
        };
        match record.state {
            WriteState::Done { waiters, .. } if waiters == ticket => {
                match self.completed_remote_action(device_id, action_id) {
                    Some(result) => WaitOutcome::Result(result),
                    None => WaitOutcome::AlreadyCompleted,
                }
            }
            _ => WaitOutcome::Superseded,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{PairedDevice, SecurityProfile};

    fn relay_with_phone() -> RelayState {
        let (change_tx, _) = tokio::sync::watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp/remote-requests-test".to_string(),
            change_tx,
            SecurityProfile::private(),
        );
        relay.paired_devices.insert(
            "phone".to_string(),
            PairedDevice {
                device_id: "phone".to_string(),
                label: "phone".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: "key".to_string(),
                created_at: 1,
                last_seen_at: None,
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
                pairing_broker: None,
            },
        );
        relay
    }

    fn facts<'a>(
        sid: &'a str,
        seq: u64,
        sent_ms: u64,
        action_id: &'a str,
        class: RequestClass,
    ) -> SignedRequestFacts<'a> {
        SignedRequestFacts {
            device_id: "phone",
            peer_id: "peer",
            sid,
            boot_id: relay_boot_id(),
            seq,
            sent_ms,
            action_id,
            action_kind: "start_session",
            class,
            digest: "digest",
            op_boot: relay_boot_id(),
            op_t0: sent_ms,
        }
    }

    #[test]
    fn a_full_write_ledger_refuses_new_writes_and_keeps_every_record() {
        let mut relay = relay_with_phone();
        let now = relay_clock_ms();
        let sid = relay
            .open_request_session("phone", "peer", now, 1)
            .unwrap()
            .sid;
        let ids: Vec<String> = (0..MAX_WRITE_RECORDS_PER_DEVICE)
            .map(|index| format!("write-{index}"))
            .collect();
        for (index, id) in ids.iter().enumerate() {
            assert!(matches!(
                relay.admit_signed_request(
                    &facts(&sid, index as u64 + 1, now, id, RequestClass::Write),
                    now,
                    1
                ),
                RequestAdmission::Execute(_)
            ));
        }
        assert!(matches!(
            relay.admit_signed_request(
                &facts(&sid, 1_000, now, "write-new", RequestClass::Write),
                now,
                1
            ),
            RequestAdmission::Refused(WRITE_LEDGER_FULL_ERROR)
        ));
        // The oldest is still on record: a retry of it waits, it does not run again.
        assert!(matches!(
            relay.admit_signed_request(
                &facts(&sid, 1_001, now, "write-0", RequestClass::Write),
                now,
                1
            ),
            RequestAdmission::InFlight(_)
        ));
        // Reads are not writes and are not held back by the ledger.
        assert!(matches!(
            relay.admit_signed_request(
                &facts(&sid, 1_002, now, "read", RequestClass::Read),
                now,
                1
            ),
            RequestAdmission::Execute(_)
        ));
    }

    #[test]
    fn only_an_answered_attempt_spends_its_sequence_number() {
        let mut relay = relay_with_phone();
        let now = relay_clock_ms();
        let sid = relay
            .open_request_session("phone", "peer", now, 1)
            .unwrap()
            .sid;
        let stale = facts(
            &sid,
            1,
            now - REMOTE_REQUEST_MAX_AGE_MS - 1,
            "a",
            RequestClass::Read,
        );
        assert!(matches!(
            relay.admit_signed_request(&stale, now, 1),
            RequestAdmission::Reauthorize
        ));
        let fresh = facts(&sid, 1, now, "a", RequestClass::Read);
        assert!(matches!(
            relay.admit_signed_request(&fresh, now, 1),
            RequestAdmission::Execute(_)
        ));
        assert!(matches!(
            relay.admit_signed_request(&fresh, now, 1),
            RequestAdmission::Duplicate
        ));
        let mut other_peer = facts(&sid, 2, now, "b", RequestClass::Read);
        other_peer.peer_id = "elsewhere";
        assert!(matches!(
            relay.admit_signed_request(&other_peer, now, 1),
            RequestAdmission::Reauthorize
        ));
        assert!(matches!(
            relay.admit_signed_request(&facts(&sid, 2, now, "b", RequestClass::Read), now, 1),
            RequestAdmission::Execute(_)
        ));
    }

    #[test]
    fn a_write_with_an_operation_clock_too_far_ahead_is_refused() {
        let mut relay = relay_with_phone();
        let now = relay_clock_ms();
        let sid = relay
            .open_request_session("phone", "peer", now, 1)
            .unwrap()
            .sid;
        let mut ahead = facts(&sid, 1, now, "x", RequestClass::Write);
        ahead.op_t0 = now + REMOTE_REQUEST_MAX_FUTURE_MS + 1;
        assert!(matches!(
            relay.admit_signed_request(&ahead, now, 1),
            RequestAdmission::Refused(OPERATION_CLOCK_ERROR)
        ));
    }

    #[test]
    fn an_old_completion_cannot_overwrite_a_repaired_devices_reservation() {
        let mut relay = relay_with_phone();
        let now = relay_clock_ms();
        let sid = relay
            .open_request_session("phone", "peer", now, 1)
            .unwrap()
            .sid;
        let RequestAdmission::Execute(first) =
            relay.admit_signed_request(&facts(&sid, 1, now, "w", RequestClass::Write), now, 1)
        else {
            panic!("the first attempt reserves the write");
        };
        let device = relay.paired_devices["phone"].clone();
        assert!(relay.revoke_paired_device("phone", 1));
        relay.paired_devices.insert("phone".to_string(), device);
        let sid = relay
            .open_request_session("phone", "peer", now, 1)
            .unwrap()
            .sid;
        let RequestAdmission::Execute(second) =
            relay.admit_signed_request(&facts(&sid, 1, now, "w", RequestClass::Write), now, 1)
        else {
            panic!("the paired device reserves a new write");
        };
        relay.complete_remote_write("phone", "w", &first, cached_result(), 1, now);
        assert!(matches!(
            relay.admit_signed_request(&facts(&sid, 2, now, "w", RequestClass::Write), now, 1),
            RequestAdmission::InFlight(_)
        ));
        relay.complete_remote_write("phone", "w", &second, cached_result(), 1, now);
        assert!(matches!(
            relay.admit_signed_request(&facts(&sid, 3, now, "w", RequestClass::Write), now, 1),
            RequestAdmission::Replay(_)
        ));
    }

    #[test]
    fn admission_requires_the_signing_session_to_be_current_and_unexpired() {
        let mut relay = relay_with_phone();
        let now = relay_clock_ms();
        let old = relay
            .open_request_session("phone", "peer", now, 1)
            .unwrap()
            .sid;
        let newer = relay
            .open_request_session("phone", "peer", now, 1)
            .unwrap()
            .sid;
        assert!(matches!(
            relay.admit_signed_request(&facts(&old, 1, now, "old", RequestClass::Read), now, 1),
            RequestAdmission::Reauthorize
        ));
        assert!(matches!(
            relay.admit_signed_request(&facts(&newer, 1, now, "new", RequestClass::Read), now, 1),
            RequestAdmission::Execute(_)
        ));
        relay.expire_request_session_for_test(&newer);
        assert!(matches!(
            relay.admit_signed_request(
                &facts(&newer, 2, now, "expired", RequestClass::Read),
                now,
                1
            ),
            RequestAdmission::Reauthorize
        ));
    }

    fn cached_result() -> CachedRemoteActionResult {
        CachedRemoteActionResult {
            action_kind: "start_session".to_string(),
            ok: true,
            snapshot: None,
            receipt: None,
            ask_user_answer_receipt: None,
            providers: None,
            models: None,
            threads: None,
            thread_entry_detail: None,
            thread_transcript: None,
            workspace_diff: None,
            workspace_git_context: None,
            thread_workspace: None,
            thread_settings: None,
            thread_skills: None,
            reviews: None,
            workflows: None,
            devices: None,
            projects: None,
            ask_user_question_detail: None,
            ask_detail: None,
            session_claim: None,
            session_claim_expires_at: None,
            session_claim_boot: None,
            session_claim_relay_ms: None,
            claim_challenge_id: None,
            claim_challenge: None,
            claim_challenge_expires_at: None,
            response_secret: None,
            error: None,
            error_code: None,
        }
    }

    #[test]
    fn sessions_are_capped_per_device_and_end_with_their_peer_or_device() {
        let mut relay = relay_with_phone();
        let now = relay_clock_ms();
        let sids: Vec<String> = (0..5)
            .map(|index| {
                relay
                    .open_request_session("phone", &format!("peer-{index}"), now + index, 1)
                    .unwrap()
                    .sid
            })
            .collect();
        assert_eq!(
            relay.remote_requests.sessions.len(),
            MAX_REQUEST_SESSIONS_PER_DEVICE
        );
        assert!(
            !relay.remote_requests.sessions.contains_key(&sids[0]),
            "oldest went first"
        );
        let replaced = relay
            .open_request_session("phone", "peer-4", now + 9, 1)
            .unwrap();
        assert!(!relay.remote_requests.sessions.contains_key(&sids[4]));
        assert!(relay.remote_requests.sessions.contains_key(&replaced.sid));
        relay.drop_request_sessions_for_peer("peer-4");
        assert!(!relay.remote_requests.sessions.contains_key(&replaced.sid));
        assert!(relay.remote_requests.sessions.contains_key(&sids[3]));
        assert!(relay.revoke_paired_device("phone", 1));
        assert!(relay.remote_requests.sessions.is_empty());
        assert!(relay
            .open_request_session("phone", "peer-3", now, 1)
            .is_err());
    }

    #[test]
    fn the_sequence_window_refuses_reuse_and_anything_older_than_256() {
        let mut session = RequestSession {
            device_id: "d".into(),
            peer_id: "p".into(),
            opened_ms: 0,
            expires_ms: u64::MAX,
            high_seq: 0,
            used: BTreeSet::new(),
        };
        assert!(!session.seq_is_unused(0));
        session.use_seq(5);
        assert!(!session.seq_is_unused(5));
        assert!(
            session.seq_is_unused(4),
            "out of order but inside the window"
        );
        session.use_seq(300);
        assert!(
            !session.seq_is_unused(44),
            "300 - 44 = 256 is outside the window"
        );
        assert!(session.seq_is_unused(45));
        assert!(!session.seq_is_unused(5));
        session.use_seq(45);
        assert!(!session.seq_is_unused(45));
        assert!(session.used.len() <= REQUEST_SEQ_WINDOW as usize);
        for seq in 301..2_000 {
            session.use_seq(seq);
        }
        assert!(session.used.len() <= REQUEST_SEQ_WINDOW as usize);
    }
}
