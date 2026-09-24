use super::*;

use std::time::Instant;

use crate::protocol::{ProviderSkillView, SkillInvocationInput, ThreadSkillsView};
use crate::provider::{provider_display_name, SkillInputRef, SkillInvocation};
use crate::skills::{
    collapse_slash_twins, compose_skill_text, find_listed_skill, scan_skills_on_disk, sort_skills,
    SkillRoots,
};

use super::providers::SessionTarget;

/// A menu read reuses a list this young: Claude's answer costs a worker probe.
const SKILL_LIST_FRESH: Duration = Duration::from_secs(20);
/// A send trusts a list the menu fetched this long ago before asking again.
const SKILL_PICK_GRACE: Duration = Duration::from_secs(10 * 60);
/// Past this the menu shows what is on disk rather than nothing.
const SKILL_LIST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub(crate) struct CachedSkillCatalog {
    fetched_at: Instant,
    source: &'static str,
    note: Option<String>,
    skills: Vec<ProviderSkillView>,
}

/// Keyed by (provider, cwd, session): the session is empty unless the provider's list is
/// that session's own (`skills_are_per_session`).
pub(crate) type SkillCatalogs = Arc<RwLock<HashMap<(String, String, String), CachedSkillCatalog>>>;

impl AppState {
    /// The skills this thread's OWN provider offers in this thread's OWN folder.
    pub async fn thread_skills(
        &self,
        device_id: Option<String>,
        thread_id: &str,
    ) -> Result<ThreadSkillsView, String> {
        let thread_id = self.canonical_session_id(thread_id).await?;
        let cwd = self.skill_cwd(device_id.as_deref(), &thread_id).await?;
        let target = self.resolve_session_target(&thread_id).await?;
        let catalog = self.skill_catalog(&target, &cwd, SKILL_LIST_FRESH).await;
        Ok(ThreadSkillsView {
            thread_id,
            provider: target.provider.clone(),
            cwd,
            source: catalog.source.to_string(),
            invocation: target.bridge().skill_invocation().as_str().to_string(),
            note: catalog.note,
            skills: catalog.skills,
        })
    }

    async fn skill_cwd(&self, device_id: Option<&str>, thread_id: &str) -> Result<String, String> {
        let relay = self.relay.read().await;
        let cwd = relay
            .thread_cwd(thread_id)
            .ok_or_else(|| "this session has no folder yet, so it has no skills".to_string())?;
        // Local names no device and is already authorized; `allowed_roots` still bind it.
        let device_scope = device_id
            .map(|id| relay.device_path_scope(id))
            .unwrap_or_default();
        ensure_path_within_device_scope(&cwd, &device_scope, &relay.allowed_roots)?;
        Ok(cwd)
    }

    async fn skill_catalog(
        &self,
        target: &SessionTarget,
        cwd: &str,
        max_age: Duration,
    ) -> CachedSkillCatalog {
        let session = if target.bridge().skills_are_per_session() {
            target.provider_handle.clone()
        } else {
            String::new()
        };
        let key = (target.provider.clone(), cwd.to_string(), session);
        if let Some(cached) = self.provider_skill_catalogs.read().await.get(&key) {
            if cached.fetched_at.elapsed() < max_age {
                return cached.clone();
            }
        }
        let name = provider_display_name(&target.provider).to_string();
        let live = tokio::time::timeout(SKILL_LIST_TIMEOUT, target.list_skills(cwd)).await;
        let catalog = match live {
            Ok(Ok(Some(mut skills))) => {
                sort_skills(&mut skills);
                CachedSkillCatalog {
                    fetched_at: Instant::now(),
                    source: "runtime",
                    note: None,
                    skills,
                }
            }
            outcome => {
                let reason = match outcome {
                    Ok(Ok(_)) => format!("{name} does not report its skills"),
                    Ok(Err(error)) => format!("{name} could not list its skills ({error})"),
                    Err(_) => format!("{name} took too long to list its skills"),
                };
                let provider = target.provider.clone();
                let dir = std::path::PathBuf::from(cwd);
                let roots = self.skill_roots();
                let skills = tokio::task::spawn_blocking(move || {
                    scan_skills_on_disk(&provider, &dir, &roots)
                })
                .await
                .unwrap_or_default();
                CachedSkillCatalog {
                    fetched_at: Instant::now(),
                    source: "filesystem",
                    note: Some(format!("{reason}, so these were read from disk.")),
                    skills,
                }
            }
        };
        // A slash provider runs `/name`: rows that share a name are one command, whether
        // they came from disk or a runtime that listed both.
        let mut catalog = catalog;
        if target.bridge().skill_invocation() == SkillInvocation::Slash {
            catalog.skills = collapse_slash_twins(catalog.skills);
        }
        self.provider_skill_catalogs
            .write()
            .await
            .insert(key, catalog.clone());
        catalog
    }

    fn skill_roots(&self) -> SkillRoots {
        #[cfg(test)]
        if let Some(roots) = self.skill_roots_override.lock().unwrap().clone() {
            return roots;
        }
        SkillRoots::from_env()
    }

    #[cfg(test)]
    pub(crate) fn override_skill_roots_for_test(&self, roots: SkillRoots) {
        *self.skill_roots_override.lock().unwrap() = Some(roots);
    }

    /// The text and skill inputs a picked skill turns a send into.
    ///
    /// Refused unless the pick is one this thread's provider listed for this thread's
    /// folder: a stale menu, another session's pill or a hand-built request must not
    /// run a skill the session was never offered.
    pub(super) async fn prepare_skill_turn(
        &self,
        target: &SessionTarget,
        cwd: &str,
        pick: &SkillInvocationInput,
        args: &str,
    ) -> Result<(String, Vec<SkillInputRef>), String> {
        let invocation = target.bridge().skill_invocation();
        let lookup = |catalog: CachedSkillCatalog| {
            find_listed_skill(&catalog.skills, pick, invocation).cloned()
        };
        let mut skill = lookup(self.skill_catalog(target, cwd, SKILL_PICK_GRACE).await);
        if skill.is_none() {
            skill = lookup(self.skill_catalog(target, cwd, Duration::ZERO).await);
        }
        let skill = skill.ok_or_else(|| {
            format!(
                "{} has no skill “{}” in {cwd} any more — pick it again from the / menu.",
                provider_display_name(&target.provider),
                pick.name
            )
        })?;
        let text = compose_skill_text(invocation, &skill.name, args);
        let inputs = match (invocation, skill.path) {
            (SkillInvocation::SkillInput, Some(path)) => vec![SkillInputRef {
                name: skill.name,
                path,
            }],
            _ => Vec::new(),
        };
        Ok((text, inputs))
    }
}
