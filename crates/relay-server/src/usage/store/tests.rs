use std::io::Write;

use tempfile::TempDir;

use super::*;

fn event(at: u64, provider: &str, model: &str, total: u64) -> TokenEvent {
    TokenEvent {
        at,
        provider: provider.to_string(),
        model: Some(model.to_string()),
        thread_id: "thread-1".to_string(),
        turn_id: Some("turn-1".to_string()),
        usage: TokenUsage {
            input: total / 4,
            cached_input: total / 4,
            cache_write: total / 4,
            output: total / 4,
            reasoning_output: 0,
            total,
        },
        ..TokenEvent::default()
    }
}

fn open_in(dir: &TempDir) -> UsageStore {
    UsageStore::open(&dir.path().join("sealwire.db"))
}

/// Three reviewer prompts bill under one role. Without the phase on the row
/// there is no way to price `design_review` against `mr_gate`.
#[test]
fn a_row_carries_the_phase_so_the_three_review_prompts_price_apart() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    for (phase, total) in [("design_review", 1_000u64), ("mr_gate", 4_000)] {
        store.record(&TokenEvent {
            at: 100,
            provider: "codex".to_string(),
            model: Some("gpt-5".to_string()),
            thread_id: format!("reviewer-{phase}"),
            role: Some("reviewer".to_string()),
            team_run_id: Some("run-1".to_string()),
            phase: Some(phase.to_string()),
            usage: TokenUsage {
                total,
                ..TokenUsage::default()
            },
            ..TokenEvent::default()
        });
    }

    let conn = Connection::open(dir.path().join("sealwire.db")).expect("open");
    let mut statement = conn
        .prepare("SELECT phase, total FROM token_event ORDER BY total")
        .expect("prepare");
    let rows: Vec<(Option<String>, u64)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .map(|row| row.expect("row"))
        .collect();

    assert_eq!(
        rows,
        vec![
            (Some("design_review".to_string()), 1_000),
            (Some("mr_gate".to_string()), 4_000),
        ],
        "the design reviewer and the MR gate must be separable on the row"
    );
}

/// Claude rows written before `ClaudeUsageTracker` existed hold the SDK's
/// session-cumulative figures; summing them bills the triangular number.
#[test]
fn the_inherited_cumulative_claude_rows_are_differenced_in_place() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");

    {
        let store = open_in(&dir);
        for turn in 1..=10u64 {
            store.record(&TokenEvent {
                at: turn,
                provider: "claude_code".to_string(),
                model: Some("claude-opus-5".to_string()),
                thread_id: "thread-a".to_string(),
                turn_id: Some(format!("turn-{turn}")),
                usage: TokenUsage {
                    input: turn * 1_000,
                    total: turn * 1_000,
                    ..TokenUsage::default()
                },
                cost_usd: Some(turn as f64 * 0.5),
                ..TokenEvent::default()
            });
        }
        // Rewind so the rows read as inherited from before the fix.
        rusqlite::Connection::open(&path)
            .expect("open")
            .execute_batch("PRAGMA user_version = 6;")
            .expect("rewind");
    }

    let _store = open_in(&dir);
    let conn = rusqlite::Connection::open(&path).expect("reopen");
    let (total, input, cost): (u64, u64, f64) = conn
        .query_row(
            "SELECT SUM(total), SUM(input), SUM(COALESCE(cost_usd, 0)) FROM token_event",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("query");

    assert_eq!(
        total, 10_000,
        "ten 1k turns must sum to 10k; {total} means the cumulative rows \
         were left as-is"
    );
    assert_eq!(
        input, 10_000,
        "every component is differenced, not just total"
    );
    assert!(
        (cost - 5.0).abs() < 1e-9,
        "cost is cumulative too: ten $0.50 turns must sum to $5.00, not ${cost}"
    );
}

