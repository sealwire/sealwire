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
    let writes: Vec<(&str, &str, &str, Option<u64>)> = writes
        .iter()
        .map(|(thread, cwd, path, revision)| (*thread, *cwd, *path, Some(*revision)))
        .collect();
    router_with_history(root, &writes).await
}

/// As above; a `None` revision is a write read back from a saved conversation, not seen live.
async fn router_with_history(
    root: &str,
    writes: &[(&str, &str, &str, Option<u64>)],
) -> axum::Router {
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
            let mut record = landed_edit(path, revision.unwrap_or_default());
            record.last_live_upsert_revision = *revision;
            runtime.transcript.push(record);
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

#[tokio::test]
async fn a_write_seen_live_outranks_one_read_back_from_a_saved_conversation() {
    let (_dir, root) = editor_repo().await;
    let seed = format!("{root}/seed.txt");
    let other = format!("{root}/other.txt");
    // The saved conversation is long, so its write sits at a high index; that index is
    // no time at all, and says nothing about another session.
    let mut writes: Vec<(&str, &str, &str, Option<u64>)> = (0..6)
        .map(|_| ("thread-saved", root.as_str(), other.as_str(), None))
        .collect();
    writes.push(("thread-saved", root.as_str(), seed.as_str(), None));
    writes.push(("thread-live", root.as_str(), seed.as_str(), Some(1)));
    let router = router_with_history(&root, &writes).await;
    let (_, body) = get_json(
        router,
        &format!("/api/editor/changes?root={}", query_value(&root)),
    )
    .await;
    assert_eq!(session_of(&body, "seed.txt"), "thread-live", "{body}");

    let router = router_with_history(
        &root,
        &[
            ("thread-x", root.as_str(), seed.as_str(), None),
            ("thread-y", root.as_str(), seed.as_str(), None),
        ],
    )
    .await;
    let (_, body) = get_json(
        router,
        &format!("/api/editor/changes?root={}", query_value(&root)),
    )
    .await;
    assert!(
        session_of(&body, "seed.txt").is_null(),
        "two saved conversations cannot say which wrote last: {body}"
    );
}

#[tokio::test]
async fn a_written_path_that_climbs_with_dot_dot_is_not_attributed() {
    let (_dir, root) = editor_repo().await;
    // `src/..` is only the root if `src` is not a symlink; the path is not trusted to say.
    let climbing = format!("{root}/src/../seed.txt");
    let router =
        router_with_writers(&root, &[("thread-a", root.as_str(), climbing.as_str(), 3)]).await;
    let (_, body) = get_json(
        router,
        &format!("/api/editor/changes?root={}", query_value(&root)),
    )
    .await;
    assert!(session_of(&body, "seed.txt").is_null(), "{body}");
}

#[tokio::test]
async fn editor_commit_takes_only_changed_files_never_a_folder() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/src/lib.rs"), "fn changed() {}\n").unwrap();
    std::fs::write(format!("{root}/src/inner/more.rs"), "fn more() {}\n").unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    for path in ["src", ".", "src/inner", "src/unchanged.rs"] {
        let (status, body) = post_json(
            router.clone(),
            "/api/editor/commit",
            serde_json::json!({ "root": root, "paths": [path], "message": "too much", "device_id": "d1" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: body={body}");
    }
    assert_eq!(head_subject(&root), before);
}

#[tokio::test]
async fn editor_commit_of_a_renamed_file_takes_both_of_its_names() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs"], "message": "Rename lib", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let out = std::process::Command::new("git")
        .args(["show", "--name-status", "--format=", "-M", "HEAD"])
        .current_dir(&root)
        .output()
        .unwrap();
    let shown = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        shown.starts_with("R100\tsrc/lib.rs\tsrc/core.rs"),
        "{shown}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn editor_commit_with_a_long_message_and_a_noisy_hook_does_not_hang() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    let hook = format!("{root}/.git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\nhead -c 400000 /dev/zero | tr '\\0' x\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let message = format!("Long\n\n{}", "word ".repeat(200_000));
    let router = trusted_router(&root).await;
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        post_json(
            router,
            "/api/editor/commit",
            serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": message, "device_id": "d1" }),
        ),
    )
    .await;
    let (status, body) = reply.expect("the commit finished instead of waiting on full pipes");
    assert_eq!(status, StatusCode::OK, "body={body}");
}

#[tokio::test]
async fn a_rename_whose_old_name_was_written_again_needs_that_file_ticked_too() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    std::fs::write(format!("{root}/src/lib.rs"), "private work\n").unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs"], "message": "Rename", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(
        head_subject(&root),
        before,
        "the unticked file at the old name was not committed"
    );
}

