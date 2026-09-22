//! Where a relay session reaches its provider.
//!
//! Phase 1 of `markdown/STABLE_SESSION_ID_DESIGN.md`: the registry exists and is
//! kept correct, but every binding it holds is an IDENTITY mapping
//! (`session_id == provider_handle == provider_thread_id`), so no public id moves.
//! Phase 2 routes provider calls (2a) and provider events (2b) through it; Phase 3
//! is the first phase allowed to mint a session id that differs from the handle.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// One session's current provider address.
///
/// `provider_handle` and `provider_thread_id` are separate because a deferred
/// Claude session has a bridge handle (`claude-pending-*`) before it has a native
/// id — the handle is callable, the native id is durable, and only the second one
/// is safe to persist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionBinding {
    pub(crate) provider: String,
    pub(crate) provider_handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider_thread_id: Option<String>,
}

impl SessionBinding {
    /// The compatibility shape every Phase-1 binding takes: the relay session id
    /// IS the provider's native id.
    pub(crate) fn identity(provider: &str, native_id: &str) -> Self {
        Self {
            provider: provider.to_string(),
            provider_handle: native_id.to_string(),
            provider_thread_id: Some(native_id.to_string()),
        }
    }

    pub(crate) fn route_key(&self) -> ProviderRouteKey {
        ProviderRouteKey {
            provider: self.provider.clone(),
            handle: self.provider_handle.clone(),
        }
    }

    /// Whether the provider has handed over a durable id yet. Phase 3 replaces the
    /// `starts_with("claude-pending-")` persistence checks with this.
    pub(crate) fn is_materialized(&self) -> bool {
        self.provider_thread_id.is_some()
    }

    fn is_identity_for(&self, session_id: &str) -> bool {
        self.provider_handle == session_id && self.provider_thread_id.as_deref() == Some(session_id)
    }
}

/// The reverse key. Provider-qualified because two providers may legitimately use
/// the same native id string, and an unqualified key would route one to the other.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ProviderRouteKey {
    pub(crate) provider: String,
    pub(crate) handle: String,
}

/// What an arriving provider event's handle resolves to.
///
/// Separate from a bare `Option` because "the handle names a session that is not
/// yours" and "nothing named a session" are opposite instructions: one is a drop
/// with a reason, the other is the ordinary unaddressed event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProviderEventTarget {
    /// A binding already owns `(provider, handle)`.
    Bound(String),
    /// Nothing owned the handle, so an identity binding was created for it —
    /// invariant 7, applied to events rather than list rows.
    Adopted(String),
    /// The handle spells a session id that belongs to a different provider
    /// address. Adopting it would point two providers at one session's state.
    Refused { owner_provider: String },
    /// Blank provider or handle: there is nothing to route on.
    Unroutable,
}

/// What a provider router should do with one event, after translation.
///
/// `Unnamed` is not `Refused`: an event that named no session at all is the
/// ordinary "applies to whatever is active" case every router already had, while
/// `Refused` means a handle was named and the relay will not route it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProviderEventSession {
    /// The event carried no thread/session field.
    Unnamed,
    /// The stable relay session id to key every record by.
    Session(String),
    /// Drop the event.
    Refused,
}

/// What a caller needs to reach a provider: never the session id on its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedProviderTarget {
    pub(crate) session_id: String,
    pub(crate) provider: String,
    pub(crate) provider_handle: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionBindingError {
    /// A binding with a blank session id / provider / handle would make the reverse
    /// index collide on the empty key and route unrelated sessions together.
    Blank(&'static str),
    /// Invariant 5: at most one session owns a `(provider, handle)` pair.
    HandleClaimed {
        provider: String,
        handle: String,
        owner: String,
    },
    /// Identity-only adoption cannot expose the same raw string as a second
    /// provider's public session id. Phase 3 can mint a distinct session id; Phase
    /// 2c must refuse instead of silently moving the existing binding.
    SessionIdClaimed {
        session_id: String,
        owner_provider: String,
    },
}

impl std::fmt::Display for SessionBindingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blank(field) => write!(f, "session binding {field} must not be empty"),
            Self::HandleClaimed {
                provider,
                handle,
                owner,
            } => write!(
                f,
                "provider handle {provider}/{handle} is already bound to session '{owner}'"
            ),
            Self::SessionIdClaimed {
                session_id,
                owner_provider,
            } => write!(
                f,
                "provider result id '{session_id}' is already a session owned by provider '{owner_provider}'"
            ),
        }
    }
}