/// Rows written through schema v8 kept Codex's inclusive `inputTokens` beside
/// its cached subset. Normalize the historical rows once, without touching
/// Claude where the provider already reports uncached input separately.
#[test]
fn migration_nine_removes_cached_input_from_legacy_codex_input() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");

    {
        let store = open_in(&dir);
        for (provider, input, cached_input) in [("codex", 1_000, 900), ("claude_code", 100, 900)] {
            store.record(&TokenEvent {
                at: 100,
                provider: provider.to_string(),
                model: Some("model".to_string()),
                thread_id: provider.to_string(),
                usage: TokenUsage {
                    input,
                    cached_input,
                    output: 100,
                    total: 1_100,
                    ..TokenUsage::default()
                },
                ..TokenEvent::default()
            });
        }
        Connection::open(&path)
            .expect("open")
            .execute_batch("PRAGMA user_version = 8;")
            .expect("rewind to the legacy schema");
    }

    let _store = open_in(&dir);
    let conn = Connection::open(&path).expect("reopen");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("query migrated schema version");
    let codex: (u64, u64, u64) = conn
        .query_row(
            "SELECT input, cached_input, total FROM token_event WHERE provider = 'codex'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("query codex");
    let claude: (u64, u64) = conn
        .query_row(
            "SELECT input, cached_input FROM token_event WHERE provider = 'claude_code'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query claude");

    assert_eq!(
        version, LEDGER_SCHEMA_VERSION,
        "data and schema stamp commit together"
    );
    assert_eq!(codex, (100, 900, 1_100));
    assert_eq!(
        claude,
        (100, 900),
        "Claude input is already the uncached remainder"
    );

    drop(conn);
    drop(_store);
    let _reopened = open_in(&dir);
    let input_after_second_open: u64 = Connection::open(&path)
        .expect("reopen again")
        .query_row(
            "SELECT input FROM token_event WHERE provider = 'codex'",
            [],
            |row| row.get(0),
        )
        .expect("query after second open");
    assert_eq!(
        input_after_second_open, 100,
        "the migration must run exactly once"
    );
}

/// **The load-bearing invariant of this whole module.**
///
/// `session.json` fails closed and catastrophically: one bad byte and
/// `AppState::new` discards the entire file, unpairing every device. The ledger
/// must fail the other way — an unreadable database costs you a number, never a
/// relay.
///
/// This test pins the store half of that (a corrupt file degrades rather than
/// panicking or returning an error the caller must handle);
/// `relay_boot_survives_a_corrupt_token_ledger` pins the boot half.
#[test]
fn a_corrupt_ledger_database_degrades_instead_of_failing_the_relay() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");
    let mut file = std::fs::File::create(&path).expect("create");
    file.write_all(b"this is emphatically not a sqlite database")
        .expect("write garbage");
    drop(file);

    // Must not panic, and must not return an Err the caller has to handle.
    let store = UsageStore::open(&path);

    assert!(
        !store.is_enabled(),
        "a corrupt ledger must report itself disabled so a surface can say \
         'unavailable' rather than render a confident zero"
    );
    // Every operation stays callable and inert.
    store.record(&event(1, "codex", "gpt-5", 1_000));
    assert!(store.by_provider_model(0, u64::MAX).is_empty());
    assert!(store.by_day(0, u64::MAX).is_empty());
}

/// A file written by a NEWER build must not be downgraded under a build that
/// cannot read it. Degrade this run instead.
#[test]
fn a_ledger_from_a_newer_build_is_refused_rather_than_downgraded() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch("PRAGMA user_version = 99;")
            .expect("stamp a future version");
    }

    let store = UsageStore::open(&path);
    assert!(!store.is_enabled(), "a future schema degrades this run");

    // And the file is left intact for the build that does understand it.
    let conn = Connection::open(&path).expect("reopen");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read version");
    assert_eq!(version, 99, "the newer schema stamp must not be rewritten");
}

/// The constant and the migration chain must agree.
///
/// `migrate` refuses any file whose `user_version` is above
/// `LEDGER_SCHEMA_VERSION`. So if a numbered migration stamps HIGHER than the
/// constant, the first open migrates the file and every open after it refuses
/// the very file this build just wrote — the ledger silently disables itself on
/// the second launch, and the only symptom a user sees is token usage quietly
/// staying at zero.
#[test]
fn the_schema_version_constant_matches_what_the_migrations_stamp() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");
    assert!(UsageStore::open(&path).is_enabled(), "a fresh ledger opens");

    let conn = Connection::open(&path).expect("reopen");
    let stamped: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read version");
    assert_eq!(
        stamped, LEDGER_SCHEMA_VERSION,
        "a fresh ledger stamped user_version {stamped}, but this build refuses \
         anything above {LEDGER_SCHEMA_VERSION}. Bump LEDGER_SCHEMA_VERSION to \
         match the highest numbered migration."
    );
}

