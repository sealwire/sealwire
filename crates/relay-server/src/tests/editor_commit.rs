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

fn git_output(root: &str, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("git runs");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
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

fn tree_of(root: &str, dir: &str) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(["ls-tree", "-r", "--name-only", "HEAD", dir])
        .current_dir(root)
        .output()
        .expect("git runs");
    let mut tree: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    tree.sort();
    tree
}

fn porcelain(root: &str) -> String {
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=all"])
        .current_dir(root)
        .output()
        .expect("git runs");
    String::from_utf8_lossy(&out.stdout).to_string()
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
async fn a_rename_whose_old_name_was_written_again_commits_without_that_unticked_file() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    std::fs::write(format!("{root}/src/lib.rs"), "private work\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs"], "message": "Rename", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        tree_of(&root, "src"),
        ["src/core.rs"],
        "the rename is whole, and the file written at the old name is not in it"
    );
    assert!(
        porcelain(&root).contains("?? src/lib.rs"),
        "{}",
        porcelain(&root)
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
async fn a_rename_that_only_changes_letter_case_is_committed() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/Lib.rs"]);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/Lib.rs"], "message": "Capitalise", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(tree_of(&root, "src"), ["src/Lib.rs"]);
}

#[tokio::test]
async fn a_rename_whose_old_name_became_a_folder_commits_with_or_without_that_folders_files() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    std::fs::create_dir_all(format!("{root}/src/lib.rs")).unwrap();
    std::fs::write(format!("{root}/src/lib.rs/child.txt"), "child\n").unwrap();
    std::fs::write(format!("{root}/src/lib.rs/later.txt"), "later\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs", "src/lib.rs/child.txt"], "message": "Both", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        tree_of(&root, "src"),
        ["src/core.rs", "src/lib.rs/child.txt"]
    );
    assert!(
        porcelain(&root).contains("?? src/lib.rs/later.txt"),
        "the unticked one stays out"
    );
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

#[tokio::test]
async fn a_ticked_file_never_carries_the_deletion_of_a_file_it_sits_under() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    // `seed.txt` was a tracked file; now it is a folder holding the ticked file.
    std::fs::remove_file(format!("{root}/seed.txt")).unwrap();
    std::fs::create_dir_all(format!("{root}/seed.txt/sub")).unwrap();
    std::fs::write(format!("{root}/seed.txt/sub/child"), "c\n").unwrap();
    let before = head_subject(&root);
    let staged_before = git_output(&root, &["diff", "--cached", "--name-only"]);

    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt/sub/child"], "message": "Child", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the deletion of seed.txt is not ticked: {body}"
    );

    // From a root below it, the deletion is outside the folder the user may commit in.
    let sub = format!("{root}/seed.txt/sub");
    let router = git_context_router(&sub, vec![sub.clone()], vec![sub.clone()]).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": sub, "paths": ["child"], "message": "Child", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head_subject(&root), before);
    assert_eq!(
        git_output(&root, &["diff", "--cached", "--name-only"]),
        staged_before,
        "a refused commit leaves what is staged as it was"
    );
}

#[tokio::test]
async fn a_refused_commit_leaves_the_staging_area_as_it_was() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    let hook = format!("{root}/.git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let router = trusted_router(&root).await;
    let (status, _) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt", "new.txt"], "message": "x", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(git_output(&root, &["diff", "--cached", "--name-only"]), "");
}

#[tokio::test]
async fn a_submodule_moved_to_another_commit_is_committed_as_one_change() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    let module = format!("{root}/module");
    std::fs::create_dir_all(&module).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@e.com"],
        vec!["config", "user.name", "T"],
        vec!["commit", "-q", "--allow-empty", "-m", "one"],
    ] {
        git(&module, &args);
    }
    git(&root, &["add", "module"]);
    git(&root, &["commit", "-q", "-m", "add module"]);
    git(&module, &["commit", "-q", "--allow-empty", "-m", "two"]);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["module"], "message": "Bump module", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(head_subject(&root), "Bump module");
}

#[tokio::test]
async fn a_rename_whose_old_name_is_a_hard_link_commits_both_ticked_files() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    std::fs::hard_link(format!("{root}/src/core.rs"), format!("{root}/src/lib.rs")).unwrap();
    std::fs::write(format!("{root}/src/core.rs"), "fn linked() {}\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs", "src/lib.rs"], "message": "Linked", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(tree_of(&root, "src"), ["src/core.rs", "src/lib.rs"]);
}

