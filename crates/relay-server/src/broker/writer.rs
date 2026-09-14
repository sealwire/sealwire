//! The broker socket's write half, owned by its own task.
//!
//! # Why this exists
//!
//! The relay's broker session is one `tokio::select!` loop. Before this module, that
//! loop owned the `SplitSink` directly and every publish borrowed it `&mut`, which
//! meant *writing blocked reading*: the `incoming = receiver.next()` arm awaits
//! `handle_server_message(...)` inline, and a remote action's reply is published from
//! inside that handler.
//!
//! A large action reply is split into chunks paced
//! `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS` apart. A 21-chunk reply is
//! therefore ~5 seconds during which the relay read **nothing** from the broker: not
//! another surface's `fetch_thread_transcript`, not a `claim_challenge`, not even the
//! presence frame saying the surface it was answering had gone away. Users saw that as
//! "I clicked and nothing happened, then a while later everything arrived at once".
//!
//! # What it guarantees
//!
//! 1. **Handing off does not block on pacing.** The read loop enqueues a whole chunk
//!    train in one send and goes back to reading.
//! 2. **One big reply cannot monopolise the socket.** Ordinary traffic is a separate
//!    queue and goes out in a train's pacing gaps, so a snapshot or another surface's
//!    answer overtakes a 21-chunk train instead of waiting it out.
//! 3. **The backlog is bounded.** At most one train is resident in the writer and one
//!    more waits in its channel; a third makes the producer wait. That is deliberate
//!    backpressure — see `TRAIN_QUEUE_CAPACITY`.
//! 4. **The writer dies with its session.** The socket is the session, so the task is
//!    aborted when the session ends rather than being left to drain into a dead socket.

use std::collections::VecDeque;
use std::time::Duration;

use futures_util::{sink::SinkExt, stream::SplitSink};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use super::BrokerSocket;
use crate::state::AppState;

/// Ordinary frames queued for the socket. These are small and bounded individually
/// (snapshots and deltas are compacted to a byte budget before they get here), so a
/// deep queue costs little and keeps the read loop free.
const NOW_QUEUE_CAPACITY: usize = 512;

/// Chunk trains waiting to start.
///
/// One, on purpose. A train is a whole action reply — a workspace diff can be megabytes
/// across hundreds of ~32KiB chunks — and the writer emits only four chunks a second.
/// The pre-writer code published trains inline, which meant the relay could not accept
/// another action until the current reply had gone out: crude, but a real bound. Moving
/// the pacing off the read loop removed that bound, and an earlier revision of this
/// module replaced it with nothing: the writer eagerly drained trains out of its channel
/// into an unbounded internal queue, so a surface replaying a cached large result could
/// grow the backlog without limit.
///
/// So: at most one train is resident in the writer, one more waits here, and a third
/// makes `send_train` wait until the in-flight one finishes. The read loop only ever
/// blocks when a surface already has two replies outstanding, instead of on every
/// reply — and it blocks on real congestion rather than on pacing.
///
/// Keeping exactly one train resident also means `watch_target` below always describes
/// exactly one reply, so the departure check cannot be confused by two surfaces sharing
/// a queue.
const TRAIN_QUEUE_CAPACITY: usize = 1;

/// Heartbeat pings waiting to go out.
///
/// Their own lane, ahead of everything else, for two reasons. The broker's publish
/// allowance only counts `ClientMessage::Publish` frames — a websocket Ping is a control
/// frame it answers separately — so a ping is never the thing that puts this relay over
/// a limit and must never be delayed on that account. And the session arms its pong
/// deadline when it *hands over* a ping, so a ping stuck behind a queue of snapshots
/// reads as a dead peer and tears down a perfectly healthy session.
const PING_QUEUE_CAPACITY: usize = 4;

/// A single frame taking longer than this to reach the socket means the connection is
/// congested. Previously warned per chunk from the action path; it belongs here now,
/// where the actual write happens.
const SLOW_FRAME_WRITE_WARN_MILLIS: u128 = 500;

/// Whether the writer took on a chunk train.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TrainHandoff {
    Queued,
    /// Never queued: the surface it was for had already left the room.
    Dropped,
    /// Too many large replies already outstanding. The caller must answer the client
    /// some other way rather than wait — see `send_train`.
    Busy,
}