#[tokio::test]
async fn a_ticked_file_that_replaced_a_folder_does_not_take_the_folders_unticked_files() {
    let (_dir, root) = editor_repo().await;
    std::fs::remove_dir_all(format!("{root}/src")).unwrap();
    std::fs::write(format!("{root}/src"), "now a file\n").unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router.clone(),
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src"], "message": "Flatten", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head_subject(&root), before);
    let staged = std::process::Command::new("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&staged.stdout).trim(),
        "",
        "nothing was staged either"
    );
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src", "src/lib.rs"], "message": "Flatten", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "with every affected file ticked it goes through: {body}"
    );
}

#[tokio::test]
async fn a_rename_that_only_changes_letter_case_is_committed_or_plainly_refused() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/Lib.rs"]);
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/Lib.rs"], "message": "Capitalise", "device_id": "d1" }),
    )
    .await;
    if status == StatusCode::OK {
        assert_eq!(head_subject(&root), "Capitalise");
    } else {
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("letter case"),
            "the reason is the real one: {body}"
        );
        assert_eq!(head_subject(&root), before);
    }
}

#[tokio::test]
async fn a_rename_whose_old_name_became_a_folder_commits_with_that_folders_files_ticked() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    std::fs::create_dir_all(format!("{root}/src/lib.rs")).unwrap();
    std::fs::write(format!("{root}/src/lib.rs/child.txt"), "child\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router.clone(),
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs"], "message": "Half", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the folder's file is not ticked: {body}"
    );
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs", "src/lib.rs/child.txt"], "message": "Both", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let out = std::process::Command::new("git")
        .args(["ls-tree", "-r", "--name-only", "HEAD", "src"])
        .current_dir(&root)
        .output()
        .unwrap();
    let mut tree: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    tree.sort();
    assert_eq!(tree, ["src/core.rs", "src/lib.rs/child.txt"]);
}

#[tokio::test]
async fn a_file_replaced_by_a_folder_commits_once_every_change_is_ticked() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    std::fs::remove_file(format!("{root}/seed.txt")).unwrap();
    std::fs::create_dir_all(format!("{root}/seed.txt")).unwrap();
    std::fs::write(format!("{root}/seed.txt/child"), "c\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt", "seed.txt/child"], "message": "Folder", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(head_subject(&root), "Folder");
}

#[cfg(unix)]
#[tokio::test]
async fn a_ticked_file_does_not_take_an_unticked_file_whose_name_is_not_utf8() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    // A tracked file under `config/` whose name is not UTF-8, put in through the index: the
    // disk here may refuse such a name, but a repository can still carry one.
    let blob = std::process::Command::new("git")
        .args(["hash-object", "-w", "seed.txt"])
        .current_dir(&root)
        .output()
        .unwrap();
    let blob = String::from_utf8(blob.stdout).unwrap().trim().to_string();
    let mut name = b"config/hidden-".to_vec();
    name.push(0xff);
    let mut info = format!("100644 {blob}\t").into_bytes();
    info.extend_from_slice(&name);
    info.push(b'\n');
    let mut child = std::process::Command::new("git")
        .args(["update-index", "--index-info"])
        .current_dir(&root)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(&info).unwrap();
    }
    assert!(child.wait().unwrap().success());
    git(&root, &["commit", "-q", "-m", "hidden"]);
    // The folder is gone from disk and a file named `config` took its place.
    std::fs::write(format!("{root}/config"), "now a file\n").unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["config"], "message": "Take config", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head_subject(&root), before);
}
