//! Branches and worktrees from the editor: switching is the user's act, but never under an
//! agent that is mid-turn in that tree, and a new worktree lands where the allowed root
//! already reaches.

use super::editor_files::{editor_repo, git, query_value, trusted_router};
use super::*;

fn head(root: &str) -> String {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
        .expect("git runs");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `feature` is checked out in a linked worktree, `topic` is free, and a remote-tracking
/// ref stands in for a fetched branch.
async fn branchy_repo() -> (tempfile::TempDir, tempfile::TempDir, String, String) {
    let (dir, root) = editor_repo().await;
    git(&root, &["branch", "topic"]);
    let wt_dir = tempfile::TempDir::new().expect("tmp");
    let wt = wt_dir.path().join("feature-tree");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            wt.to_str().unwrap(),
        ],
    );
    git(
        &root,
        &["update-ref", "refs/remotes/origin/remote-only", "HEAD"],
    );
    let wt = wt.canonicalize().unwrap().to_string_lossy().to_string();
    (dir, wt_dir, root, wt)
}

async fn busy_router(root: &str, thread_cwd: &str) -> axum::Router {
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
        let runtime = relay.ensure_runtime_for_thread("thread-busy");
        runtime.current_cwd = thread_cwd.to_string();
        runtime.active_turn_id = Some("turn-1".to_string());
    }
    let context = AppContext {
        app: crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    build_router(context, WebAssets::Embedded)
}

#[tokio::test]
async fn editor_lists_branches_with_the_worktree_holding_each() {
    let (_dir, _wt_dir, root, wt) = branchy_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!("/api/editor/branches?root={}", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["current"], "main");
    assert!(body["data"]["busy"].is_null(), "body={body}");
    let branches = body["data"]["branches"].as_array().expect("branches");
    let find = |name: &str| {
        branches
            .iter()
            .find(|branch| branch["name"] == name)
            .unwrap_or_else(|| panic!("no {name} in {body}"))
            .clone()
    };
    assert_eq!(find("feature")["worktree"], wt.as_str());
    assert!(find("topic")["worktree"].is_null());
    assert_eq!(find("main")["worktree"], root.as_str());
    assert_eq!(find("origin/remote-only")["remote"], true);
    assert!(
        !branches
            .iter()
            .any(|branch| branch["name"] == "origin/HEAD"),
        "the remote HEAD alias is not a branch"
    );
}

#[tokio::test]
async fn editor_switches_the_folder_to_another_branch() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    std::fs::write(format!("{root}/seed.txt"), "line1\n").unwrap();
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(head(&root), "topic");
}

#[tokio::test]
async fn editor_switch_passes_on_gits_refusal_and_changes_nothing() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    // `topic` changes seed.txt, and the folder has an uncommitted edit to it.
    git(&root, &["stash", "-u", "-q"]);
    git(&root, &["switch", "-q", "topic"]);
    std::fs::write(format!("{root}/seed.txt"), "topic\n").unwrap();
    git(&root, &["commit", "-q", "-am", "topic edit"]);
    git(&root, &["switch", "-q", "main"]);
    std::fs::write(format!("{root}/seed.txt"), "mine, uncommitted\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("seed.txt"),
        "git's own reason reaches the user: {body}"
    );
    assert_eq!(head(&root), "main");
    assert_eq!(
        std::fs::read_to_string(format!("{root}/seed.txt")).unwrap(),
        "mine, uncommitted\n"
    );
}

#[tokio::test]
async fn editor_will_not_switch_a_tree_an_agent_is_working_in() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    // The agent works in a subfolder; the switch would still change its files.
    let router = busy_router(&root, &format!("{root}/src")).await;
    let (_, listing) = get_json(
        router.clone(),
        &format!("/api/editor/branches?root={}", query_value(&root)),
    )
    .await;
    assert!(listing["data"]["busy"].is_string(), "body={listing}");
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head(&root), "main");
}