/// A paced multi-frame action reply.
pub(super) struct TrainFrame {
    pub(super) chunks: Vec<Message>,
    pub(super) interval: Duration,
    /// The surface this reply is for, but ONLY when that surface was observed online at
    /// the moment the train was queued.
    ///
    /// `None` means "we have no positive evidence this surface was ever here", and the
    /// train is then delivered whole no matter what presence says later. That asymmetry
    /// is deliberate: a client resolves a chunked reply only once every chunk arrives,
    /// so abandoning one mid-flight turns a valid answer into a 15-second client
    /// timeout. Wasting frames on a departed surface is cheap; truncating a live one is
    /// not. Only an *observed departure* — online at queue time, absent now — may stop a
    /// train.
    pub(super) watch_target: Option<String>,
}

/// Whether a surface is still in the broker room.
///
/// A trait so the writer's abandonment rule can be tested against a flippable fake
/// instead of a live relay.
pub(super) trait SurfacePresence {
    async fn is_online(&self, peer_id: &str) -> bool;
}

impl SurfacePresence for AppState {
    async fn is_online(&self, peer_id: &str) -> bool {
        self.surface_peer_is_online(peer_id).await
    }
}

/// A cloneable handle to the broker socket's write half.
///
/// Replaces the `&mut SplitSink` that used to be threaded through every publish
/// function.
#[derive(Clone)]
pub(super) struct BrokerWriter {
    ping_tx: mpsc::Sender<Message>,
    now_tx: mpsc::Sender<Message>,
    train_tx: mpsc::Sender<TrainFrame>,
}

impl BrokerWriter {
    /// Enqueue a heartbeat ping, which jumps every other queue. See
    /// `PING_QUEUE_CAPACITY`.
    pub(super) fn send_ping(&self, message: Message) -> Result<(), String> {
        match self.ping_tx.try_send(message) {
            Ok(()) => Ok(()),
            // Four unanswered pings already queued means the socket is not draining;
            // the pong timeout is the right thing to let fire.
            Err(mpsc::error::TrySendError::Full(_)) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err("broker writer task has stopped".to_string())
            }
        }
    }

    /// Enqueue one ordinary frame.
    pub(super) async fn send_now(&self, message: Message) -> Result<(), String> {
        self.now_tx
            .send(message)
            .await
            .map_err(|_| "broker writer task has stopped".to_string())
    }

    /// Offer a paced chunk train. Never waits.
    ///
    /// This is called from inside the session's inline message handler, so it must not
    /// block: the relay has exactly one reader, and anything that parks it stops
    /// presence frames, heartbeat pongs and every other surface's requests — the very
    /// stall this module exists to remove. An earlier revision awaited a bounded
    /// channel here, which bounded memory correctly but reintroduced that stall as soon
    /// as a third large reply showed up (cheap to trigger, because a replayed action id
    /// is served from cache without redoing the work).
    ///
    /// So a full queue is reported, not waited on. The caller answers the client with
    /// an explicit failure instead, which is recoverable — a client that is told "busy"
    /// can retry, whereas a client whose relay stopped reading can only time out.
    pub(super) fn send_train(
        &self,
        chunks: Vec<Message>,
        interval: Duration,
        watch_target: Option<String>,
    ) -> Result<TrainHandoff, String> {
        if chunks.is_empty() {
            return Ok(TrainHandoff::Queued);
        }
        match self.train_tx.try_send(TrainFrame {
            chunks,
            interval,
            watch_target,
        }) {
            Ok(()) => Ok(TrainHandoff::Queued),
            Err(mpsc::error::TrySendError::Full(_)) => Ok(TrainHandoff::Busy),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err("broker writer task has stopped".to_string())
            }
        }
    }
}

/// Aborts the writer task when the session that owns it goes away.
///
/// The socket is the session. Without this the task outlives its session: closing the
/// channel is not enough, because a send to a peer that has stopped reading never
/// completes, so the task can sit on a dead socket while the session reconnects and
/// then emit frames onto it.
pub(super) struct BrokerWriterGuard(JoinHandle<()>);

impl Drop for BrokerWriterGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Start the writer task for a freshly split broker socket.
///
/// Returns the publisher handle, a receiver that yields the first write error, and a
/// guard that must be kept alive for exactly as long as the session.
pub(super) fn spawn_broker_writer(
    sink: SplitSink<BrokerSocket, Message>,
    presence: AppState,
) -> (BrokerWriter, oneshot::Receiver<String>, BrokerWriterGuard) {
    let (ping_tx, ping_rx) = mpsc::channel(PING_QUEUE_CAPACITY);
    let (now_tx, now_rx) = mpsc::channel(NOW_QUEUE_CAPACITY);
    let (train_tx, train_rx) = mpsc::channel(TRAIN_QUEUE_CAPACITY);
    let (error_tx, error_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        if let Err(error) = drive_writer(ping_rx, now_rx, train_rx, sink, presence).await {
            // Nobody left to tell is fine: it means the session already ended.
            let _ = error_tx.send(error);
        }
    });
    (
        BrokerWriter {
            ping_tx,
            now_tx,
            train_tx,
        },
        error_rx,
        BrokerWriterGuard(task),
    )
}

