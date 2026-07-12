//! Usage event stream for the broker.
//!
//! The broker is the only component that centrally observes every device that
//! connects (relay-server is self-hosted per user), so it is the natural place
//! to answer "how many users are connecting and how often". We emit one
//! structured event per connect / disconnect / publish, keyed by
//! `device_id` / `peer_id` / `role`, so usage frequency and unique-device counts
//! become simple queries over the resulting stream.
//!
//! Two backends implement the [`UsageEventSink`] trait: [`FileUsageEventSink`]
//! appends newline-delimited JSON to a file, and [`PostgresUsageEventSink`]
//! batches rows into a `usage_events` table. Both keep `record` non-blocking on
//! the broker hot path; the environment selects which one is active.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::TrySendError;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use relay_util::trimmed_option_string;
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, QueryBuilder};
use tracing::{error, info, warn};

use crate::protocol::PeerRole;

/// Environment variable pointing at the newline-delimited JSON file that usage
/// events are appended to. When unset, file usage logging stays disabled.
pub const USAGE_EVENTS_PATH_ENV: &str = "RELAY_BROKER_USAGE_EVENTS_PATH";

/// Environment variable pointing at a Postgres URL for usage events. Point it at
/// the same database as the control plane to get SQL analytics in one place.
/// Takes precedence over [`USAGE_EVENTS_PATH_ENV`] when both are set.
pub const USAGE_EVENTS_POSTGRES_URL_ENV: &str = "RELAY_BROKER_USAGE_EVENTS_POSTGRES_URL";

/// Optional retention window (in whole days) for the Postgres usage-events table.
/// When set to a positive integer, a background task periodically deletes rows
/// older than this, capping unbounded growth. Unset / `0` / unparseable = keep
/// forever. Only applies to the Postgres sink; the NDJSON file sink is append-only
/// and left to external log rotation.
pub const USAGE_EVENTS_RETENTION_DAYS_ENV: &str = "RELAY_BROKER_USAGE_EVENTS_RETENTION_DAYS";

/// How often the retention task sweeps expired usage events. A few hours keeps the
/// table bounded without hammering Postgres; the `ts_ms` index makes each sweep cheap.
const USAGE_EVENT_RETENTION_SWEEP: Duration = Duration::from_secs(6 * 60 * 60);

/// Milliseconds in a day, used to convert the retention window to a `ts_ms` cutoff.
const MS_PER_DAY: u128 = 24 * 60 * 60 * 1000;

/// Bounded capacity of the in-memory queue between the broker hot path and the
/// writer. Bounding it caps memory if the writer stalls (e.g. slow or full disk,
/// or a Postgres outage) on a public broker; excess events are dropped and
/// counted rather than accumulating without limit. ~8k events is a small budget.
const USAGE_EVENT_QUEUE_CAPACITY: usize = 8192;

/// Max rows folded into a single multi-row INSERT by the Postgres writer.
const USAGE_EVENT_BATCH_MAX: usize = 256;

/// The kind of usage event observed at the broker.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageEventKind {
    /// A peer joined a channel (a device came online / connected).
    Connect,
    /// A peer left a channel (a device went offline / disconnected).
    Disconnect,
    /// A peer published a message (a unit of activity within a session).
    Publish,
}

impl UsageEventKind {
    /// Stable column value; must match the serde `snake_case` name so the file
    /// (NDJSON) and Postgres backends agree.
    fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Disconnect => "disconnect",
            Self::Publish => "publish",
        }
    }
}

/// Stable string for a peer role, matching `PeerRole`'s serde `snake_case` name.
fn role_str(role: PeerRole) -> &'static str {
    match role {
        PeerRole::Relay => "relay",
        PeerRole::Surface => "surface",
    }
}

/// A single usage observation, ready to be persisted as one NDJSON row.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UsageEvent {
    /// Milliseconds since the Unix epoch.
    pub ts_ms: u128,
    pub event: UsageEventKind,
    /// Broker room id the peer is connected to.
    pub channel_id: String,
    pub peer_id: String,
    pub role: PeerRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Payload `kind` for publish events (e.g. `session_snapshot`); `None` for
    /// connect/disconnect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_kind: Option<String>,
}

