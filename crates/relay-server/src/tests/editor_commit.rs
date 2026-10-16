//! The editor's Changes view: each changed file names the session that last wrote it, and
//! a commit takes exactly the files the user ticked, through the repository's own hooks.

use super::editor_files::{editor_repo, git, query_value, trusted_router};
use super::*;

fn landed_edit(path: &str, revision: u64) -> crate::state::TranscriptRecord {
    crate::state::TranscriptRecord {
        row_id: format!("edit-{revision}"),
        provider_item_id: None,
        relay_item_id: None,
        kind: crate::protocol::TranscriptEntryKind::ToolCall,
        text: None,
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: Some(crate::protocol::ToolCallView {
            item_type: "fileChange".to_string(),
            name: "Edit".to_string(),
            title: "Edit".to_string(),
            kind: None,
            detail: None,
            query: None,
            path: None,
            url: None,
            command: None,
            input_preview: None,
            result_preview: None,
            diff: None,
            file_changes: vec![crate::protocol::FileChangeDiffView {
                path: path.to_string(),
                change_type: "update".to_string(),
                diff: format!("--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-old\n+new\n"),
            }],
            apply_state: None,
            file_changes_omitted: false,
            can_apply: None,
        }),
        order_seq: 0,
        withdrawn: false,
        last_live_upsert_revision: Some(revision),
        cut: false,
    }
}

/// A trusted router whose relay holds sessions that wrote files: `(thread, cwd, path, revision)`.
async fn router_with_writers(root: &str, writes: &[(&str, &str, &str, u64)]) -> axum::Router {
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        root.to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    {
        let mut relay = relay.write().await;
        relay.set_allowed_roots(
            crate::state::normalize_allowed_roots(vec![root.to_string()]).expect("roots"),
        );
        relay.trusted_workspaces = vec![root.to_string()];
        for (thread, cwd, path, revision) in writes {
            let runtime = relay.ensure_runtime_for_thread(thread);
            runtime.current_cwd = cwd.to_string();
            runtime.transcript.push(landed_edit(path, *revision));
        }
    }
    let context = AppContext {
        app: crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    build_router(context, WebAssets::Embedded)
}

fn head_subject(root: &str) -> String {
    let out = std::process::Command::new("git")
        .args(["log", "-1", "--format=%s"])
        .current_dir(root)
        .output()
        .expect("git runs");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn committed_files(root: &str) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(["show", "--name-only", "--format=", "HEAD"])
        .current_dir(root)
        .output()
        .expect("git runs");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

fn session_of<'a>(body: &'a serde_json::Value, path: &str) -> &'a serde_json::Value {
    &body["data"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|entry| entry["path"] == path)
        .unwrap_or_else(|| panic!("no {path} in {body}"))["session"]
}

#[tokio::test]
async fn editor_changes_name_the_session_that_last_wrote_each_file() {
    let (_dir, root) = editor_repo().await;
    let seed = format!("{root}/seed.txt");
    let router = router_with_writers(
        &root,
        &[
            ("thread-old", root.as_str(), seed.as_str(), 3),
            ("thread-a", root.as_str(), seed.as_str(), 5),
            // A relative path is the agent's, so it is read from that agent's folder.
            ("thread-b", root.as_str(), "new.txt", 7),
            ("thread-c", "/elsewhere", "/elsewhere/seed.txt", 9),
        ],
    )
    .await;
    let (status, body) = get_json(
        router,
        &format!("/api/editor/changes?root={}", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(session_of(&body, "seed.txt"), "thread-a");
    assert_eq!(session_of(&body, "new.txt"), "thread-b");
    let sessions: Vec<&str> = body["data"]["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .map(|session| session["id"].as_str().unwrap())
        .collect();
    assert!(
        sessions.contains(&"thread-a") && sessions.contains(&"thread-b"),
        "{body}"
    );
    assert!(
        !sessions.contains(&"thread-c"),
        "a session writing elsewhere is not listed: {body}"
    );
}

#[tokio::test]
async fn editor_commit_takes_exactly_the_ticked_files() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/src/lib.rs"), "fn staged() {}\n").unwrap();
    git(&root, &["add", "src/lib.rs"]);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({
            "root": root, "paths": ["seed.txt", "new.txt"],
            "message": "Edit the seed\n\nAnd add a file.", "device_id": "d1",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(head_subject(&root), "Edit the seed");
    let mut files = committed_files(&root);
    files.sort();
    assert_eq!(files, vec!["new.txt".to_string(), "seed.txt".to_string()]);
    let status = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&status.stdout).trim(),
        "M  src/lib.rs",
        "what the user had staged but did not tick stays staged and uncommitted"
    );
}

#[tokio::test]
async fn editor_commit_reads_paths_literally() {
    let (_dir, root) = editor_repo().await;
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    for path in [":(top)seed.txt", ":!seed.txt", "*.txt"] {
        let (status, body) = post_json(
            router.clone(),
            "/api/editor/commit",
            serde_json::json!({ "root": root, "paths": [path], "message": "magic", "device_id": "d1" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: body={body}");
    }
    assert_eq!(head_subject(&root), before);
}

#[cfg(unix)]
#[tokio::test]
async fn editor_commit_runs_the_repository_hooks_and_reports_their_refusal() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    let hook = format!("{root}/.git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho 'blocked by the repo hook' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "try", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("blocked by the repo hook"),
        "the hook's words reach the user: {body}"
    );
    assert_eq!(head_subject(&root), before);
}

#[tokio::test]
async fn editor_commit_needs_a_message_and_files() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    for body in [
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "  ", "device_id": "d1" }),
        serde_json::json!({ "root": root, "paths": [], "message": "x", "device_id": "d1" }),
        serde_json::json!({ "root": root, "paths": ["../x"], "message": "x", "device_id": "d1" }),
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "x" }),
    ] {
        let (status, reply) = post_json(router.clone(), "/api/editor/commit", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body={reply}");
    }
}
