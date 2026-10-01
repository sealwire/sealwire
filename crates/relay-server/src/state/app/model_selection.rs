//! The one place a thread's model is chosen. Sealwire's default policy and the
//! flagship rule live here, so every start path answers the same way.

use super::*;
use crate::model_policy::{self, DEFAULT_MODEL_KEYWORD};

/// Asking for this resolves to Sealwire's default for the provider.
pub(super) const PROVIDER_DEFAULT_MODEL: &str = DEFAULT_MODEL_KEYWORD;

/// How long a start trusts a provider's reported default before asking again.
const PROVIDER_DEFAULT_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// A provider's own default per `(provider, cwd)`: project settings can change it.
pub(super) type ProviderDefaultCache =
    Arc<RwLock<HashMap<(String, String), CachedProviderDefault>>>;

#[derive(Clone)]
pub(super) struct CachedProviderDefault {
    model: String,
    fetched_at: std::time::Instant,
}

/// Who picked the model. Only an agent's own pick of a flagship waits for a person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ModelChooser {
    /// The UI, a slash command, or a confirmed card that showed the model.
    Person,
    Agent,
}

/// A named model is not proof a person chose it, so the chooser is recorded
/// beside it, and inheritance stays separate from a request.
#[derive(Clone)]
pub(super) struct ModelSelection {
    requested: Option<String>,
    inherited: Option<String>,
    fallback: ModelFallback,
    chooser: ModelChooser,
}

#[derive(Clone)]
enum ModelFallback {
    SealwireDefault,
    /// Restoring a session keeps a known last-used id. A newly available catalog
    /// replaces only a fallback it does not offer, never a pinned selection.
    KeepIfKnown(String),
}

impl ModelSelection {
    pub(super) fn new(requested: Option<String>) -> Self {
        Self {
            requested: non_empty(requested),
            inherited: None,
            fallback: ModelFallback::SealwireDefault,
            chooser: ModelChooser::Person,
        }
    }

    pub(super) fn by(mut self, chooser: ModelChooser) -> Self {
        self.chooser = chooser;
        self
    }

    /// The model the target thread already runs. An agent may keep it even when
    /// it is a flagship: a person allowed it when the thread got it.
    pub(super) fn with_inherited(mut self, inherited: Option<String>) -> Self {
        self.inherited = non_empty(inherited);
        self
    }

    pub(super) fn with_known_fallback(mut self, model: String) -> Self {
        self.fallback = ModelFallback::KeepIfKnown(model);
        self
    }
}

/// What a model is being chosen for.
pub(super) struct ModelTarget<'a> {
    pub(super) provider: &'a str,
    pub(super) bridge: &'a Arc<dyn ProviderBridge>,
    pub(super) catalog: &'a Option<Vec<ModelOptionView>>,
    /// Empty means the relay's own folder.
    pub(super) cwd: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SelectedModel {
    pub(super) model: String,
    /// The provider's own default, when this is Sealwire's and replaced a flagship.
    pub(super) replaced_flagship: Option<String>,
}

impl SelectedModel {
    fn named(model: String) -> Self {
        Self {
            model,
            replaced_flagship: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ModelRefusal {
    /// An agent named a flagship. Nothing may start until a person allows it.
    NeedsApproval { model: String, family: &'static str },
    /// No known default or vetted fallback is available for this provider.
    NoDefault(String),
}

impl std::fmt::Display for ModelRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelRefusal::NeedsApproval { model, family } => write!(
                f,
                "{model} is a flagship model ({family}); an agent cannot start it without the user's approval"
            ),
            ModelRefusal::NoDefault(reason) => f.write_str(reason),
        }
    }
}

impl From<ModelRefusal> for String {
    fn from(refusal: ModelRefusal) -> Self {
        refusal.to_string()
    }
}

enum DefaultUnresolved {
    Flagship(String),
    /// Neither the provider nor its catalog gave anything to go on.
    Unknown,
}

impl AppState {
    /// The selection entry point for sessions, peers, forks, reviewers and seats.
    /// Named ids are honored even when unlisted, except an agent's flagship.
    pub(super) async fn select_model(
        &self,
        target: ModelTarget<'_>,
        selection: ModelSelection,
    ) -> Result<SelectedModel, ModelRefusal> {
        let ModelSelection {
            requested,
            inherited,
            fallback,
            chooser,
        } = selection;
        let catalog = target.catalog.as_deref().unwrap_or(&[]);
        let inherited = match inherited {
            Some(model)
                if self
                    .model_belongs_to_another_provider(target.provider, &model)
                    .await =>
            {
                None
            }
            other => other,
        };

        if let Some(requested) = requested {
            if requested == DEFAULT_MODEL_KEYWORD {
                return self.select_default(&target).await;
            }
            if chooser == ModelChooser::Agent && inherited.as_deref() != Some(requested.as_str()) {
                if let Some(family) = model_policy::flagship_in(&requested, catalog) {
                    return Err(ModelRefusal::NeedsApproval {
                        model: requested,
                        family: family.label,
                    });
                }
            }
            return Ok(SelectedModel::named(requested));
        }
        match inherited {
            Some(model) if model != DEFAULT_MODEL_KEYWORD => Ok(SelectedModel::named(model)),
            Some(_) => self.select_default(&target).await,
            None => match fallback {
                ModelFallback::SealwireDefault => self.select_default(&target).await,
                ModelFallback::KeepIfKnown(model) => {
                    let offered = model != DEFAULT_MODEL_KEYWORD
                        && catalog.iter().any(|option| option.model == model);
                    if offered {
                        return Ok(SelectedModel::named(model));
                    }
                    self.select_default(&target).await
                }
            },
        }
    }