/// Opening the same path twice must be a no-op the second time, not a reset.
#[test]
fn reopening_an_existing_ledger_preserves_its_rows() {
    let dir = TempDir::new().expect("tempdir");
    open_in(&dir).record(&event(1_000, "codex", "gpt-5", 400));

    let reopened = open_in(&dir);
    assert!(reopened.is_enabled());
    let rows = reopened.by_provider_model(0, u64::MAX);
    assert_eq!(rows.len(), 1, "migration re-ran and dropped the table");
    assert_eq!(rows[0].usage.total, 400);
}

#[test]
fn usage_groups_by_provider_and_model() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    store.record(&event(100, "codex", "gpt-5", 1_000));
    store.record(&event(200, "codex", "gpt-5", 500));
    store.record(&event(300, "codex", "gpt-5-mini", 40));
    store.record(&event(400, "claude_code", "claude-opus-5", 9_000));

    let rows = store.by_provider_model(0, u64::MAX);
    assert_eq!(rows.len(), 3, "one row per (provider, model)");

    // Ordered by total descending, so the biggest consumer reads first.
    assert_eq!(rows[0].provider, "claude_code");
    assert_eq!(rows[0].usage.total, 9_000);
    assert_eq!(rows[0].turns, 1);

    let codex_gpt5 = rows
        .iter()
        .find(|row| row.model.as_deref() == Some("gpt-5"))
        .expect("gpt-5 row");
    assert_eq!(codex_gpt5.usage.total, 1_500, "two turns summed");
    assert_eq!(codex_gpt5.turns, 2);
}

/// The cache breakdown is the whole point of keeping the columns apart — it has
/// to survive aggregation, not just the parse.
#[test]
fn the_cache_breakdown_survives_aggregation() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    for _ in 0..3 {
        store.record(&TokenEvent {
            at: 100,
            provider: "claude_code".to_string(),
            model: Some("claude-opus-5".to_string()),
            thread_id: "t".to_string(),
            usage: TokenUsage {
                input: 10,
                cached_input: 900,
                cache_write: 50,
                output: 40,
                reasoning_output: 0,
                total: 1_000,
            },
            ..TokenEvent::default()
        });
    }

    let rows = store.by_provider_model(0, u64::MAX);
    let row = rows.first().expect("one group");
    assert_eq!(row.usage.input, 30);
    assert_eq!(
        row.usage.cached_input, 2_700,
        "cache reads aggregate separately"
    );
    assert_eq!(
        row.usage.cache_write, 150,
        "cache writes aggregate separately"
    );
    assert_eq!(row.usage.output, 120);
    assert_eq!(row.usage.total, 3_000);
}

#[test]
fn the_window_is_half_open() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    store.record(&event(100, "codex", "gpt-5", 7));
    store.record(&event(200, "codex", "gpt-5", 11));
    store.record(&event(300, "codex", "gpt-5", 13));

    let rows = store.by_provider_model(100, 300);
    assert_eq!(
        rows[0].usage.total, 18,
        "`since` is inclusive and `until` exclusive, so adjacent windows \
         neither double-count nor drop a row"
    );
}

/// `SUM(cost_usd)` over unpriced rows is `0`, which would render as a confident
/// "$0.00" for a subscription plan that reports no cost at all. Absent and free
/// are different facts.
#[test]
fn an_unpriced_group_reports_no_cost_rather_than_zero() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    store.record(&event(100, "codex", "gpt-5", 1_000));

    let rows = store.by_provider_model(0, u64::MAX);
    assert_eq!(
        rows[0].cost_usd, None,
        "a provider that reported no cost must not read as free"
    );

    store.record(&TokenEvent {
        cost_usd: Some(0.25),
        ..event(150, "claude_code", "claude-opus-5", 1_000)
    });
    let priced = store
        .by_provider_model(0, u64::MAX)
        .into_iter()
        .find(|row| row.provider == "claude_code")
        .expect("claude row");
    assert_eq!(priced.cost_usd, Some(0.25));
}

