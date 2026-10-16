//! The editor's History: the log of the folder's repository, one commit's files, and one
//! file before and after a commit. Read-only, and kept to the folder the editor is rooted at.

use tokio::io::AsyncReadExt;

use super::editor_files::{
    editable_text, GitProbe, GitView, EDITOR_FILE_MAX_BYTES, EDITOR_GIT_BUDGET,
};
use super::team_diff::validate_repo_relative_path;
use super::*;
use crate::protocol::{
    EditorCommitDetail, EditorCommitFileEntry, EditorCommitFileView, EditorLogCommit,
    EditorLogQuery, EditorLogView,
};

const EDITOR_LOG_PAGE: usize = 200;
const EDITOR_LOG_MAX_SKIP: usize = 1_000_000;
const EDITOR_LOG_BYTES: usize = 4 * 1024 * 1024;
const EDITOR_FILTER_MAX_CHARS: usize = 200;
const EDITOR_COMMIT_FILES_MAX: usize = 2000;
const EDITOR_COMMIT_FILES_BYTES: usize = 2 * 1024 * 1024;
/// A log over a large history, narrowed to a path, walks every commit.
const EDITOR_HISTORY_BUDGET: Duration = Duration::from_secs(5);
const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s";

impl AppState {
    pub(crate) async fn editor_log(&self, query: EditorLogQuery) -> Result<EditorLogView, String> {
        let workspace = self
            .editor_workspace(query.device_id.as_deref(), &query.root)
            .await?;
        let root = workspace.as_str().to_string();
        let limit = query
            .limit
            .unwrap_or(EDITOR_LOG_PAGE)
            .clamp(1, EDITOR_LOG_PAGE);
        let skip = query.skip.unwrap_or(0);
        if skip > EDITOR_LOG_MAX_SKIP {
            return Err("that is further back than the history goes here".to_string());
        }
        let author = filter_text(query.author.as_deref(), "author")?;
        let text = filter_text(query.query.as_deref(), "search")?;
        let path = match query
            .path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            Some(path) => {
                validate_repo_relative_path(path)?;
                Some(path.to_string())
            }
            None => None,
        };
        let empty = |is_repo: bool, complete: bool| EditorLogView {
            root: root.clone(),
            is_repo,
            complete,
            commits: Vec::new(),
            more: false,
        };
        let git = match GitView::open(&workspace).await {
            GitProbe::Repo(git) => git,
            GitProbe::NotRepo => return Ok(empty(false, true)),
            GitProbe::Unknown => return Ok(empty(true, false)),
        };