    async fn select_default(
        &self,
        target: &ModelTarget<'_>,
    ) -> Result<SelectedModel, ModelRefusal> {
        match self.sealwire_default_model(target).await {
            Ok(default) => Ok(default),
            Err(DefaultUnresolved::Flagship(reason)) => Err(ModelRefusal::NoDefault(reason)),
            // Some providers consume an initial prompt during start_thread. Passing
            // an unresolved keyword through would let a turn run before this policy
            // can inspect its model, so it cannot be repaired on the first send.
            Err(DefaultUnresolved::Unknown) => Err(ModelRefusal::NoDefault(format!(
                "{} has no resolved default model or available vetted fallback — name a model",
                target.provider
            ))),
        }
    }

    /// The provider's own default, unless it is a flagship; then a vetted fallback.
    async fn sealwire_default_model(
        &self,
        target: &ModelTarget<'_>,
    ) -> Result<SelectedModel, DefaultUnresolved> {
        let catalog = target.catalog.as_deref().unwrap_or(&[]);
        let provider = target.provider;
        let default = self
            .provider_default_model(provider, target.bridge, target.cwd)
            .await
            .ok()
            .and_then(|model| non_empty(Some(model)))
            .and_then(|model| {
                if model != DEFAULT_MODEL_KEYWORD {
                    return Some(model);
                }
                catalog
                    .iter()
                    .find(|option| option.model == DEFAULT_MODEL_KEYWORD)
                    .and_then(|option| non_empty(option.resolved_model.clone()))
                    .filter(|resolved| resolved != DEFAULT_MODEL_KEYWORD)
            });
        match default {
            Some(default) => match model_policy::flagship_in(&default, catalog) {
                None => Ok(SelectedModel::named(catalog_id_for(&default, catalog))),
                Some(family) => vetted_fallback(provider, catalog)
                    .map(|model| SelectedModel {
                        model,
                        replaced_flagship: Some(default.clone()),
                    })
                    .ok_or_else(|| {
                        DefaultUnresolved::Flagship(format!(
                            "{provider}'s default model is {default} ({}), a flagship, and it \
offers none of the models Sealwire uses instead ({}) — name a model",
                            family.label,
                            model_policy::default_fallbacks(provider).join(", ")
                        ))
                    }),
            },
            None => vetted_fallback(provider, catalog)
                .map(SelectedModel::named)
                .ok_or(DefaultUnresolved::Unknown),
        }
    }

    async fn provider_default_model(
        &self,
        provider: &str,
        bridge: &Arc<dyn ProviderBridge>,
        cwd: &str,
    ) -> Result<String, String> {
        let cwd = if cwd.is_empty() {
            self.relay.read().await.current_cwd.clone()
        } else {
            cwd.to_string()
        };
        let key = (provider.to_string(), cwd.clone());
        let cached = self.provider_default_models.read().await.get(&key).cloned();
        if let Some(cached) = &cached {
            if cached.fetched_at.elapsed() < PROVIDER_DEFAULT_TTL {
                return Ok(cached.model.clone());
            }
        }
        match bridge.default_model(&cwd).await {
            Ok(model) => {
                self.provider_default_models.write().await.insert(
                    key,
                    CachedProviderDefault {
                        model: model.clone(),
                        fetched_at: std::time::Instant::now(),
                    },
                );
                Ok(model)
            }
            Err(error) => {
                self.push_runtime_log(
                    "warn",
                    format!("Could not read {provider}'s default model for {cwd}: {error}"),
                )
                .await;
                cached.map(|cached| cached.model).ok_or(error)
            }
        }
    }