#[tokio::test]
async fn a_commit_is_refused_while_a_merge_is_unfinished() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["switch", "-q", "-c", "other"]);
    std::fs::write(format!("{root}/seed.txt"), "theirs\n").unwrap();
    std::fs::write(format!("{root}/incoming.txt"), "incoming\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "other side"]);
    git(&root, &["switch", "-q", "main"]);
    std::fs::write(format!("{root}/seed.txt"), "ours\n").unwrap();
    git(&root, &["commit", "-q", "-am", "our side"]);
    let merge = std::process::Command::new("git")
        .args(["merge", "-q", "other"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(!merge.status.success(), "the merge stops on a conflict");
    std::fs::write(format!("{root}/src/lib.rs"), "fn unrelated() {}\n").unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/lib.rs"], "message": "Sneak", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head_subject(&root), before);
    assert!(
        std::path::Path::new(&format!("{root}/.git/MERGE_HEAD")).exists(),
        "the merge is still the user's to finish"
    );
}

#[tokio::test]
async fn repository_diff_settings_cannot_hide_a_change_from_the_commit_check() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    let module = format!("{root}/config/module");
    std::fs::create_dir_all(&module).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@e.com"],
        vec!["config", "user.name", "T"],
        vec!["commit", "-q", "--allow-empty", "-m", "one"],
    ] {
        git(&module, &args);
    }
    git(&root, &["add", "config/module"]);
    git(&root, &["commit", "-q", "-m", "add module"]);
    git(&root, &["config", "diff.ignoreSubmodules", "all"]);
    git(&root, &["config", "diff.relative", "true"]);
    std::fs::remove_dir_all(format!("{root}/config")).unwrap();
    std::fs::write(format!("{root}/config"), "now a file\n").unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["config"], "message": "Config", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the submodule's removal is not ticked: {body}"
    );
    assert_eq!(head_subject(&root), before);

    // `diff.relative` must not turn an ordinary commit from a subfolder into a refusal.
    std::fs::write(format!("{root}/src/lib.rs"), "fn sub() {}\n").unwrap();
    let src = format!("{root}/src");
    let router = git_context_router(&src, vec![src.clone()], vec![src.clone()]).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": src, "paths": ["lib.rs"], "message": "Sub", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
}

#[cfg(unix)]
#[tokio::test]
async fn after_a_commit_the_index_holds_what_was_committed_not_the_disk_again() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    // A formatter hook rewrites the staged copy of what is being committed.
    let hook = format!("{root}/.git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\nblob=$(git show :seed.txt | tr a-z A-Z | git hash-object -w --stdin)\ngit update-index --cacheinfo 100644,$blob,seed.txt\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Format", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["show", "HEAD:seed.txt"]),
        "LINE1\nLINE2"
    );
    assert_eq!(
        git_output(&root, &["diff", "--cached", "--name-only"]),
        "",
        "nothing staged that would undo the formatted commit"
    );
}

#[tokio::test]
async fn a_file_kept_out_of_a_sparse_checkout_is_not_committed_as_a_deletion() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/seed.txt"), "staged\n").unwrap();
    git(&root, &["add", "seed.txt"]);
    git(&root, &["update-index", "--skip-worktree", "seed.txt"]);
    std::fs::remove_file(format!("{root}/seed.txt")).unwrap();
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Sparse", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head_subject(&root), before);
}

#[tokio::test]
async fn an_unticked_file_marked_at_a_renames_old_name_keeps_its_mark() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    std::fs::write(format!("{root}/src/lib.rs"), "planned\n").unwrap();
    git(&root, &["add", "-N", "src/lib.rs"]);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs"], "message": "Rename", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["ls-files", "src/lib.rs"]),
        "src/lib.rs",
        "the user's intent-to-add entry is still in the index"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn the_commit_is_built_in_an_index_inside_the_repository() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    let seen = format!("{root}/.git/seen-index");
    let hook = format!("{root}/.git/hooks/pre-commit");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\necho \"$GIT_INDEX_FILE\" > '{seen}'\n"),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Where", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let index = std::fs::read_to_string(&seen).unwrap();
    let git_dir = std::path::Path::new(&root)
        .join(".git")
        .canonicalize()
        .unwrap();
    let index = std::path::Path::new(index.trim());
    assert!(
        index
            .parent()
            .and_then(|dir| dir.canonicalize().ok())
            .as_deref()
            == Some(git_dir.as_path()),
        "not in a shared temp folder: {}",
        index.display()
    );
    assert!(!index.exists(), "and it is gone afterwards");
}

