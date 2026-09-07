use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;

use super::LocalCodexStore;

fn unique_temp_dir(label: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_secs();
    std::env::temp_dir().join(format!(
        "agent-relay-codex-local-{label}-{}-{}",
        std::process::id(),
        now
    ))
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent directory should be creatable");
    }
    fs::write(path, contents).expect("file should be writable");
}

fn seed_state_db(path: &Path, thread_id: &str, rollout_path: &Path) {
    let connection = Connection::open(path).expect("state db should open");
    connection
        .execute_batch(
            "
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source TEXT NOT NULL,
                model_provider TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                sandbox_policy TEXT NOT NULL,
                approval_mode TEXT NOT NULL,
                tokens_used INTEGER NOT NULL DEFAULT 0,
                has_user_event INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at INTEGER,
                git_sha TEXT,
                git_branch TEXT,
                git_origin_url TEXT,
                cli_version TEXT NOT NULL DEFAULT '',
                first_user_message TEXT NOT NULL DEFAULT '',
                agent_nickname TEXT,
                agent_role TEXT,
                memory_mode TEXT NOT NULL DEFAULT 'enabled',
                model TEXT,
                reasoning_effort TEXT,
                agent_path TEXT
            );
            CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, generated_at INTEGER NOT NULL);
            CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, input_schema TEXT NOT NULL, defer_loading INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, message TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE agent_job_items (job_id TEXT NOT NULL, item_id TEXT NOT NULL, row_index INTEGER NOT NULL, source_id TEXT, row_json TEXT NOT NULL, status TEXT NOT NULL, assigned_thread_id TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, result_json TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, reported_at INTEGER);
            ",
        )
        .expect("schema should create");

    connection
        .execute(
            "INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode) VALUES (?1, ?2, 1, 1, 'vscode', 'openai', '/tmp/project', 'Thread Title', '{}', 'on-request')",
            (&thread_id, &rollout_path.display().to_string()),
        )
        .expect("thread row should insert");
    connection
        .execute(
            "INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at) VALUES (?1, 1, 'raw', 'summary', 1)",
            [thread_id],
        )
        .expect("stage1 output should insert");
    connection
        .execute(
            "INSERT INTO thread_dynamic_tools (thread_id, position, name, description, input_schema, defer_loading) VALUES (?1, 0, 'tool', 'desc', '{}', 0)",
            [thread_id],
        )
        .expect("dynamic tool should insert");
    connection
        .execute(
            "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?1, 'child-thread', 'completed')",
            [thread_id],
        )
        .expect("spawn edge should insert");
    connection
        .execute(
            "INSERT INTO logs (ts, ts_nanos, level, target, message, thread_id, estimated_bytes) VALUES (1, 1, 'info', 'test', 'message', ?1, 1)",
            [thread_id],
        )
        .expect("state log should insert");
    connection
        .execute(
            "INSERT INTO agent_job_items (job_id, item_id, row_index, row_json, status, assigned_thread_id, attempt_count, created_at, updated_at) VALUES ('job-1', 'item-1', 0, '{}', 'done', ?1, 0, 1, 1)",
            [thread_id],
        )
        .expect("agent job item should insert");
}

fn seed_logs_db(path: &Path, thread_id: &str) {
    let connection = Connection::open(path).expect("logs db should open");
    connection
        .execute_batch(
            "
            CREATE TABLE logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                ts_nanos INTEGER NOT NULL,
                level TEXT NOT NULL,
                target TEXT NOT NULL,
                message TEXT,
                module_path TEXT,
                file TEXT,
                line INTEGER,
                thread_id TEXT,
                process_uuid TEXT,
                estimated_bytes INTEGER NOT NULL DEFAULT 0
            );
            ",
        )
        .expect("logs schema should create");
    connection
        .execute(
            "INSERT INTO logs (ts, ts_nanos, level, target, message, thread_id, estimated_bytes) VALUES (1, 1, 'info', 'test', 'message', ?1, 1)",
            [thread_id],
        )
        .expect("logs row should insert");
}

#[test]
fn local_delete_removes_rollout_files_and_indexes() {
    let root = unique_temp_dir("purge");
    let sessions_path = root
        .join("sessions/2026/03/29")
        .join("rollout-2026-03-29T20-00-00-thread-123.jsonl");
    let archived_path = root
        .join("archived_sessions")
        .join("rollout-2026-03-29T20-01-00-thread-123.jsonl");
    write_file(
        &sessions_path,
        "{\"timestamp\":\"2026-03-29T20:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-123\"}}\n",
    );
    write_file(
        &archived_path,
        "{\"timestamp\":\"2026-03-29T20:01:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-123\"}}\n",
    );
    write_file(
        &root.join("session_index.jsonl"),
        "{\"id\":\"thread-123\",\"thread_name\":\"Test Thread\",\"updated_at\":\"2026-03-29T20:00:00Z\"}\n{\"id\":\"thread-keep\",\"thread_name\":\"Keep\",\"updated_at\":\"2026-03-29T20:02:00Z\"}\n",
    );
    seed_state_db(&root.join("state_5.sqlite"), "thread-123", &sessions_path);
    seed_logs_db(&root.join("logs_1.sqlite"), "thread-123");

    let store = LocalCodexStore::from_root(root.clone()).expect("store should resolve");
    let summary = store
        .delete_thread_permanently("thread-123")
        .expect("local delete should succeed");

    assert!(summary.deleted_thread_row);
    assert!(!sessions_path.exists());
    assert!(!archived_path.exists());

    let index = fs::read_to_string(root.join("session_index.jsonl"))
        .expect("session index should remain readable");
    assert!(!index.contains("thread-123"));
    assert!(index.contains("thread-keep"));

    let state_connection = Connection::open(root.join("state_5.sqlite")).expect("state db reopens");
    let count: i64 = state_connection
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE id = 'thread-123'",
            [],
            |row| row.get(0),
        )
        .expect("thread count should query");
    assert_eq!(count, 0);
    let log_count: i64 = state_connection
        .query_row(
            "SELECT COUNT(*) FROM logs WHERE thread_id = 'thread-123'",
            [],
            |row| row.get(0),
        )
        .expect("state logs should query");
    assert_eq!(log_count, 0);
    let assigned_count: i64 = state_connection
        .query_row(
            "SELECT COUNT(*) FROM agent_job_items WHERE assigned_thread_id = 'thread-123'",
            [],
            |row| row.get(0),
        )
        .expect("assigned thread rows should query");
    assert_eq!(assigned_count, 0);

    let logs_connection = Connection::open(root.join("logs_1.sqlite")).expect("logs db reopens");
    let external_log_count: i64 = logs_connection
        .query_row(
            "SELECT COUNT(*) FROM logs WHERE thread_id = 'thread-123'",
            [],
            |row| row.get(0),
        )
        .expect("logs db should query");
    assert_eq!(external_log_count, 0);

    fs::remove_dir_all(root).expect("temp store should be removable");
}

#[test]
fn local_delete_reports_missing_thread() {
    let root = unique_temp_dir("missing");
    fs::create_dir_all(&root).expect("temp root should create");
    write_file(&root.join("session_index.jsonl"), "");
    let store = LocalCodexStore::from_root(root.clone()).expect("store should resolve");

    let error = store
        .delete_thread_permanently("thread-missing")
        .expect_err("missing thread should fail");

    assert!(error.contains("was not found"));
    assert!(
        store
            .delete_thread_permanently_if_present("thread-missing")
            .expect("idempotent task delete")
            .is_none(),
        "the task-only delete contract must distinguish an already-absent seat"
    );
    fs::remove_dir_all(root).expect("temp store should be removable");
}
