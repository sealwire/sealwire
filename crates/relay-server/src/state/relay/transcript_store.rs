use std::collections::HashMap;
use std::ops::Deref;

use super::TranscriptRecord;

/// Which namespace an id belongs to — and, at a row's birth, whose name it is.
///
/// These are the same question: an id minted by the provider lives in the provider
/// namespace, an id minted by the relay lives in the row namespace. Collapsing them
/// into one lookup is what let a provider event land on an unrelated relay row that
/// merely shared its spelling, so callers must say which one they hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IdSpace {
    /// A name the provider issued.
    Provider,
    /// The relay's own key for a row.
    Row,
}

impl IdSpace {
    /// What to record as a row's `provider_item_id` when it is born under `item_id`.
    pub(crate) fn provider_name_of(self, item_id: &str) -> Option<String> {
        match self {
            Self::Provider => Some(item_id.to_string()),
            Self::Row => None,
        }
    }
}

/// One thread's rows plus the indexes that make identity resolution O(1).
///
/// The Vec is the only source of truth; both maps are derived, private, and
/// rebuilt by the mutators here — which is why there is no `DerefMut` and no way
/// to reach the backing Vec. A caller that could append directly would leave a
/// row unreachable by id while it still rendered, and the resulting "second copy
/// of one message" is exactly what this type exists to make impossible.
#[derive(Debug, Default)]
pub(crate) struct ThreadTranscript {
    rows: Vec<TranscriptRecord>,
    by_row_id: HashMap<String, usize>,
    /// provider_item_id -> row_id. Many provider ids may name one row (a tool's
    /// request and its result, a send's reservation and the provider's echo);
    /// one provider id never names two rows.
    row_id_by_provider_item_id: HashMap<String, String>,
    /// Only ever used to disambiguate a minted id, so it need not be dense.
    synthetic_seq: u64,
    /// Probes performed by the last `resolve_index`. Test-only, and an atomic
    /// rather than a `Cell` because `RelayState` must stay `Sync`.
    #[cfg(test)]
    probe_visited: std::sync::atomic::AtomicUsize,
}

/// The fields of a row that a mutation may not change, captured before the edit
/// and put back after it.
struct RowIdentity {
    row_id: String,
    order_seq: i64,
    withdrawn: bool,
}

impl RowIdentity {
    fn of(record: &TranscriptRecord) -> Self {
        Self {
            row_id: record.row_id.clone(),
            order_seq: record.order_seq,
            withdrawn: record.withdrawn,
        }
    }

    fn restore(&self, record: &mut TranscriptRecord) {
        record.row_id.clone_from(&self.row_id);
        record.order_seq = self.order_seq;
        // Absorbing: set stays set, and a later copy may still set it.
        record.withdrawn |= self.withdrawn;
    }
}

