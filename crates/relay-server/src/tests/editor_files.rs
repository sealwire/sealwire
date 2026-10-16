//! The editor's file routes: what they may reach, and that a save never lands on top of a
//! change the editor did not see.

use super::*;
use sha2::{Digest, Sha256};

fn query_value(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn revision(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn git(root: &str, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?} failed: {out:?}");
}

/// A repo with an ignored build tree, a committed source file, one modified tracked file
/// (`seed.txt`) and one untracked file (`new.txt`).
async fn editor_repo() -> (tempfile::TempDir, String) {
    let dir = tempfile::TempDir::new().expect("tmp");
    let root = seed_git_repo(dir.path()).await;
    std::fs::write(format!("{root}/.gitignore"), "target/\n").unwrap();
    std::fs::create_dir_all(format!("{root}/src/inner")).unwrap();
    std::fs::create_dir_all(format!("{root}/target/debug")).unwrap();
    std::fs::write(format!("{root}/src/lib.rs"), "fn a() {}\n").unwrap();
    std::fs::write(format!("{root}/target/debug/out"), "x").unwrap();
    git(&root, &["add", ".gitignore", "src/lib.rs"]);
    git(&root, &["commit", "-q", "-m", "src"]);
    std::fs::write(format!("{root}/seed.txt"), "line1\nline2\n").unwrap();
    std::fs::write(format!("{root}/new.txt"), "n\n").unwrap();
    (dir, root)
}

async fn trusted_router(root: &str) -> axum::Router {
    git_context_router(root, vec![root.to_string()], vec![root.to_string()]).await
}

fn entry<'a>(body: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    body["data"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap_or_else(|| panic!("no entry {name} in {body}"))
}

#[tokio::test]
async fn editor_lists_a_folder_without_git_internals_or_ignored_trees() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!("/api/editor/dir?root={}&dir=", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let names: Vec<&str> = body["data"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["src", ".gitignore", "new.txt", "seed.txt"]);
    assert_eq!(entry(&body, "seed.txt")["status"], "M");
    assert_eq!(entry(&body, "new.txt")["status"], "?");
    assert!(entry(&body, ".gitignore").get("status").is_none());
    assert_eq!(entry(&body, "src")["kind"], "dir");
    assert_eq!(body["data"]["statuses_known"], true);
}

