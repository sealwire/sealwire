use std::sync::{Arc, Mutex};

use super::*;

/// Collects what the writer wrote, in order, so the scheduling policy can be asserted
/// without a websocket.
struct RecordingSink {
    written: Arc<Mutex<Vec<String>>>,
    fail_with: Option<String>,
}

impl FrameSink for RecordingSink {
    async fn send_frame(&mut self, message: Message) -> Result<(), String> {
        if let Some(error) = &self.fail_with {
            return Err(error.clone());
        }
        match message {
            Message::Text(text) => self.written.lock().unwrap().push(text),
            Message::Ping(_) => self.written.lock().unwrap().push("PING".to_string()),
            _ => {}
        }
        Ok(())
    }
}

/// A sink whose writes never complete, for asserting the session can still tear the
/// writer down.
struct StalledSink;

impl FrameSink for StalledSink {
    async fn send_frame(&mut self, _message: Message) -> Result<(), String> {
        std::future::pending::<()>().await;
        unreachable!("a stalled sink never completes a write")
    }
}

/// Presence the test can flip mid-train.
#[derive(Clone)]
struct FakePresence {
    online: Arc<Mutex<bool>>,
}

impl SurfacePresence for FakePresence {
    async fn is_online(&self, _peer_id: &str) -> bool {
        *self.online.lock().unwrap()
    }
}

fn always_online() -> FakePresence {
    FakePresence {
        online: Arc::new(Mutex::new(true)),
    }
}

fn recorder() -> (Arc<Mutex<Vec<String>>>, RecordingSink) {
    let written = Arc::new(Mutex::new(Vec::new()));
    (
        Arc::clone(&written),
        RecordingSink {
            written,
            fail_with: None,
        },
    )
}

fn text(label: &str) -> Message {
    Message::Text(label.to_string())
}

fn train_of(prefix: &str, count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| text(&format!("{prefix}{index}")))
        .collect()
}

fn train_of_labels(prefix: &str, count: usize) -> Vec<String> {
    (0..count).map(|index| format!("{prefix}{index}")).collect()
}

fn plain_train(chunks: Vec<Message>, interval_ms: u64) -> TrainFrame {
    TrainFrame {
        chunks,
        interval: Duration::from_millis(interval_ms),
        watch_target: None,
    }
}

/// The point of the whole module: a snapshot queued while a 21-chunk reply is pacing
/// must not wait out the reply.
#[tokio::test(start_paused = true)]
async fn ordinary_traffic_goes_out_during_a_trains_pacing_gap() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    train_tx
        .send(plain_train(train_of("chunk-", 5), 250))
        .await
        .expect("train should queue");

    tokio::time::sleep(Duration::from_millis(10)).await;
    now_tx
        .send(text("snapshot"))
        .await
        .expect("snapshot should queue");

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    let snapshot_at = written
        .iter()
        .position(|entry| entry == "snapshot")
        .unwrap();
    assert_eq!(written[0], "chunk-0", "the first chunk is due immediately");
    assert_eq!(
        snapshot_at, 1,
        "the snapshot must go out in the very next pacing gap, not after all 5 chunks; \
         got order {written:?}"
    );
    assert_eq!(
        written.len(),
        6,
        "and every chunk still arrives: {written:?}"
    );
}

/// The train must not be starved by sustained ordinary traffic either.
#[tokio::test(start_paused = true)]
async fn a_train_still_completes_under_sustained_ordinary_traffic() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    train_tx
        .send(plain_train(train_of("chunk-", 4), 100))
        .await
        .expect("train should queue");

    for index in 0..20 {
        now_tx
            .send(text(&format!("noise-{index}")))
            .await
            .expect("noise should queue");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    let chunks: Vec<&String> = written
        .iter()
        .filter(|entry| entry.starts_with("chunk-"))
        .collect();
    assert_eq!(
        chunks,
        vec!["chunk-0", "chunk-1", "chunk-2", "chunk-3"],
        "a paced reply must survive a noisy relay, in order: {written:?}"
    );
}