        let mut args: Vec<String> = [
            "--literal-pathspecs",
            "log",
            "--no-show-signature",
            "--no-color",
            "--date-order",
            // Rewrites each commit's parents to the ones listed when a path narrows the log,
            // so the graph still joins up.
            "--parents",
            LOG_FORMAT,
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        args.push(format!("--max-count={}", limit + 1));
        args.push(format!("--skip={skip}"));
        if let Some(author) = &author {
            args.push(format!("--author={author}"));
        }
        if let Some(text) = &text {
            args.push(format!("--grep={text}"));
        }
        if author.is_some() || text.is_some() {
            args.extend([
                "--regexp-ignore-case".to_string(),
                "--fixed-strings".to_string(),
            ]);
        }
        match query
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => args.push(branch_ref(&workspace, name, query.remote).await?),
            None => {
                args.extend(["--branches".to_string(), "--remotes".to_string()]);
                // A repository with no commit yet has no HEAD, and git refuses to log one.
                if git_succeeds(&workspace, &["rev-parse", "--verify", "--quiet", "HEAD"]).await {
                    args.push("HEAD".to_string());
                }
            }
        }
        args.push("--".to_string());
        if let Some(path) = path {
            args.push(path);
        } else if !git.prefix.is_empty() {
            args.push(".".to_string());
        }

        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw = match git_read(&workspace, &args, EDITOR_LOG_BYTES, EDITOR_HISTORY_BUDGET).await {
            GitRead::Out(raw) => raw,
            GitRead::Late | GitRead::TooBig(_) => return Ok(empty(true, false)),
            GitRead::Failed => return Err("git could not read this folder's history".to_string()),
        };
        let mut commits: Vec<EditorLogCommit> = String::from_utf8_lossy(&raw)
            .lines()
            .filter_map(parse_log_line)
            .collect();
        let more = commits.len() > limit;
        commits.truncate(limit);
        Ok(EditorLogView {
            root,
            is_repo: true,
            complete: true,
            commits,
            more,
        })
    }

    pub(crate) async fn editor_commit_detail(
        &self,
        device_id: Option<&str>,
        root: &str,
        id: &str,
    ) -> Result<EditorCommitDetail, String> {
        let workspace = self.editor_workspace(device_id, root).await?;
        let id = commit_id(id)?;
        let peeled = format!("{id}^{{commit}}");
        let raw = match git_read(
            &workspace,
            &[
                "log",
                "-1",
                "--no-show-signature",
                "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%B",
                &peeled,
                "--",
            ],
            EDITOR_LOG_BYTES,
            EDITOR_HISTORY_BUDGET,
        )
        .await
        {
            GitRead::Out(raw) => raw,
            GitRead::Late => return Err("reading that commit took too long".to_string()),
            _ => return Err(no_such_commit(id)),
        };
        let text = String::from_utf8_lossy(&raw);
        let fields: Vec<&str> = text.splitn(8, '\0').collect();
        let [commit, parents, author, email, time, committer, committed_at, message] = fields[..]
        else {
            return Err(no_such_commit(id));
        };
        let parents: Vec<String> = parents.split_whitespace().map(str::to_string).collect();

        let mut args = vec![
            "diff-tree",
            "-r",
            "-z",
            "--no-commit-id",
            "--name-status",
            "-M",
            "--relative",
            "--no-ext-diff",
            "--no-textconv",
        ];
        match parents.first() {
            Some(parent) => args.extend([parent.as_str(), commit]),
            None => args.extend(["--root", commit]),
        }
        let (files, truncated) = match git_read(
            &workspace,
            &args,
            EDITOR_COMMIT_FILES_BYTES,
            EDITOR_HISTORY_BUDGET,
        )
        .await
        {
            GitRead::Out(raw) => parse_name_status(&raw, false),
            GitRead::TooBig(raw) => parse_name_status(&raw, true),
            GitRead::Late => return Err("listing that commit's files took too long".to_string()),
            GitRead::Failed => return Err(no_such_commit(id)),
        };
        Ok(EditorCommitDetail {
            id: commit.to_string(),
            parents,
            author: author.to_string(),
            email: email.to_string(),
            time: time.trim().parse().unwrap_or_default(),
            committer: committer.to_string(),
            committed_at: committed_at.trim().parse().unwrap_or_default(),
            message: message.to_string(),
            files,
            truncated,
        })
    }

    pub(crate) async fn editor_commit_file(
        &self,
        device_id: Option<&str>,
        root: &str,
        id: &str,
        path: &str,
        old_path: Option<&str>,
    ) -> Result<EditorCommitFileView, String> {
        let workspace = self.editor_workspace(device_id, root).await?;
        let id = commit_id(id)?;
        validate_repo_relative_path(path)?;
        let old_path = old_path.filter(|old| !old.is_empty());
        if let Some(old) = old_path {
            validate_repo_relative_path(old)?;
        }
        let peeled = format!("{id}^{{commit}}");
        let parents = match git_read(
            &workspace,
            &[
                "log",
                "-1",
                "--no-show-signature",
                "--format=%P",
                &peeled,
                "--",
            ],
            4096,
            EDITOR_GIT_BUDGET,
        )
        .await
        {
            GitRead::Out(raw) => String::from_utf8_lossy(&raw).trim().to_string(),
            GitRead::Late => return Err("reading that commit took too long".to_string()),
            _ => return Err(no_such_commit(id)),
        };
        let mut view = EditorCommitFileView {
            path: path.to_string(),
            before: None,
            after: None,
            binary: false,
            too_large: false,
        };
        // `./` reads the path from the editor root, which may sit below the repository top.
        let after = read_blob(&workspace, &format!("{id}:./{path}")).await?;
        let before = match parents.split_whitespace().next() {
            Some(parent) => {
                read_blob(
                    &workspace,
                    &format!("{parent}:./{}", old_path.unwrap_or(path)),
                )
                .await?
            }
            None => Blob::Missing,
        };
        view.after = view.take(after);
        view.before = view.take(before);
        Ok(view)
    }
}

enum GitRead {
    Out(Vec<u8>),
    /// The first `limit` bytes; git was stopped there.
    TooBig(Vec<u8>),
    Failed,
    Late,
}

/// Stdout of one git run, capped in size and time. Stderr is dropped: every caller turns a
/// failure into its own fixed wording.
async fn git_read(
    workspace: &TrustedWorkspace,
    args: &[&str],
    limit: usize,
    budget: Duration,
) -> GitRead {
    let run = async {
        let Ok(mut child) = background_git(workspace)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        else {
            return GitRead::Failed;
        };
        let Some(mut stdout) = child.stdout.take() else {
            return GitRead::Failed;
        };
        let mut bytes = Vec::new();
        if (&mut stdout)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .is_err()
        {
            return GitRead::Failed;
        }
        if bytes.len() > limit {
            let _ = child.start_kill();
            let _ = child.wait().await;
            bytes.truncate(limit);
            return GitRead::TooBig(bytes);
        }
        drop(stdout);
        match child.wait().await {
            Ok(status) if status.success() => GitRead::Out(bytes),
            _ => GitRead::Failed,
        }
    };
    tokio::time::timeout(budget, run)
        .await
        .unwrap_or(GitRead::Late)
}

async fn git_succeeds(workspace: &TrustedWorkspace, args: &[&str]) -> bool {
    matches!(
        git_read(workspace, args, 4096, EDITOR_GIT_BUDGET).await,
        GitRead::Out(_)
    )
}