/// `session_id -> binding`, plus the derived `(provider, handle) -> session_id`
/// index. The index is never persisted: it is rebuilt from the bindings on load,
/// which is also what keeps the two from drifting.
///
/// Deliberately uncapped, unlike `search_routing_hints`: entries leave on archive
/// and delete, and evicting a live session's binding would orphan the session
/// outright once Phase 3 can mint an id the provider has never heard of.
#[derive(Clone, Debug, Default)]
pub(crate) struct SessionBindingRegistry {
    bindings: HashMap<String, SessionBinding>,
    by_provider_handle: HashMap<ProviderRouteKey, String>,
}

impl SessionBindingRegistry {
    /// Register or re-point a session. Rebinding drops the old reverse key in the
    /// same call, so a stale handle can never keep routing to a session that moved.
    pub(crate) fn bind(
        &mut self,
        session_id: &str,
        binding: SessionBinding,
    ) -> Result<(), SessionBindingError> {
        if session_id.is_empty() {
            return Err(SessionBindingError::Blank("session id"));
        }
        if binding.provider.is_empty() {
            return Err(SessionBindingError::Blank("provider"));
        }
        if binding.provider_handle.is_empty() {
            return Err(SessionBindingError::Blank("provider handle"));
        }

        let key = binding.route_key();
        if let Some(owner) = self.by_provider_handle.get(&key) {
            if owner != session_id {
                return Err(SessionBindingError::HandleClaimed {
                    provider: key.provider,
                    handle: key.handle,
                    owner: owner.clone(),
                });
            }
        }

        if let Some(previous) = self.bindings.get(session_id) {
            let previous_key = previous.route_key();
            if previous_key != key {
                self.by_provider_handle.remove(&previous_key);
            }
        }
        self.by_provider_handle.insert(key, session_id.to_string());
        self.bindings.insert(session_id.to_string(), binding);
        Ok(())
    }

    pub(crate) fn bind_identity(
        &mut self,
        provider: &str,
        native_id: &str,
    ) -> Result<(), SessionBindingError> {
        self.bind(native_id, SessionBinding::identity(provider, native_id))
    }

    pub(crate) fn binding(&self, session_id: &str) -> Option<&SessionBinding> {
        self.bindings.get(session_id)
    }

    pub(crate) fn resolve(&self, session_id: &str) -> Option<ResolvedProviderTarget> {
        let binding = self.bindings.get(session_id)?;
        Some(ResolvedProviderTarget {
            session_id: session_id.to_string(),
            provider: binding.provider.clone(),
            provider_handle: binding.provider_handle.clone(),
        })
    }

    pub(crate) fn session_for_provider_handle(&self, provider: &str, handle: &str) -> Option<&str> {
        self.by_provider_handle
            .get(&ProviderRouteKey {
                provider: provider.to_string(),
                handle: handle.to_string(),
            })
            .map(String::as_str)
    }

    /// Resolve an unqualified legacy provider handle at API ingress.
    ///
    /// Public inputs do not carry a provider key. A real session id always wins;
    /// otherwise exactly one reverse-index match may act as its alias. The same raw
    /// handle under two providers is ambiguous and must be refused rather than routed
    /// by HashMap iteration order.
    pub(crate) fn canonical_session_id(&self, value: &str) -> Result<String, Vec<String>> {
        if self.bindings.contains_key(value) {
            return Ok(value.to_string());
        }
        let mut matches = self
            .by_provider_handle
            .iter()
            .filter(|(key, _)| key.handle == value)
            .map(|(_, session_id)| session_id.clone())
            .collect::<Vec<_>>();
        matches.sort();
        matches.dedup();
        match matches.as_slice() {
            [] => Ok(value.to_string()),
            [session_id] => Ok(session_id.clone()),
            _ => Err(matches),
        }
    }