/// Chunks keep their order relative to each other.
#[tokio::test(start_paused = true)]
async fn a_train_keeps_its_chunk_order() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    train_tx
        .send(plain_train(train_of("chunk-", 21), 250))
        .await
        .expect("train should queue");
    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    assert_eq!(
        written.lock().unwrap().clone(),
        train_of_labels("chunk-", 21)
    );
}

/// The backlog bound. A train is a whole action reply — a workspace diff can be
/// megabytes across hundreds of chunks — and the writer emits four chunks a second.
///
/// An earlier revision drained trains eagerly out of the channel into an unbounded
/// internal queue, so the producer never waited and a surface replaying a cached large
/// result could grow the backlog without limit. The pre-writer code was crudely bounded
/// (it published inline, so nothing else could be accepted until a reply had gone out);
/// moving pacing off the read loop must not throw that bound away.
#[tokio::test(start_paused = true)]
async fn a_third_train_waits_instead_of_growing_the_backlog() {
    let (_written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(TRAIN_QUEUE_CAPACITY);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    // One becomes resident in the writer, one waits in the channel.
    train_tx
        .send(plain_train(train_of("a-", 40), 250))
        .await
        .expect("first train is accepted");
    tokio::time::sleep(Duration::from_millis(10)).await;
    train_tx
        .send(plain_train(train_of("b-", 40), 250))
        .await
        .expect("second train fills the channel");

    // The third must not be absorbed: that is the bound.
    let third = train_tx.try_send(plain_train(train_of("c-", 40), 250));
    assert!(
        third.is_err(),
        "a third outstanding reply must not be absorbed into an unbounded backlog — \
         that is what stops a replayed large result from growing memory without limit"
    );

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");
}

/// A train stops once the surface it is for has demonstrably left.
///
/// Only meaningful because the read loop no longer blocks while the writer paces: before
/// that, the presence frame saying "that surface left" could not be read until the train
/// had already finished, so the signal was frozen for exactly the window it was supposed
/// to react to.
#[tokio::test(start_paused = true)]
async fn a_train_stops_once_its_surface_is_seen_to_leave() {
    let (written, sink) = recorder();
    let presence = always_online();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        presence.clone(),
    ));

    train_tx
        .send(TrainFrame {
            chunks: train_of("chunk-", 21),
            interval: Duration::from_millis(250),
            watch_target: Some("surface-a".to_string()),
        })
        .await
        .expect("train should queue");

    // The surface reloads away while its answer is still pacing.
    tokio::time::sleep(Duration::from_millis(300)).await;
    *presence.online.lock().unwrap() = false;

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    assert!(
        written.len() <= 3,
        "the train must stop promptly instead of publishing all 21 chunks into the \
         void: got {written:?}"
    );
}

/// The asymmetry that keeps a truncated reply from ever being a client-visible failure.
///
/// A client resolves a chunked reply only once EVERY chunk has arrived, so a train
/// abandoned halfway is not a saving — it is a guaranteed client timeout. Absence from
/// the presence set is therefore not enough to stop a train; only an observed departure
/// is.
#[tokio::test(start_paused = true)]
async fn a_train_for_a_surface_never_seen_online_is_delivered_whole() {
    let (written, sink) = recorder();
    let presence = FakePresence {
        online: Arc::new(Mutex::new(false)),
    };
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(ping_rx, now_rx, train_rx, sink, presence));

    train_tx
        .send(plain_train(train_of("chunk-", 6), 250))
        .await
        .expect("train should queue");
    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    assert_eq!(
        written.lock().unwrap().len(),
        6,
        "a cold presence set must not truncate a valid answer into a client timeout"
    );
}

/// A write failure ends the writer, which is how the session learns the socket is gone.
#[tokio::test(start_paused = true)]
async fn a_failed_write_stops_the_writer() {
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (_train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        RecordingSink {
            written: Arc::new(Mutex::new(Vec::new())),
            fail_with: Some("socket is gone".to_string()),
        },
        always_online(),
    ));

    now_tx
        .send(text("snapshot"))
        .await
        .expect("frame should queue");

    let error = writer
        .await
        .expect("writer joins")
        .expect_err("a failed send must surface");
    assert_eq!(error, "socket is gone");
}