/// Where the writer puts frames. A trait rather than a closure so the scheduling loop
/// below can be driven by tests over a recorder without a live websocket.
pub(super) trait FrameSink {
    async fn send_frame(&mut self, message: Message) -> Result<(), String>;
}

impl FrameSink for SplitSink<BrokerSocket, Message> {
    async fn send_frame(&mut self, message: Message) -> Result<(), String> {
        let started_at = Instant::now();
        let outcome = self
            .send(message)
            .await
            .map_err(|error| format!("broker publish failed: {error}"));
        let elapsed_ms = started_at.elapsed().as_millis();
        if elapsed_ms >= SLOW_FRAME_WRITE_WARN_MILLIS {
            warn!(elapsed_ms, "broker frame write was slow");
        }
        outcome
    }
}

/// A writer handle with no socket behind it, plus the queues it feeds. Lets tests assert
/// what a publish path hands off, and how long handing off costs.
#[cfg(test)]
pub(super) fn test_writer() -> (
    BrokerWriter,
    mpsc::Receiver<Message>,
    mpsc::Receiver<TrainFrame>,
) {
    let (ping_tx, _ping_rx) = mpsc::channel(PING_QUEUE_CAPACITY);
    let (now_tx, now_rx) = mpsc::channel(NOW_QUEUE_CAPACITY);
    let (train_tx, train_rx) = mpsc::channel(TRAIN_QUEUE_CAPACITY);
    std::mem::forget(_ping_rx);
    (
        BrokerWriter {
            ping_tx,
            now_tx,
            train_tx,
        },
        now_rx,
        train_rx,
    )
}