impl UsageEvent {
    pub fn new(
        event: UsageEventKind,
        channel_id: &str,
        peer_id: &str,
        role: PeerRole,
        device_id: Option<String>,
    ) -> Self {
        Self {
            ts_ms: now_ms(),
            event,
            channel_id: channel_id.to_string(),
            peer_id: peer_id.to_string(),
            role,
            device_id,
            payload_kind: None,
        }
    }

    pub fn with_payload_kind(mut self, kind: impl Into<String>) -> Self {
        self.payload_kind = Some(kind.into());
        self
    }
}

/// Somewhere usage events can be recorded. Implementations must be cheap and
/// non-blocking: `record` runs on the broker hot path while the room lock is
/// held, so it must never perform blocking I/O inline.
pub trait UsageEventSink: Send + Sync {
    fn record(&self, event: UsageEvent);
}

/// Appends usage events as newline-delimited JSON to a file.
///
/// A dedicated writer thread owns the file and drains a *bounded* channel, so
/// `record` only performs a non-blocking `try_send`. Bounding the queue caps
/// memory when the writer stalls; overflow events are dropped and counted (see
/// [`dropped`](Self::dropped)) rather than growing the broker without limit.
/// Using a std thread (not a tokio task) keeps the writer fully decoupled from
/// the async runtime and avoids depending on optional tokio fs features.
pub struct FileUsageEventSink {
    tx: std::sync::mpsc::SyncSender<UsageEvent>,
    dropped: Arc<AtomicU64>,
}

impl FileUsageEventSink {
    /// Open (creating if needed) the file at `path` and spawn the writer thread.
    pub fn spawn(path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        // Validate we can open the file before spawning, so misconfiguration
        // surfaces immediately instead of silently dropping every event.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;

        let display_path = path.display().to_string();
        let (tx, rx) = std::sync::mpsc::sync_channel::<UsageEvent>(USAGE_EVENT_QUEUE_CAPACITY);
        std::thread::spawn(move || {
            use std::io::Write;
            let mut writer = std::io::BufWriter::new(file);
            while let Ok(event) = rx.recv() {
                let line = match serde_json::to_string(&event) {
                    Ok(line) => line,
                    Err(error) => {
                        warn!(%error, "failed to serialize broker usage event; skipping");
                        continue;
                    }
                };
                // Flush per event: usage volume is low and losing the buffered
                // tail on a crash defeats the point of the stream. A write or
                // flush failure (e.g. disk full) is a hard error for the stream,
                // so log it loudly and stop — subsequent `record` calls then
                // count as drops, keeping the failure observable.
                if let Err(error) = writeln!(writer, "{line}").and_then(|()| writer.flush()) {
                    error!(
                        %error,
                        path = %display_path,
                        "broker usage event writer failed; usage logging stopped"
                    );
                    break;
                }
            }
        });

        Ok(Self {
            tx,
            dropped: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Total number of usage events dropped because the queue was full or the
    /// writer thread had exited. Non-zero means the usage stream is incomplete.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl UsageEventSink for FileUsageEventSink {
    fn record(&self, event: UsageEvent) {
        // Non-blocking, bounded: if the writer is behind or gone we drop the
        // event and account for it rather than blocking the broker hot path or
        // letting the queue grow without bound.
        match self.tx.try_send(event) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                // Throttle: log the 1st, 2nd, 4th, 8th... drop so a sustained
                // stall is visible without flooding the log every event.
                if dropped.is_power_of_two() {
                    warn!(
                        dropped,
                        "broker usage event queue full or writer gone; dropping usage events"
                    );
                }
            }
        }
    }
}

/// Writes usage events into a Postgres `usage_events` table.
///
/// Same shape as [`FileUsageEventSink`]: `record` only does a non-blocking
/// `try_send` onto a bounded queue; a background async task drains it and folds
/// events into batched multi-row INSERTs. Overflow (queue full, or the writer
/// stalled on a Postgres outage) is dropped and counted rather than blocking the
/// broker hot path or growing memory without bound.
pub struct PostgresUsageEventSink {
    tx: tokio::sync::mpsc::Sender<UsageEvent>,
    dropped: Arc<AtomicU64>,
}

impl PostgresUsageEventSink {
    /// Connect to `url`, ensure the `usage_events` schema exists, and spawn the
    /// batching writer task. Must be called inside a Tokio runtime.
    pub async fn connect(url: &str) -> Result<Self, String> {
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(url)
            .await
            .map_err(|error| {
                format!("failed to connect to {USAGE_EVENTS_POSTGRES_URL_ENV}: {error}")
            })?;
        initialize_usage_events_schema(&pool).await?;

        // Optional retention sweeper: cap unbounded growth of the usage_events table.
        if let Some(retention_days) = retention_days_from_env() {
            let retention_pool = pool.clone();
            info!(
                retention_days,
                "usage_events retention enabled; sweeping every {}h",
                USAGE_EVENT_RETENTION_SWEEP.as_secs() / 3600
            );
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(USAGE_EVENT_RETENTION_SWEEP);
                loop {
                    ticker.tick().await;
                    match prune_usage_events(&retention_pool, retention_days, now_ms()).await {
                        Ok(0) => {}
                        Ok(deleted) => {
                            info!(deleted, retention_days, "pruned expired usage events")
                        }
                        Err(error) => {
                            warn!(%error, "usage_events retention sweep failed; will retry")
                        }
                    }
                }
            });
        }