/// The writer must be cancellable mid-write, which is what ties it to its session.
///
/// Closing the channels is not enough on its own: a send to a peer that has stopped
/// reading never completes, so a stalled task cannot observe the closure. Without an
/// abort it sits on a dead socket while `run_broker_loop` reconnects, and can still emit
/// frames onto it afterwards. `BrokerWriterGuard` is what performs that abort; this pins
/// the property the guard depends on.
#[tokio::test(start_paused = true)]
async fn a_stalled_writer_can_be_cancelled_when_its_session_ends() {
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let task = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        StalledSink,
        always_online(),
    ));

    now_tx
        .send(text("frame-that-never-lands"))
        .await
        .expect("frame should queue");
    tokio::time::sleep(Duration::from_millis(10)).await;

    // The session ends. Dropping the handles alone cannot stop a task parked on a write.
    drop(now_tx);
    drop(train_tx);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !task.is_finished(),
        "a task parked on a socket write cannot observe channel closure — which is \
         exactly why the session needs a guard that aborts it"
    );

    task.abort();
    let outcome = task.await;
    assert!(
        outcome.is_err_and(|error| error.is_cancelled()),
        "the abort must actually cancel it — that is all BrokerWriterGuard does on drop"
    );
}

/// Bounding the backlog must not re-park the relay's only reader.
///
/// `send_train` is called from inside the session's inline message handler. An earlier
/// revision bounded memory by awaiting a full channel there, which is correct for memory
/// and wrong for liveness: the relay has exactly one reader, so parking it stops
/// presence frames, heartbeat pongs, and every other surface's requests — the same stall
/// this module was written to remove, just needing three large replies instead of one.
/// Cheap to reach, too: a replayed action id is served from cache without redoing work.
#[tokio::test(start_paused = true)]
async fn a_saturated_train_queue_reports_busy_instead_of_parking_the_caller() {
    let (writer, _now_rx, _train_rx) = test_writer();

    assert_eq!(
        writer
            .send_train(train_of("a-", 4), Duration::from_millis(250), None)
            .expect("first train is accepted"),
        TrainHandoff::Queued
    );

    // Nothing is draining the queue, so the next one cannot be taken on.
    let second = tokio::time::timeout(
        Duration::from_millis(50),
        std::future::ready(writer.send_train(train_of("b-", 4), Duration::from_millis(250), None)),
    )
    .await
    .expect("send_train must not block the caller")
    .expect("a full queue is not a session error");

    assert_eq!(
        second,
        TrainHandoff::Busy,
        "a saturated writer must report Busy so the caller can answer the client, not \
         park the relay's only reader until the queue drains"
    );
}

/// A heartbeat ping must not wait behind data.
///
/// Two independent reasons, both of which cost a healthy session:
///
///   * The broker's publish allowance counts only `ClientMessage::Publish` frames — a
///     websocket Ping is a control frame it answers separately — so a ping is never
///     what puts this relay over a limit, and delaying it buys nothing.
///   * The session arms its pong deadline when it *hands a ping over*, not when the
///     ping reaches the socket. A ping queued behind a burst of snapshots therefore
///     reads as a dead peer, and the session tears itself down while the connection is
///     perfectly fine — taking every queued frame with it, since the guard aborts the
///     writer on the way out.
#[tokio::test(start_paused = true)]
async fn a_heartbeat_ping_overtakes_queued_data() {
    let (written, sink) = recorder();
    let (ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);

    // Queue data first, and a train, so every other lane has work waiting.
    for index in 0..40 {
        now_tx
            .send(text(&format!("snapshot-{index}")))
            .await
            .expect("data should queue");
    }
    train_tx
        .send(plain_train(train_of("chunk-", 10), 250))
        .await
        .expect("train should queue");
    ping_tx
        .send(Message::Ping(vec![7]))
        .await
        .expect("ping should queue");

    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));
    tokio::time::sleep(Duration::from_millis(1)).await;

    let seen = written.lock().unwrap().len();
    drop(ping_tx);
    drop(now_tx);
    drop(train_tx);
    let _ = writer.await;

    let written = written.lock().unwrap().clone();
    let ping_at = written
        .iter()
        .position(|entry| entry == "PING")
        .unwrap_or_else(|| panic!("the ping must be sent at all; got {written:?}"));
    assert_eq!(
        ping_at, 0,
        "the ping must go out before the queued snapshots, not after {ping_at} of them"
    );
    let _ = seen;
}

