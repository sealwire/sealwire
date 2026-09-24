//! Provider skills: what the composer's "/" menu offers beside Sealwire's own commands.
//!
//! The provider's own runtime is the source of truth (`ProviderBridge::list_skills`).
//! What lives here is the fallback for when it cannot answer, and the two rules every
//! path shares: which listed skill a pick names, and what text the turn carries.

use std::path::{Path, PathBuf};

use crate::protocol::{ProviderSkillView, SkillInvocationInput};
use crate::provider::SkillInvocation;

/// Where a provider keeps skills on disk. Explicit so tests never read the real home.
#[derive(Debug, Clone, Default)]
pub(crate) struct SkillRoots {
    pub(crate) home: Option<PathBuf>,
    pub(crate) codex_home: Option<PathBuf>,
    pub(crate) claude_home: Option<PathBuf>,
}

impl SkillRoots {
    pub(crate) fn from_env() -> Self {
        let home = crate::state_paths::home_dir();
        let env_dir = |key: &str| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        Self {
            codex_home: env_dir("CODEX_HOME").or_else(|| home.as_ref().map(|h| h.join(".codex"))),
            claude_home: env_dir("CLAUDE_CONFIG_DIR")
                .or_else(|| home.as_ref().map(|h| h.join(".claude"))),
            home,
        }
    }
}

/// Sort key for the menu: what this repo adds first, then the person's own, then the
/// ones that came with something else.
fn scope_rank(scope: &str) -> u8 {
    match scope {
        "repo" => 0,
        "global" => 1,
        "plugin" => 2,
        "admin" => 3,
        "system" => 4,
        "builtin" => 5,
        "session" => 6,
        _ => 7,
    }
}