    /// Adopted catalogs mark Sealwire's default, so a picker preselects the model
    /// a start without one would run rather than the provider's own flag.
    pub(super) async fn mark_sealwire_default(
        &self,
        provider: &str,
        bridge: &Arc<dyn ProviderBridge>,
        models: &mut [ModelOptionView],
    ) {
        // OpenCode discovers defaults by starting a session, which executes cwd plugins.
        // A background catalog refresh must not enter another provider's workspace.
        if provider == "opencode" {
            let catalog = models.to_vec();
            for model in models.iter_mut() {
                model.is_default &= model_policy::flagship_in(&model.model, &catalog).is_none();
            }
            return;
        }
        let catalog = Some(models.to_vec());
        let chosen = self
            .sealwire_default_model(&ModelTarget {
                provider,
                bridge,
                catalog: &catalog,
                cwd: "",
            })
            .await
            .ok()
            .map(|default| default.model);
        for option in models.iter_mut() {
            option.is_default = chosen.as_deref() == Some(option.model.as_str());
        }
    }

    /// Reads never ask the provider: polling a viewed thread would otherwise issue
    /// a model/list and a default probe each time.
    pub(super) async fn select_cached_thread_model(
        &self,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
        remembered_model: Option<String>,
    ) -> String {
        let models = match self.cached_provider_model_catalog(provider_name).await {
            Some(models) => Some(models),
            None => {
                self.load_provider_model_catalog(provider_name, bridge)
                    .await
            }
        };
        let remembered = match non_empty(remembered_model) {
            Some(model)
                if self
                    .model_belongs_to_another_provider(provider_name, &model)
                    .await =>
            {
                None
            }
            other => other,
        };
        match remembered {
            Some(model) if model != DEFAULT_MODEL_KEYWORD => model,
            _ => preferred_model(&models)
                .map(|model| model.model.clone())
                .unwrap_or_else(|| {
                    if provider_name == "codex" {
                        DEFAULT_MODEL
                    } else {
                        DEFAULT_MODEL_KEYWORD
                    }
                    .to_string()
                }),
        }
    }