    /// Adopt one provider result and return all three boundary names.
    ///
    /// Existing reverse bindings win, which is what rewrites an injected/stale
    /// provider alias to its stable session id. Unknown rows get the compatibility
    /// identity binding. A raw handle that already spells some session id is refused:
    /// Phase 2c cannot represent that second identity without minting an id.
    pub(crate) fn adopt_provider_handle(
        &mut self,
        provider: &str,
        handle: &str,
    ) -> Result<crate::provider::AdoptedProviderSession, SessionBindingError> {
        if provider.is_empty() {
            return Err(SessionBindingError::Blank("provider"));
        }
        if handle.is_empty() {
            return Err(SessionBindingError::Blank("provider handle"));
        }
        if let Some(session_id) = self.session_for_provider_handle(provider, handle) {
            return Ok(crate::provider::AdoptedProviderSession {
                provider: provider.to_string(),
                provider_handle: handle.to_string(),
                session_id: session_id.to_string(),
            });
        }
        if let Some(existing) = self.bindings.get(handle) {
            return Err(SessionBindingError::SessionIdClaimed {
                session_id: handle.to_string(),
                owner_provider: existing.provider.clone(),
            });
        }
        self.bind_identity(provider, handle)?;
        Ok(crate::provider::AdoptedProviderSession {
            provider: provider.to_string(),
            provider_handle: handle.to_string(),
            session_id: handle.to_string(),
        })
    }

    /// Route one provider event to the session that owns its handle, adopting the
    /// handle when nothing claims it yet.
    ///
    /// The refusal arm is the whole reason this is not `session_for_provider_handle`
    /// plus a `bind_identity`: past the lookup, a binding stored UNDER the handle
    /// string can only be some other address's, and `bind` would silently drop that
    /// session's reverse key on the way past.
    pub(crate) fn route_provider_event(
        &mut self,
        provider: &str,
        handle: &str,
    ) -> ProviderEventTarget {
        if provider.is_empty() || handle.is_empty() {
            return ProviderEventTarget::Unroutable;
        }
        if let Some(session_id) = self.session_for_provider_handle(provider, handle) {
            return ProviderEventTarget::Bound(session_id.to_string());
        }
        if let Some(existing) = self.bindings.get(handle) {
            return ProviderEventTarget::Refused {
                owner_provider: existing.provider.clone(),
            };
        }
        match self.bind_identity(provider, handle) {
            Ok(()) => ProviderEventTarget::Adopted(handle.to_string()),
            // Both refusal causes are checked above, so this is unreachable today —
            // but a refused bind must never be reported as a routable session.
            Err(_) => ProviderEventTarget::Refused {
                owner_provider: provider.to_string(),
            },
        }
    }

    pub(crate) fn remove(&mut self, session_id: &str) -> Option<SessionBinding> {
        let binding = self.bindings.remove(session_id)?;
        self.by_provider_handle.remove(&binding.route_key());
        Some(binding)
    }

    /// The subset worth writing to `session.json`.
    ///
    /// An identity binding re-derives itself from the provider's own thread list on
    /// the next refresh, so persisting one per historical row would grow the state
    /// file by every session a search ever scanned and change no decision. An
    /// unmaterialized session is dropped for the reason its metadata already is:
    /// nothing on the provider side survives the restart.
    pub(crate) fn persistable(&self) -> HashMap<String, SessionBinding> {
        self.bindings
            .iter()
            .filter(|(session_id, binding)| {
                binding.is_materialized() && !binding.is_identity_for(session_id)
            })
            .map(|(session_id, binding)| (session_id.clone(), binding.clone()))
            .collect()
    }