        let (tx, mut rx) = tokio::sync::mpsc::channel::<UsageEvent>(USAGE_EVENT_QUEUE_CAPACITY);
        tokio::spawn(async move {
            while let Some(first) = rx.recv().await {
                let mut batch = vec![first];
                while batch.len() < USAGE_EVENT_BATCH_MAX {
                    match rx.try_recv() {
                        Ok(event) => batch.push(event),
                        Err(_) => break,
                    }
                }
                if let Err(error) = insert_usage_events(&pool, &batch).await {
                    // Best-effort: a transient Postgres error drops this batch but
                    // keeps the writer alive so logging resumes once it recovers.
                    warn!(%error, count = batch.len(), "failed to write usage events to postgres; dropping batch");
                }
            }
        });

        Ok(Self {
            tx,
            dropped: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Total events dropped because the queue was full or the writer task exited.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl UsageEventSink for PostgresUsageEventSink {
    fn record(&self, event: UsageEvent) {
        if self.tx.try_send(event).is_err() {
            let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            if dropped.is_power_of_two() {
                warn!(
                    dropped,
                    "broker usage event queue full or writer gone; dropping usage events"
                );
            }
        }
    }
}

async fn initialize_usage_events_schema(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS usage_events (
            id BIGSERIAL PRIMARY KEY,
            ts_ms BIGINT NOT NULL,
            event TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            role TEXT NOT NULL,
            device_id TEXT,
            payload_kind TEXT
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create usage_events table: {error}"))?;
    sqlx::query("CREATE INDEX IF NOT EXISTS usage_events_ts_ms_idx ON usage_events (ts_ms)")
        .execute(pool)
        .await
        .map_err(|error| format!("failed to create usage_events ts_ms index: {error}"))?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS usage_events_device_id_idx ON usage_events (device_id)",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create usage_events device_id index: {error}"))?;
    Ok(())
}

/// Parse the retention window from the environment. Returns `Some(days)` only for
/// a positive integer; unset / `0` / unparseable all mean "keep forever" (`None`).
fn retention_days_from_env() -> Option<u32> {
    trimmed_option_string(std::env::var(USAGE_EVENTS_RETENTION_DAYS_ENV).ok())
        .and_then(|raw| raw.parse::<u32>().ok())
        .filter(|days| *days > 0)
}

/// Delete usage events older than `retention_days` relative to `now_ms`. Returns
/// the number of rows removed. `now_ms` is a parameter (not read from the clock)
/// so retention is deterministically testable. A `retention_days` of 0 is a no-op.
async fn prune_usage_events(
    pool: &PgPool,
    retention_days: u32,
    now_ms: u128,
) -> Result<u64, sqlx::Error> {
    if retention_days == 0 {
        return Ok(0);
    }
    // Saturating so a small `now_ms` (only realistic in tests) can't underflow.
    let cutoff_ms = now_ms.saturating_sub(u128::from(retention_days) * MS_PER_DAY);
    let cutoff = i64::try_from(cutoff_ms).unwrap_or(i64::MAX);
    let result = sqlx::query("DELETE FROM usage_events WHERE ts_ms < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

async fn insert_usage_events(pool: &PgPool, events: &[UsageEvent]) -> Result<(), sqlx::Error> {
    if events.is_empty() {
        return Ok(());
    }
    let mut builder = QueryBuilder::<Postgres>::new(
        "INSERT INTO usage_events (ts_ms, event, channel_id, peer_id, role, device_id, payload_kind) ",
    );
    builder.push_values(events, |mut row, event| {
        row.push_bind(i64::try_from(event.ts_ms).unwrap_or(i64::MAX))
            .push_bind(event.event.as_str())
            .push_bind(event.channel_id.as_str())
            .push_bind(event.peer_id.as_str())
            .push_bind(role_str(event.role))
            .push_bind(event.device_id.as_deref())
            .push_bind(event.payload_kind.as_deref());
    });
    builder.build().execute(pool).await?;
    Ok(())
}

/// Build the usage event sink from the environment, if configured.
///
/// Postgres ([`USAGE_EVENTS_POSTGRES_URL_ENV`]) takes precedence over the file
/// sink ([`USAGE_EVENTS_PATH_ENV`]). Returns `None` (usage logging disabled) when
/// neither is set, or the configured backend cannot be initialized.
pub async fn usage_event_sink_from_env() -> Option<Arc<dyn UsageEventSink>> {
    if let Some(url) = trimmed_option_string(std::env::var(USAGE_EVENTS_POSTGRES_URL_ENV).ok()) {
        return match PostgresUsageEventSink::connect(&url).await {
            Ok(sink) => {
                info!("broker usage event logging enabled (postgres)");
                Some(Arc::new(sink))
            }
            Err(error) => {
                warn!(%error, "failed to enable postgres usage event logging");
                None
            }
        };
    }
    if let Some(path) = trimmed_option_string(std::env::var(USAGE_EVENTS_PATH_ENV).ok()) {
        return match FileUsageEventSink::spawn(PathBuf::from(&path)) {
            Ok(sink) => {
                info!(path = %path, "broker usage event logging enabled (file)");
                Some(Arc::new(sink))
            }
            Err(error) => {
                warn!(%error, path = %path, "failed to enable file usage event logging");
                None
            }
        };
    }
    None
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_sink_appends_ndjson_rows() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("agent-relay-usage-events-{unique}.ndjson"));

        let sink = FileUsageEventSink::spawn(path.clone()).expect("sink should open file");
        sink.record(UsageEvent::new(
            UsageEventKind::Connect,
            "room-a",
            "relay-1",
            PeerRole::Relay,
            Some("device-xyz".to_string()),
        ));
        sink.record(
            UsageEvent::new(
                UsageEventKind::Publish,
                "room-a",
                "relay-1",
                PeerRole::Relay,
                Some("device-xyz".to_string()),
            )
            .with_payload_kind("session_snapshot"),
        );

        // The writer runs on its own thread; poll until both rows land.
        let rows = read_rows_until(&path, 2);
        let _ = std::fs::remove_file(&path);

        assert_eq!(rows.len(), 2, "expected two NDJSON rows, got {rows:?}");

        let connect: serde_json::Value =
            serde_json::from_str(&rows[0]).expect("row 0 should be valid JSON");
        assert_eq!(connect["event"], "connect");
        assert_eq!(connect["channel_id"], "room-a");
        assert_eq!(connect["peer_id"], "relay-1");
        assert_eq!(connect["role"], "relay");
        assert_eq!(connect["device_id"], "device-xyz");
        assert!(
            connect.get("payload_kind").is_none(),
            "connect omits payload_kind"
        );
        assert!(connect["ts_ms"].as_u64().unwrap_or(0) > 0);

        let publish: serde_json::Value =
            serde_json::from_str(&rows[1]).expect("row 1 should be valid JSON");
        assert_eq!(publish["event"], "publish");
        assert_eq!(publish["payload_kind"], "session_snapshot");

        assert_eq!(sink.dropped(), 0, "nothing should drop on the happy path");
    }

    #[test]
    fn record_drops_and_counts_when_queue_is_full() {
        // No consumer drains the receiver, so a capacity-1 queue fills after the
        // first send and every later record is dropped and counted. `_rx` stays
        // bound so the channel is Full (not Disconnected) for the first send.
        let (tx, _rx) = std::sync::mpsc::sync_channel::<UsageEvent>(1);
        let sink = FileUsageEventSink {
            tx,
            dropped: Arc::new(AtomicU64::new(0)),
        };

        let make = || {
            UsageEvent::new(
                UsageEventKind::Publish,
                "room-a",
                "relay-1",
                PeerRole::Relay,
                None,
            )
        };
        sink.record(make()); // buffered
        sink.record(make()); // full -> dropped
        sink.record(make()); // full -> dropped

        assert_eq!(
            sink.dropped(),
            2,
            "two events should be dropped and counted"
        );
    }

    #[test]
    fn postgres_record_drops_and_counts_when_queue_is_full() {
        // No consumer drains the receiver, so a capacity-1 queue fills after the
        // first send and every later record is dropped and counted. `_rx` stays
        // bound so the channel is Full (not Closed). Deterministic, no DB needed.
        let (tx, _rx) = tokio::sync::mpsc::channel::<UsageEvent>(1);
        let sink = PostgresUsageEventSink {
            tx,
            dropped: Arc::new(AtomicU64::new(0)),
        };

        let make = || {
            UsageEvent::new(
                UsageEventKind::Publish,
                "room-a",
                "relay-1",
                PeerRole::Relay,
                None,
            )
        };
        sink.record(make()); // buffered
        sink.record(make()); // full -> dropped
        sink.record(make()); // full -> dropped

        assert_eq!(
            sink.dropped(),
            2,
            "two events should be dropped and counted"
        );
    }

    fn read_rows_until(path: &std::path::Path, want: usize) -> Vec<String> {
        for _ in 0..200 {
            if let Ok(contents) = std::fs::read_to_string(path) {
                let rows: Vec<String> = contents
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(|line| line.to_string())
                    .collect();
                if rows.len() >= want {
                    return rows;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Vec::new()
    }

    /// Live-Postgres test for the batching writer. Env-gated so plain
    /// `cargo test` stays offline. Run against a throwaway DB:
    ///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://sealwire:dev@127.0.0.1:5433/sealwire \
    ///     cargo test -p relay-broker postgres_sink -- --nocapture
    #[tokio::test]
    async fn postgres_sink_writes_usage_events() {
        let Some(url) = trimmed_option_string(std::env::var("RELAY_BROKER_TEST_POSTGRES_URL").ok())
        else {
            eprintln!("skipping postgres usage sink: set RELAY_BROKER_TEST_POSTGRES_URL");
            return;
        };

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let channel = format!("room-{unique}");

        let sink = PostgresUsageEventSink::connect(&url)
            .await
            .expect("sink should connect to postgres");
        sink.record(UsageEvent::new(
            UsageEventKind::Connect,
            &channel,
            "relay-1",
            PeerRole::Relay,
            Some("device-xyz".to_string()),
        ));
        sink.record(
            UsageEvent::new(
                UsageEventKind::Publish,
                &channel,
                "relay-1",
                PeerRole::Relay,
                Some("device-xyz".to_string()),
            )
            .with_payload_kind("session_snapshot"),
        );
        sink.record(UsageEvent::new(
            UsageEventKind::Disconnect,
            &channel,
            "phone-1",
            PeerRole::Surface,
            None,
        ));

        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("query pool should connect");

        // The writer is async and batched; poll until all three rows land.
        let mut rows: Vec<(String, Option<String>, Option<String>, String)> = Vec::new();
        for _ in 0..100 {
            rows = sqlx::query_as(
                "SELECT event, device_id, payload_kind, role FROM usage_events \
                 WHERE channel_id = $1 ORDER BY ts_ms, id",
            )
            .bind(&channel)
            .fetch_all(&pool)
            .await
            .expect("query should succeed");
            if rows.len() >= 3 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // Clean up before asserting so a failure still leaves the table tidy.
        let _ = sqlx::query("DELETE FROM usage_events WHERE channel_id = $1")
            .bind(&channel)
            .execute(&pool)
            .await;

        assert_eq!(
            rows.len(),
            3,
            "all three events should be written; got {rows:?}"
        );
        assert_eq!(
            rows[0],
            (
                "connect".to_string(),
                Some("device-xyz".to_string()),
                None,
                "relay".to_string()
            )
        );
        assert_eq!(
            rows[1],
            (
                "publish".to_string(),
                Some("device-xyz".to_string()),
                Some("session_snapshot".to_string()),
                "relay".to_string()
            )
        );
        assert_eq!(
            rows[2],
            ("disconnect".to_string(), None, None, "surface".to_string())
        );
        assert_eq!(sink.dropped(), 0, "nothing should drop on the happy path");
    }

    /// `retention_days_from_env` treats only a positive integer as a real window;
    /// unset / 0 / junk all mean "keep forever".
    #[test]
    fn retention_days_env_parsing() {
        let key = USAGE_EVENTS_RETENTION_DAYS_ENV;
        let restore = std::env::var(key).ok();

        std::env::remove_var(key);
        assert_eq!(retention_days_from_env(), None, "unset = keep forever");

        std::env::set_var(key, "0");
        assert_eq!(retention_days_from_env(), None, "0 = keep forever");

        std::env::set_var(key, "  30 ");
        assert_eq!(retention_days_from_env(), Some(30), "trimmed positive int");

        std::env::set_var(key, "not-a-number");
        assert_eq!(retention_days_from_env(), None, "junk = keep forever");

        match restore {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    /// Live-Postgres retention test: seed one stale and one fresh event, prune with
    /// a 30-day window, and assert only the stale one is deleted. Env-gated like the
    /// writer test. Deterministic because `prune_usage_events` takes `now_ms`.
    ///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://sealwire:dev@127.0.0.1:5433/sealwire \
    ///     cargo test -p relay-broker prune_usage_events -- --nocapture
    #[tokio::test]
    async fn prune_usage_events_deletes_only_stale_rows() {
        let Some(url) = trimmed_option_string(std::env::var("RELAY_BROKER_TEST_POSTGRES_URL").ok())
        else {
            eprintln!("skipping postgres retention test: set RELAY_BROKER_TEST_POSTGRES_URL");
            return;
        };

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let channel = format!("retention-{unique}");

        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("query pool should connect");
        initialize_usage_events_schema(&pool)
            .await
            .expect("schema init");

        // Anchor "now" well past the retention window so the arithmetic is unambiguous.
        let now_ms: u128 = 1_000 * MS_PER_DAY;
        let stale_ts = now_ms - 40 * MS_PER_DAY; // outside a 30-day window
        let fresh_ts = now_ms - 1 * MS_PER_DAY; // inside a 30-day window

        for (ts, event) in [(stale_ts, "connect"), (fresh_ts, "connect")] {
            sqlx::query(
                "INSERT INTO usage_events (ts_ms, event, channel_id, peer_id, role) \
                 VALUES ($1, $2, $3, 'relay-1', 'relay')",
            )
            .bind(i64::try_from(ts).unwrap())
            .bind(event)
            .bind(&channel)
            .execute(&pool)
            .await
            .expect("seed event");
        }

        let deleted = prune_usage_events(&pool, 30, now_ms)
            .await
            .expect("prune should succeed");

        let remaining: Vec<(i64,)> =
            sqlx::query_as("SELECT ts_ms FROM usage_events WHERE channel_id = $1 ORDER BY ts_ms")
                .bind(&channel)
                .fetch_all(&pool)
                .await
                .expect("query remaining");

        // Clean up before asserting so a failure still leaves the table tidy.
        let _ = sqlx::query("DELETE FROM usage_events WHERE channel_id = $1")
            .bind(&channel)
            .execute(&pool)
            .await;

        assert_eq!(deleted, 1, "exactly the stale row should be deleted");
        assert_eq!(remaining.len(), 1, "only the fresh row should survive");
        assert_eq!(
            remaining[0].0,
            i64::try_from(fresh_ts).unwrap(),
            "the surviving row should be the fresh one"
        );
    }
}