/// A partially-priced group must report the cost it does know, not discard it.
#[test]
fn a_partially_priced_group_reports_the_costs_it_has() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    store.record(&event(100, "claude_code", "claude-opus-5", 500));
    store.record(&TokenEvent {
        cost_usd: Some(1.5),
        ..event(150, "claude_code", "claude-opus-5", 500)
    });

    let rows = store.by_provider_model(0, u64::MAX);
    assert_eq!(rows[0].cost_usd, Some(1.5));
    assert_eq!(rows[0].turns, 2, "both turns still count toward tokens");
}

/// A provider that never names the model must not have its rows folded into a
/// neighbouring model's bucket.
#[test]
fn an_unknown_model_is_its_own_bucket() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    store.record(&event(100, "cursor", "composer-1", 100));
    store.record(&TokenEvent {
        model: None,
        ..event(150, "cursor", "ignored", 900)
    });

    let rows = store.by_provider_model(0, u64::MAX);
    assert_eq!(rows.len(), 2);
    let unknown = rows
        .iter()
        .find(|row| row.model.is_none())
        .expect("unknown");
    assert_eq!(unknown.usage.total, 900);
}

#[test]
fn by_day_buckets_each_calendar_day_separately() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    // Two timestamps ~48h apart land in different local days under every zone.
    store.record(&event(1_700_000_000, "codex", "gpt-5", 100));
    store.record(&event(1_700_000_000 + 172_800, "codex", "gpt-5", 250));

    let rows = store.by_day(0, u64::MAX);
    assert_eq!(rows.len(), 2, "two days, two buckets");
    assert!(
        rows.iter().all(|row| row.day.is_some()),
        "each row is dated"
    );
    assert!(
        rows[0].day < rows[1].day,
        "days come back oldest-first so a chart can plot them directly"
    );
    assert_eq!(rows.iter().map(|row| row.usage.total).sum::<u64>(), 350);
}

/// A ledger written by migration 1 must gain migration 2's columns in place,
/// keeping its rows. If this ever drops the table instead, everyone's history
/// vanishes on upgrade.
#[test]
fn migrating_an_existing_ledger_adds_columns_without_losing_rows() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");
    {
        // Exactly the v1 schema, stamped at version 1.
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE token_event (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 at INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT,
                 thread_id TEXT NOT NULL, turn_id TEXT, team_run_id TEXT, role TEXT,
                 input INTEGER NOT NULL DEFAULT 0, cached_input INTEGER NOT NULL DEFAULT 0,
                 cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
                 reasoning_output INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
                 cost_usd REAL, context_window INTEGER
             );
             INSERT INTO token_event (at, provider, thread_id, total)
                 VALUES (100, 'codex', 'legacy-thread', 4242);
             PRAGMA user_version = 1;",
        )
        .expect("build a v1 ledger");
    }

    let store = UsageStore::open(&path);
    assert!(store.is_enabled(), "a v1 ledger must migrate, not degrade");

    let rows = store.by_provider_model(0, i64::MAX as u64);
    assert_eq!(rows.len(), 1, "the pre-existing row survived the migration");
    assert_eq!(rows[0].usage.total, 4_242);

    // And the new columns are usable.
    store.record(&TokenEvent {
        failed: true,
        sub_task_id: Some("step-3".to_string()),
        team_id: Some("infra".to_string()),
        ..event(200, "codex", "gpt-5", 10)
    });
}

/// A disabled store is inert but still callable — no branch at the call site.
#[test]
fn a_disabled_store_is_inert_but_callable() {
    let store = UsageStore::disabled();
    assert!(!store.is_enabled());
    store.record(&event(1, "codex", "gpt-5", 1_000));
    assert!(store.by_provider_model(0, u64::MAX).is_empty());
    assert!(store.by_day(0, u64::MAX).is_empty());
}

