//! The editor's History: the log, one commit's files, and a file before and after it.
//! Read-only, inside the folder the editor is rooted at.

use super::editor_files::{git, query_value, trusted_router};
use super::*;

fn rev(root: &str, spec: &str) -> String {
    let out = std::process::Command::new("git")
        .args(["rev-parse", spec])
        .current_dir(root)
        .output()
        .expect("git runs");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `main`: seed → sub-a → merge(side) → rename+delete; `side`: side-top.
async fn history_repo() -> (tempfile::TempDir, String) {
    let dir = tempfile::TempDir::new().expect("tmp");
    let root = seed_git_repo(dir.path()).await;
    std::fs::create_dir_all(format!("{root}/sub")).unwrap();
    std::fs::write(format!("{root}/sub/a.txt"), "a1\n").unwrap();
    std::fs::write(format!("{root}/top.txt"), "t1\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "Add sub and top"]);
    git(&root, &["switch", "-q", "-c", "side"]);
    std::fs::write(format!("{root}/top.txt"), "t1\nside\n").unwrap();
    git(
        &root,
        &[
            "-c",
            "user.name=Other Person",
            "-c",
            "user.email=o@e.com",
            "commit",
            "-q",
            "-am",
            "Side touches top",
        ],
    );
    git(&root, &["switch", "-q", "main"]);
    std::fs::write(format!("{root}/sub/a.txt"), "a1\na2\n").unwrap();
    git(
        &root,
        &[
            "commit",
            "-q",
            "-am",
            "Grow a [draft]\n\nThe body\nhas lines.",
        ],
    );
    git(&root, &["merge", "-q", "--no-edit", "side"]);
    git(&root, &["mv", "sub/a.txt", "sub/b.txt"]);
    git(&root, &["rm", "-q", "seed.txt"]);
    std::fs::write(format!("{root}/sub/new.txt"), "fresh\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "Rename, delete, add"]);
    (dir, root)
}

fn subjects(body: &serde_json::Value) -> Vec<String> {
    body["data"]["commits"]
        .as_array()
        .unwrap_or_else(|| panic!("commits in {body}"))
        .iter()
        .map(|commit| commit["subject"].as_str().unwrap().to_string())
        .collect()
}

async fn history(router: axum::Router, root: &str, extra: &str) -> (StatusCode, serde_json::Value) {
    get_json(
        router,
        &format!("/api/editor/history?root={}{extra}", query_value(root)),
    )
    .await
}

#[tokio::test]
async fn editor_history_lists_every_branch_newest_first_with_parents_and_refs() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = history(router, &root, "").await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let names = subjects(&body);
    assert_eq!(
        names.first().map(String::as_str),
        Some("Rename, delete, add")
    );
    assert_eq!(names.last().map(String::as_str), Some("seed"));
    assert!(names.contains(&"Side touches top".to_string()), "{names:?}");
    let commits = body["data"]["commits"].as_array().unwrap();
    let merge = commits
        .iter()
        .find(|commit| commit["subject"].as_str().unwrap().starts_with("Merge"))
        .expect("merge");
    assert_eq!(merge["parents"].as_array().unwrap().len(), 2);
    assert_eq!(commits[0]["id"], rev(&root, "HEAD"));
    assert!(
        commits[0]["refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "HEAD -> main"),
        "{body}"
    );
    let side = commits
        .iter()
        .find(|commit| commit["subject"] == "Side touches top")
        .unwrap();
    assert_eq!(side["author"], "Other Person");
    assert!(side["time"].as_i64().unwrap() > 0);
    assert_eq!(body["data"]["more"], false);
}

#[tokio::test]
async fn editor_history_follows_one_branch_and_filters_by_author_text_and_path() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;

    let (status, body) = history(router.clone(), &root, "&branch=side").await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        subjects(&body),
        ["Side touches top", "Add sub and top", "seed"]
    );

    let (_, body) = history(router.clone(), &root, "&author=other%20person").await;
    assert_eq!(subjects(&body), ["Side touches top"]);

    // Plain text, not a pattern: a bracket is not a syntax error and `s.de` is not "Side".
    let (status, body) = history(
        router.clone(),
        &root,
        &format!("&query={}", query_value("[draft")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(subjects(&body), ["Grow a [draft]"]);
    let (_, body) = history(router.clone(), &root, "&query=s.de").await;
    assert_eq!(subjects(&body), Vec::<String>::new());

    let (_, body) = history(router.clone(), &root, "&path=top.txt").await;
    assert_eq!(subjects(&body), ["Side touches top", "Add sub and top"]);
    // Parents are rewritten to the commits listed, so a filtered graph still joins up.
    let commits = body["data"]["commits"].as_array().unwrap();
    assert_eq!(commits[0]["parents"][0], commits[1]["id"]);

    let (status, body) = history(
        router.clone(),
        &root,
        &format!("&branch={}&remote=true", query_value("origin/main")),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an unknown branch is refused: {body}"
    );
}

#[tokio::test]
async fn editor_history_takes_only_a_real_branch_name() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;
    for branch in [
        "-p",
        "--all",
        "HEAD~1",
        "main..side",
        "main^",
        "@{-1}",
        "refs/heads/main",
        ":/seed",
        "",
    ] {
        let (status, body) = history(
            router.clone(),
            &root,
            &format!("&branch={}", query_value(branch)),
        )
        .await;
        if branch.is_empty() {
            assert_eq!(
                status,
                StatusCode::OK,
                "an empty branch means every branch: {body}"
            );
        } else {
            assert_eq!(status, StatusCode::BAD_REQUEST, "{branch}: body={body}");
        }
    }
    for path in ["../x", "/etc"] {
        let (status, body) = history(
            router.clone(),
            &root,
            &format!("&path={}", query_value(path)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: body={body}");
    }
    // A path is a file name, never pathspec magic.
    let (status, body) = history(
        router.clone(),
        &root,
        &format!("&path={}", query_value(":(top)seed.txt")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(subjects(&body), Vec::<String>::new());
}

#[tokio::test]
async fn editor_history_comes_in_pages() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;
    let (_, first) = history(router.clone(), &root, "&limit=2").await;
    assert_eq!(subjects(&first).len(), 2);
    assert_eq!(first["data"]["more"], true);
    let (_, rest) = history(router.clone(), &root, "&limit=50&skip=2").await;
    let (_, all) = history(router, &root, "").await;
    let mut joined = subjects(&first);
    joined.extend(subjects(&rest));
    assert_eq!(joined, subjects(&all));
    assert_eq!(rest["data"]["more"], false);
}

#[tokio::test]
async fn editor_history_commit_lists_its_files_and_full_message() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;
    let head = rev(&root, "HEAD");
    let (status, body) = get_json(
        router.clone(),
        &format!(
            "/api/editor/history/commit?root={}&id={head}",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["id"], head);
    assert_eq!(
        body["data"]["message"].as_str().unwrap().trim(),
        "Rename, delete, add"
    );
    let mut files: Vec<(String, String, String)> = body["data"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            (
                file["status"].as_str().unwrap().to_string(),
                file["path"].as_str().unwrap().to_string(),
                file["old_path"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    files.sort();
    assert_eq!(
        files,
        vec![
            ("A".into(), "sub/new.txt".into(), String::new()),
            ("D".into(), "seed.txt".into(), String::new()),
            ("R".into(), "sub/b.txt".into(), "sub/a.txt".into()),
        ]
    );

    let grown = rev(&root, "HEAD~1^1");
    let (_, body) = get_json(
        router.clone(),
        &format!(
            "/api/editor/history/commit?root={}&id={grown}",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(
        body["data"]["message"].as_str().unwrap().trim(),
        "Grow a [draft]\n\nThe body\nhas lines."
    );

    // A merge is shown against its first parent: what the merge brought in.
    let merge = rev(&root, "HEAD~1");
    let (_, body) = get_json(
        router,
        &format!(
            "/api/editor/history/commit?root={}&id={merge}",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(body["data"]["parents"].as_array().unwrap().len(), 2);
    let paths: Vec<&str> = body["data"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["top.txt"]);
}

#[tokio::test]
async fn editor_history_file_returns_both_sides_of_a_change() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;
    let grown = rev(&root, "HEAD~1^1");
    let (status, body) = get_json(
        router.clone(),
        &format!(
            "/api/editor/history/file?root={}&id={grown}&path=sub/a.txt",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["before"], "a1\n");
    assert_eq!(body["data"]["after"], "a1\na2\n");

    let head = rev(&root, "HEAD");
    let (_, body) = get_json(
        router.clone(),
        &format!(
            "/api/editor/history/file?root={}&id={head}&path=sub/b.txt&old_path=sub/a.txt",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(
        body["data"]["before"], "a1\na2\n",
        "a rename reads the old name before"
    );
    assert_eq!(body["data"]["after"], "a1\na2\n");

    let (_, body) = get_json(
        router.clone(),
        &format!(
            "/api/editor/history/file?root={}&id={head}&path=seed.txt",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(body["data"]["before"], "line1\n");
    assert!(body["data"]["after"].is_null(), "deleted: {body}");

    let first = rev(&root, "HEAD~1^1~2");
    let (_, body) = get_json(
        router,
        &format!(
            "/api/editor/history/file?root={}&id={first}&path=seed.txt",
            query_value(&root)
        ),
    )
    .await;
    assert!(
        body["data"]["before"].is_null(),
        "the first commit has no before: {body}"
    );
    assert_eq!(body["data"]["after"], "line1\n");
}

#[tokio::test]
async fn editor_history_takes_only_a_full_commit_id() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;
    let head = rev(&root, "HEAD");
    let tree = rev(&root, "HEAD^{tree}");
    for id in [
        "HEAD".to_string(),
        "main".to_string(),
        head[..12].to_string(),
        "--all".to_string(),
        format!("{head}^"),
        tree,
        "0".repeat(40),
    ] {
        let (status, body) = get_json(
            router.clone(),
            &format!(
                "/api/editor/history/commit?root={}&id={}",
                query_value(&root),
                query_value(&id)
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{id}: body={body}");
        let (status, body) = get_json(
            router.clone(),
            &format!(
                "/api/editor/history/file?root={}&id={}&path=top.txt",
                query_value(&root),
                query_value(&id)
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{id}: body={body}");
    }
    for path in ["../top.txt", "/etc/passwd", ""] {
        let (status, body) = get_json(
            router.clone(),
            &format!(
                "/api/editor/history/file?root={}&id={head}&path={}",
                query_value(&root),
                query_value(path)
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: body={body}");
    }
}

#[tokio::test]
async fn editor_history_of_a_subfolder_stays_inside_it() {
    let (_dir, root) = history_repo().await;
    let sub = format!("{root}/sub");
    let router = trusted_router(&sub).await;
    let (status, body) = history(router.clone(), &sub, "").await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        subjects(&body),
        ["Rename, delete, add", "Grow a [draft]", "Add sub and top"]
    );

    let head = rev(&root, "HEAD");
    let (_, body) = get_json(
        router.clone(),
        &format!(
            "/api/editor/history/commit?root={}&id={head}",
            query_value(&sub)
        ),
    )
    .await;
    let mut paths: Vec<&str> = body["data"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        ["b.txt", "new.txt"],
        "paths are the folder's own, outside ones left out"
    );

    let (_, body) = get_json(
        router.clone(),
        &format!(
            "/api/editor/history/file?root={}&id={head}&path=b.txt&old_path=a.txt",
            query_value(&sub)
        ),
    )
    .await;
    assert_eq!(body["data"]["after"], "a1\na2\n");
    let (status, _) = get_json(
        router,
        &format!(
            "/api/editor/history/file?root={}&id={head}&path=..%2Ftop.txt",
            query_value(&sub)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn editor_history_needs_a_trusted_folder_inside_the_allowed_roots() {
    let (_dir, root) = history_repo().await;
    let untrusted = git_context_router(&root, vec![root.clone()], Vec::new()).await;
    let (status, body) = history(untrusted, &root, "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    let (_other, elsewhere) = history_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = history(router, &elsewhere, "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
}

#[tokio::test]
async fn editor_history_reads_an_author_name_holding_a_separator_byte() {
    let (_dir, root) = history_repo().await;
    std::fs::write(format!("{root}/top.txt"), "odd author\n").unwrap();
    git(
        &root,
        &[
            "-c",
            "user.name=Ann\u{1f}Inserted",
            "commit",
            "-q",
            "-am",
            "Odd author",
        ],
    );
    let router = trusted_router(&root).await;
    let (status, body) = history(router, &root, "&limit=1").await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let commit = &body["data"]["commits"][0];
    assert_eq!(commit["subject"], "Odd author", "{body}");
    assert_eq!(commit["author"], "Ann\u{1f}Inserted");
    assert!(commit["time"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn editor_history_next_page_never_skips_commits_when_a_branch_moves() {
    let (_dir, root) = history_repo().await;
    let router = trusted_router(&root).await;
    let (_, first) = history(router.clone(), &root, "&branch=main&limit=2").await;
    let tips = first["data"]["tips"].as_str().expect("tips").to_string();
    let (_, all) = history(router.clone(), &root, "&branch=main").await;
    git(&root, &["update-ref", "refs/heads/main", "HEAD~1"]);
    let (status, next) = history(
        router.clone(),
        &root,
        &format!("&branch=main&limit=50&skip=2&tips={tips}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={next}");
    if next["data"]["moved"] == true {
        assert_eq!(
            subjects(&next),
            Vec::<String>::new(),
            "a moved branch asks for a fresh start"
        );
    } else {
        let mut joined = subjects(&first);
        joined.extend(subjects(&next));
        assert_eq!(joined, subjects(&all), "no commit skipped");
    }
    assert_ne!(next["data"]["tips"].as_str().unwrap_or_default(), tips);
}

#[tokio::test]
async fn editor_history_does_not_merge_two_file_names_that_differ_only_in_bad_bytes() {
    let (_dir, root) = history_repo().await;
    let blob = |text: &str| {
        let mut child = std::process::Command::new("git")
            .args(["hash-object", "-w", "--stdin"])
            .current_dir(&root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        String::from_utf8(child.wait_with_output().unwrap().stdout)
            .unwrap()
            .trim()
            .to_string()
    };
    let (bad, good) = (blob("bad bytes\n"), blob("good name\n"));
    let mut listing = Vec::new();
    listing.extend_from_slice(format!("100644 blob {bad}\todd-").as_bytes());
    listing.extend_from_slice(b"\xff.txt\0");
    listing.extend_from_slice(format!("100644 blob {good}\todd-\u{fffd}.txt\0").as_bytes());
    let mut child = std::process::Command::new("git")
        .args(["mktree", "-z"])
        .current_dir(&root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(&listing).unwrap();
    }
    let tree = String::from_utf8(child.wait_with_output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_string();
    let out = std::process::Command::new("git")
        .args(["commit-tree", &tree, "-m", "odd names"])
        .current_dir(&root)
        .output()
        .unwrap();
    let id = String::from_utf8(out.stdout).unwrap().trim().to_string();
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!(
            "/api/editor/history/commit?root={}&id={id}",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let paths: Vec<&str> = body["data"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        ["odd-\u{fffd}.txt"],
        "the bad name is not shown as the good one: {body}"
    );
    assert_eq!(
        body["data"]["truncated"], true,
        "the list says it is not complete"
    );
}
