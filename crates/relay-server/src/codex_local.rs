use std::{
    collections::BTreeSet,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone)]
pub struct LocalThreadDeleteSummary {
    pub deleted_paths: Vec<PathBuf>,
    pub deleted_thread_row: bool,
}

#[derive(Debug, Clone)]
struct LocalCodexStore {
    sessions_dir: PathBuf,
    archived_sessions_dir: PathBuf,
    session_index_path: PathBuf,
    state_db_path: PathBuf,
    logs_db_path: PathBuf,
}

impl LocalCodexStore {
    fn resolve() -> Result<Self, String> {
        Self::from_root(resolve_codex_home()?)
    }

    fn from_root(root: PathBuf) -> Result<Self, String> {
        if !root.exists() {
            return Err(format!(
                "local Codex home does not exist at {}",
                root.display()
            ));
        }

        Ok(Self {
            sessions_dir: root.join("sessions"),
            archived_sessions_dir: root.join("archived_sessions"),
            session_index_path: root.join("session_index.jsonl"),
            state_db_path: root.join("state_5.sqlite"),
            logs_db_path: root.join("logs_1.sqlite"),
        })
    }

    fn delete_thread_permanently_if_present(
        &self,
        thread_id: &str,
    ) -> Result<Option<LocalThreadDeleteSummary>, String> {
        let rollout_path = self.lookup_rollout_path(thread_id)?;
        let deleted_thread_row = self.purge_state_sqlite(thread_id)?;
        self.purge_logs_sqlite(thread_id)?;
        self.prune_session_index(thread_id)?;

        let mut deleted_paths = Vec::new();
        for path in self.collect_rollout_paths(thread_id, rollout_path.as_deref())? {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| {
                    format!("failed to remove rollout file {}: {error}", path.display())
                })?;
                deleted_paths.push(path);
            }
        }

        if !deleted_thread_row && deleted_paths.is_empty() {
            return Ok(None);
        }

        Ok(Some(LocalThreadDeleteSummary {
            deleted_paths,
            deleted_thread_row,
        }))
    }

    fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        self.delete_thread_permanently_if_present(thread_id)?
            .ok_or_else(|| format!("thread {thread_id} was not found in local Codex storage"))
    }

    fn lookup_rollout_path(&self, thread_id: &str) -> Result<Option<PathBuf>, String> {
        if !self.state_db_path.exists() {
            return Ok(None);
        }

        let connection = Connection::open(&self.state_db_path)
            .map_err(|error| format!("failed to open state database: {error}"))?;
        let rollout_path: Option<String> = connection
            .query_row(
                "SELECT rollout_path FROM threads WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("failed to query threads table: {error}"))?;

        Ok(rollout_path.map(PathBuf::from))
    }

    fn purge_state_sqlite(&self, thread_id: &str) -> Result<bool, String> {
        if !self.state_db_path.exists() {
            return Ok(false);
        }

        let connection = Connection::open(&self.state_db_path)
            .map_err(|error| format!("failed to open state database: {error}"))?;
        let tx = connection
            .unchecked_transaction()
            .map_err(|error| format!("failed to start local delete transaction: {error}"))?;

        execute_if_table_exists(
            &tx,
            "stage1_outputs",
            "DELETE FROM stage1_outputs WHERE thread_id = ?1",
            thread_id,
        )?;
        execute_if_table_exists(
            &tx,
            "thread_dynamic_tools",
            "DELETE FROM thread_dynamic_tools WHERE thread_id = ?1",
            thread_id,
        )?;
        execute_if_table_exists(
            &tx,
            "thread_spawn_edges",
            "DELETE FROM thread_spawn_edges WHERE parent_thread_id = ?1 OR child_thread_id = ?1",
            thread_id,
        )?;
        execute_if_table_exists(
            &tx,
            "logs",
            "DELETE FROM logs WHERE thread_id = ?1",
            thread_id,
        )?;
        execute_if_table_exists(
            &tx,
            "agent_job_items",
            "UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?1",
            thread_id,
        )?;

        let deleted_thread_row = if table_exists(&tx, "threads")? {
            tx.execute("DELETE FROM threads WHERE id = ?1", params![thread_id])
                .map_err(|error| format!("failed to delete thread row: {error}"))?
                > 0
        } else {
            false
        };

        tx.commit()
            .map_err(|error| format!("failed to commit local delete transaction: {error}"))?;
        Ok(deleted_thread_row)
    }

    fn purge_logs_sqlite(&self, thread_id: &str) -> Result<(), String> {
        if !self.logs_db_path.exists() {
            return Ok(());
        }

        let connection = Connection::open(&self.logs_db_path)
            .map_err(|error| format!("failed to open logs database: {error}"))?;
        if table_exists(&connection, "logs")? {
            connection
                .execute("DELETE FROM logs WHERE thread_id = ?1", params![thread_id])
                .map_err(|error| format!("failed to delete logs rows: {error}"))?;
        }
        Ok(())
    }

    fn prune_session_index(&self, thread_id: &str) -> Result<(), String> {
        if !self.session_index_path.exists() {
            return Ok(());
        }

        rewrite_jsonl_without_id(&self.session_index_path, thread_id)
    }

    fn collect_rollout_paths(
        &self,
        thread_id: &str,
        primary_path: Option<&Path>,
    ) -> Result<Vec<PathBuf>, String> {
        let mut paths = BTreeSet::new();
        if let Some(path) = primary_path {
            paths.insert(path.to_path_buf());
        }

        for base in [&self.sessions_dir, &self.archived_sessions_dir] {
            if !base.exists() {
                continue;
            }

            for entry in fs::read_dir(base)
                .map_err(|error| format!("failed to read Codex sessions directory: {error}"))?
            {
                let entry = entry.map_err(|error| {
                    format!("failed to inspect Codex sessions directory entry: {error}")
                })?;
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    self.collect_rollout_paths_recursive(&entry.path(), thread_id, &mut paths)?;
                } else if entry.file_name().to_string_lossy().contains(thread_id) {
                    paths.insert(entry.path());
                }
            }
        }

        Ok(paths.into_iter().collect())
    }

    fn collect_rollout_paths_recursive(
        &self,
        directory: &Path,
        thread_id: &str,
        paths: &mut BTreeSet<PathBuf>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("failed to walk Codex rollout directory: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("failed to inspect rollout entry: {error}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect rollout file type: {error}"))?;
            if file_type.is_dir() {
                self.collect_rollout_paths_recursive(&path, thread_id, paths)?;
                continue;
            }
            if path
                .file_name()
                .map(|name| name.to_string_lossy().contains(thread_id))
                .unwrap_or(false)
            {
                paths.insert(path);
            }
        }
        Ok(())
    }
}