#[test]
fn budget_hit_is_one_row_per_local_day_and_counts_holds() {
    let dir = TempDir::new().unwrap();
    let store = open_in(&dir);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let day_start = store.local_midnight_containing(now);
    store.record_budget_hit(day_start + 3_600, 5_000_000, 5_000_000, "hold_new_work");
    store.record_budget_hit(day_start + 4_000, 5_100_000, 5_000_000, "hold_new_work");
    store.record_budget_hit(day_start + 5_000, 5_200_000, 5_000_000, "hold_new_work");
    let hits = store.budget_hits(day_start, day_start + 86_400);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].hold_count, 3);
    assert_eq!(hits[0].at, day_start + 3_600, "first hit time is sticky");
    assert_eq!(hits[0].spent, 5_200_000, "spent tracks the latest refuse");
    assert_eq!(hits[0].cap, 5_000_000);
    assert_eq!(hits[0].policy, "hold_new_work");
}

/// The daily budget's day boundary, pinned by properties true in every timezone.
///
/// The bug these caught: the SQL applied the `'localtime'` modifier twice —
/// once to read the local calendar date, and again when turning that date back
/// into an instant. The second one converts a UTC instant TO local time, which
/// is the opposite of what interpreting a local date string requires, so the
/// answer came out shifted by the offset instead of back to midnight.
///
/// East of UTC that put "the start of today" in the FUTURE for the first hours
/// of every local day. `usage_budget_verdict` then asked for the window
/// `[day_start, now]` with `day_start > now`, read zero spend, and let every
/// turn through: the daily cap silently stopped enforcing overnight and
/// under-counted by the offset for the rest of the day. In UTC the double shift
/// is zero, which is why CI never saw it.
#[test]
fn local_midnight_is_never_in_the_future_and_is_todays() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    let now = crate::state::unix_now();

    let midnight = store.local_midnight_containing(now);

    assert!(
        midnight <= now,
        "the start of today cannot be after now (midnight={midnight}, now={now}); \
a budget window of [midnight, now] would be inverted and read as zero spend"
    );
    assert!(
        now - midnight < 86_400,
        "the start of today cannot be more than a day ago (midnight={midnight}, now={now})"
    );
}

/// And it is the start of the day `now` falls in, not some other day's.
#[test]
fn local_midnight_lands_on_the_same_local_day() {
    let dir = TempDir::new().expect("tempdir");
    let store = open_in(&dir);
    let now = crate::state::unix_now();

    let midnight = store.local_midnight_containing(now);

    // Spend recorded a second into the local day must fall inside the window the
    // budget gate asks for. Under the old shift this failed for the whole offset.
    let just_after_midnight = midnight + 1;
    assert!(
        just_after_midnight <= now || midnight == now,
        "the first second of today must be countable (midnight={midnight}, now={now})"
    );
}

#[test]
fn migration_five_adds_review_comment_tables() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch("PRAGMA user_version = 4;")
            .expect("stamp v4");
    }

    let store = UsageStore::open(&path);
    assert!(store.is_enabled(), "a v4 ledger must migrate to v5");

    let conn = Connection::open(&path).expect("reopen");
    for table in [
        "review_comment",
        "review_comment_event",
        "file_review_state",
    ] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .expect("query table");
        assert_eq!(exists, 1, "{table} must exist after migration 5");
    }

    let content_hash_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('file_review_state') WHERE name = 'content_hash'",
            [],
            |row| row.get(0),
        )
        .expect("query content_hash column");
    assert_eq!(
        content_hash_column, 1,
        "file_review_state must store content_hash"
    );

    let version_after: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read version");
    assert_eq!(
        version_after, LEDGER_SCHEMA_VERSION,
        "review tables must migrate all the way to the current schema"
    );
}

#[test]
fn migration_six_drops_legacy_integer_tick_column() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("sealwire.db");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "PRAGMA user_version = 5;
             CREATE TABLE file_review_state (
                 scope TEXT NOT NULL,
                 path TEXT NOT NULL,
                 side TEXT NOT NULL,
                 base_commit TEXT NOT NULL DEFAULT '',
                 last_tick_at INTEGER NOT NULL DEFAULT 0,
                 tick INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (scope, path, side, base_commit)
             );",
        )
        .expect("seed legacy v5");
    }

    let _store = UsageStore::open(&path);
    let conn = Connection::open(&path).expect("reopen");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read version");
    assert_eq!(version, LEDGER_SCHEMA_VERSION);

    let legacy_tick_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('file_review_state') WHERE name = 'tick'",
            [],
            |row| row.get(0),
        )
        .expect("query tick column");
    assert_eq!(legacy_tick_column, 0, "integer tick column must be removed");
}