// Hand-written so the test-only probe counter (an atomic, which is not `Clone`)
// does not force itself onto the real shape. A clone starts its count fresh.
impl Clone for ThreadTranscript {
    fn clone(&self) -> Self {
        Self {
            rows: self.rows.clone(),
            by_row_id: self.by_row_id.clone(),
            row_id_by_provider_item_id: self.row_id_by_provider_item_id.clone(),
            synthetic_seq: self.synthetic_seq,
            #[cfg(test)]
            probe_visited: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl Deref for ThreadTranscript {
    type Target = [TranscriptRecord];

    fn deref(&self) -> &Self::Target {
        &self.rows
    }
}

impl ThreadTranscript {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Build from rows that already carry ids — a provider read, or the legacy
    /// mirror being copied into a runtime. Duplicate ids inside `rows` are
    /// re-minted rather than dropped: two rows arriving under one id are two
    /// messages, and collapsing them loses one outright.
    pub(crate) fn from_rows(rows: Vec<TranscriptRecord>) -> Self {
        let mut store = Self::new();
        for row in rows {
            store.push(row);
        }
        store
    }

    /// Resolve in the ROW namespace: the relay's own key, which is what clients
    /// hold and what every core operation is addressed by.
    ///
    /// Deliberately blind to provider ids. The two namespaces overlap in practice —
    /// a provider-born row's key IS its provider id — but they are not the same
    /// space, and a single resolver that fell back from one to the other let a
    /// provider event land on an unrelated relay row that merely shared its
    /// spelling.
    pub(crate) fn resolve_row(&self, row_id: &str) -> Option<&str> {
        self.by_row_id
            .get_key_value(row_id)
            .map(|(id, _)| id.as_str())
    }

    /// Resolve in the PROVIDER namespace: only ids a provider has actually issued
    /// for a row. A relay-owned key that was never bound resolves to nothing here,
    /// even when some other row happens to be keyed by that string.
    pub(crate) fn resolve_provider(&self, provider_item_id: &str) -> Option<&str> {
        self.row_id_by_provider_item_id
            .get(provider_item_id)
            .map(String::as_str)
            .filter(|row_id| self.by_row_id.contains_key(*row_id))
    }

    /// Resolve in the namespace the caller says it is holding.
    pub(crate) fn resolve_in(&self, space: IdSpace, id: &str) -> Option<&str> {
        match space {
            IdSpace::Provider => self.resolve_provider(id),
            IdSpace::Row => self.resolve_row(id),
        }
    }

    /// Delegates to `resolve_in` so the namespace choice lives in exactly one
    /// place — two copies of that `match` is two places for the split to rot.
    pub(crate) fn resolve_index_in(&self, space: IdSpace, id: &str) -> Option<usize> {
        #[cfg(test)]
        self.probe(true);
        let row_id = self.resolve_in(space, id)?;
        #[cfg(test)]
        self.probe(false);
        self.by_row_id.get(row_id).copied()
    }

    /// Resolve an incoming history/page record to the row it belongs to.
    ///
    /// A record the provider named is matched in the PROVIDER namespace, the only
    /// space where its identity means anything. A relay-synthesized record — a
    /// per-turn diff re-derived from a read — carries no provider name and is
    /// matched by its deterministic row key instead.
    pub(crate) fn resolve_incoming(&self, record: &TranscriptRecord) -> Option<&str> {
        match record.provider_item_id.as_deref() {
            Some(provider_item_id) => self.resolve_provider(provider_item_id),
            None => self.resolve_row(&record.row_id),
        }
    }

    pub(crate) fn resolve_row_index(&self, row_id: &str) -> Option<usize> {
        // Every probe is counted, so `probe_visited` measures the work this does.
        // Reintroducing a scan here means counting per row, and the complexity
        // test below starts growing with transcript length.
        #[cfg(test)]
        self.probe(true);
        self.by_row_id.get(row_id).copied()
    }

    pub(crate) fn resolve_provider_index(&self, provider_item_id: &str) -> Option<usize> {
        #[cfg(test)]
        self.probe(true);
        let row_id = self.resolve_provider(provider_item_id)?;
        #[cfg(test)]
        self.probe(false);
        self.by_row_id.get(row_id).copied()
    }

    #[cfg(test)]
    fn probe(&self, reset: bool) {
        use std::sync::atomic::Ordering;
        if reset {
            self.probe_visited.store(1, Ordering::Relaxed);
        } else {
            self.probe_visited.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn index_of_row(&self, row_id: &str) -> Option<usize> {
        self.by_row_id.get(row_id).copied()
    }

    pub(crate) fn contains_row(&self, row_id: &str) -> bool {
        self.by_row_id.contains_key(row_id)
    }

    pub(crate) fn get_row(&self, row_id: &str) -> Option<&TranscriptRecord> {
        self.resolve_row_index(row_id)
            .map(|index| &self.rows[index])
    }

    pub(crate) fn get_by_provider(&self, provider_item_id: &str) -> Option<&TranscriptRecord> {
        self.resolve_provider_index(provider_item_id)
            .map(|index| &self.rows[index])
    }

    /// The id the PROVIDER knows this row by, for an operation addressed to the
    /// provider (a fork point, a detail fetch).
    ///
    /// `None` means only the relay has ever named this row, so there is nothing the
    /// provider could match — the caller must degrade deliberately rather than send
    /// a string the provider has never issued.
    pub(crate) fn provider_item_id(&self, row_id: &str) -> Option<&str> {
        self.get_row(row_id)?.provider_item_id.as_deref()
    }

    /// A row id that is free right now, preferring `candidate`.
    ///
    /// Adopting the first id a row is seen under is what keeps the wire value
    /// stable for every client that already holds it. When the candidate is
    /// already spoken for by an UNRELATED row, minting a synthetic id is the
    /// only safe answer — merging two logically distinct rows under one id
    /// silently destroys one of them, and no later event can undo that.
    pub(crate) fn mint_row_id(&mut self, candidate: &str) -> String {
        if !candidate.is_empty() && !self.by_row_id.contains_key(candidate) {
            return candidate.to_string();
        }
        loop {
            self.synthetic_seq = self.synthetic_seq.saturating_add(1);
            let minted = if candidate.is_empty() {
                format!("row:{}", self.synthetic_seq)
            } else {
                format!("{candidate}#row{}", self.synthetic_seq)
            };
            if !self.by_row_id.contains_key(&minted) {
                return minted;
            }
        }
    }

    /// Record that `provider_item_id` names `row_id`.
    ///
    /// Refuses to re-point a provider id that already names a different live
    /// row: the second claim is a stale or duplicated event, and honouring it
    /// would let one provider id drag two rows together.
    pub(crate) fn bind_provider_item_id(&mut self, row_id: &str, provider_item_id: &str) -> bool {
        if provider_item_id.is_empty() || !self.by_row_id.contains_key(row_id) {
            return false;
        }
        if let Some(existing) = self.row_id_by_provider_item_id.get(provider_item_id) {
            if existing != row_id && self.by_row_id.contains_key(existing) {
                return false;
            }
        }
        // A provider id that happens to equal some OTHER row's key is fine and must
        // be recorded: the namespaces are separate, so provider `x` naming row
        // `x#row1` while an unrelated relay row owns key `x` is exactly the state
        // a collision has to be able to reach.
        self.row_id_by_provider_item_id
            .insert(provider_item_id.to_string(), row_id.to_string());
        if let Some(index) = self.by_row_id.get(row_id).copied() {
            let row = &mut self.rows[index];
            if row.provider_item_id.is_none() {
                row.provider_item_id = Some(provider_item_id.to_string());
            }
        }
        true
    }

    /// Append a row, minting a free id if the one it carries is taken.
    /// Returns the row id it actually landed under.
    pub(crate) fn push(&mut self, mut record: TranscriptRecord) -> String {
        let row_id = self.mint_row_id(&record.row_id);
        record.row_id = row_id.clone();
        let provider_item_id = record.provider_item_id.clone();
        self.by_row_id.insert(row_id.clone(), self.rows.len());
        self.rows.push(record);
        if let Some(provider_item_id) = provider_item_id {
            self.bind_provider_item_id(&row_id, &provider_item_id);
        }
        row_id
    }

    /// The one `&mut` door into a row, addressed in the ROW namespace.
    ///
    /// The closure may touch content freely, but the row's identity is restored
    /// afterwards: `row_id` because a rename is not expressible on the wire,
    /// `order_seq` because it is birth-fixed and clients may already be sorting by
    /// it, and `withdrawn` because it is absorbing. Restoring rather than trusting
    /// the closure is what makes those invariants unbreakable from outside — the
    /// whole-record replace inside `merge_runtime_entry` overwrites all three.
    pub(crate) fn update_row<R>(
        &mut self,
        row_id: &str,
        edit: impl FnOnce(&mut TranscriptRecord) -> R,
    ) -> Option<R> {
        let index = self.resolve_row_index(row_id)?;
        let identity = RowIdentity::of(&self.rows[index]);
        let outcome = edit(&mut self.rows[index]);
        identity.restore(&mut self.rows[index]);
        if let Some(provider_item_id) = self.rows[index].provider_item_id.clone() {
            self.bind_provider_item_id(&identity.row_id.clone(), &provider_item_id);
        }
        Some(outcome)
    }

    /// Apply `edit` to every row — for the sweeps that cannot name their target up
    /// front (withdrawal by predicate). Same identity rules as `update_row`.
    pub(crate) fn update_all(&mut self, mut edit: impl FnMut(&mut TranscriptRecord)) {
        for row in self.rows.iter_mut() {
            let identity = RowIdentity::of(row);
            edit(row);
            identity.restore(row);
        }
        self.reindex();
    }

    /// Insert a run of rows immediately before `index`, minting ids as needed.
    pub(crate) fn insert_before(&mut self, index: usize, records: Vec<TranscriptRecord>) {
        let mut records = records;
        for record in records.iter_mut() {
            record.row_id = self.mint_row_id(&record.row_id);
            // Claim it immediately so two rows in one batch cannot mint the same id.
            self.by_row_id.insert(record.row_id.clone(), usize::MAX);
        }
        for (offset, record) in records.into_iter().enumerate() {
            self.rows.insert(index + offset, record);
        }
        self.reindex();
    }

    /// Replace every row wholesale (history prepend rebuilds the vector).
    ///
    /// Goes through `push` so a duplicate id inside `rows` is re-minted rather
    /// than silently collapsing two rows into one index entry.
    pub(crate) fn replace_all(&mut self, rows: Vec<TranscriptRecord>) {
        let aliases = std::mem::take(&mut self.row_id_by_provider_item_id);
        self.rows = Vec::with_capacity(rows.len());
        self.by_row_id.clear();
        for row in rows {
            self.push(row);
        }
        // Aliases outlive the rebuild when their row came along with it — a
        // prepend must not forget that a provider id already names a live row.
        for (provider_item_id, row_id) in aliases {
            if self.by_row_id.contains_key(&row_id) {
                self.row_id_by_provider_item_id
                    .entry(provider_item_id)
                    .or_insert(row_id);
            }
        }
    }

    pub(crate) fn clear(&mut self) {
        self.rows.clear();
        self.by_row_id.clear();
        self.row_id_by_provider_item_id.clear();
    }

    pub(crate) fn rows(&self) -> &[TranscriptRecord] {
        &self.rows
    }

    fn reindex(&mut self) {
        self.by_row_id.clear();
        for (index, row) in self.rows.iter().enumerate() {
            self.by_row_id.insert(row.row_id.clone(), index);
        }
        self.row_id_by_provider_item_id
            .retain(|_, row_id| self.by_row_id.contains_key(row_id));
        for row in self.rows.iter() {
            if let Some(provider_item_id) = row.provider_item_id.as_ref() {
                self.row_id_by_provider_item_id
                    .entry(provider_item_id.clone())
                    .or_insert_with(|| row.row_id.clone());
            }
        }
    }

    /// How many rows the last `resolve_index` had to visit. Zero with the index
    /// in place; a linear scan would report the row's distance from the head.
    #[cfg(test)]
    pub(crate) fn probe_visited(&self) -> usize {
        self.probe_visited
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Every index entry agrees with the Vec, and nothing is missing from it.
    #[cfg(test)]
    pub(crate) fn assert_indexes_consistent(&self) {
        assert_eq!(
            self.by_row_id.len(),
            self.rows.len(),
            "row index must name every row exactly once"
        );
        for (index, row) in self.rows.iter().enumerate() {
            assert_eq!(
                self.by_row_id.get(&row.row_id).copied(),
                Some(index),
                "row {} is indexed at the wrong position",
                row.row_id
            );
        }
        for (provider_item_id, row_id) in &self.row_id_by_provider_item_id {
            assert!(
                self.by_row_id.contains_key(row_id),
                "alias {provider_item_id} points at a row that is gone"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TranscriptEntryKind;

    fn row(row_id: &str, text: &str) -> TranscriptRecord {
        TranscriptRecord {
            row_id: row_id.to_string(),
            provider_item_id: None,
            kind: TranscriptEntryKind::AgentText,
            text: Some(text.to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            order_seq: 0,
            withdrawn: false,
            last_live_upsert_revision: None,
        }
    }

    /// The placeholder/echo shape: one row, one id, before and after the
    /// provider names it. A second row here is one send rendered twice.
    #[test]
    fn a_provider_echo_binds_to_the_placeholder_without_renaming_it() {
        let mut store = ThreadTranscript::new();
        let row_id = store.push(row("codex:user-reserve:gen:t1:1", "hello"));

        assert!(store.bind_provider_item_id(&row_id, "msg_abc"));

        assert_eq!(store.len(), 1, "the echo must not add a row");
        assert_eq!(
            store.resolve_provider("msg_abc"),
            Some("codex:user-reserve:gen:t1:1"),
            "the provider id resolves to the row it named"
        );
        assert_eq!(
            store.resolve_row("codex:user-reserve:gen:t1:1"),
            Some("codex:user-reserve:gen:t1:1"),
            "and the row keeps the id already published to clients"
        );
        store.assert_indexes_consistent();
    }

    /// Two provider ids for one logical row (a tool's request and its result)
    /// must land on one row, not two.
    #[test]
    fn several_provider_ids_can_alias_one_row_without_making_twins() {
        let mut store = ThreadTranscript::new();
        let row_id = store.push(row("tool:call-1", "reading"));

        assert!(store.bind_provider_item_id(&row_id, "call-1\nfc_0"));
        assert!(store.bind_provider_item_id(&row_id, "replay-0-1"));

        assert_eq!(store.len(), 1);
        assert_eq!(
            store.resolve_row("tool:call-1"),
            Some("tool:call-1"),
            "the row is reachable by its own key"
        );
        for named in ["call-1\nfc_0", "replay-0-1"] {
            assert_eq!(
                store.resolve_provider(named),
                Some("tool:call-1"),
                "provider id `{named}` must name the one row"
            );
        }
        store.assert_indexes_consistent();
    }

    /// An alias may never be re-pointed at a second row. Honouring the later
    /// claim would let one provider id drag two unrelated rows together.
    #[test]
    fn an_alias_cannot_be_stolen_by_a_second_row() {
        let mut store = ThreadTranscript::new();
        let first = store.push(row("row-a", "a"));
        let second = store.push(row("row-b", "b"));
        assert!(store.bind_provider_item_id(&first, "prov-1"));

        assert!(
            !store.bind_provider_item_id(&second, "prov-1"),
            "the second claim on a live alias must be refused"
        );
        assert_eq!(store.resolve_provider("prov-1"), Some("row-a"));
        store.assert_indexes_consistent();
    }

    /// The collision rule: a candidate id already spoken for by an unrelated row
    /// gets a synthetic id. Merging would destroy one of the two messages.
    #[test]
    fn a_colliding_candidate_id_mints_a_new_row_instead_of_merging() {
        let mut store = ThreadTranscript::new();
        let first = store.push(row("shared-id", "first message"));
        let second = store.push(row("shared-id", "second message"));

        assert_ne!(first, second, "the collision must not reuse the id");
        assert_eq!(store.len(), 2, "two messages stay two rows");
        assert_eq!(
            store
                .get_row(&first)
                .and_then(|r| r.text.clone())
                .as_deref(),
            Some("first message")
        );
        assert_eq!(
            store
                .get_row(&second)
                .and_then(|r| r.text.clone())
                .as_deref(),
            Some("second message")
        );
        store.assert_indexes_consistent();
    }

    /// THE collision the split exists for: a relay row owns key `x`, and a
    /// DIFFERENT provider row arrives calling itself `x`.
    ///
    /// With one blended resolver the provider event landed on the relay row and
    /// overwrote it, and the alias could never be recorded because it shadowed a
    /// row key — so the collision had no representable state at all. The two
    /// namespaces must hold both facts at once.
    #[test]
    fn a_provider_id_may_shadow_an_unrelated_row_key_without_crossing_rows() {
        let mut store = ThreadTranscript::new();
        let relay_row = store.push(row("x", "the relay's row"));

        // A provider row that calls itself `x` cannot take the key, so it mints.
        let provider_row = store.push(TranscriptRecord {
            provider_item_id: Some("x".to_string()),
            ..row("x", "the provider's row")
        });

        assert_ne!(relay_row, provider_row, "two rows, two keys");
        assert_eq!(store.len(), 2);
        assert_eq!(
            store.resolve_row("x"),
            Some("x"),
            "the row namespace still answers with the relay's row"
        );
        assert_eq!(
            store.resolve_provider("x"),
            Some(provider_row.as_str()),
            "the provider namespace answers with the provider's row"
        );
        assert_eq!(
            store.get_row("x").and_then(|r| r.text.clone()).as_deref(),
            Some("the relay's row")
        );
        assert_eq!(
            store
                .get_by_provider("x")
                .and_then(|r| r.text.clone())
                .as_deref(),
            Some("the provider's row")
        );
        // A relay row nobody bound is invisible in the provider namespace, which is
        // what stops a provider event from ever reaching it.
        assert_eq!(store.provider_item_id(&relay_row), None);
        store.assert_indexes_consistent();
    }

    /// Every structural mutation leaves the derived indexes exact.
    #[test]
    fn the_indexes_survive_every_structural_mutation() {
        let mut store = ThreadTranscript::new();
        store.push(row("a", "a"));
        store.push(row("c", "c"));
        store.assert_indexes_consistent();

        store.insert_before(1, vec![row("b1", "b1"), row("b2", "b2")]);
        store.assert_indexes_consistent();
        assert_eq!(
            store.iter().map(|r| r.row_id.as_str()).collect::<Vec<_>>(),
            ["a", "b1", "b2", "c"]
        );

        let head = store.push(row("d", "d"));
        assert!(store.bind_provider_item_id(&head, "prov-d"));
        store.assert_indexes_consistent();

        let snapshot = store.rows().to_vec();
        store.replace_all(snapshot);
        store.assert_indexes_consistent();
        assert_eq!(
            store.resolve_provider("prov-d"),
            Some("d"),
            "a wholesale replace keeps aliases whose row came along"
        );

        store.update_all(|record| record.withdrawn = true);
        store.assert_indexes_consistent();
        assert!(store.iter().all(|r| r.withdrawn));
    }

    /// `row_id` is the one field a mutation may never touch. A rename is not
    /// expressible on the wire, so a caller that tries one must find it had no
    /// effect — not a repaired index pointing somewhere new.
    #[test]
    fn a_closure_cannot_rename_a_row_through_update_row() {
        let mut store = ThreadTranscript::new();
        let row_id = store.push(row("before", "text"));
        assert!(store.bind_provider_item_id(&row_id, "prov-1"));

        store
            .update_row("before", |record| record.row_id = "after".to_string())
            .expect("the row is there");

        assert_eq!(store[0].row_id, "before", "the rename must not take");
        assert_eq!(store.resolve_row("after"), None);
        assert_eq!(store.resolve_row("before"), Some("before"));
        assert_eq!(store.resolve_provider("prov-1"), Some("before"));
        store.assert_indexes_consistent();
    }

    /// The sharp version: renaming ONTO a live row would collapse two index
    /// entries into one and leave a row that is still rendered unreachable by id.
    #[test]
    fn an_attempted_rename_onto_a_live_row_cannot_strand_it() {
        let mut store = ThreadTranscript::new();
        store.push(row("row-a", "a"));
        store.push(row("row-b", "b"));

        store
            .update_row("row-a", |record| record.row_id = "row-b".to_string())
            .expect("the row is there");

        assert_eq!(store.len(), 2, "both rows still exist");
        assert_eq!(store.resolve_row("row-a"), Some("row-a"));
        assert_eq!(store.resolve_row("row-b"), Some("row-b"));
        assert_eq!(
            store
                .get_row("row-a")
                .and_then(|r| r.text.clone())
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            store
                .get_row("row-b")
                .and_then(|r| r.text.clone())
                .as_deref(),
            Some("b")
        );
        store.assert_indexes_consistent();
    }

    /// `order_seq` is assigned once at birth; a client may already be sorting by it.
    /// `withdrawn` is absorbing. Neither may be undone by a later mutation.
    #[test]
    fn update_row_keeps_order_seq_birth_fixed_and_withdrawn_absorbing() {
        let mut store = ThreadTranscript::new();
        let row_id = store.push(TranscriptRecord {
            order_seq: 4096,
            withdrawn: true,
            ..row("row-a", "a")
        });

        store
            .update_row(&row_id, |record| {
                record.order_seq = 17;
                record.withdrawn = false;
            })
            .expect("the row is there");

        assert_eq!(store[0].order_seq, 4096, "an issued order key never moves");
        assert!(store[0].withdrawn, "a tombstone cannot be cleared");
    }

    /// The by-predicate sweep has the same identity rules as the targeted door.
    #[test]
    fn update_all_cannot_change_identity_or_clear_a_tombstone() {
        let mut store = ThreadTranscript::new();
        store.push(TranscriptRecord {
            withdrawn: true,
            ..row("row-a", "a")
        });
        store.push(row("row-b", "b"));

        store.update_all(|record| {
            record.row_id = format!("{}-renamed", record.row_id);
            record.withdrawn = false;
        });

        assert_eq!(
            store.iter().map(|r| r.row_id.as_str()).collect::<Vec<_>>(),
            ["row-a", "row-b"],
            "a sweep cannot rename rows"
        );
        assert!(store[0].withdrawn, "nor resurrect a withdrawn one");
        store.assert_indexes_consistent();
    }

    /// The index exists to remove the linear scan. Resolution cost must not grow
    /// with the transcript, so the row at the far end costs the same as the first.
    #[test]
    fn resolution_cost_does_not_grow_with_the_transcript() {
        let mut small = ThreadTranscript::new();
        for index in 0..8 {
            small.push(row(&format!("row-{index}"), "x"));
        }
        let mut large = ThreadTranscript::new();
        for index in 0..20_000 {
            large.push(row(&format!("row-{index}"), "x"));
        }

        assert_eq!(small.resolve_row_index("row-7"), Some(7));
        let small_cost = small.probe_visited();
        assert_eq!(large.resolve_row_index("row-19999"), Some(19_999));
        let large_cost = large.probe_visited();

        assert_eq!(
            small_cost, large_cost,
            "the last row of a 20k transcript must cost what the last row of an 8-row one costs \
             (a scan would report ~19999 vs ~7)"
        );
        assert!(
            large_cost <= 2,
            "resolution must be a constant number of probes, got {large_cost}"
        );
    }
}