#[tokio::test]
async fn editor_marks_a_folder_that_holds_a_change() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/src/lib.rs"), "fn b() {}\n").unwrap();
    let router = trusted_router(&root).await;
    let (_, top) = get_json(
        router.clone(),
        &format!("/api/editor/dir?root={}&dir=", query_value(&root)),
    )
    .await;
    assert_eq!(entry(&top, "src")["changed"], true, "body={top}");
    let (status, src) = get_json(
        router,
        &format!("/api/editor/dir?root={}&dir=src", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={src}");
    assert_eq!(entry(&src, "lib.rs")["path"], "src/lib.rs");
    assert_eq!(entry(&src, "lib.rs")["status"], "M");
    assert_eq!(entry(&src, "inner")["kind"], "dir");
}

#[tokio::test]
async fn editor_rooted_in_a_subfolder_reports_paths_relative_to_it() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/src/lib.rs"), "fn b() {}\n").unwrap();
    let sub = format!("{root}/src");
    let router = git_context_router(&root, vec![root.clone()], vec![root.clone()]).await;
    let (status, body) = get_json(
        router.clone(),
        &format!("/api/editor/dir?root={}&dir=", query_value(&sub)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(entry(&body, "lib.rs")["status"], "M");
    let (_, changes) = get_json(
        router,
        &format!("/api/editor/changes?root={}", query_value(&sub)),
    )
    .await;
    let paths: Vec<&str> = changes["data"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, vec!["lib.rs"], "body={changes}");
}

#[tokio::test]
async fn editor_refuses_a_folder_outside_the_allowed_roots_without_naming_it() {
    let (_dir, root) = editor_repo().await;
    let outside = tempfile::TempDir::new().expect("tmp");
    let outside_root = seed_git_repo(outside.path()).await;
    let router = trusted_router(&root).await;
    for uri in [
        format!("/api/editor/dir?root={}&dir=", query_value(&outside_root)),
        format!(
            "/api/editor/file?root={}&path=seed.txt",
            query_value(&outside_root)
        ),
    ] {
        let (status, body) = get_json(router.clone(), &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: body={body}");
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            !message.contains(&outside_root),
            "the refusal must not describe the target: {message}"
        );
    }
}

#[tokio::test]
async fn editor_refuses_a_folder_that_is_not_trusted() {
    let (_dir, root) = editor_repo().await;
    let router = git_context_router(&root, vec![root.clone()], Vec::new()).await;
    let (status, body) = get_json(
        router.clone(),
        &format!("/api/editor/file?root={}&path=seed.txt", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("not trusted"),
        "body={body}"
    );
    let (status, body) = post_json(
        router,
        "/api/editor/file",
        serde_json::json!({
            "root": root, "path": "seed.txt", "content": "x",
            "expected_revision": revision("line1\nline2\n"), "device_id": "d1",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(
        std::fs::read_to_string(format!("{root}/seed.txt")).unwrap(),
        "line1\nline2\n"
    );
}

#[tokio::test]
async fn editor_reads_a_file_with_the_revision_a_save_must_quote() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!(
            "/api/editor/file?root={}&path=src/lib.rs",
            query_value(&root)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["content"], "fn a() {}\n");
    assert_eq!(body["data"]["revision"], revision("fn a() {}\n"));
    assert_eq!(body["data"]["binary"], false);
}

#[tokio::test]
async fn editor_does_not_open_a_binary_file_as_text() {
    let (_dir, root) = editor_repo().await;
    std::fs::write(format!("{root}/blob.bin"), b"ab\0cd").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!("/api/editor/file?root={}&path=blob.bin", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["binary"], true);
    assert!(body["data"]["content"].is_null());
}

#[tokio::test]
async fn editor_refuses_paths_that_climb_out_of_the_folder() {
    let (_dir, root) = editor_repo().await;
    let outside = tempfile::TempDir::new().expect("tmp");
    std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        format!("{root}/link.txt"),
    )
    .unwrap();
    let router = trusted_router(&root).await;
    let mut paths = vec!["../seed.txt", "/etc/hosts", "src/../../x"];
    if cfg!(unix) {
        paths.push("link.txt");
    }
    for path in paths {
        let (status, body) = get_json(
            router.clone(),
            &format!(
                "/api/editor/file?root={}&path={}",
                query_value(&root),
                query_value(path)
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: body={body}");
        assert!(body["data"]["content"].is_null(), "{path} leaked: {body}");
    }
    let (_, listing) = get_json(
        router,
        &format!("/api/editor/dir?root={}&dir=", query_value(&root)),
    )
    .await;
    assert!(
        !listing.to_string().contains("link.txt"),
        "a link out of the folder is not listed: {listing}"
    );
}

#[tokio::test]
async fn editor_saves_over_the_revision_it_loaded() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/file",
        serde_json::json!({
            "root": root, "path": "src/lib.rs", "content": "fn b() {}\n",
            "expected_revision": revision("fn a() {}\n"), "device_id": "d1",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["status"], "saved");
    assert_eq!(body["data"]["revision"], revision("fn b() {}\n"));
    assert_eq!(
        std::fs::read_to_string(format!("{root}/src/lib.rs")).unwrap(),
        "fn b() {}\n"
    );
}

#[tokio::test]
async fn editor_never_saves_over_a_change_it_did_not_see() {
    let (_dir, root) = editor_repo().await;
    // An agent rewrote the file after the editor loaded "fn a() {}".
    std::fs::write(format!("{root}/src/lib.rs"), "fn agent() {}\n").unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/file",
        serde_json::json!({
            "root": root, "path": "src/lib.rs", "content": "fn mine() {}\n",
            "expected_revision": revision("fn a() {}\n"), "device_id": "d1",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["status"], "conflict");
    assert_eq!(
        body["data"]["current_revision"],
        revision("fn agent() {}\n")
    );
    assert_eq!(
        std::fs::read_to_string(format!("{root}/src/lib.rs")).unwrap(),
        "fn agent() {}\n"
    );
}

#[tokio::test]
async fn editor_does_not_bring_back_a_deleted_file() {
    let (_dir, root) = editor_repo().await;
    std::fs::remove_file(format!("{root}/src/lib.rs")).unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/file",
        serde_json::json!({
            "root": root, "path": "src/lib.rs", "content": "fn b() {}\n",
            "expected_revision": revision("fn a() {}\n"), "device_id": "d1",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["status"], "missing");
    assert!(!std::path::Path::new(&format!("{root}/src/lib.rs")).exists());
}

#[tokio::test]
async fn editor_save_needs_a_device_id() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/file",
        serde_json::json!({
            "root": root, "path": "src/lib.rs", "content": "fn b() {}\n",
            "expected_revision": revision("fn a() {}\n"),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(
        std::fs::read_to_string(format!("{root}/src/lib.rs")).unwrap(),
        "fn a() {}\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn editor_save_keeps_the_file_executable() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = editor_repo().await;
    let script = format!("{root}/run.sh");
    std::fs::write(&script, "#!/bin/sh\necho a\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let router = trusted_router(&root).await;
    let (status, body) = post_json(
        router,
        "/api/editor/file",
        serde_json::json!({
            "root": root, "path": "run.sh", "content": "#!/bin/sh\necho b\n",
            "expected_revision": revision("#!/bin/sh\necho a\n"), "device_id": "d1",
        }),
    )
    .await;
    assert_eq!(
        body["data"]["status"], "saved",
        "status={status} body={body}"
    );
    let mode = std::fs::metadata(&script).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o755);
}

#[tokio::test]
async fn editor_stat_reports_each_open_file_or_its_absence() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    let paths = serde_json::json!(["src/lib.rs", "gone.rs"]).to_string();
    let (status, body) = get_json(
        router,
        &format!(
            "/api/editor/stat?root={}&paths={}",
            query_value(&root),
            query_value(&paths)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let stats = body["data"].as_array().expect("stats");
    assert_eq!(stats[0]["revision"], revision("fn a() {}\n"));
    assert_eq!(stats[0]["missing"], false);
    assert!(stats[1]["revision"].is_null());
    assert_eq!(stats[1]["missing"], true);
}

#[tokio::test]
async fn editor_lists_the_changed_files() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!("/api/editor/changes?root={}", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["complete"], true);
    assert_eq!(
        body["data"]["entries"],
        serde_json::json!([
            { "path": "new.txt", "status": "?" },
            { "path": "seed.txt", "status": "M" },
        ])
    );
}

#[tokio::test]
async fn editor_base_is_the_last_committed_text() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router.clone(),
        &format!("/api/editor/base?root={}&path=seed.txt", query_value(&root)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["content"], "line1\n");
    assert_eq!(body["data"]["tracked"], true);
    let (_, untracked) = get_json(
        router,
        &format!("/api/editor/base?root={}&path=new.txt", query_value(&root)),
    )
    .await;
    assert_eq!(untracked["data"]["tracked"], false);
    assert!(untracked["data"]["content"].is_null());
}

#[tokio::test]
async fn editor_base_is_relative_to_a_subfolder_root() {
    let (_dir, root) = editor_repo().await;
    let sub = format!("{root}/src");
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!("/api/editor/base?root={}&path=lib.rs", query_value(&sub)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["content"], "fn a() {}\n");
}

#[tokio::test]
async fn editor_base_refuses_paths_out_of_the_folder() {
    let (_dir, root) = editor_repo().await;
    let sub = format!("{root}/src");
    let router = trusted_router(&root).await;
    for (folder, path) in [
        (&root, "../x"),
        (&sub, "../seed.txt"),
        (&root, "/etc/hosts"),
    ] {
        let (status, body) = get_json(
            router.clone(),
            &format!(
                "/api/editor/base?root={}&path={}",
                query_value(folder),
                query_value(path)
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: body={body}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editor_saves_racing_over_one_revision_let_exactly_one_through() {
    let (_dir, root) = editor_repo().await;
    let router = trusted_router(&root).await;
    for round in 0..12 {
        let current = std::fs::read_to_string(format!("{root}/src/lib.rs")).unwrap();
        let expected = revision(&current);
        let mut writers = Vec::new();
        for writer in 0..6 {
            let router = router.clone();
            let root = root.clone();
            let expected = expected.clone();
            writers.push(tokio::spawn(async move {
                post_json(
                    router,
                    "/api/editor/file",
                    serde_json::json!({
                        "root": root, "path": "src/lib.rs",
                        "content": format!("round {round} writer {writer}\n"),
                        "expected_revision": expected, "device_id": "d1",
                    }),
                )
                .await
            }));
        }
        let mut saved = 0;
        for writer in writers {
            let (_, body) = writer.await.unwrap();
            if body["data"]["status"] == "saved" {
                saved += 1;
            }
        }
        assert_eq!(
            saved, 1,
            "round {round}: one save wins, the rest see a conflict"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn editor_does_not_say_whether_a_path_behind_an_outward_link_exists() {
    let (_dir, root) = editor_repo().await;
    let outside = tempfile::TempDir::new().expect("tmp");
    std::fs::create_dir_all(outside.path().join("existing")).unwrap();
    std::fs::write(outside.path().join("existing.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(outside.path(), format!("{root}/out")).unwrap();
    let router = trusted_router(&root).await;
    // A refusal may echo the caller's own path; everything else must match.
    let ask = |uri: String| {
        let router = router.clone();
        async move {
            let (status, body) = get_json(router, &uri).await;
            let text = body
                .to_string()
                .replace("existing", "<path>")
                .replace("missing", "<path>");
            (status, text)
        }
    };
    let q = query_value(&root);
    let dir_hit = ask(format!("/api/editor/dir?root={q}&dir=out/existing")).await;
    let dir_miss = ask(format!("/api/editor/dir?root={q}&dir=out/missing")).await;
    assert_eq!(dir_hit, dir_miss, "folder refusals must read the same");
    let file_hit = ask(format!("/api/editor/file?root={q}&path=out/existing.txt")).await;
    let file_miss = ask(format!("/api/editor/file?root={q}&path=out/missing.txt")).await;
    assert_eq!(file_hit, file_miss, "file refusals must read the same");
    let paths =
        query_value(&serde_json::json!(["out/existing.txt", "out/missing.txt"]).to_string());
    let (status, stats) = get_json(
        router.clone(),
        &format!("/api/editor/stat?root={q}&paths={paths}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={stats}");
    assert_eq!(
        stats["data"][0],
        serde_json::json!({"path": "out/existing.txt", "revision": null, "missing": true, "too_large": false})
    );
    assert_eq!(stats["data"][1]["missing"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn editor_listing_answers_even_when_git_itself_hangs() {
    let (_dir, root) = editor_repo().await;
    // A config include pointing at a FIFO with no writer blocks every git command.
    let fifo = format!("{root}/.git/stall");
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap();
    assert!(made.success());
    git(&root, &["config", "include.path", &fifo]);
    let router = trusted_router(&root).await;
    let listing = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        get_json(
            router,
            &format!("/api/editor/dir?root={}&dir=", query_value(&root)),
        ),
    )
    .await
    .expect("the listing must not wait on git forever");
    assert_eq!(listing.0, StatusCode::OK, "body={}", listing.1);
    assert_eq!(listing.1["data"]["statuses_known"], false);
}

#[tokio::test]
async fn editor_rooted_in_a_folder_with_a_leading_space_keeps_its_statuses() {
    let (_dir, root) = editor_repo().await;
    std::fs::create_dir_all(format!("{root}/ src")).unwrap();
    std::fs::write(format!("{root}/ src/a.rs"), "a\n").unwrap();
    git(&root, &["add", " src/a.rs"]);
    git(&root, &["commit", "-q", "-m", "spaced"]);
    std::fs::write(format!("{root}/ src/a.rs"), "b\n").unwrap();
    let spaced = format!("{root}/ src");
    let router = trusted_router(&root).await;
    let (status, body) = get_json(
        router,
        &format!("/api/editor/dir?root={}&dir=", query_value(&spaced)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(entry(&body, "a.rs")["status"], "M");
}