/// …including when the writer is idle, which is where it spends almost all its time.
///
/// The overtaking test above pre-queues data, so it only proves the ping wins a race it
/// was already in. The idle wait is a different code path, and a version of it that
/// forgets the ping arm does not merely delay a heartbeat: nothing notices the ping
/// until some unrelated frame happens to wake the loop, so a quiet, healthy connection
/// times out on its own pong deadline. That is how this was actually broken.
#[tokio::test(start_paused = true)]
async fn an_idle_writer_still_notices_a_ping() {
    let (written, sink) = recorder();
    let (ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    // Let the writer settle into its idle wait with nothing queued at all.
    tokio::time::sleep(Duration::from_millis(50)).await;
    ping_tx
        .send(Message::Ping(vec![1]))
        .await
        .expect("ping should queue");
    tokio::time::sleep(Duration::from_millis(10)).await;

    let seen = written.lock().unwrap().clone();
    drop(ping_tx);
    drop(now_tx);
    drop(train_tx);
    let _ = writer.await;

    assert_eq!(
        seen,
        vec!["PING".to_string()],
        "an idle writer must wake for a ping without needing other traffic to nudge it"
    );
}

/// A reply must start streaming even while ordinary traffic keeps arriving.
///
/// The writer drains an ordinary frame and loops, and only looks for a new train when
/// the ordinary queue is momentarily empty. A slow socket, a reconnect's delta backlog,
/// or plain sustained snapshot traffic can therefore keep a queued reply from ever being
/// *accepted* — and the client, which cannot see any of this, just times out.
///
/// The neighbouring "sustained traffic" test queues the train first, so it only proves a
/// train already under way survives noise. This is the order that actually breaks:
/// noise first, train second.
#[tokio::test(start_paused = true)]
async fn a_train_starts_even_while_ordinary_traffic_keeps_arriving() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(512);
    let (train_tx, train_rx) = mpsc::channel(1);

    // A backlog is already waiting when the reply is queued behind it.
    for index in 0..200 {
        now_tx
            .send(text(&format!("noise-{index}")))
            .await
            .expect("noise should queue");
    }
    train_tx
        .send(plain_train(train_of("chunk-", 5), 250))
        .await
        .expect("train should queue");

    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));
    tokio::time::sleep(Duration::from_millis(5)).await;

    let seen = written.lock().unwrap().clone();
    drop(now_tx);
    drop(train_tx);
    let _ = writer.await;

    let first_chunk_at = seen
        .iter()
        .position(|entry| entry.starts_with("chunk-"))
        .unwrap_or_else(|| panic!("the reply never started; wrote {} frames", seen.len()));
    assert!(
        first_chunk_at < 20,
        "the reply waited behind {first_chunk_at} ordinary frames before its first chunk \
         went out; a backlog must not postpone a reply the client is timing"
    );
}

/// Records when each frame went out, so pacing can be asserted rather than just ordering.
struct TimingSink {
    written: Arc<Mutex<Vec<(String, Duration)>>>,
    start: Instant,
}

impl FrameSink for TimingSink {
    async fn send_frame(&mut self, message: Message) -> Result<(), String> {
        if let Message::Text(text) = message {
            let at = Instant::now().duration_since(self.start);
            self.written.lock().unwrap().push((text, at));
        }
        Ok(())
    }
}