pub(crate) fn sort_skills(skills: &mut [ProviderSkillView]) {
    skills.sort_by(|a, b| {
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
}

/// The skills `provider` would load for `cwd`, read off disk. Deliberately narrower
/// than any runtime (no plugins, no bundled skills): it only exists so a provider that
/// cannot answer still shows what the person and the repo put there.
pub(crate) fn scan_skills_on_disk(
    provider: &str,
    cwd: &Path,
    roots: &SkillRoots,
) -> Vec<ProviderSkillView> {
    let project_dirs = project_dirs(cwd);
    let mut skills = Vec::new();
    match provider {
        "codex" => {
            if let Some(codex_home) = &roots.codex_home {
                let user = codex_home.join("skills");
                collect_skill_dirs(&user, "global", &mut skills);
                collect_skill_dirs(&user.join(".system"), "system", &mut skills);
            }
            if let Some(home) = &roots.home {
                collect_skill_dirs(&home.join(".agents/skills"), "global", &mut skills);
            }
            for dir in &project_dirs {
                collect_skill_dirs(&dir.join(".agents/skills"), "repo", &mut skills);
                collect_skill_dirs(&dir.join(".codex/skills"), "repo", &mut skills);
            }
        }
        "claude_code" => {
            if let Some(claude_home) = &roots.claude_home {
                collect_skill_dirs(&claude_home.join("skills"), "global", &mut skills);
                collect_command_files(&claude_home.join("commands"), "global", &mut skills);
            }
            for dir in &project_dirs {
                collect_skill_dirs(&dir.join(".claude/skills"), "repo", &mut skills);
                collect_command_files(&dir.join(".claude/commands"), "repo", &mut skills);
            }
        }
        // Per cursor.com/docs/context/skills: its own and the `.agents` roots, Claude's and
        // Codex's for compatibility, each walked recursively, plus the `.cursor/skills` or
        // `.agents/skills` of any package inside the repository.
        "cursor" => {
            if let Some(home) = &roots.home {
                for root in CURSOR_SKILL_ROOTS {
                    walk_skill_root(&home.join(root), "global", None, &mut skills);
                }
                collect_command_files(&home.join(".cursor/commands"), "global", &mut skills);
            }
            for dir in &project_dirs {
                for root in CURSOR_SKILL_ROOTS {
                    walk_skill_root(&dir.join(root), "repo", None, &mut skills);
                }
                collect_command_files(&dir.join(".cursor/commands"), "repo", &mut skills);
            }
            if let Some(repo_root) = project_dirs.last() {
                for (package, root) in nested_package_skill_roots(repo_root) {
                    walk_skill_root(&root, "repo", Some(&package), &mut skills);
                }
            }
        }
        _ => {}
    }
    // One file, one row, however many roots reached it (a package the cwd sits in is
    // both an ancestor and a nested package).
    skills.sort_by(|a, b| a.path.cmp(&b.path));
    skills.dedup_by(|a, b| a.path == b.path);
    sort_skills(&mut skills);
    skills
}

const CURSOR_SKILL_ROOTS: [&str; 4] = [
    ".agents/skills",
    ".cursor/skills",
    ".claude/skills",
    ".codex/skills",
];
/// Bounds on the fallback's walks: it runs on a menu open, in whatever tree the session
/// happens to be in.
const MAX_WALK_DEPTH: usize = 8;
const MAX_WALK_DIRS: usize = 5_000;
/// Never where a repository's own skills live, and often enormous.
const SKIPPED_DIRS: [&str; 7] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "venv",
    "__pycache__",
];

fn walkable(dir_name: &str) -> bool {
    !dir_name.starts_with('.') && !SKIPPED_DIRS.contains(&dir_name)
}

/// Every `SKILL.md` under `root`, named by the folder that holds it — Cursor's rule.
fn walk_skill_root(
    root: &Path,
    scope: &str,
    origin: Option<&str>,
    out: &mut Vec<ProviderSkillView>,
) {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = pending.pop() {
        visited += 1;
        if visited > MAX_WALK_DIRS {
            return;
        }
        for entry in sorted_entries(&dir) {
            let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !entry.is_dir() || !walkable(name) {
                continue;
            }
            let file = entry.join("SKILL.md");
            if file.is_file() {
                let meta = read_front_matter(&file);
                out.push(ProviderSkillView {
                    name: name.to_string(),
                    description: meta.description.unwrap_or_default(),
                    scope: scope.to_string(),
                    origin: origin.map(str::to_string),
                    path: Some(file.to_string_lossy().into_owned()),
                    argument_hint: meta.argument_hint,
                });
            }
            if depth + 1 < MAX_WALK_DEPTH {
                pending.push((entry, depth + 1));
            }
        }
    }
}

/// `(package, skills root)` for every `.cursor/skills` or `.agents/skills` below
/// `repo_root`, the package named by its path from the root.
fn nested_package_skill_roots(repo_root: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let mut pending = vec![(repo_root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = pending.pop() {
        visited += 1;
        if visited > MAX_WALK_DIRS {
            break;
        }
        for entry in sorted_entries(&dir) {
            let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !entry.is_dir() || !walkable(name) {
                continue;
            }
            let package = entry
                .strip_prefix(repo_root)
                .map(|relative| relative.to_string_lossy().into_owned())
                .unwrap_or_default();
            for root in [".cursor/skills", ".agents/skills"] {
                if entry.join(root).is_dir() {
                    found.push((package.clone(), entry.join(root)));
                }
            }
            if depth + 1 < MAX_WALK_DEPTH {
                pending.push((entry, depth + 1));
            }
        }
    }
    found
}

/// Scope for rows an agent announced without one, from where the same name sits on
/// disk. A name found nowhere stays `session`: the agent offered it, nothing more is known.
pub(crate) fn label_from_disk(
    mut announced: Vec<ProviderSkillView>,
    provider: &str,
    cwd: &Path,
    roots: &SkillRoots,
) -> Vec<ProviderSkillView> {
    let on_disk = scan_skills_on_disk(provider, cwd, roots);
    for row in &mut announced {
        let found = on_disk
            .iter()
            .filter(|skill| skill.name == row.name)
            .collect::<Vec<_>>();
        // Files in two scopes means either could be the one announced: saying which
        // would be a guess, so the row stays `session`.
        let scopes = found
            .iter()
            .map(|skill| skill.scope.as_str())
            .collect::<std::collections::HashSet<_>>();
        if scopes.len() != 1 {
            continue;
        }
        row.scope = found[0].scope.clone();
        if let [only] = found.as_slice() {
            row.origin = only.origin.clone();
            if row.description.is_empty() {
                row.description = only.description.clone();
            }
        }
    }
    announced
}

/// `cwd` and each parent up to the repository root. Outside a repository, `cwd` alone:
/// walking to `/` would pick up whatever a stray parent directory happens to hold.
fn project_dirs(cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for dir in cwd.ancestors() {
        dirs.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            return dirs;
        }
    }
    vec![cwd.to_path_buf()]
}

fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn collect_skill_dirs(dir: &Path, scope: &str, out: &mut Vec<ProviderSkillView>) {
    for entry in sorted_entries(dir) {
        let file = entry.join("SKILL.md");
        let Some(dir_name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if dir_name.starts_with('.') || !file.is_file() {
            continue;
        }
        let meta = read_front_matter(&file);
        out.push(ProviderSkillView {
            name: meta.name.unwrap_or_else(|| dir_name.to_string()),
            description: meta.description.unwrap_or_default(),
            scope: scope.to_string(),
            origin: None,
            path: Some(file.to_string_lossy().into_owned()),
            argument_hint: meta.argument_hint,
        });
    }
}

fn collect_command_files(dir: &Path, scope: &str, out: &mut Vec<ProviderSkillView>) {
    for file in sorted_entries(dir) {
        if file.extension().and_then(|ext| ext.to_str()) != Some("md") || !file.is_file() {
            continue;
        }
        let Some(stem) = file.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let meta = read_front_matter(&file);
        out.push(ProviderSkillView {
            name: stem.to_string(),
            description: meta.description.unwrap_or_default(),
            scope: scope.to_string(),
            origin: None,
            path: Some(file.to_string_lossy().into_owned()),
            argument_hint: meta.argument_hint,
        });
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct FrontMatter {
    name: Option<String>,
    description: Option<String>,
    argument_hint: Option<String>,
}

/// Enough YAML front matter for a menu row. A skill file is user content, so this reads
/// a bounded prefix and never fails: a row with no description beats no row.
fn read_front_matter(file: &Path) -> FrontMatter {
    use std::io::Read;
    let mut head = String::new();
    if let Ok(handle) = std::fs::File::open(file) {
        let _ = handle.take(16 * 1024).read_to_string(&mut head);
    }
    parse_front_matter(&head)
}

fn parse_front_matter(text: &str) -> FrontMatter {
    let mut meta = FrontMatter::default();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return meta;
    }
    let body = lines
        .take_while(|line| line.trim() != "---")
        .collect::<Vec<_>>();
    let mut index = 0;
    while index < body.len() {
        let line = body[index];
        index += 1;
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let mut value = value.trim().to_string();
        // Block scalars (`>` / `|`): fold the indented lines that follow into one.
        if matches!(value.as_str(), ">" | "|" | ">-" | "|-") {
            let mut folded = Vec::new();
            while index < body.len() && body[index].starts_with(char::is_whitespace) {
                folded.push(body[index].trim());
                index += 1;
            }
            value = folded.join(" ");
        }
        let value = unquote(value.trim());
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" => meta.name = Some(value),
            "description" => meta.description = Some(value),
            "argument-hint" | "argument_hint" => meta.argument_hint = Some(value),
            _ => {}
        }
    }
    meta
}

fn unquote(value: &str) -> String {
    let quoted = value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')));
    if quoted {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

/// One row per name, for a provider that runs `/name`: same-name files are one command
/// the provider resolves itself, so no row may claim which file runs. Scopes that differ
/// become `ambiguous`, with the scopes found listed in `origin`.
pub(crate) fn collapse_slash_twins(skills: Vec<ProviderSkillView>) -> Vec<ProviderSkillView> {
    let mut rows: Vec<ProviderSkillView> = Vec::with_capacity(skills.len());
    let mut scopes: Vec<Vec<String>> = Vec::with_capacity(skills.len());
    for skill in skills {
        let Some(index) = rows.iter().position(|row| row.name == skill.name) else {
            scopes.push(vec![skill.scope.clone()]);
            rows.push(skill);
            continue;
        };
        let row = &mut rows[index];
        if !scopes[index].contains(&skill.scope) {
            scopes[index].push(skill.scope.clone());
        }
        row.path = None;
        if row.description != skill.description {
            row.description.clear();
        }
        if row.origin != skill.origin {
            row.origin = None;
        }
        if row.argument_hint != skill.argument_hint {
            row.argument_hint = None;
        }
    }
    for (row, found) in rows.iter_mut().zip(scopes) {
        if found.len() > 1 {
            row.scope = "ambiguous".to_string();
            row.origin = Some(found.join(","));
        }
    }
    rows
}

/// The listed skill a pick names, or why it names none.
///
/// Codex is matched on name AND path, because a name alone can be two different files.
/// A slash provider dispatches by name, so its name is the whole identity.
pub(crate) fn find_listed_skill<'a>(
    skills: &'a [ProviderSkillView],
    pick: &SkillInvocationInput,
    invocation: SkillInvocation,
) -> Option<&'a ProviderSkillView> {
    match invocation {
        SkillInvocation::SkillInput => {
            let path = pick.path.as_deref().filter(|path| !path.is_empty())?;
            skills
                .iter()
                .find(|skill| skill.name == pick.name && skill.path.as_deref() == Some(path))
        }
        SkillInvocation::Slash => skills.iter().find(|skill| skill.name == pick.name),
    }
}

/// The turn text for a picked skill: the provider's own spelling of it, then the words.
pub(crate) fn compose_skill_text(invocation: SkillInvocation, name: &str, args: &str) -> String {
    let sigil = match invocation {
        SkillInvocation::Slash => '/',
        SkillInvocation::SkillInput => '$',
    };
    let args = args.trim();
    if args.is_empty() {
        format!("{sigil}{name}")
    } else {
        format!("{sigil}{name} {args}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn skill(dir: &Path, name: &str, description: &str) {
        write(
            &dir.join(name).join("SKILL.md"),
            &format!("---\nname: {name}\ndescription: {description}\n---\nbody\n"),
        );
    }

    fn names(skills: &[ProviderSkillView]) -> Vec<(String, String)> {
        skills
            .iter()
            .map(|skill| (skill.scope.clone(), skill.name.clone()))
            .collect()
    }

    struct Layout {
        _root: TempDir,
        roots: SkillRoots,
        repo: PathBuf,
        other_repo: PathBuf,
    }

    fn layout() -> Layout {
        let root = TempDir::new().unwrap();
        let home = root.path().join("home");
        let repo = root.path().join("work/repo");
        let other_repo = root.path().join("work/other");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(other_repo.join(".git")).unwrap();
        skill(&home.join(".codex/skills"), "codex-global", "mine");
        skill(&home.join(".codex/skills/.system"), "imagegen", "bundled");
        skill(&home.join(".claude/skills"), "claude-global", "mine");
        write(
            &home.join(".claude/commands/deploy.md"),
            "---\ndescription: ship it\nargument-hint: <env>\n---\n",
        );
        skill(&home.join(".cursor/skills"), "cursor-global", "mine");
        skill(&repo.join(".agents/skills"), "probe", "agents copy");
        skill(&repo.join(".codex/skills"), "probe", "codex copy");
        skill(&repo.join(".claude/skills"), "review", "repo review");
        skill(&repo.join(".cursor/skills"), "cursor-repo", "repo");
        skill(
            &other_repo.join(".agents/skills"),
            "elsewhere",
            "not this repo",
        );
        skill(
            &other_repo.join(".claude/skills"),
            "elsewhere",
            "not this repo",
        );
        Layout {
            roots: SkillRoots {
                codex_home: Some(home.join(".codex")),
                claude_home: Some(home.join(".claude")),
                home: Some(home),
            },
            _root: root,
            repo,
            other_repo,
        }
    }

    #[test]
    fn each_provider_reads_only_its_own_folders() {
        let fixture = layout();
        let codex = scan_skills_on_disk("codex", &fixture.repo, &fixture.roots);
        let claude = scan_skills_on_disk("claude_code", &fixture.repo, &fixture.roots);
        let cursor = scan_skills_on_disk("cursor", &fixture.repo, &fixture.roots);

        assert_eq!(
            names(&codex),
            vec![
                ("repo".into(), "probe".into()),
                ("repo".into(), "probe".into()),
                ("global".into(), "codex-global".into()),
                ("system".into(), "imagegen".into()),
            ]
        );
        assert_eq!(
            names(&claude),
            vec![
                ("repo".into(), "review".into()),
                ("global".into(), "claude-global".into()),
                ("global".into(), "deploy".into()),
            ]
        );
        // Cursor also reads Claude's and Codex's folders (cursor.com/docs/context/skills).
        assert_eq!(
            names(&cursor),
            vec![
                ("repo".into(), "cursor-repo".into()),
                ("repo".into(), "probe".into()),
                ("repo".into(), "probe".into()),
                ("repo".into(), "review".into()),
                ("global".into(), "claude-global".into()),
                ("global".into(), "codex-global".into()),
                ("global".into(), "cursor-global".into()),
            ]
        );
        assert!(scan_skills_on_disk("fake", &fixture.repo, &fixture.roots).is_empty());
    }

    #[test]
    fn a_repo_skill_never_shows_up_in_another_repo() {
        let fixture = layout();
        for provider in ["codex", "claude_code", "cursor"] {
            let here = scan_skills_on_disk(provider, &fixture.repo, &fixture.roots);
            assert!(
                here.iter().all(|skill| skill.name != "elsewhere"),
                "{provider} listed another repo's skill"
            );
            let there = scan_skills_on_disk(provider, &fixture.other_repo, &fixture.roots);
            assert!(there.iter().any(|skill| skill.name == "elsewhere"));
            assert!(
                there
                    .iter()
                    .all(|skill| skill.scope != "repo" || skill.name == "elsewhere"),
                "{provider} leaked this repo's skills into the other one"
            );
        }
    }

    #[test]
    fn a_subfolder_still_sees_the_repo_root_skills() {
        let fixture = layout();
        let nested = fixture.repo.join("crates/deep");
        fs::create_dir_all(&nested).unwrap();
        let codex = scan_skills_on_disk("codex", &nested, &fixture.roots);
        assert_eq!(
            codex.iter().filter(|skill| skill.name == "probe").count(),
            2
        );
    }

    #[test]
    fn same_name_codex_skills_keep_their_own_paths_and_the_pick_matches_by_path() {
        let fixture = layout();
        let codex = scan_skills_on_disk("codex", &fixture.repo, &fixture.roots);
        let codex_copy = codex
            .iter()
            .find(|skill| skill.description == "codex copy")
            .unwrap();
        let pick = SkillInvocationInput {
            name: "probe".into(),
            path: codex_copy.path.clone(),
        };
        let found = find_listed_skill(&codex, &pick, SkillInvocation::SkillInput).unwrap();
        assert_eq!(found.description, "codex copy");

        let no_path = SkillInvocationInput {
            name: "probe".into(),
            path: None,
        };
        assert!(
            find_listed_skill(&codex, &no_path, SkillInvocation::SkillInput).is_none(),
            "a Codex pick without a path is ambiguous and must not resolve"
        );
        let foreign = SkillInvocationInput {
            name: "probe".into(),
            path: Some("/elsewhere/.agents/skills/probe/SKILL.md".into()),
        };
        assert!(find_listed_skill(&codex, &foreign, SkillInvocation::SkillInput).is_none());
    }

    #[test]
    fn announced_commands_take_their_scope_from_where_the_file_sits() {
        let fixture = layout();
        let announced = |name: &str| ProviderSkillView {
            name: name.into(),
            description: String::new(),
            scope: "session".into(),
            origin: None,
            path: None,
            argument_hint: None,
        };
        let labelled = label_from_disk(
            vec![
                announced("cursor-repo"),
                announced("cursor-global"),
                announced("built-in-ish"),
            ],
            "cursor",
            &fixture.repo,
            &fixture.roots,
        );
        assert_eq!(
            names(&labelled),
            vec![
                ("repo".into(), "cursor-repo".into()),
                ("global".into(), "cursor-global".into()),
                ("session".into(), "built-in-ish".into()),
            ]
        );
        assert_eq!(
            labelled[0].description, "repo",
            "an empty description is filled from disk"
        );
        assert!(
            labelled.iter().all(|row| row.path.is_none()),
            "ACP dispatches by name only"
        );
    }

    #[test]
    fn cursor_walks_its_skill_roots_recursively_and_finds_nested_packages() {
        let fixture = layout();
        let home = fixture.roots.home.clone().unwrap();
        skill(&home.join(".agents/skills"), "agents-global", "mine");
        skill(
            &fixture.repo.join(".cursor/skills/tools"),
            "deep-skill",
            "in a category",
        );
        skill(
            &fixture.repo.join("packages/web/.cursor/skills"),
            "web-skill",
            "for the web package",
        );
        skill(
            &fixture.repo.join("node_modules/pkg/.cursor/skills"),
            "vendored",
            "not ours",
        );

        let cursor = scan_skills_on_disk("cursor", &fixture.repo, &fixture.roots);
        assert_eq!(
            names(&cursor),
            vec![
                ("repo".into(), "cursor-repo".into()),
                ("repo".into(), "deep-skill".into()),
                ("repo".into(), "probe".into()),
                ("repo".into(), "probe".into()),
                ("repo".into(), "review".into()),
                ("repo".into(), "web-skill".into()),
                ("global".into(), "agents-global".into()),
                ("global".into(), "claude-global".into()),
                ("global".into(), "codex-global".into()),
                ("global".into(), "cursor-global".into()),
            ]
        );
        let web = cursor.iter().find(|s| s.name == "web-skill").unwrap();
        assert_eq!(
            web.origin.as_deref(),
            Some("packages/web"),
            "says which package it is for"
        );
    }

    #[test]
    fn a_name_found_in_more_than_one_scope_is_not_given_either_label() {
        let fixture = layout();
        let home = fixture.roots.home.clone().unwrap();
        skill(&home.join(".cursor/skills"), "shared", "the global copy");
        skill(
            &fixture.repo.join(".cursor/skills"),
            "shared",
            "the repo copy",
        );
        let announced = |name: &str| ProviderSkillView {
            name: name.into(),
            description: String::new(),
            scope: "session".into(),
            origin: None,
            path: None,
            argument_hint: None,
        };
        let labelled = label_from_disk(
            vec![announced("shared")],
            "cursor",
            &fixture.repo,
            &fixture.roots,
        );
        assert_eq!(
            labelled[0].scope, "session",
            "either file could be the one announced"
        );
        assert_eq!(
            labelled[0].description, "",
            "and neither description is borrowed"
        );
    }

    #[test]
    fn slash_twins_collapse_to_one_row_that_claims_no_file() {
        let row = |scope: &str, path: &str, description: &str| ProviderSkillView {
            name: "review".into(),
            description: description.into(),
            scope: scope.into(),
            origin: None,
            path: Some(path.into()),
            argument_hint: None,
        };
        let only = ProviderSkillView {
            name: "solo".into(),
            ..row("repo", "/r/.claude/skills/solo/SKILL.md", "alone")
        };
        let collapsed = collapse_slash_twins(vec![
            row("repo", "/r/.claude/skills/review/SKILL.md", "repo copy"),
            only.clone(),
            row("global", "/h/.claude/skills/review/SKILL.md", "global copy"),
        ]);
        assert_eq!(collapsed.len(), 2);
        assert_eq!(collapsed[0].scope, "ambiguous");
        assert_eq!(collapsed[0].origin.as_deref(), Some("repo,global"));
        assert_eq!(collapsed[0].path, None);
        assert_eq!(collapsed[0].description, "");
        assert_eq!(
            collapsed[1], only,
            "a name found once is left exactly as it was"
        );

        // Same scope twice (a repo and its parent folder) is still that scope.
        let same_scope = collapse_slash_twins(vec![
            row("repo", "/r/sub/.claude/skills/review/SKILL.md", "same"),
            row("repo", "/r/.claude/skills/review/SKILL.md", "same"),
        ]);
        assert_eq!(same_scope.len(), 1);
        assert_eq!(same_scope[0].scope, "repo");
        assert_eq!(same_scope[0].path, None);
        assert_eq!(same_scope[0].description, "same");
    }

    #[test]
    fn composed_text_uses_the_providers_own_sigil() {
        assert_eq!(
            compose_skill_text(SkillInvocation::Slash, "review", "  the parser "),
            "/review the parser"
        );
        assert_eq!(
            compose_skill_text(SkillInvocation::Slash, "review", ""),
            "/review"
        );
        assert_eq!(
            compose_skill_text(SkillInvocation::SkillInput, "probe", "go"),
            "$probe go"
        );
    }

    #[test]
    fn front_matter_is_read_leniently() {
        assert_eq!(
            parse_front_matter(
                "---\nname: \"quoted\"\ndescription: >\n  folded over\n  two lines\nargument-hint: <x>\n---\nbody"
            ),
            FrontMatter {
                name: Some("quoted".into()),
                description: Some("folded over two lines".into()),
                argument_hint: Some("<x>".into()),
            }
        );
        assert_eq!(
            parse_front_matter("no front matter"),
            FrontMatter::default()
        );
    }
}