/// A branch the repository has, as a full ref name: never a revision expression or option.
async fn branch_ref(
    workspace: &TrustedWorkspace,
    name: &str,
    remote: bool,
) -> Result<String, String> {
    let missing = || format!("there is no branch named {name}");
    if name.starts_with('-') || name.starts_with("refs/") || name.contains("..") {
        return Err(missing());
    }
    let full = if remote {
        format!("refs/remotes/{name}")
    } else {
        format!("refs/heads/{name}")
    };
    if !git_succeeds(workspace, &["check-ref-format", &full]).await
        || !git_succeeds(workspace, &["show-ref", "--verify", "--quiet", &full]).await
    {
        return Err(missing());
    }
    Ok(full)
}

/// A full object id, SHA-1 or SHA-256. Anything shorter or symbolic would be a revision
/// expression, which git would resolve to something the caller never named.
fn commit_id(id: &str) -> Result<&str, String> {
    let hex = id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if hex && (id.len() == 40 || id.len() == 64) {
        Ok(id)
    } else {
        Err("that is not a commit id".to_string())
    }
}

fn no_such_commit(id: &str) -> String {
    format!("there is no commit {}", &id[..id.len().min(12)])
}

fn filter_text(value: Option<&str>, what: &str) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > EDITOR_FILTER_MAX_CHARS || value.contains('\0') {
        return Err(format!("the {what} filter is too long"));
    }
    Ok(Some(value.to_string()))
}

fn parse_log_line(line: &str) -> Option<EditorLogCommit> {
    let mut fields = line.splitn(6, '\x1f');
    let id = fields.next()?.to_string();
    let parents = fields
        .next()?
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let author = fields.next()?.to_string();
    let time = fields.next()?.trim().parse().unwrap_or_default();
    // Ref names cannot hold a space, so git's ", " separator is unambiguous.
    let refs = fields
        .next()?
        .split(", ")
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    let subject = fields.next().unwrap_or_default().to_string();
    if id.is_empty() {
        return None;
    }
    Some(EditorLogCommit {
        id,
        parents,
        author,
        time,
        refs,
        subject,
    })
}

/// `diff-tree -z --name-status`: a status, then one path, or two after a rename or copy.
/// When git was cut short the last entry may be cut too, so it is dropped.
fn parse_name_status(raw: &[u8], cut: bool) -> (Vec<EditorCommitFileEntry>, bool) {
    let mut fields = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let letter = status.first().copied().unwrap_or(b'M');
        let Some(first) = fields.next() else {
            break;
        };
        let first = String::from_utf8_lossy(first).to_string();
        let entry = if matches!(letter, b'R' | b'C') {
            let Some(second) = fields.next() else {
                break;
            };
            EditorCommitFileEntry {
                path: String::from_utf8_lossy(second).to_string(),
                old_path: Some(first),
                status: if letter == b'R' { "R" } else { "A" }.to_string(),
            }
        } else {
            EditorCommitFileEntry {
                path: first,
                old_path: None,
                status: match letter {
                    b'A' => "A",
                    b'D' => "D",
                    _ => "M",
                }
                .to_string(),
            }
        };
        files.push(entry);
    }
    if cut {
        files.pop();
    }
    let truncated = cut || files.len() > EDITOR_COMMIT_FILES_MAX;
    files.truncate(EDITOR_COMMIT_FILES_MAX);
    (files, truncated)
}

enum Blob {
    Missing,
    TooLarge,
    Content(Vec<u8>),
}

async fn read_blob(workspace: &TrustedWorkspace, spec: &str) -> Result<Blob, String> {
    match git_read(
        workspace,
        &["cat-file", "blob", spec],
        EDITOR_FILE_MAX_BYTES as usize,
        EDITOR_GIT_BUDGET,
    )
    .await
    {
        GitRead::Out(bytes) => Ok(Blob::Content(bytes)),
        GitRead::TooBig(_) => Ok(Blob::TooLarge),
        GitRead::Failed => Ok(Blob::Missing),
        GitRead::Late => Err("reading that file from history took too long".to_string()),
    }
}

impl EditorCommitFileView {
    fn take(&mut self, blob: Blob) -> Option<String> {
        match blob {
            Blob::Missing => None,
            Blob::TooLarge => {
                self.too_large = true;
                None
            }
            Blob::Content(bytes) => {
                let text = editable_text(bytes);
                self.binary |= text.is_none();
                text
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_short_file_list_drops_its_last_entry() {
        let raw = b"M\0a.txt\0R100\0old.txt\0new.txt\0A\0half-writ";
        let (files, truncated) = parse_name_status(raw, true);
        assert!(truncated);
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "new.txt"]);
        assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn only_a_full_lowercase_hex_id_is_a_commit_id() {
        assert!(commit_id(&"a".repeat(40)).is_ok());
        assert!(commit_id(&"0".repeat(64)).is_ok());
        for id in [
            "HEAD",
            "abc123",
            &"A".repeat(40),
            &format!("{}^", "a".repeat(40)),
        ] {
            assert!(commit_id(id).is_err(), "{id}");
        }
    }
}