/// Pacing must hold ACROSS trains, not just inside one.
///
/// The interval exists to keep the relay's publish rate under the broker's allowance. It
/// was applied only between chunks of the same train: `advance_train` returns `None` on the
/// last chunk, and `accept_train` then marks the next train's first chunk due *immediately*.
/// Back-to-back two-chunk replies therefore went out at t=0, 250, 250, 500, 500… — two
/// frames per interval, double the rate the pacing advertises, and the byte budget on the
/// broker is sized against that advertised rate.
///
/// A reply that fits one frame never becomes a train at all, so two chunks is the smallest
/// real train and this is the worst case rather than a contrived one.
#[tokio::test(start_paused = true)]
async fn pacing_holds_across_train_boundaries() {
    let written = Arc::new(Mutex::new(Vec::new()));
    let sink = TimingSink {
        written: Arc::clone(&written),
        start: Instant::now(),
    };
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    // Two consecutive replies, each the smallest a real train can be.
    train_tx
        .send(plain_train(train_of("a-", 2), 250))
        .await
        .expect("first train should queue");
    train_tx
        .send(plain_train(train_of("b-", 2), 250))
        .await
        .expect("second train should queue");

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    assert_eq!(
        written.len(),
        4,
        "every chunk must still arrive: {written:?}"
    );

    for pair in written.windows(2) {
        let (previous_label, previous_at) = &pair[0];
        let (label, at) = &pair[1];
        let gap = at.saturating_sub(*previous_at);
        assert!(
            gap >= Duration::from_millis(250),
            "`{previous_label}` -> `{label}` were only {}ms apart, but the train interval \
             is 250ms. Pacing that lapses at a train boundary means the relay publishes at \
             up to double its advertised rate, which is the rate the broker's byte budget \
             is sized against. Order was {written:?}",
            gap.as_millis()
        );
    }
}

/// This relay's publish cadence must stay inside the broker's shipped byte budget.
///
/// The broker crate has its own version of this arithmetic, but it can only guess at the
/// cadence — it has no access to `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS`, so
/// it hardcodes the interval and would stay green if this crate sped up. This is the
/// authoritative check: it reads the real cadence, the real frame cap, and the broker's
/// real default, so changing any one of the three has to confront the other two.
///
/// Being refused is fatal for a relay — the `rate_limited` arm ends the session and
/// resyncs a full snapshot — so the budget has to sit well clear of what this relay can
/// actually emit, not merely above it.
#[test]
fn this_relays_publish_cadence_stays_inside_the_brokers_byte_budget() {
    use crate::broker::remote_actions::REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS;
    use crate::broker::MAX_BROKER_TEXT_FRAME_BYTES;

    let frames_per_minute =
        (1_000 / REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS as usize) * 60;
    // Every chunk frame is capped, because the chunk builders shrink a chunk until its
    // frame fits. Cap x cadence is therefore an upper bound on the chunk train, not an
    // estimate — and pacing now holds across train boundaries (see
    // `pacing_holds_across_train_boundaries`), so the cadence is the real ceiling rather
    // than double it.
    let chunk_train_ceiling_per_minute = MAX_BROKER_TEXT_FRAME_BYTES * frames_per_minute;

    assert!(
        relay_broker::DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE >= chunk_train_ceiling_per_minute * 6,
        "this relay can emit up to {chunk_train_ceiling_per_minute} B/min of chunked \
         replies ({frames_per_minute} frames a minute at the {MAX_BROKER_TEXT_FRAME_BYTES} \
         byte frame cap), and the broker ships a {} B/min budget. That leaves too little \
         room for transcript deltas and snapshots running alongside — and a refused \
         publish ends the session and resyncs.",
        relay_broker::DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE
    );
}

/// This relay's fixed frame size must fit inside the smallest cap any broker can enforce.
///
/// relay-server compiles `MAX_BROKER_TEXT_FRAME_BYTES` in and fits every chunk against it,
/// with no way to learn what the broker it connects to was configured with. The broker's
/// job is therefore to guarantee a floor; this asserts the relay stays under it. Raise the
/// relay's constant without raising `MIN_MAX_TEXT_FRAME_BYTES` and every large reply
/// becomes `frame_too_large` — which closes the socket, so the reconnect replays the same
/// result and fails the same way.
#[test]
fn this_relays_frame_size_fits_the_brokers_guaranteed_minimum() {
    use crate::broker::MAX_BROKER_TEXT_FRAME_BYTES;

    assert!(
        MAX_BROKER_TEXT_FRAME_BYTES <= relay_broker::MIN_MAX_TEXT_FRAME_BYTES,
        "this relay fits chunks to {MAX_BROKER_TEXT_FRAME_BYTES} bytes but a broker only \
         guarantees it will accept {}. The relay cannot negotiate the cap, so the excess \
         is not throttled — it is refused, and refused again on every replay.",
        relay_broker::MIN_MAX_TEXT_FRAME_BYTES
    );
}