#[tokio::test]
async fn editor_switch_refuses_names_git_would_read_as_options() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    let router = trusted_router(&root).await;
    for branch in ["-f", "--orphan=x", "", "bad..name"] {
        let (status, body) = post_json(
            router.clone(),
            "/api/editor/switch",
            serde_json::json!({ "root": root, "branch": branch, "create": true, "device_id": "d1" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{branch:?}: body={body}");
    }
    assert_eq!(head(&root), "main");
}

#[tokio::test]
async fn editor_creates_a_branch_here() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "fresh-start", "create": true, "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(head(&root), "fresh-start");
}

#[tokio::test]
async fn editor_opens_an_existing_branch_in_a_new_worktree_under_the_repo() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router.clone(),
        "/api/editor/worktree",
        serde_json::json!({ "root": root, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let path = body["data"]["path"].as_str().expect("path").to_string();
    assert!(
        path.starts_with(&format!("{root}/.sealwire/worktrees/")),
        "nested where the allowed root reaches: {path}"
    );
    assert_eq!(head(&path), "topic");
    // The new tree is immediately usable by the editor.
    let (status, listing) = get_json(
        router,
        &format!("/api/editor/dir?root={}&dir=", query_value(&path)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={listing}");
}

#[tokio::test]
async fn editor_opens_a_new_branch_in_a_new_worktree() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/worktree",
        serde_json::json!({ "root": root, "branch": "spike", "create": true, "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let path = body["data"]["path"].as_str().expect("path");
    assert_eq!(head(path), "spike");
    assert_eq!(
        head(&root),
        "main",
        "the folder the user was in is untouched"
    );
}

#[tokio::test]
async fn editor_worktree_refuses_a_branch_already_checked_out() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/worktree",
        serde_json::json!({ "root": root, "branch": "feature", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
}

#[tokio::test]
async fn editor_switch_from_a_subfolder_needs_the_whole_repository_in_scope() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    let sub = format!("{root}/src");
    // Only the subfolder is allowed; a switch would rewrite files above it.
    let router = git_context_router(&sub, vec![sub.clone()], vec![root.clone()]).await;
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": sub, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head(&root), "main");
}

#[tokio::test]
async fn editor_switch_refuses_shorthand_that_git_would_expand() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    git(&root, &["switch", "-q", "topic"]);
    git(&root, &["switch", "-q", "main"]);
    let router = trusted_router(&root).await;
    for (branch, create) in [
        ("@{-1}", true),
        ("@{-1}", false),
        ("refs/heads/topic", false),
        ("refs/heads/x", true),
        ("HEAD", true),
        ("@", true),
    ] {
        let (status, body) = post_json(
            router.clone(),
            "/api/editor/switch",
            serde_json::json!({ "root": root, "branch": branch, "create": create, "device_id": "d1" }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{branch:?} create={create}: body={body}"
        );
        assert_eq!(head(&root), "main", "{branch:?}");
    }
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "origin/@{-1}", "remote": true, "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
}

#[tokio::test]
async fn editor_worktree_needs_the_git_directory_in_scope() {
    let outside = tempfile::TempDir::new().expect("tmp");
    let inside = tempfile::TempDir::new().expect("tmp");
    let repo = inside.path().canonicalize().unwrap().join("repo");
    let git_dir = outside.path().canonicalize().unwrap().join("repo.git");
    let status = std::process::Command::new("git")
        .args(["init", "-q", "-b", "main", "--separate-git-dir"])
        .arg(&git_dir)
        .arg(&repo)
        .status()
        .unwrap();
    assert!(status.success());
    let root = repo.to_string_lossy().to_string();
    git(&root, &["config", "user.email", "t@e.com"]);
    git(&root, &["config", "user.name", "T"]);
    std::fs::write(format!("{root}/a.txt"), "a\n").unwrap();
    git(&root, &["add", "a.txt"]);
    git(&root, &["commit", "-q", "-m", "a"]);
    let exclude = git_dir.join("info/exclude");
    let before = std::fs::read_to_string(&exclude).unwrap_or_default();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/worktree",
        serde_json::json!({ "root": root, "branch": "spike", "create": true, "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(
        std::fs::read_to_string(&exclude).unwrap_or_default(),
        before
    );
    assert!(
        !git_dir.join("worktrees").exists(),
        "no worktree was registered"
    );
}

#[tokio::test]
async fn editor_will_not_switch_a_tree_inside_a_folder_an_agent_is_working_in() {
    let (dir, _wt_dir, root, _wt) = branchy_repo().await;
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    let above = dir.path().parent().unwrap().canonicalize().unwrap();
    let router = busy_router(&root, &above.to_string_lossy()).await;
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(head(&root), "main");
}

#[tokio::test]
async fn an_agent_in_a_nested_linked_worktree_does_not_block_its_parent_tree() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    std::fs::write(format!("{root}/.git/info/exclude"), ".sealwire/\n").unwrap();
    let task = format!("{root}/.sealwire/worktrees/task");
    git(&root, &["worktree", "add", "-q", "-b", "task", &task]);
    let router = busy_router(&root, &format!("{task}/src")).await;
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the task has its own checkout: {body}"
    );
    assert_eq!(head(&root), "topic");
    assert_eq!(head(&task), "task");
}

#[tokio::test]
async fn a_switch_never_overwrites_ignored_files_such_as_a_nested_worktree() {
    let (_dir, _wt_dir, root, _wt) = branchy_repo().await;
    std::fs::remove_file(format!("{root}/new.txt")).unwrap();
    git(&root, &["checkout", "-q", "--", "seed.txt"]);
    // `topic` tracks a file where main keeps an ignored nested worktree.
    git(&root, &["switch", "-q", "topic"]);
    std::fs::create_dir_all(format!("{root}/.sealwire/worktrees/task")).unwrap();
    std::fs::write(format!("{root}/.sealwire/worktrees/task/seed"), "topic's\n").unwrap();
    git(&root, &["add", "-f", ".sealwire/worktrees/task/seed"]);
    git(&root, &["commit", "-q", "-m", "track it"]);
    git(&root, &["switch", "-q", "main"]);
    std::fs::write(format!("{root}/.git/info/exclude"), ".sealwire/\n").unwrap();
    let task = format!("{root}/.sealwire/worktrees/task");
    git(&root, &["worktree", "add", "-q", "-b", "task", &task]);
    std::fs::write(format!("{task}/seed"), "the agent's unsaved work\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/switch",
        serde_json::json!({ "root": root, "branch": "topic", "device_id": "d1" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(
        std::fs::read_to_string(format!("{task}/seed")).unwrap(),
        "the agent's unsaved work\n"
    );
    assert_eq!(head(&root), "main");
}