#[cfg(unix)]
#[tokio::test]
async fn a_commit_made_by_a_post_commit_hook_is_kept_and_so_is_ours() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    let hook = format!("{root}/.git/hooks/post-commit");
    std::fs::write(
        &hook,
        // Guarded: the hook's own commit runs post-commit again.
        "#!/bin/sh\n[ -n \"$IN_FOLLOW_UP\" ] && exit 0\nunset GIT_INDEX_FILE\nIN_FOLLOW_UP=1 git commit -q --allow-empty -m 'Follow-up from the hook'\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Ours", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["log", "--format=%s", "-2"]),
        "Follow-up from the hook\nOurs"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_merge_that_starts_while_a_commit_is_prepared_is_never_finished_by_it() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    git(&root, &["switch", "-q", "-c", "side"]);
    std::fs::write(format!("{root}/incoming.txt"), "incoming\n").unwrap();
    git(&root, &["add", "incoming.txt"]);
    git(&root, &["commit", "-q", "-m", "incoming"]);
    git(&root, &["switch", "-q", "main"]);
    let before = git_output(&root, &["rev-parse", "HEAD"]);
    // Another process starts a merge while the Editor's commit is being prepared.
    let hook = format!("{root}/.git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\nunset GIT_INDEX_FILE\ngit merge -q --no-ff --no-commit side >/dev/null 2>&1\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Ours", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(git_output(&root, &["rev-parse", "HEAD"]), before);
    assert!(
        std::path::Path::new(&format!("{root}/.git/MERGE_HEAD")).exists(),
        "the merge is left for the user to finish"
    );
}

#[tokio::test]
async fn a_file_name_holding_a_line_break_cannot_touch_other_index_entries() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    std::fs::create_dir_all(format!("{root}/sub")).unwrap();
    let zeros = "0".repeat(40);
    let name = format!("chosen\n0 {zeros}\tseed.txt");
    std::fs::write(format!("{root}/sub/{name}"), "x\n").unwrap();
    let sub = format!("{root}/sub");
    let router = git_context_router(&sub, vec![sub.clone()], vec![sub.clone()]).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": sub, "paths": [name], "message": "Odd name", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["ls-files", "seed.txt"]),
        "seed.txt",
        "an entry outside the root is untouched"
    );
    assert_eq!(git_output(&root, &["diff", "--cached", "--name-only"]), "");
}

#[tokio::test]
async fn a_file_name_that_reads_like_pathspec_magic_is_caught_up_literally() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    std::fs::write(format!("{root}/:(top)magic"), "m\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": [":(top)magic"], "message": "Magic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(git_output(&root, &["diff", "--cached", "--name-only"]), "");
}

#[cfg(unix)]
fn hook(root: &str, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = format!("{root}/.git/hooks/{name}");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn hooks_run_in_the_repository_itself_even_when_its_name_ends_in_a_space() {
    let parent = tempfile::TempDir::new().expect("tmp");
    let parent = parent
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let spaced = format!("{parent}/repo ");
    let sibling = format!("{parent}/repo");
    for repo in [&spaced, &sibling] {
        std::fs::create_dir_all(format!("{repo}/sub")).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@e.com"],
            vec!["config", "user.name", "T"],
            vec!["commit", "-q", "--allow-empty", "-m", "start"],
        ] {
            git(repo, &args);
        }
    }
    hook(
        &sibling,
        "pre-commit",
        &format!("touch '{parent}/sibling-hook-ran'"),
    );
    std::fs::write(format!("{spaced}/sub/a.txt"), "a\n").unwrap();
    let sub = format!("{spaced}/sub");
    let router = git_context_router(&sub, vec![sub.clone()], vec![sub.clone()]).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": sub, "paths": ["a.txt"], "message": "Spaced", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert!(
        !std::path::Path::new(&format!("{parent}/sibling-hook-ran")).exists(),
        "the neighbouring repository's hook never ran"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_message_hook_cannot_slip_an_unticked_file_into_the_commit() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/victim.txt"), "unticked\n").unwrap();
    hook(&root, "commit-msg", "git add victim.txt");
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Picked", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        git_output(&root, &["ls-tree", "--name-only", "HEAD", "victim.txt"]),
        "",
        "body={body}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_post_commit_hook_does_not_see_the_users_unticked_staging() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/victim.txt"), "staged, not ticked\n").unwrap();
    git(&root, &["add", "victim.txt"]);
    hook(
        &root,
        "post-commit",
        "[ -n \"$AMENDING\" ] && exit 0\nAMENDING=1 git commit -q --amend --no-edit",
    );
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Picked", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["ls-tree", "--name-only", "HEAD", "victim.txt"]),
        ""
    );
    assert_eq!(
        git_output(&root, &["diff", "--cached", "--name-only"]),
        "victim.txt",
        "still staged for later"
    );
}

#[tokio::test]
async fn a_signing_setting_git_cannot_read_stops_the_commit() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["config", "commit.gpgsign", "tru"]);
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Unsigned?", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head_subject(&root), before);
}

#[cfg(unix)]
#[tokio::test]
async fn a_commit_never_lands_on_a_branch_switched_to_while_it_was_prepared() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["branch", "other"]);
    let main_before = git_output(&root, &["rev-parse", "main"]);
    hook(
        &root,
        "pre-commit",
        "unset GIT_INDEX_FILE\ngit switch -q other",
    );
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Mine", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(git_output(&root, &["rev-parse", "main"]), main_before);
    assert_eq!(git_output(&root, &["rev-parse", "other"]), main_before);
}