fn content_publish(
    crypto: &super::super::RelayContentCrypto,
    peer: &str,
    mut payload: serde_json::Value,
) -> Message {
    payload["target_peer_id"] = serde_json::json!(peer);
    payload["protocol_version"] = serde_json::json!(4);
    crypto.bind_epochs(&mut payload);
    Message::Text(
        serde_json::json!({
            "type": "publish",
            "protocol_version": 2,
            "payload": payload,
        })
        .to_string(),
    )
}

fn chunk_body(index: usize, count: usize) -> serde_json::Value {
    serde_json::json!({
        "kind": "encrypted_remote_action_result_chunk",
        "device_id": "device-a",
        "action_id": "long-reply",
        "action": "fetch_workspace_diff",
        "chunk_index": index,
        "chunk_count": count,
        "envelope": { "nonce": format!("n{index}"), "ciphertext": format!("c{index}") },
    })
}

/// Chunks are sealed when the writer emits them, per recipient. Another phone's
/// traffic and size probes must not push this phone's chunks outside its window,
/// and a hello that lands while they are queued must not rebind the old session.
#[tokio::test(start_paused = true)]
async fn emission_order_seals_each_recipient_without_probe_side_effects() {
    use ed25519_dalek::{SigningKey, Verifier};

    let key = SigningKey::from_bytes(&[7_u8; 32]);
    let crypto = std::sync::Arc::new(super::super::RelayContentCrypto::new(
        key.clone(),
        "relay-writer".to_string(),
        "room-writer".to_string(),
    ));
    let session_a = crypto.open_session("phone-a");
    crypto.open_session("phone-b");
    let probe = super::super::protocol::frame_bytes_for_payload(
        &super::super::protocol::OutboundBrokerPayload::EncryptedRemoteActionResultChunk {
            action_id: "probe".to_string(),
            target_peer_id: "phone-a".to_string(),
            device_id: "device-a".to_string(),
            action: super::super::remote_actions::RemoteActionKind::FetchWorkspaceDiff,
            chunk_index: 0,
            chunk_count: 1,
            envelope: super::super::crypto::EncryptedEnvelope {
                nonce: "probe-n".to_string(),
                ciphertext: "probe-c".to_string(),
            },
        },
    );
    assert!(probe > 0);
    for _ in 0..600 {
        let _ = super::super::protocol::frame_bytes_for_payload(
            &super::super::protocol::OutboundBrokerPayload::RemoteActionPending {
                action_id: "probe".to_string(),
                target_peer_id: "phone-b".to_string(),
            },
        );
    }
    assert_eq!(
        crypto.issued("phone-a"),
        0,
        "a size probe must not mint a nonce"
    );
    assert_eq!(crypto.issued("phone-b"), 0);

    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer_with_signer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
        Some(std::sync::Arc::clone(&crypto)),
    ));

    let first_train: Vec<Message> = (0..5)
        .map(|index| content_publish(&crypto, "phone-a", chunk_body(index, 5)))
        .collect();
    train_tx
        .send(plain_train(first_train, 100))
        .await
        .expect("first train queues");
    tokio::time::sleep(Duration::from_millis(10)).await;
    for index in 0..20 {
        now_tx
            .send(content_publish(
                &crypto,
                "phone-b",
                serde_json::json!({
                    "kind": "remote_action_pending",
                    "action_id": format!("other-{index}"),
                }),
            ))
            .await
            .expect("other phone frame queues");
    }
    let second_train: Vec<Message> = (0..3)
        .map(|index| content_publish(&crypto, "phone-a", chunk_body(index, 3)))
        .collect();
    train_tx
        .send(plain_train(second_train, 100))
        .await
        .expect("second train queues");

    tokio::time::sleep(Duration::from_secs(3)).await;
    let stale = content_publish(&crypto, "phone-a", chunk_body(99, 100));
    let session_b = crypto.open_session("phone-a");
    assert_ne!(session_a, session_b);
    let fresh = content_publish(
        &crypto,
        "phone-a",
        serde_json::json!({
            "kind": "encrypted_remote_action_result",
            "device_id": "device-a",
            "action_id": "after-hello",
            "envelope": { "nonce": "new-n", "ciphertext": "new-c" },
        }),
    );
    now_tx.send(stale).await.expect("stale frame queues");
    now_tx.send(fresh).await.expect("fresh frame queues");
    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    let mut phone_a_chunks = Vec::new();
    let mut phone_a_nonces = Vec::new();
    let mut phone_b_nonces = Vec::new();
    let mut saw_fresh = false;
    for text in &written {
        let frame: serde_json::Value = serde_json::from_str(text).expect("sealed json");
        let payload = &frame["payload"];
        let target = payload["target_peer_id"].as_str().unwrap();
        let session = payload["relay_content_session"].as_str().unwrap();
        let nonce = payload["relay_content_nonce"].as_str().unwrap();
        let signed = super::super::relay_content_message(
            "relay-writer",
            "room-writer",
            session,
            nonce,
            payload.as_object().unwrap(),
        )
        .unwrap();
        let signature: [u8; 64] = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            payload["relay_content_signature"].as_str().unwrap(),
        )
        .unwrap()
        .try_into()
        .unwrap();
        key.verifying_key()
            .verify(&signed, &ed25519_dalek::Signature::from_bytes(&signature))
            .expect("emitted frame verifies");
        if target == "phone-b" {
            phone_b_nonces.push(nonce.to_string());
            continue;
        }
        if payload["kind"] == "encrypted_remote_action_result_chunk" {
            assert_eq!(session, session_a);
            phone_a_chunks.push(payload["chunk_index"].as_u64().unwrap());
            phone_a_nonces.push(nonce.to_string());
        } else {
            assert_eq!(payload["action_id"], "after-hello");
            assert_eq!(session, session_b);
            assert_eq!(nonce, "9");
            saw_fresh = true;
        }
    }
    assert_eq!(
        phone_a_chunks,
        vec![0, 1, 2, 3, 4, 0, 1, 2],
        "both trains arrive, including chunks overtaken by the other phone: {written:?}"
    );
    assert_eq!(
        phone_a_nonces,
        (1..=8).map(|nonce| nonce.to_string()).collect::<Vec<_>>()
    );
    assert_eq!(
        phone_b_nonces,
        (1..=20).map(|nonce| nonce.to_string()).collect::<Vec<_>>()
    );
    assert!(
        saw_fresh,
        "the post-hello reply is delivered under the new session"
    );
    assert!(
        written
            .iter()
            .all(|text| !text.contains("\"chunk_index\":99")),
        "the frame queued under the old session must not be sent"
    );
}

#[test]
fn departure_drops_the_content_session_and_its_sequence() {
    let crypto = super::super::RelayContentCrypto::new(
        ed25519_dalek::SigningKey::from_bytes(&[4_u8; 32]),
        "relay".to_string(),
        "room".to_string(),
    );
    let session = crypto.open_session("phone");
    let mut payload = serde_json::json!({
        "kind": "remote_action_pending",
        "target_peer_id": "phone",
        "action_id": "queued",
    });
    crypto.bind_epochs(&mut payload);
    crypto.forget_peer("phone");
    let frame = serde_json::json!({
        "type": "publish",
        "protocol_version": 2,
        "payload": payload,
    })
    .to_string();
    assert!(crypto.seal_frame_text(&frame).unwrap().is_none());
    assert_eq!(crypto.issued("phone"), 0);
    assert!(crypto.session("phone").is_none());
    assert_ne!(crypto.open_session("phone"), session);
}
