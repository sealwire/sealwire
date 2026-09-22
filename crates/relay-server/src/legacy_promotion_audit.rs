//! Tripwire for the Phase-4 removal of public thread promotion.
//!
//! Before Phase 3 a deferred Claude session was exposed to clients under the
//! bridge's own `claude-pending-…` handle, and its first turn REPLACED that public
//! id with the SDK's — so every relay-owned map, every client tab and every saved
//! reference had to be re-keyed mid-turn. Phase 3 gave such a session a stable
//! relay id and moved the handle into `SessionBinding`, which left that machinery
//! dead. Phase 4 deleted it (`markdown/STABLE_SESSION_ID_DESIGN.md`).
//!
//! Dead code does not stay dead on its own: the next person to meet a deferred
//! start reaches for exactly the shape that was removed. This scan makes that
//! reach fail in CI with the reason attached, rather than in a user's tab strip.
//!
//! # What this is not
//!
//! A **textual scan** over this crate's sources and `relay-api`'s, not a proof. It
//! notices the removed NAMES coming back. It cannot notice the same idea returning
//! under a new name — a `rekey_session`, a second public id handed out by a provider
//! result, an outcome enum that starts carrying an id again — so a green run means
//! "the old spelling is still gone", never "no promotion exists". The behavioural
//! guards are the stable-id lifecycle tests in `state/app/tests.rs`; this only keeps
//! the corpse buried.
//!
//! It deliberately bans no provider-side vocabulary. A bridge handle, a
//! `pending_thread_id` correlation and a binding that materializes are all still how
//! a deferred session works; what is banned is the relay handing a DIFFERENT id back
//! to its own callers.
//!
//! Needles are assembled from two halves at runtime so this file needs no
//! self-exemption: it scans every `.rs` under `src/`, itself included, and a
//! literal written here would (correctly) trip it.

use std::path::{Path, PathBuf};

/// `(needle first half, needle second half, still-allowed superstring, why it went)`.
///
/// The superstring column exists for one case: `active_thread_promoted_from` is
/// still in the wire model for one compatibility release, and it CONTAINS the
/// removed state field's name. Occurrences of the allowed superstring are erased
/// before the bare needle is looked for.
const REMOVED: &[(&str, &str, Option<(&str, &str)>, &str)] = &[
    (
        "promote_background",
        "_thread",
        None,
        "re-keyed ~20 relay-owned maps when a public id changed; a stable session id \
never changes, so nothing is left to re-key",
    ),
    (
        "thread_promoted",
        "_from",
        Some(("active_thread_promoted", "_from")),
        "persisted lineage real_id -> pending_id, written only by the re-key above",
    ),
    (
        "resolve_promoted",
        "_thread_id",
        None,
        "client-supplied-id alias resolver; it scanned the lineage map and answered \
only for ids beginning `claude-pending-`, which are no longer public",
    ),
    (
        "legacy_thread_promotion",
        "_count",
        None,
        "test observability for the lineage map",
    ),
    (
        "resolve_started",
        "_thread_id",
        None,
        "asked a bridge which public id a just-started turn really belonged to; the \
send path now keeps the session id it already had",
    ),
    (
        "promoted_thread",
        "_ids",
        None,
        "the bridge side of that question — a pending-handle -> real-id handoff drained \
once per start. Materializing the binding is what carries that fact now",
    ),
    (
        "dispatched_thread",
        "_id",
        None,
        "answered `which thread did that turn really land on?` from the relay's lineage \
record. Every dispatch now lands on the id the caller supplied",
    ),
    (
        "dispatched.thread",
        "_id",
        None,
        "the same question asked of the dispatch RESULT. A driver that reads a thread id \
back out of a dispatch is carrying the retired protocol, whatever it is spelled",
    ),
    (
        "rekey",
        "_thread",
        None,
        "`TeamRun`'s sweep that rewrote one thread id to another across every seat, role, \
provider and in-flight marker. Nothing rotates a seat by renaming it",
    ),
];

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {} ({e}) — did the crate move?", dir.display()))
    {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_source_reintroduces_public_thread_promotion() {
    // `relay-api` too: `TeamRun` owns the run record, and the seat-rewriting sweep
    // that was removed with the rest of this lived there rather than here.
    let roots = [
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../relay-api/src")
            .canonicalize()
            .expect("relay-api/src — did the sibling crate move?"),
    ];
    let mut files = Vec::new();
    for root in &roots {
        rust_sources(root, &mut files);
    }
    assert!(
        files.len() > 20,
        "only {} sources found under {:?} — this guard scans nothing",
        files.len(),
        roots
    );

    let mut found: Vec<String> = Vec::new();
    for path in &files {
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let rel = roots
            .iter()
            .find_map(|root| path.strip_prefix(root).ok())
            .unwrap_or(path)
            .display()
            .to_string();
        for (head, tail, allowed, why) in REMOVED {
            let needle = format!("{head}{tail}");
            let haystack = match allowed {
                Some((head, tail)) => text.replace(&format!("{head}{tail}"), ""),
                None => text.clone(),
            };
            let hits = haystack.matches(&needle).count();
            if hits > 0 {
                found.push(format!("{rel}: {hits}x `{needle}` — removed because {why}"));
            }
        }
    }

    found.sort();
    assert!(
        found.is_empty(),
        "public thread promotion is back in the sources:\n  {}\n\nPhase 4 removed it \
(markdown/STABLE_SESSION_ID_DESIGN.md). A deferred session keeps ONE relay id for \
life; only its `SessionBinding` moves. If a provider genuinely needs to hand back a \
different id, bind it — do not re-key relay state.",
        found.join("\n  ")
    );
}