#[cfg(unix)]
#[tokio::test]
async fn a_hook_refusing_the_branch_update_is_reported_in_its_own_words() {
    let (_dir, root) = editor_repo().await;
    hook(
        &root,
        "reference-transaction",
        "if [ \"$1\" = prepared ]; then echo 'Policy: this branch is locked' >&2; exit 1; fi",
    );
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Locked", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("this branch is locked"),
        "{body}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn the_repositorys_message_cleanup_setting_is_applied() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["config", "commit.cleanup", "strip"]);
    hook(&root, "commit-msg", "echo '# only a comment' > \"$1\"");
    let before = head_subject(&root);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Will be emptied", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an empty message after cleanup is refused: {body}"
    );
    assert_eq!(head_subject(&root), before);
}

#[cfg(unix)]
#[tokio::test]
async fn a_hook_cannot_put_back_a_file_at_a_renames_old_name() {
    let (_dir, root) = editor_repo().await;
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    git(&root, &["mv", "src/lib.rs", "src/core.rs"]);
    std::fs::write(format!("{root}/src/lib.rs"), "private work\n").unwrap();
    hook(&root, "pre-commit", "git add -A src/lib.rs");
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["src/core.rs"], "message": "Rename", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the old name may only be deleted: {body}"
    );
    assert_eq!(git_output(&root, &["show", "HEAD:src/lib.rs"]), "fn a() {}");
}

#[cfg(unix)]
#[tokio::test]
async fn after_a_post_commit_hook_amends_the_index_matches_what_it_left() {
    let (_dir, root) = editor_repo().await;
    hook(
        &root,
        "post-commit",
        "[ -n \"$AMENDING\" ] && exit 0\necho formatted > seed.txt\ngit add seed.txt\nAMENDING=1 git commit -q --amend --no-edit",
    );
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Seed", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(git_output(&root, &["show", "HEAD:seed.txt"]), "formatted");
    assert_eq!(
        git_output(&root, &["diff", "--cached", "--name-only"]),
        "",
        "nothing staged that would undo the hook's amend"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_message_in_the_repositorys_own_encoding_keeps_its_bytes() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["config", "i18n.commitEncoding", "ISO-8859-1"]);
    git(&root, &["config", "commit.cleanup", "verbatim"]);
    hook(&root, "commit-msg", "printf 'caf\\351\\n' > \"$1\"");
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Latin", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let raw = std::process::Command::new("git")
        .args(["cat-file", "commit", "HEAD"])
        .current_dir(&root)
        .output()
        .unwrap()
        .stdout;
    assert!(
        raw.windows(4).any(|window| window == b"caf\xe9"),
        "{:?}",
        String::from_utf8_lossy(&raw)
    );
}

#[tokio::test]
async fn an_automatic_comment_character_keeps_message_lines_that_start_with_hash() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["config", "commit.cleanup", "strip"]);
    git(&root, &["config", "core.commentChar", "auto"]);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Subject\n\n# Heading\nBody", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["log", "-1", "--format=%B"]),
        "Subject\n\n# Heading\nBody"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_hook_refusal_that_happens_to_say_but_expected_still_reaches_the_user() {
    let (_dir, root) = editor_repo().await;
    hook(
        &root,
        "reference-transaction",
        "if [ \"$1\" = prepared ]; then echo 'Policy: branch is main but expected release; choose the release branch' >&2; exit 1; fi",
    );
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Locked", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("choose the release branch"),
        "{body}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_commit_made_from_the_index_during_post_commit_keeps_the_editors_change() {
    let (_dir, root) = editor_repo().await;
    // A slow post-commit (a push, a build) while another process commits from the index.
    hook(
        &root,
        "post-commit",
        "[ -n \"$FOLLOW\" ] && exit 0\nunset GIT_INDEX_FILE\nFOLLOW=1 git commit -q --allow-empty -m 'Meanwhile'",
    );
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Seed", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["log", "-1", "--format=%s"]),
        "Meanwhile"
    );
    assert_eq!(
        git_output(&root, &["show", "HEAD:seed.txt"]),
        "line1\nline2",
        "the commit made meanwhile did not take the change back"
    );
}

#[tokio::test]
async fn an_automatic_comment_string_keeps_message_lines_that_start_with_hash() {
    let (_dir, root) = editor_repo().await;
    git(&root, &["config", "commit.cleanup", "strip"]);
    git(&root, &["config", "core.commentString", "auto"]);
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/commit",
        serde_json::json!({ "root": root, "paths": ["seed.txt"], "message": "Subject\n\n# Heading\nBody", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        git_output(&root, &["log", "-1", "--format=%B"]),
        "Subject\n\n# Heading\nBody"
    );
}