pub fn delete_thread_permanently(thread_id: &str) -> Result<LocalThreadDeleteSummary, String> {
    LocalCodexStore::resolve()?.delete_thread_permanently(thread_id)
}

pub fn delete_thread_permanently_if_present(
    thread_id: &str,
) -> Result<Option<LocalThreadDeleteSummary>, String> {
    LocalCodexStore::resolve()?.delete_thread_permanently_if_present(thread_id)
}

fn resolve_codex_home() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(value));
    }

    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".codex"));
    }

    if let Some(profile) = env::var_os("USERPROFILE") {
        return Ok(PathBuf::from(profile).join(".codex"));
    }

    Err("could not resolve local Codex home; set CODEX_HOME".to_string())
}

fn rewrite_jsonl_without_id(path: &Path, thread_id: &str) -> Result<(), String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let reader = BufReader::new(file);
    let mut kept_lines = Vec::new();

    for line in reader.lines() {
        let line = line.map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        let should_keep = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|value| {
                value
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(|id| id != thread_id)
            })
            .unwrap_or(true);
        if should_keep {
            kept_lines.push(line);
        }
    }

    let mut output = fs::File::create(path)
        .map_err(|error| format!("failed to rewrite {}: {error}", path.display()))?;
    for line in kept_lines {
        writeln!(output, "{line}")
            .map_err(|error| format!("failed to update {}: {error}", path.display()))?;
    }
    Ok(())
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            params![table_name],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("failed to inspect sqlite schema: {error}"))?
        .is_some();
    Ok(exists)
}

fn execute_if_table_exists(
    connection: &Connection,
    table_name: &str,
    sql: &str,
    thread_id: &str,
) -> Result<(), String> {
    if table_exists(connection, table_name)? {
        connection
            .execute(sql, params![thread_id])
            .map_err(|error| format!("failed to update sqlite table {table_name}: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