/// The scheduling policy, generic over where frames go and where presence comes from.
pub(super) async fn drive_writer<S: FrameSink, P: SurfacePresence>(
    mut ping_rx: mpsc::Receiver<Message>,
    mut now_rx: mpsc::Receiver<Message>,
    mut train_rx: mpsc::Receiver<TrainFrame>,
    mut sink: S,
    presence: P,
) -> Result<(), String> {
    let mut train: VecDeque<Message> = VecDeque::new();
    let mut train_interval = Duration::ZERO;
    let mut train_watch_target: Option<String> = None;
    let mut next_chunk_at: Option<Instant> = None;
    // When the last chunk went out, across ALL trains rather than the current one.
    //
    // Pacing exists to keep the relay's publish rate under the broker's allowance, and an
    // interval applied only within a train does not do that: a train's last chunk used to
    // be followed immediately by the next train's first, so back-to-back replies published
    // at up to double the advertised rate. Carrying the instant across the boundary is what
    // makes the interval a rate rather than a within-train detail.
    let mut last_chunk_at: Option<Instant> = None;
    // Closure of either channel means the session dropped its handle. The writer then
    // finishes the reply it has already accepted and stops — it does NOT wait for more.
    // Lifecycle is `BrokerWriterGuard`'s job: it aborts this task when the session ends,
    // which is the only thing that can stop a task parked on a socket write. This drain
    // is the orderly path, not the guarantee.
    let mut now_closed = false;
    let mut train_closed = false;

    loop {
        // 0. Heartbeat pings first, unconditionally. They keep the session alive and
        //    cost nothing against the broker's publish allowance.
        if let Ok(ping) = ping_rx.try_recv() {
            sink.send_frame(ping).await?;
            continue;
        }

        // 1. A train chunk that is already due. This is the ONLY place a chunk is
        //    written, so the departure check below cannot be bypassed by whichever
        //    branch happened to notice the deadline first.
        if next_chunk_at.is_some_and(|deadline| deadline <= Instant::now()) {
            // Only a surface we SAW here and that is now gone stops its own train. This
            // check is meaningful only because the read loop no longer blocks while the
            // writer paces: presence frames now land mid-train instead of after it.
            if let Some(peer_id) = train_watch_target.clone() {
                if !presence.is_online(&peer_id).await {
                    info!(
                        peer_id = %peer_id,
                        abandoned_chunks = train.len(),
                        "abandoning a chunk train: its surface left the room"
                    );
                    train.clear();
                    train_watch_target = None;
                    next_chunk_at = None;
                    continue;
                }
            }
            if let Some(chunk) = train.pop_front() {
                sink.send_frame(chunk).await?;
                // Recorded after the write, matching `advance_train`: the interval is
                // measured from when a chunk actually left, not from when it was picked up.
                last_chunk_at = Some(Instant::now());
            }
            next_chunk_at = advance_train(&train, train_interval);
            continue;
        }

        // 2. Take on a waiting reply BEFORE draining ordinary traffic. Accepting one
        //    sends nothing — it only makes its first chunk due, so step 1 can start
        //    interleaving it with the ordinary frames below. Draining first instead
        //    meant a backlog (a slow socket, a reconnect's delta catch-up, plain
        //    sustained snapshots) could keep a queued reply from ever being accepted,
        //    while the client sat there timing it.
        //
        //    Still only one at a time: leaving the next in its channel is what bounds
        //    the backlog, and what keeps `watch_target` describing exactly one reply.
        if train.is_empty() {
            match train_rx.try_recv() {
                Ok(frame) => {
                    accept_train(
                        frame,
                        &mut train,
                        &mut train_interval,
                        &mut train_watch_target,
                        &mut next_chunk_at,
                        last_chunk_at,
                    );
                    continue;
                }
                Err(mpsc::error::TryRecvError::Disconnected) => train_closed = true,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
        }

        // 3. Ordinary traffic, which is what "overtakes the train" means: it goes out
        //    during the pacing gap instead of queueing behind every chunk.
        match now_rx.try_recv() {
            Ok(message) => {
                sink.send_frame(message).await?;
                continue;
            }
            Err(mpsc::error::TryRecvError::Disconnected) => now_closed = true,
            Err(mpsc::error::TryRecvError::Empty) => {}
        }

        // 4. Wait for whichever comes first.
        if let Some(deadline) = next_chunk_at {
            if now_closed {
                // Nothing more can arrive; just pace out what we accepted.
                sleep_until(deadline).await;
                continue;
            }
            tokio::select! {
                biased;
                received = ping_rx.recv() => {
                    if let Some(ping) = received {
                        sink.send_frame(ping).await?;
                    }
                }
                received = now_rx.recv() => match received {
                    Some(message) => {
                                sink.send_frame(message).await?;
                    }
                    None => now_closed = true,
                },
                () = sleep_until(deadline) => {}
            }
            continue;
        }

        // No train resident. Once both channels are closed there is nothing left to do.
        if now_closed && train_closed {
            return Ok(());
        }

        // Every waiting path below must keep listening for pings. The idle wait is the
        // one the relay spends almost all its time in, so a version of this select
        // without the ping arm does not merely delay a heartbeat — it never notices one
        // until some other frame happens to wake the loop, and the session tears itself
        // down over a connection that was fine.
        tokio::select! {
            biased;
            received = ping_rx.recv() => {
                if let Some(ping) = received {
                    sink.send_frame(ping).await?;
                }
            }
            received = now_rx.recv(), if !now_closed => match received {
                Some(message) => {
                    sink.send_frame(message).await?;
                }
                None => now_closed = true,
            },
            received = train_rx.recv(), if !train_closed => match received {
                Some(frame) => accept_train(
                    frame,
                    &mut train,
                    &mut train_interval,
                    &mut train_watch_target,
                    &mut next_chunk_at,
                    last_chunk_at,
                ),
                None => train_closed = true,
            },
        }
    }
}

fn advance_train(train: &VecDeque<Message>, interval: Duration) -> Option<Instant> {
    if train.is_empty() {
        None
    } else {
        Some(Instant::now() + interval)
    }
}

fn accept_train(
    frame: TrainFrame,
    train: &mut VecDeque<Message>,
    train_interval: &mut Duration,
    train_watch_target: &mut Option<String>,
    next_chunk_at: &mut Option<Instant>,
    last_chunk_at: Option<Instant>,
) {
    debug_assert!(
        train.is_empty(),
        "a train is only accepted when the previous one has finished"
    );
    let queued = frame.chunks.len();
    train.extend(frame.chunks);
    *train_interval = frame.interval;
    *train_watch_target = frame.watch_target;
    // Due as soon as PACING allows, which is not necessarily now: the previous train's last
    // chunk may have gone out moments ago, and the interval is a publish rate rather than a
    // within-train detail. After an idle spell the deadline is already past, so this is
    // still immediate in the common case.
    //
    // Note this only moves when the first chunk is *sent*. Acceptance itself still happens
    // eagerly, before ordinary traffic is drained, so a backlog still cannot postpone a
    // queued reply.
    let now = Instant::now();
    *next_chunk_at = Some(match last_chunk_at {
        Some(last) => (last + frame.interval).max(now),
        None => now,
    });
    info!(
        queued_chunks = queued,
        interval_ms = frame.interval.as_millis() as u64,
        "queued a paced chunk train"
    );
}

#[cfg(test)]
mod tests;