    /// Catalog absence alone cannot condemn an inherited id: a provider can
    /// accept models it does not list. Require its own catalog to be known and
    /// another provider to publish the id before treating it as a leaked value.
    async fn model_belongs_to_another_provider(&self, provider_name: &str, model: &str) -> bool {
        let catalogs = self.provider_model_catalogs.read().await;
        let Some(own) = catalogs.get(provider_name).filter(|own| !own.is_empty()) else {
            return false;
        };
        if own.iter().any(|option| option.model == model) {
            return false;
        }
        catalogs.iter().any(|(other, catalog)| {
            other != provider_name && catalog.iter().any(|option| option.model == model)
        })
    }
}

/// The row that runs `model`, so pickers and the thread show a name they list.
/// A family alias avoids following changes to the global `default` choice;
/// it does not pin a model version.
fn catalog_id_for(model: &str, catalog: &[ModelOptionView]) -> String {
    if model == DEFAULT_MODEL_KEYWORD {
        if let Some(resolved) = catalog
            .iter()
            .find(|option| option.model == model)
            .and_then(|option| option.resolved_model.as_deref())
        {
            return catalog_id_for(resolved, catalog);
        }
    }
    if catalog.iter().any(|option| option.model == model) {
        return model.to_string();
    }
    catalog
        .iter()
        .filter(|option| option.model != DEFAULT_MODEL_KEYWORD && !option.hidden)
        .find(|option| option.resolved_model.as_deref() == Some(model))
        .map(|option| option.model.clone())
        .unwrap_or_else(|| model.to_string())
}

/// A configured stand-in the live catalog offers and that is not itself a flagship.
fn vetted_fallback(provider: &str, catalog: &[ModelOptionView]) -> Option<String> {
    // Cursor Auto is explicitly allowed even on the first startup, before ACP
    // has a session/new catalog. This exception does not authorize an opaque
    // provider default for Claude, Codex, or future providers.
    if provider == "cursor" && catalog.is_empty() {
        return Some("default[]".to_string());
    }
    model_policy::default_fallbacks(provider)
        .iter()
        .find(|id| {
            catalog
                .iter()
                .any(|option| option.model == **id && !option.hidden)
                && model_policy::flagship_in(id, catalog).is_none()
        })
        .map(|id| id.to_string())
}

/// Sealwire's mark on an adopted catalog, else the first ordinary row.
pub(super) fn preferred_model(models: &Option<Vec<ModelOptionView>>) -> Option<&ModelOptionView> {
    let models = models.as_ref()?;
    models.iter().find(|model| model.is_default).or_else(|| {
        models.iter().find(|model| {
            !model.hidden && model_policy::flagship_in(&model.model, models).is_none()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_provider::FakeProviderBridge;

    async fn app() -> (AppState, Arc<FakeProviderBridge>, Arc<dyn ProviderBridge>) {
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            ".".to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let fake = Arc::new(
            FakeProviderBridge::spawn(relay.clone())
                .await
                .expect("fake provider"),
        );
        let bridge: Arc<dyn ProviderBridge> = fake.clone();
        let app = AppState::from_parts(relay, HashMap::new(), change_tx);
        (app, fake, bridge)
    }

    fn catalog(entries: &[(&str, Option<&str>)]) -> Option<Vec<ModelOptionView>> {
        Some(
            entries
                .iter()
                .map(|(model, resolved)| ModelOptionView {
                    model: model.to_string(),
                    display_name: model.to_string(),
                    provider: String::new(),
                    supported_reasoning_efforts: Vec::new(),
                    default_reasoning_effort: String::new(),
                    hidden: false,
                    is_default: false,
                    resolved_model: resolved.map(str::to_string),
                })
                .collect(),
        )
    }

    fn codex_catalog() -> Option<Vec<ModelOptionView>> {
        let mut models = catalog(&[
            ("gpt-6-astra", None),
            ("gpt-6-sol", None),
            ("gpt-5.6-sol", None),
        ]);
        // What Codex's model/list recommends; never the policy's input.
        models.as_mut().unwrap()[0].is_default = true;
        models
    }

    async fn pick(
        app: &AppState,
        bridge: &Arc<dyn ProviderBridge>,
        provider: &str,
        models: &Option<Vec<ModelOptionView>>,
        selection: ModelSelection,
    ) -> Result<SelectedModel, ModelRefusal> {
        app.select_model(
            ModelTarget {
                provider,
                bridge,
                catalog: models,
                cwd: "/work",
            },
            selection,
        )
        .await
    }

    fn agent(model: &str) -> ModelSelection {
        ModelSelection::new(Some(model.to_string())).by(ModelChooser::Agent)
    }

    #[tokio::test]
    async fn codex_runs_its_configured_default_not_the_catalogs_recommendation() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("gpt-5.6-sol"));
        assert_eq!(
            pick(
                &app,
                &bridge,
                "codex",
                &codex_catalog(),
                ModelSelection::new(None)
            )
            .await,
            Ok(SelectedModel::named("gpt-5.6-sol".to_string())),
            "isDefault marks gpt-6-astra, but the configured default is gpt-5.6-sol"
        );
    }

    #[tokio::test]
    async fn a_flagship_default_is_replaced_by_the_vetted_fallback() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("gpt-6-astra"));
        for selection in [
            ModelSelection::new(None),
            ModelSelection::new(Some("default".to_string())),
            agent("default"),
        ] {
            assert_eq!(
                pick(&app, &bridge, "codex", &codex_catalog(), selection).await,
                Ok(SelectedModel {
                    model: "gpt-5.6-sol".to_string(),
                    replaced_flagship: Some("gpt-6-astra".to_string()),
                })
            );
        }
    }

    #[tokio::test]
    async fn a_missing_fallback_refuses_instead_of_guessing_or_keeping_the_flagship() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("gpt-6-astra"));
        // gpt-6-sol is ordinary and listed, but it is not the configured stand-in.
        let models = catalog(&[("gpt-6-astra", None), ("gpt-6-sol", None)]);
        let refused = pick(&app, &bridge, "codex", &models, ModelSelection::new(None)).await;
        assert!(
            matches!(&refused, Err(ModelRefusal::NoDefault(reason)) if reason.contains("gpt-6-astra")),
            "{refused:?}"
        );
    }

    #[tokio::test]
    async fn claude_aliases_are_judged_and_named_by_what_they_resolve_to() {
        let (app, fake, bridge) = app().await;
        let models = catalog(&[
            ("default", Some("claude-fable-5-1")),
            ("opus[1m]", Some("claude-opus-5-5[1m]")),
            ("claude-fable-5-1[1m]", Some("claude-fable-5-1")),
            ("sonnet", Some("claude-sonnet-5")),
        ]);
        fake.set_default_model(Some("claude-fable-5-1"));
        assert_eq!(
            pick(
                &app,
                &bridge,
                "claude_code",
                &models,
                ModelSelection::new(None)
            )
            .await,
            Ok(SelectedModel {
                model: "opus[1m]".to_string(),
                replaced_flagship: Some("claude-fable-5-1".to_string()),
            })
        );

        // An ordinary default keeps its family rather than following `default`.
        let (app, fake, bridge) = self::app().await;
        let models = catalog(&[
            ("default", Some("claude-opus-5-5[1m]")),
            ("opus[1m]", Some("claude-opus-5-5[1m]")),
        ]);
        fake.set_default_model(Some("claude-opus-5-5[1m]"));
        assert_eq!(
            pick(
                &app,
                &bridge,
                "claude_code",
                &models,
                ModelSelection::new(None)
            )
            .await,
            Ok(SelectedModel::named("opus[1m]".to_string()))
        );
    }

    #[tokio::test]
    async fn cursor_auto_stays_the_default() {
        let (app, fake, bridge) = app().await;
        let models = catalog(&[
            ("default[]", None),
            (
                "claude-fable-5-1[thinking=true,context=300k,effort=high]",
                None,
            ),
            ("gpt-5.5[context=272k,reasoning=medium,fast=false]", None),
        ]);
        fake.set_default_model(Some("default[]"));
        assert_eq!(
            pick(&app, &bridge, "cursor", &models, ModelSelection::new(None)).await,
            Ok(SelectedModel::named("default[]".to_string()))
        );
    }

    #[tokio::test]
    async fn only_an_agents_own_flagship_pick_waits_for_a_person() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("gpt-5.6-sol"));
        let models = codex_catalog();
        assert_eq!(
            pick(&app, &bridge, "codex", &models, agent("gpt-6-astra")).await,
            Err(ModelRefusal::NeedsApproval {
                model: "gpt-6-astra".to_string(),
                family: "GPT-6 Astra",
            })
        );
        assert_eq!(
            pick(&app, &bridge, "codex", &models, agent("gpt-6-sol")).await,
            Ok(SelectedModel::named("gpt-6-sol".to_string()))
        );
        assert_eq!(
            pick(
                &app,
                &bridge,
                "codex",
                &models,
                ModelSelection::new(Some("gpt-6-astra".to_string())),
            )
            .await,
            Ok(SelectedModel::named("gpt-6-astra".to_string())),
            "a person's pick of a flagship is never held"
        );
        // Keeping the flagship a thread already runs is not a new pick.
        assert_eq!(
            pick(
                &app,
                &bridge,
                "codex",
                &models,
                agent("gpt-6-astra").with_inherited(Some("gpt-6-astra".to_string())),
            )
            .await,
            Ok(SelectedModel::named("gpt-6-astra".to_string()))
        );
        // An alias is held for what it runs, not for its name.
        let claude = catalog(&[("best", Some("claude-fable-5-1")), ("opus[1m]", None)]);
        assert!(matches!(
            pick(&app, &bridge, "claude_code", &claude, agent("best")).await,
            Err(ModelRefusal::NeedsApproval { .. })
        ));
    }

    #[tokio::test]
    async fn named_and_inherited_models_take_priority_over_the_default() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("recommended"));
        let models = catalog(&[("first", None), ("recommended", None)]);
        for (request, inherited, expected) in [
            (Some("unlisted"), Some("saved"), "unlisted"),
            (None, Some("saved"), "saved"),
            (Some("  "), Some("saved"), "saved"),
            (None, Some("  "), "recommended"),
            (None, None, "recommended"),
            // An inherited keyword is resolved, never forwarded.
            (None, Some("default"), "recommended"),
        ] {
            let selection = ModelSelection::new(request.map(str::to_string))
                .with_inherited(inherited.map(str::to_string));
            assert_eq!(
                pick(&app, &bridge, "test", &models, selection)
                    .await
                    .map(|chosen| chosen.model),
                Ok(expected.to_string())
            );
        }
    }

    #[tokio::test]
    async fn an_unreadable_default_uses_the_vetted_fallback_or_refuses() {
        let (app, fake, bridge) = app().await;
        fake.fail_default_model(true);
        let claude = catalog(&[("default", None), ("opus[1m]", None)]);
        assert_eq!(
            pick(
                &app,
                &bridge,
                "claude_code",
                &claude,
                ModelSelection::new(None)
            )
            .await,
            Ok(SelectedModel::named("opus[1m]".to_string()))
        );
        // Nothing known at all: never forward a keyword or guess a model.
        for provider in ["codex", "claude_code", "test"] {
            for models in [None, Some(Vec::new())] {
                for selection in [
                    agent("default"),
                    ModelSelection::new(None),
                    ModelSelection::new(None).with_known_fallback("default".to_string()),
                ] {
                    let result = pick(&app, &bridge, provider, &models, selection).await;
                    assert!(
                        matches!(result, Err(ModelRefusal::NoDefault(_))),
                        "{provider}: {result:?}"
                    );
                }
            }
        }
        // The user explicitly allows Cursor Auto, including a cold catalog.
        assert_eq!(
            pick(&app, &bridge, "cursor", &None, agent("default")).await,
            Ok(SelectedModel::named("default[]".to_string()))
        );
    }

    #[tokio::test]
    async fn a_reported_default_keyword_is_not_a_resolved_model() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("default"));
        for models in [
            None,
            catalog(&[("default", None)]),
            catalog(&[("default", Some("default"))]),
        ] {
            let result = pick(&app, &bridge, "claude_code", &models, agent("default")).await;
            assert!(
                matches!(result, Err(ModelRefusal::NoDefault(_))),
                "{result:?}"
            );
        }
        let models = catalog(&[("default", Some("claude-opus-5-5[1m]"))]);
        assert_eq!(
            pick(&app, &bridge, "claude_code", &models, agent("default")).await,
            Ok(SelectedModel::named("claude-opus-5-5[1m]".to_string()))
        );
    }

    #[tokio::test]
    async fn late_catalogs_replace_only_unknown_fallbacks() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("recommended"));
        let models = catalog(&[(DEFAULT_MODEL, None), ("recommended", None)]);
        for (selection, expected) in [
            (
                ModelSelection::new(None).with_known_fallback("foreign".to_string()),
                "recommended",
            ),
            (
                ModelSelection::new(None).with_known_fallback(DEFAULT_MODEL.to_string()),
                DEFAULT_MODEL,
            ),
            (
                ModelSelection::new(None).with_known_fallback("default".to_string()),
                "recommended",
            ),
            (
                ModelSelection::new(Some("unlisted".to_string()))
                    .with_known_fallback("foreign".to_string()),
                "unlisted",
            ),
            (
                ModelSelection::new(None)
                    .with_inherited(Some("unlisted".to_string()))
                    .with_known_fallback("foreign".to_string()),
                "unlisted",
            ),
        ] {
            assert_eq!(
                pick(&app, &bridge, "test", &models, selection)
                    .await
                    .map(|chosen| chosen.model),
                Ok(expected.to_string())
            );
        }
    }

    #[tokio::test]
    async fn foreign_ownership_filters_inheritance_but_never_a_named_override() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("own"));
        let models = catalog(&[("own", None)]);
        {
            let mut catalogs = app.provider_model_catalogs.write().await;
            catalogs.insert("test".to_string(), models.clone().unwrap());
            catalogs.insert("other".to_string(), catalog(&[("foreign", None)]).unwrap());
        }
        let inherited = ModelSelection::new(None).with_inherited(Some("foreign".to_string()));
        let chosen = |selection| {
            let (app, bridge, models) = (&app, &bridge, &models);
            async move {
                pick(app, bridge, "test", models, selection)
                    .await
                    .map(|chosen| chosen.model)
            }
        };
        assert_eq!(chosen(inherited.clone()).await, Ok("own".to_string()));
        assert_eq!(
            chosen(ModelSelection::new(Some("foreign".to_string()))).await,
            Ok("foreign".to_string())
        );
        // Without this provider's catalog, ownership cannot be established.
        app.provider_model_catalogs.write().await.remove("test");
        assert_eq!(chosen(inherited).await, Ok("foreign".to_string()));
    }

    #[tokio::test]
    async fn adopted_catalogs_mark_sealwires_default_not_the_providers_flag() {
        let (app, fake, bridge) = app().await;
        fake.set_default_model(Some("gpt-6-astra"));
        let mut models = codex_catalog().unwrap();
        app.mark_sealwire_default("codex", &bridge, &mut models)
            .await;
        let marked: Vec<&str> = models
            .iter()
            .filter(|model| model.is_default)
            .map(|model| model.model.as_str())
            .collect();
        assert_eq!(marked, vec!["gpt-5.6-sol"]);
    }
}
