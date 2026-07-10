//! Usage event stream for the broker.
//!
//! The broker is the only component that centrally observes every device that
//! connects (relay-server is self-hosted per user), so it is the natural place
//! to answer "how many users are connecting and how often". We emit one
//! structured event per connect / disconnect / publish, keyed by
//! `device_id` / `peer_id` / `role`, so usage frequency and unique-device counts
//! become simple queries over the resulting stream.
//!
//! Today the sink appends newline-delimited JSON to a file (cheap, dependency
//! free, survives restarts). The [`UsageEventSink`] trait keeps this swappable:
//! a Postgres-backed sink can slot in later without touching the hot path.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::TrySendError;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use relay_util::trimmed_option_string;
use serde::Serialize;
use tracing::{error, info, warn};

use crate::protocol::PeerRole;

/// Environment variable pointing at the newline-delimited JSON file that usage
/// events are appended to. When unset, usage event logging stays disabled.
pub const USAGE_EVENTS_PATH_ENV: &str = "RELAY_BROKER_USAGE_EVENTS_PATH";

/// Bounded capacity of the in-memory queue between the broker hot path and the
/// file writer thread. Bounding it caps memory if the writer stalls (e.g. slow
/// or full disk) on a public broker; excess events are dropped and counted
/// rather than accumulating without limit. ~8k events is a small, fixed budget.
const USAGE_EVENT_QUEUE_CAPACITY: usize = 8192;

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

/// Build the usage event sink from the environment, if configured.
///
/// Returns `None` (usage logging disabled) when [`USAGE_EVENTS_PATH_ENV`] is
/// unset/blank or the file cannot be opened.
pub fn usage_event_sink_from_env() -> Option<Arc<dyn UsageEventSink>> {
    let path = trimmed_option_string(std::env::var(USAGE_EVENTS_PATH_ENV).ok())?;
    match FileUsageEventSink::spawn(PathBuf::from(&path)) {
        Ok(sink) => {
            info!(path = %path, "broker usage event logging enabled");
            Some(Arc::new(sink))
        }
        Err(error) => {
            warn!(%error, path = %path, "failed to enable broker usage event logging");
            None
        }
    }
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
}