    /// Rebuild from a loaded state file, returning the session ids whose bindings
    /// had to be dropped because another session already claimed their handle.
    /// Applied in sorted order so a corrupt file resolves the same way every boot.
    pub(crate) fn restore(persisted: &HashMap<String, SessionBinding>) -> (Self, Vec<String>) {
        let mut registry = Self::default();
        let mut dropped = Vec::new();
        let mut entries: Vec<(&String, &SessionBinding)> = persisted.iter().collect();
        entries.sort_by(|left, right| left.0.cmp(right.0));
        for (session_id, binding) in entries {
            if registry.bind(session_id, binding.clone()).is_err() {
                dropped.push(session_id.clone());
            }
        }
        (registry, dropped)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.bindings.len()
    }

    /// Exposed for tests only: a reverse index that outgrows the forward map is the
    /// exact leak `bind`/`remove` exist to prevent.
    #[cfg(test)]
    pub(crate) fn reverse_len(&self) -> usize {
        self.by_provider_handle.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real Claude session id, bound under a session id that is NOT it — the
    /// Phase-3 shape, used here to prove Phase 1 already stores and reloads it.
    fn promoted() -> SessionBinding {
        SessionBinding {
            provider: "claude_code".to_string(),
            provider_handle: "real-sdk-id".to_string(),
            provider_thread_id: Some("real-sdk-id".to_string()),
        }
    }

    #[test]
    fn identity_bind_resolves_back_to_the_same_strings() {
        let mut registry = SessionBindingRegistry::default();
        registry
            .bind_identity("codex", "thread-1")
            .expect("identity bind");

        assert_eq!(
            registry.resolve("thread-1"),
            Some(ResolvedProviderTarget {
                session_id: "thread-1".to_string(),
                provider: "codex".to_string(),
                provider_handle: "thread-1".to_string(),
            }),
        );
        assert_eq!(
            registry.session_for_provider_handle("codex", "thread-1"),
            Some("thread-1"),
        );
        assert_eq!(registry.resolve("nobody"), None);
        assert_eq!(
            registry.session_for_provider_handle("fake", "thread-1"),
            None
        );
    }

    // The deferred-Claude shape Phase 3 depends on: the session id stays put while
    // the handle moves, and the handle it left must stop routing at once — a stale
    // reverse key is how an event for a recycled handle lands on the wrong session.
    #[test]
    fn rebinding_a_session_drops_the_handle_it_left() {
        let mut registry = SessionBindingRegistry::default();
        registry
            .bind(
                "session-a",
                SessionBinding {
                    provider: "claude_code".to_string(),
                    provider_handle: "claude-pending-1".to_string(),
                    provider_thread_id: None,
                },
            )
            .expect("pending bind");
        registry
            .bind("session-a", promoted())
            .expect("promote to the real id");

        assert_eq!(
            registry.session_for_provider_handle("claude_code", "claude-pending-1"),
            None,
            "the pending handle must stop routing the moment the real one arrives",
        );
        assert_eq!(
            registry.session_for_provider_handle("claude_code", "real-sdk-id"),
            Some("session-a"),
        );
        assert_eq!(registry.len(), 1);
        assert_eq!(
            registry.reverse_len(),
            1,
            "a rebind that leaves its old reverse key behind leaks one entry per promotion",
        );
    }

    #[test]
    fn a_second_session_cannot_claim_a_bound_provider_handle() {
        let mut registry = SessionBindingRegistry::default();
        registry.bind_identity("codex", "thread-1").expect("first");

        let error = registry
            .bind("session-b", SessionBinding::identity("codex", "thread-1"))
            .expect_err("two sessions must not own one provider handle");
        assert_eq!(
            error,
            SessionBindingError::HandleClaimed {
                provider: "codex".to_string(),
                handle: "thread-1".to_string(),
                owner: "thread-1".to_string(),
            },
        );
        assert!(
            registry.binding("session-b").is_none(),
            "a refused bind must leave nothing behind",
        );
        assert_eq!(
            registry.session_for_provider_handle("codex", "thread-1"),
            Some("thread-1"),
            "the original owner keeps the handle",
        );
    }

    // Native ids are only unique WITHIN a provider. An unqualified reverse key would
    // make one provider's thread answer for the other's.
    #[test]
    fn the_same_native_id_can_exist_under_two_providers() {
        let mut registry = SessionBindingRegistry::default();
        registry
            .bind("session-codex", SessionBinding::identity("codex", "abc"))
            .expect("codex abc");
        registry
            .bind(
                "session-claude",
                SessionBinding::identity("claude_code", "abc"),
            )
            .expect("claude abc must not collide with codex abc");

        assert_eq!(
            registry.session_for_provider_handle("codex", "abc"),
            Some("session-codex"),
        );
        assert_eq!(
            registry.session_for_provider_handle("claude_code", "abc"),
            Some("session-claude"),
        );
    }

    #[test]
    fn removing_a_session_clears_its_reverse_key() {
        let mut registry = SessionBindingRegistry::default();
        registry.bind_identity("codex", "thread-1").expect("bind");

        let removed = registry.remove("thread-1").expect("removed");
        assert_eq!(removed.provider, "codex");
        assert_eq!(registry.len(), 0);
        assert_eq!(registry.reverse_len(), 0);
        assert_eq!(
            registry.session_for_provider_handle("codex", "thread-1"),
            None
        );
        assert!(
            registry.remove("thread-1").is_none(),
            "removal is idempotent"
        );
    }

    #[test]
    fn blank_components_are_refused() {
        let mut registry = SessionBindingRegistry::default();
        assert_eq!(
            registry.bind("", SessionBinding::identity("codex", "t")),
            Err(SessionBindingError::Blank("session id")),
        );
        assert_eq!(
            registry.bind("s", SessionBinding::identity("", "t")),
            Err(SessionBindingError::Blank("provider")),
        );
        assert_eq!(
            registry.bind(
                "s",
                SessionBinding {
                    provider: "codex".to_string(),
                    provider_handle: String::new(),
                    provider_thread_id: None,
                },
            ),
            Err(SessionBindingError::Blank("provider handle")),
        );
        assert_eq!(registry.len(), 0);
        assert_eq!(registry.reverse_len(), 0);
    }

    // What `persistable` is for: the state file must not grow by one row per
    // session a deep search happened to scan.
    #[test]
    fn only_non_identity_materialized_bindings_are_written() {
        let mut registry = SessionBindingRegistry::default();
        registry
            .bind_identity("codex", "thread-1")
            .expect("identity");
        registry
            .bind(
                "session-pending",
                SessionBinding {
                    provider: "claude_code".to_string(),
                    provider_handle: "claude-pending-1".to_string(),
                    provider_thread_id: None,
                },
            )
            .expect("pending");
        registry.bind("session-real", promoted()).expect("promoted");

        let persistable = registry.persistable();
        assert_eq!(
            persistable.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["session-real"],
            "identity rows re-derive from the provider list; an unsent deferred session \
has no provider history to come back to",
        );
    }

    #[test]
    fn restore_rebuilds_the_reverse_index_and_drops_conflicts_deterministically() {
        let mut persisted = HashMap::new();
        persisted.insert("session-b".to_string(), promoted());
        persisted.insert("session-a".to_string(), promoted());
        persisted.insert(
            "session-c".to_string(),
            SessionBinding::identity("codex", "codex-1"),
        );

        let (registry, dropped) = SessionBindingRegistry::restore(&persisted);
        assert_eq!(
            dropped,
            vec!["session-b".to_string()],
            "sorted application makes the loser of a duplicated handle the same one every boot",
        );
        assert_eq!(
            registry.session_for_provider_handle("claude_code", "real-sdk-id"),
            Some("session-a"),
        );
        assert_eq!(
            registry.session_for_provider_handle("codex", "codex-1"),
            Some("session-c"),
        );
        assert_eq!(registry.len(), 2);
        assert_eq!(registry.reverse_len(), 2);
    }

    // Phase 2b. The routing decision itself, away from any provider.
    #[test]
    fn a_bound_handle_routes_to_its_session_and_binds_nothing_new() {
        let mut registry = SessionBindingRegistry::default();
        registry.bind("session-a", promoted()).expect("bind");

        assert_eq!(
            registry.route_provider_event("claude_code", "real-sdk-id"),
            ProviderEventTarget::Bound("session-a".to_string()),
        );
        assert_eq!(registry.len(), 1, "a lookup must not grow the registry");
    }

    #[test]
    fn an_unknown_handle_is_adopted_so_the_event_has_a_session() {
        let mut registry = SessionBindingRegistry::default();

        assert_eq!(
            registry.route_provider_event("codex", "thread-1"),
            ProviderEventTarget::Adopted("thread-1".to_string()),
        );
        assert_eq!(
            registry.session_for_provider_handle("codex", "thread-1"),
            Some("thread-1"),
            "adoption is what makes the SECOND event a plain lookup",
        );
    }

    // The collision adoption must refuse. Binding here would drop `session-a`'s
    // reverse key on the way past and hand Codex a Claude session's state.
    #[test]
    fn a_handle_that_spells_another_addresss_session_id_is_refused() {
        let mut registry = SessionBindingRegistry::default();
        registry
            .bind(
                "session-a",
                SessionBinding::identity("claude_code", "session-a"),
            )
            .expect("bind");

        assert_eq!(
            registry.route_provider_event("codex", "session-a"),
            ProviderEventTarget::Refused {
                owner_provider: "claude_code".to_string(),
            },
        );
        assert_eq!(
            registry.session_for_provider_handle("claude_code", "session-a"),
            Some("session-a"),
            "the refusal leaves the owner exactly as it was",
        );
        assert_eq!(
            registry.session_for_provider_handle("codex", "session-a"),
            None
        );
    }

    // Same session id, non-identity binding: the handle string is free, but the id
    // is taken, and adopting it would rebind `session-a` away from its real handle.
    #[test]
    fn a_handle_equal_to_a_session_id_on_the_same_provider_is_refused_too() {
        let mut registry = SessionBindingRegistry::default();
        registry.bind("session-a", promoted()).expect("bind");

        assert_eq!(
            registry.route_provider_event("claude_code", "session-a"),
            ProviderEventTarget::Refused {
                owner_provider: "claude_code".to_string(),
            },
        );
        assert_eq!(
            registry.session_for_provider_handle("claude_code", "real-sdk-id"),
            Some("session-a"),
            "the session keeps the handle it actually lives at",
        );
    }

    #[test]
    fn two_providers_emitting_one_raw_handle_route_apart() {
        let mut registry = SessionBindingRegistry::default();
        registry
            .bind("session-codex", SessionBinding::identity("codex", "abc"))
            .expect("codex abc");
        registry
            .bind(
                "session-claude",
                SessionBinding::identity("claude_code", "abc"),
            )
            .expect("claude abc");

        assert_eq!(
            registry.route_provider_event("codex", "abc"),
            ProviderEventTarget::Bound("session-codex".to_string()),
        );
        assert_eq!(
            registry.route_provider_event("claude_code", "abc"),
            ProviderEventTarget::Bound("session-claude".to_string()),
        );
    }

    #[test]
    fn a_blank_provider_or_handle_routes_nowhere() {
        let mut registry = SessionBindingRegistry::default();
        assert_eq!(
            registry.route_provider_event("", "thread-1"),
            ProviderEventTarget::Unroutable,
        );
        assert_eq!(
            registry.route_provider_event("codex", ""),
            ProviderEventTarget::Unroutable,
        );
        assert_eq!(registry.len(), 0);
        assert_eq!(registry.reverse_len(), 0);
    }

    #[test]
    fn a_binding_survives_a_json_round_trip() {
        let binding = SessionBinding {
            provider: "claude_code".to_string(),
            provider_handle: "real-sdk-id".to_string(),
            provider_thread_id: Some("real-sdk-id".to_string()),
        };
        let json = serde_json::to_string(&binding).expect("encode");
        let decoded: SessionBinding = serde_json::from_str(&json).expect("decode");
        assert_eq!(decoded, binding);

        // An older writer omitted the optional native id entirely.
        let legacy: SessionBinding =
            serde_json::from_str(r#"{"provider":"codex","provider_handle":"t1"}"#)
                .expect("a binding without provider_thread_id must decode");
        assert_eq!(legacy.provider_thread_id, None);
        assert!(!legacy.is_materialized());
    }
}
