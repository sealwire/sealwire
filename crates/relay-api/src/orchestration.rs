//! Content-blind orchestration protocol.
//!
//! This module is the public, shared vocabulary for a future Cloud driver and a
//! future local sidecar. It deliberately contains no transport, entitlement,
//! template execution, provider calls, repository access, or driver policy.
//!
//! The privacy contract is allowlist-only. Cloud-visible messages may contain:
//! closed enums, counters, booleans, protocol and driver versions, stable
//! command/event identities, expected revisions, opaque ids, and opaque artifact
//! references. They must not contain task prose, repository paths or content,
//! prompts, transcripts, diffs, findings, logs, URLs, shell commands, arbitrary
//! text/blob fields, or `serde_json::Value`.

use std::{fmt, marker::PhantomData};

use serde::{
    de::{self, IgnoredAny, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize, Serializer,
};

/// First protocol version defined by the public repository.
pub const CURRENT_PROTOCOL_VERSION: u32 = 1;
/// Oldest protocol version this crate can negotiate.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
const _: () = assert!(MIN_PROTOCOL_VERSION <= CURRENT_PROTOCOL_VERSION);

pub const MAX_OPAQUE_ID_LEN: usize = 96;
pub const MAX_DRIVER_VERSION_LEN: usize = 64;
pub const MAX_COMMAND_BINDINGS: usize = 16;
pub const MAX_CANDIDATE_THREADS: usize = 16;
pub const MAX_CURSOR_ARTIFACTS: usize = 64;

/// Error produced while constructing a bounded protocol value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolValueError {
    Empty(&'static str),
    TooLong {
        field: &'static str,
        max: usize,
        actual: usize,
    },
    InvalidCharacter {
        field: &'static str,
        character: char,
    },
    InvalidTokenShape {
        field: &'static str,
    },
    TooManyItems {
        field: &'static str,
        max: usize,
        actual: usize,
    },
    NoCompatibleProtocol {
        local_min: u32,
        local_max: u32,
        peer_min: u32,
        peer_max: u32,
    },
    UnsupportedLocalProtocolRange {
        requested_min: u32,
        requested_max: u32,
        supported_min: u32,
        supported_max: u32,
    },
    InvalidRange {
        min: u32,
        max: u32,
    },
    UnsupportedProtocolVersion(u32),
    MalformedDriverProgress,
    UnknownBackend,
}

impl fmt::Display for ProtocolValueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty(field) => write!(f, "{field} must not be empty"),
            Self::TooLong { field, max, actual } => {
                write!(f, "{field} is too long ({actual} > {max})")
            }
            Self::InvalidCharacter { field, character } => {
                write!(f, "{field} contains invalid character {character:?}")
            }
            Self::InvalidTokenShape { field } => {
                write!(f, "{field} must not be path-like")
            }
            Self::TooManyItems { field, max, actual } => {
                write!(f, "{field} has too many items ({actual} > {max})")
            }
            Self::NoCompatibleProtocol {
                local_min,
                local_max,
                peer_min,
                peer_max,
            } => write!(
                f,
                "no compatible orchestration protocol version (local {local_min}-{local_max}, peer {peer_min}-{peer_max})"
            ),
            Self::UnsupportedLocalProtocolRange {
                requested_min,
                requested_max,
                supported_min,
                supported_max,
            } => write!(
                f,
                "requested local protocol range {requested_min}-{requested_max} is outside this build's supported range {supported_min}-{supported_max}"
            ),
            Self::InvalidRange { min, max } => {
                write!(f, "invalid protocol version range {min}-{max}")
            }
            Self::UnsupportedProtocolVersion(version) => {
                write!(f, "unsupported orchestration protocol version {version}")
            }
            Self::MalformedDriverProgress => {
                f.write_str("persisted driver progress is malformed and cannot be executed")
            }
            Self::UnknownBackend => {
                f.write_str("this build does not understand the orchestration backend")
            }
        }
    }
}

impl std::error::Error for ProtocolValueError {}

fn validate_token(
    field: &'static str,
    raw: impl AsRef<str>,
    max_len: usize,
) -> Result<String, ProtocolValueError> {
    let raw = raw.as_ref();
    if raw.is_empty() {
        return Err(ProtocolValueError::Empty(field));
    }
    if raw.len() > max_len {
        return Err(ProtocolValueError::TooLong {
            field,
            max: max_len,
            actual: raw.len(),
        });
    }
    for character in raw.chars() {
        let allowed = character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.');
        if !allowed {
            return Err(ProtocolValueError::InvalidCharacter { field, character });
        }
    }
    if raw.starts_with('.') || raw.ends_with('.') || raw.contains("..") {
        return Err(ProtocolValueError::InvalidTokenShape { field });
    }
    Ok(raw.to_string())
}

/// A protocol version this build can actually speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct SupportedProtocolVersion(u32);

impl SupportedProtocolVersion {
    pub fn new(version: u32) -> Result<Self, ProtocolValueError> {
        if (MIN_PROTOCOL_VERSION..=CURRENT_PROTOCOL_VERSION).contains(&version) {
            Ok(Self(version))
        } else {
            Err(ProtocolValueError::UnsupportedProtocolVersion(version))
        }
    }

    pub const fn current() -> Self {
        Self(CURRENT_PROTOCOL_VERSION)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

impl<'de> Deserialize<'de> for SupportedProtocolVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u32::deserialize(deserializer)?;
        Self::new(version).map_err(de::Error::custom)
    }
}

fn deserialize_supported_protocol_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    SupportedProtocolVersion::deserialize(deserializer).map(SupportedProtocolVersion::get)
}

struct LenientString(Option<String>);

impl<'de> Deserialize<'de> for LenientString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LenientStringVisitor;

        impl<'de> Visitor<'de> for LenientStringVisitor {
            type Value = LenientString;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string-like persisted field")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(Some(value.to_owned())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(Some(value)))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientString::deserialize(deserializer)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientString(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientString(None))
            }
        }

        deserializer.deserialize_any(LenientStringVisitor)
    }
}

enum LenientNullableString {
    Null,
    Value(String),
    Invalid,
}

impl<'de> Deserialize<'de> for LenientNullableString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct NullableStringVisitor;

        impl<'de> Visitor<'de> for NullableStringVisitor {
            type Value = LenientNullableString;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a nullable persisted string")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Value(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Value(value))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Null)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Null)
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientNullableString::deserialize(deserializer)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Invalid)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Invalid)
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Invalid)
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
                Ok(LenientNullableString::Invalid)
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientNullableString::Invalid)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientNullableString::Invalid)
            }
        }

        deserializer.deserialize_any(NullableStringVisitor)
    }
}

struct LenientBool(Option<bool>);

impl<'de> Deserialize<'de> for LenientBool {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct BoolVisitor;

        impl<'de> Visitor<'de> for BoolVisitor {
            type Value = LenientBool;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a persisted boolean")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(LenientBool(Some(value)))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(LenientBool(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(LenientBool(None))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientBool::deserialize(deserializer)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
                Ok(LenientBool(None))
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
                Ok(LenientBool(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
                Ok(LenientBool(None))
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
                Ok(LenientBool(None))
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
                Ok(LenientBool(None))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientBool(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientBool(None))
            }
        }

        deserializer.deserialize_any(BoolVisitor)
    }
}

struct LenientU32(Option<u32>);

impl<'de> Deserialize<'de> for LenientU32 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LenientU32Visitor;

        impl<'de> Visitor<'de> for LenientU32Visitor {
            type Value = LenientU32;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a u32-like persisted field")
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(u32::try_from(value).ok()))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(u32::try_from(value).ok()))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientU32::deserialize(deserializer)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientU32(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientU32(None))
            }
        }

        deserializer.deserialize_any(LenientU32Visitor)
    }
}

struct LenientU64(Option<u64>);

impl<'de> Deserialize<'de> for LenientU64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LenientU64Visitor;

        impl<'de> Visitor<'de> for LenientU64Visitor {
            type Value = LenientU64;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a u64-like persisted field")
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(Some(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(u64::try_from(value).ok()))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientU64::deserialize(deserializer)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientU64(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientU64(None))
            }
        }

        deserializer.deserialize_any(LenientU64Visitor)
    }
}

macro_rules! bounded_token {
    ($name:ident, $field:literal, $max:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn new(raw: impl AsRef<str>) -> Result<Self, ProtocolValueError> {
                validate_token($field, raw, $max).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                struct TokenVisitor;

                impl<'de> Visitor<'de> for TokenVisitor {
                    type Value = $name;

                    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                        write!(f, "a bounded opaque {}", $field)
                    }

                    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
                    where
                        E: de::Error,
                    {
                        $name::new(value).map_err(de::Error::custom)
                    }

                    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E>
                    where
                        E: de::Error,
                    {
                        self.visit_str(value)
                    }

                    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
                    where
                        E: de::Error,
                    {
                        $name::new(value.as_str()).map_err(de::Error::custom)
                    }
                }

                deserializer.deserialize_str(TokenVisitor)
            }
        }
    };
}

bounded_token!(CommandId, "command_id", MAX_OPAQUE_ID_LEN);
bounded_token!(EventId, "event_id", MAX_OPAQUE_ID_LEN);
bounded_token!(DriverRunId, "driver_run_id", MAX_OPAQUE_ID_LEN);
bounded_token!(ThreadHandle, "thread_handle", MAX_OPAQUE_ID_LEN);
bounded_token!(TemplateId, "template_id", MAX_OPAQUE_ID_LEN);
bounded_token!(ArtifactId, "artifact_id", MAX_OPAQUE_ID_LEN);
bounded_token!(DriverVersion, "driver_version", MAX_DRIVER_VERSION_LEN);
bounded_token!(
    UnknownBackendKind,
    "unknown_backend_kind",
    MAX_OPAQUE_ID_LEN
);

/// A vector whose deserializer rejects oversized protocol payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedVec<T, const MAX: usize> {
    items: Vec<T>,
}

impl<T, const MAX: usize> BoundedVec<T, MAX> {
    pub fn new(field: &'static str, items: Vec<T>) -> Result<Self, ProtocolValueError> {
        if items.len() > MAX {
            return Err(ProtocolValueError::TooManyItems {
                field,
                max: MAX,
                actual: items.len(),
            });
        }
        Ok(Self { items })
    }

    pub fn empty() -> Self {
        Self { items: Vec::new() }
    }

    pub fn as_slice(&self) -> &[T] {
        &self.items
    }

    pub fn into_vec(self) -> Vec<T> {
        self.items
    }
}

impl<T, const MAX: usize> Default for BoundedVec<T, MAX> {
    fn default() -> Self {
        Self::empty()
    }
}

impl<T, const MAX: usize> Serialize for BoundedVec<T, MAX>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.items.serialize(serializer)
    }
}

impl<'de, T, const MAX: usize> Deserialize<'de> for BoundedVec<T, MAX>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct BoundedVecVisitor<T, const MAX: usize> {
            marker: PhantomData<T>,
        }

        impl<'de, T, const MAX: usize> Visitor<'de> for BoundedVecVisitor<T, MAX>
        where
            T: Deserialize<'de>,
        {
            type Value = BoundedVec<T, MAX>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "a bounded sequence with at most {MAX} items")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let capacity = seq.size_hint().unwrap_or(0).min(MAX);
                let mut items = Vec::with_capacity(capacity);
                loop {
                    if items.len() == MAX {
                        if seq.next_element::<IgnoredAny>()?.is_some() {
                            return Err(de::Error::custom(ProtocolValueError::TooManyItems {
                                field: "bounded_vector",
                                max: MAX,
                                actual: MAX + 1,
                            }));
                        }
                        return Ok(BoundedVec { items });
                    }
                    let Some(item) = seq.next_element()? else {
                        return Ok(BoundedVec { items });
                    };
                    items.push(item);
                }
            }
        }

        deserializer.deserialize_seq(BoundedVecVisitor {
            marker: PhantomData,
        })
    }
}

/// Durable backend pin for one task-team run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrchestrationBackendRef {
    /// The current in-process private driver. This is the default for all
    /// existing and newly-created runs in T1-T3.
    LegacyEmbedded,
    /// Future hosted content-blind driver. It is inert until a later task adds a
    /// transport and executor.
    Cloud {
        protocol_version: SupportedProtocolVersion,
        driver_version: DriverVersion,
        cloud_run_id: DriverRunId,
    },
    /// Future licensed local sidecar. It is inert until a later task adds IPC.
    LocalSidecar {
        protocol_version: SupportedProtocolVersion,
        driver_version: DriverVersion,
    },
    /// A backend written by a newer build. The run record survives, but this
    /// build must not execute it. Only closed identity slots are retained; any
    /// future payload fields are intentionally dropped instead of being stored as
    /// arbitrary JSON.
    UnknownNonExecuting {
        original_kind: Option<UnknownBackendKind>,
        protocol_version: Option<u32>,
        driver_version: Option<DriverVersion>,
        cloud_run_id: Option<DriverRunId>,
    },
}

impl Default for OrchestrationBackendRef {
    fn default() -> Self {
        Self::LegacyEmbedded
    }
}

impl OrchestrationBackendRef {
    pub fn kind(&self) -> OrchestrationBackendKind {
        match self {
            Self::LegacyEmbedded => OrchestrationBackendKind::LegacyEmbedded,
            Self::Cloud { .. } => OrchestrationBackendKind::Cloud,
            Self::LocalSidecar { .. } => OrchestrationBackendKind::LocalSidecar,
            Self::UnknownNonExecuting { .. } => OrchestrationBackendKind::UnknownNonExecuting,
        }
    }

    pub fn is_legacy_embedded(&self) -> bool {
        matches!(self, Self::LegacyEmbedded)
    }

    pub fn is_executable_by_current_build(&self) -> bool {
        matches!(self, Self::LegacyEmbedded)
    }

    pub fn supported_protocol_version(&self) -> Option<u32> {
        match self {
            Self::LegacyEmbedded => Some(CURRENT_PROTOCOL_VERSION),
            Self::Cloud {
                protocol_version, ..
            }
            | Self::LocalSidecar {
                protocol_version, ..
            } => Some(protocol_version.get()),
            Self::UnknownNonExecuting { .. } => None,
        }
    }

    pub fn unknown_non_executing() -> Self {
        Self::UnknownNonExecuting {
            original_kind: None,
            protocol_version: None,
            driver_version: None,
            cloud_run_id: None,
        }
    }

    fn unknown_non_executing_from_parts(
        original_kind: Option<String>,
        protocol_version: Option<u32>,
        driver_version: Option<String>,
        cloud_run_id: Option<String>,
    ) -> Self {
        Self::UnknownNonExecuting {
            original_kind: original_kind.and_then(|raw| UnknownBackendKind::new(raw).ok()),
            protocol_version,
            driver_version: driver_version.and_then(|raw| DriverVersion::new(raw).ok()),
            cloud_run_id: cloud_run_id.and_then(|raw| DriverRunId::new(raw).ok()),
        }
    }

    pub fn original_unknown_kind(&self) -> Option<&str> {
        match self {
            Self::UnknownNonExecuting {
                original_kind: Some(kind),
                ..
            } => Some(kind.as_str()),
            _ => None,
        }
    }

    pub fn non_executing_reason(&self) -> Option<&'static str> {
        match self {
            Self::LegacyEmbedded => None,
            Self::Cloud { .. } => Some(
                "this task is pinned to Cloud orchestration, but this relay build has no Cloud transport",
            ),
            Self::LocalSidecar { .. } => Some(
                "this task is pinned to a local sidecar, but this relay build has no sidecar transport",
            ),
            Self::UnknownNonExecuting { .. } => Some(
                "this task is pinned to an orchestration backend this relay build does not understand",
            ),
        }
    }
}

impl Serialize for OrchestrationBackendRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;

        let mut len = 1;
        if matches!(self, Self::Cloud { .. }) {
            len = 4;
        } else if matches!(self, Self::LocalSidecar { .. }) {
            len = 3;
        } else if let Self::UnknownNonExecuting {
            original_kind,
            protocol_version,
            driver_version,
            cloud_run_id,
        } = self
        {
            len = 1
                + usize::from(original_kind.is_some())
                + usize::from(protocol_version.is_some())
                + usize::from(driver_version.is_some())
                + usize::from(cloud_run_id.is_some());
        }
        let mut map = serializer.serialize_map(Some(len))?;
        match self {
            Self::LegacyEmbedded => {
                map.serialize_entry("kind", "legacy_embedded")?;
            }
            Self::Cloud {
                protocol_version,
                driver_version,
                cloud_run_id,
            } => {
                map.serialize_entry("kind", "cloud")?;
                map.serialize_entry("protocol_version", protocol_version)?;
                map.serialize_entry("driver_version", driver_version)?;
                map.serialize_entry("cloud_run_id", cloud_run_id)?;
            }
            Self::LocalSidecar {
                protocol_version,
                driver_version,
            } => {
                map.serialize_entry("kind", "local_sidecar")?;
                map.serialize_entry("protocol_version", protocol_version)?;
                map.serialize_entry("driver_version", driver_version)?;
            }
            Self::UnknownNonExecuting {
                original_kind,
                protocol_version,
                driver_version,
                cloud_run_id,
            } => {
                map.serialize_entry("kind", "unknown_non_executing")?;
                if let Some(original_kind) = original_kind {
                    map.serialize_entry("original_kind", original_kind)?;
                }
                if let Some(protocol_version) = protocol_version {
                    map.serialize_entry("protocol_version", protocol_version)?;
                }
                if let Some(driver_version) = driver_version {
                    map.serialize_entry("driver_version", driver_version)?;
                }
                if let Some(cloud_run_id) = cloud_run_id {
                    map.serialize_entry("cloud_run_id", cloud_run_id)?;
                }
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for OrchestrationBackendRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        enum Field {
            Kind,
            OriginalKind,
            ProtocolVersion,
            DriverVersion,
            CloudRunId,
            Unknown,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Ok(match raw.as_str() {
                    "kind" => Self::Kind,
                    "original_kind" => Self::OriginalKind,
                    "protocol_version" => Self::ProtocolVersion,
                    "driver_version" => Self::DriverVersion,
                    "cloud_run_id" => Self::CloudRunId,
                    _ => Self::Unknown,
                })
            }
        }

        struct BackendVisitor;

        impl<'de> Visitor<'de> for BackendVisitor {
            type Value = OrchestrationBackendRef;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an orchestration backend object")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing())
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing())
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing())
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing())
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing())
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing())
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing_from_parts(
                    Some(value.to_string()),
                    None,
                    None,
                    None,
                ))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::unknown_non_executing_from_parts(
                    Some(value),
                    None,
                    None,
                    None,
                ))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(OrchestrationBackendRef::unknown_non_executing())
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut kind: Option<String> = None;
                let mut original_kind: Option<String> = None;
                let mut protocol_version: Option<u32> = None;
                let mut driver_version: Option<String> = None;
                let mut cloud_run_id: Option<String> = None;
                let mut unsupported_shape = false;
                let mut kind_seen = false;
                let mut original_kind_seen = false;
                let mut protocol_version_seen = false;
                let mut driver_version_seen = false;
                let mut cloud_run_id_seen = false;

                while let Some(field) = map.next_key()? {
                    match field {
                        Field::Kind => {
                            if kind_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            kind_seen = true;
                            kind = map.next_value::<LenientString>()?.0;
                            if kind.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::OriginalKind => {
                            if original_kind_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            original_kind_seen = true;
                            original_kind = map.next_value::<LenientString>()?.0;
                            if original_kind.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::ProtocolVersion => {
                            if protocol_version_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            protocol_version_seen = true;
                            protocol_version = map.next_value::<LenientU32>()?.0;
                            if protocol_version.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::DriverVersion => {
                            if driver_version_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            driver_version_seen = true;
                            driver_version = map.next_value::<LenientString>()?.0;
                            if driver_version.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::CloudRunId => {
                            if cloud_run_id_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            cloud_run_id_seen = true;
                            cloud_run_id = map.next_value::<LenientString>()?.0;
                            if cloud_run_id.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::Unknown => {
                            unsupported_shape = true;
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }

                let unknown = OrchestrationBackendRef::unknown_non_executing_from_parts(
                    original_kind.clone().or_else(|| kind.clone()),
                    protocol_version,
                    driver_version.clone(),
                    cloud_run_id.clone(),
                );

                match kind.as_deref() {
                    None => Ok(unknown),
                    Some("legacy_embedded") => {
                        if unsupported_shape
                            || original_kind.is_some()
                            || protocol_version.is_some()
                            || driver_version.is_some()
                            || cloud_run_id.is_some()
                        {
                            return Ok(unknown);
                        }
                        Ok(OrchestrationBackendRef::LegacyEmbedded)
                    }
                    Some("cloud") => {
                        if unsupported_shape || original_kind.is_some() {
                            return Ok(unknown);
                        }
                        let Some(protocol_version) = protocol_version
                            .and_then(|version| SupportedProtocolVersion::new(version).ok())
                        else {
                            return Ok(unknown);
                        };
                        let Some(driver_version) = driver_version
                            .clone()
                            .and_then(|raw| DriverVersion::new(raw).ok())
                        else {
                            return Ok(unknown);
                        };
                        let Some(cloud_run_id) = cloud_run_id
                            .clone()
                            .and_then(|raw| DriverRunId::new(raw).ok())
                        else {
                            return Ok(unknown);
                        };
                        Ok(OrchestrationBackendRef::Cloud {
                            protocol_version,
                            driver_version,
                            cloud_run_id,
                        })
                    }
                    Some("local_sidecar") => {
                        if unsupported_shape || original_kind.is_some() || cloud_run_id.is_some() {
                            return Ok(unknown);
                        }
                        let Some(protocol_version) = protocol_version
                            .and_then(|version| SupportedProtocolVersion::new(version).ok())
                        else {
                            return Ok(unknown);
                        };
                        let Some(driver_version) = driver_version
                            .clone()
                            .and_then(|raw| DriverVersion::new(raw).ok())
                        else {
                            return Ok(unknown);
                        };
                        Ok(OrchestrationBackendRef::LocalSidecar {
                            protocol_version,
                            driver_version,
                        })
                    }
                    Some("unknown_non_executing") => {
                        Ok(OrchestrationBackendRef::unknown_non_executing_from_parts(
                            original_kind,
                            protocol_version,
                            driver_version,
                            cloud_run_id,
                        ))
                    }
                    Some(_) => Ok(unknown),
                }
            }
        }

        deserializer.deserialize_any(BackendVisitor)
    }
}

/// Durable progress that lets a later command journal resume without guessing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DriverProgress {
    pub state_revision: u64,
    pub last_command_seq: u64,
    pub last_event_seq: u64,
    pub in_flight_command_id: Option<CommandId>,
    /// Progress contained an unknown or duplicate field, or a known field that
    /// could not be decoded safely. Persist this marker so a load/save cycle
    /// cannot turn truncated or corrupt progress into a plausible clean cursor.
    #[serde(default, skip_serializing_if = "is_false")]
    malformed: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl DriverProgress {
    pub fn is_malformed(&self) -> bool {
        self.malformed
    }

    fn malformed() -> Self {
        Self {
            malformed: true,
            ..Self::default()
        }
    }
}

impl<'de> Deserialize<'de> for DriverProgress {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        enum Field {
            StateRevision,
            LastCommandSeq,
            LastEventSeq,
            InFlightCommandId,
            Malformed,
            Unknown,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Ok(match raw.as_str() {
                    "state_revision" => Self::StateRevision,
                    "last_command_seq" => Self::LastCommandSeq,
                    "last_event_seq" => Self::LastEventSeq,
                    "in_flight_command_id" => Self::InFlightCommandId,
                    "malformed" => Self::Malformed,
                    _ => Self::Unknown,
                })
            }
        }

        struct ProgressVisitor;

        impl<'de> Visitor<'de> for ProgressVisitor {
            type Value = DriverProgress;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a persisted driver progress object")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::malformed())
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(DriverProgress::malformed())
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut progress = DriverProgress::default();
                let mut state_revision_seen = false;
                let mut last_command_seq_seen = false;
                let mut last_event_seq_seen = false;
                let mut in_flight_command_id_seen = false;
                let mut malformed_seen = false;

                while let Some(field) = map.next_key()? {
                    match field {
                        Field::StateRevision => {
                            if state_revision_seen {
                                let _: IgnoredAny = map.next_value()?;
                                progress.malformed = true;
                                continue;
                            }
                            state_revision_seen = true;
                            match map.next_value::<LenientU64>()?.0 {
                                Some(value) => progress.state_revision = value,
                                None => progress.malformed = true,
                            }
                        }
                        Field::LastCommandSeq => {
                            if last_command_seq_seen {
                                let _: IgnoredAny = map.next_value()?;
                                progress.malformed = true;
                                continue;
                            }
                            last_command_seq_seen = true;
                            match map.next_value::<LenientU64>()?.0 {
                                Some(value) => progress.last_command_seq = value,
                                None => progress.malformed = true,
                            }
                        }
                        Field::LastEventSeq => {
                            if last_event_seq_seen {
                                let _: IgnoredAny = map.next_value()?;
                                progress.malformed = true;
                                continue;
                            }
                            last_event_seq_seen = true;
                            match map.next_value::<LenientU64>()?.0 {
                                Some(value) => progress.last_event_seq = value,
                                None => progress.malformed = true,
                            }
                        }
                        Field::InFlightCommandId => {
                            if in_flight_command_id_seen {
                                let _: IgnoredAny = map.next_value()?;
                                progress.malformed = true;
                                continue;
                            }
                            in_flight_command_id_seen = true;
                            match map.next_value::<LenientNullableString>()? {
                                LenientNullableString::Null => {
                                    progress.in_flight_command_id = None;
                                }
                                LenientNullableString::Value(raw) => match CommandId::new(raw) {
                                    Ok(command_id) => {
                                        progress.in_flight_command_id = Some(command_id)
                                    }
                                    Err(_) => progress.malformed = true,
                                },
                                LenientNullableString::Invalid => progress.malformed = true,
                            }
                        }
                        Field::Malformed => {
                            if malformed_seen {
                                let _: IgnoredAny = map.next_value()?;
                                progress.malformed = true;
                                continue;
                            }
                            malformed_seen = true;
                            match map.next_value::<LenientBool>()?.0 {
                                Some(value) => progress.malformed |= value,
                                None => progress.malformed = true,
                            }
                        }
                        Field::Unknown => {
                            let _: IgnoredAny = map.next_value()?;
                            progress.malformed = true;
                        }
                    }
                }

                Ok(progress)
            }
        }

        deserializer.deserialize_any(ProgressVisitor)
    }
}

/// Cap on `TeamRun.command_journal`. See `.sealwire/DESIGN.md` D9: eviction
/// only ever drops a record whose `sequence` is strictly below
/// `last_command_seq`, so a redelivery of an evicted command still fails the
/// monotonic-sequence check rather than being treated as unseen.
pub const MAX_TEAM_COMMAND_JOURNAL: usize = 64;

/// Closed discriminant naming one `team_command::TeamStateCommand` variant.
/// Content-blind: journaled records may carry this, never the command itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamCommandKind {
    RecordIntake,
    SetPhase,
    RecordDesignReviewRound,
    ReplanSubTasks,
    AttachSubTaskThread,
    SetSubTaskStatus,
    RecordReviewRound,
    MarkSubTaskDigested,
    RecordMrRound,
    SetMrVerdict,
    RecordMrDevThread,
    FinishRun,
    TakeUserNotes,
    /// The lifecycle family (`.sealwire/DESIGN.md` D14). These carry the run's
    /// own status transitions rather than workflow state, so they are the one
    /// family exempt from the reducer's lifecycle gate — they ARE the
    /// transition the gate would otherwise refuse.
    SetRunStatus,
    FailRun,
    BlockRun,
    SettleRun,
    /// A restart recovered `DriverProgress.in_flight_command_id` with no
    /// record of what kind the command actually was. T4's own reducer never
    /// leaves one in flight (`.sealwire/DESIGN.md` D10), so this is reachable
    /// only via `TeamRun::reconcile_after_restore` recovering state written
    /// by a future async executor.
    Unknown,
}

/// What became of one journaled command. Content-blind, unlike the receipt
/// the reducer hands back to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum TeamCommandOutcome {
    Applied,
    Rejected {
        reason: CommandRejection,
    },
    /// Recovered from a restart that found `in_flight_command_id` set. T4's
    /// own reducer is synchronous and never sets that field, so this arm is
    /// reachable only via `TeamRun::reconcile_after_restore` today — it exists
    /// for a future async executor, per `.sealwire/DESIGN.md` D10.
    Interrupted,
}

/// Fixed-width digest over one command envelope's full canonical
/// serialization, salted with the run id — the idempotency key alongside
/// `command_id`. Computed in `relay-server`, which already depends on `sha2`;
/// this crate holds only the closed shape. See `.sealwire/DESIGN.md` D3.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CommandFingerprint([u8; 32]);

impl CommandFingerprint {
    pub fn from_digest(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for CommandFingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("CommandFingerprint").field(&"..").finish()
    }
}

/// Content-blind projection of one submitted command, durable on
/// `TeamRun.command_journal`. Never carries `team_command::TeamStateCommand`'s
/// own prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamCommandRecord {
    pub command_id: CommandId,
    pub sequence: u64,
    pub kind: TeamCommandKind,
    /// `None` means "matches any fingerprint" — written only by restart
    /// recovery for a stranded `in_flight_command_id`, whose original
    /// envelope (and thus its digest) was never durably recorded. Treating an
    /// absent digest as a wildcard, rather than inventing a sentinel value, is
    /// what lets a genuine redelivery of that id replay `Interrupted` instead
    /// of being misread as a content mismatch. See `.sealwire/DESIGN.md` D10.
    pub fingerprint: Option<CommandFingerprint>,
    pub expected_revision: u64,
    /// `state_revision` / `last_event_seq` as they stood immediately after
    /// this record was written. Unchanged from before it for every outcome
    /// but `Applied` — see `.sealwire/DESIGN.md` D7.
    pub state_revision: u64,
    pub last_event_seq: u64,
    pub outcome: TeamCommandOutcome,
}

/// A command handed to an executor but not yet known to have settled.
///
/// Content-blind, and durable so a restart can settle it honestly. The id
/// alone is not enough: recovery has to write a journal record a later
/// redelivery can be matched against, and matching on the id alone cannot
/// tell a genuine retry of the SAME envelope (replay `Interrupted`) from a
/// DIFFERENT command that reused the id (`DuplicateCommand`). Carrying the
/// digest and the counters the receipt needs is what makes both answerable
/// — see `.sealwire/DESIGN.md` D10.
///
/// T4's own reducer is synchronous under one lock and never leaves a command
/// in flight, so nothing in this build writes this; it exists so the recovery
/// contract is defined and tested before an async executor needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InFlightCommand {
    pub command_id: CommandId,
    pub fingerprint: CommandFingerprint,
    pub kind: TeamCommandKind,
    pub sequence: u64,
    pub expected_revision: u64,
    /// The run's counters as they stood when the command was handed over, so
    /// the recovered `Interrupted` receipt reports the same values the
    /// original delivery would have.
    pub state_revision: u64,
    pub last_event_seq: u64,
}

impl InFlightCommand {
    /// The terminal journal record this becomes on restore.
    pub fn into_interrupted_record(self) -> TeamCommandRecord {
        TeamCommandRecord {
            command_id: self.command_id,
            sequence: self.sequence,
            kind: self.kind,
            fingerprint: Some(self.fingerprint),
            expected_revision: self.expected_revision,
            state_revision: self.state_revision,
            last_event_seq: self.last_event_seq,
            outcome: TeamCommandOutcome::Interrupted,
        }
    }
}

/// `TeamRun.command_journal`'s wire type.
///
/// A bare `Vec<TeamCommandRecord>` would let one corrupt or unrecognized
/// element (an unknown `TeamCommandKind`, an invalid `CommandId`) hard-fail
/// deserializing the WHOLE `TeamRun` the way a plain derive does — which is
/// what forces `DriverProgress` above to hand-write its own lenient decode.
/// This wrapper absorbs that failure into `is_malformed()` instead: an empty
/// journal reads as "never seen this command", which is exactly the false
/// negative the journal exists to prevent (`.sealwire/DESIGN.md` D9), so a
/// decode failure must never masquerade as an empty one.
///
/// `malformed` is itself persisted (like `DriverProgress::malformed`) rather
/// than reset on every load: once a journal is flagged, a save/reload cycle
/// must not quietly heal it back to an empty-and-trustworthy one.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TeamCommandJournal {
    records: Vec<TeamCommandRecord>,
    #[serde(default, skip_serializing_if = "is_false")]
    malformed: bool,
}

impl TeamCommandJournal {
    pub fn is_malformed(&self) -> bool {
        self.malformed
    }

    pub fn iter(&self) -> impl Iterator<Item = &TeamCommandRecord> {
        self.records.iter()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn find(&self, command_id: &CommandId) -> Option<&TeamCommandRecord> {
        self.records
            .iter()
            .find(|record| &record.command_id == command_id)
    }

    pub fn push(&mut self, record: TeamCommandRecord) {
        self.records.push(record);
    }

    /// Remove and return the first (oldest) record matching `predicate`. The
    /// caller decides what is safe to drop; this type only offers the
    /// mechanism. Returning the removed record (not just whether one was
    /// found) lets the caller clean up anything keyed off its `command_id` —
    /// `TeamRun.drained_notes`, for a `TakeUserNotes` record.
    pub fn remove_first(
        &mut self,
        mut predicate: impl FnMut(&TeamCommandRecord) -> bool,
    ) -> Option<TeamCommandRecord> {
        let pos = self.records.iter().position(|record| predicate(record))?;
        Some(self.records.remove(pos))
    }

    fn malformed() -> Self {
        Self {
            records: Vec::new(),
            malformed: true,
        }
    }
}

impl<'de> Deserialize<'de> for TeamCommandJournal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Route through `serde_json::Value` first (format-agnostic: this just
        // captures serde's data model) so a bad element degrades this journal
        // to `malformed` rather than failing the caller's whole decode.
        let value = serde_json::Value::deserialize(deserializer)?;
        let serde_json::Value::Object(mut map) = value else {
            return Ok(Self::malformed());
        };
        // A previously-persisted `malformed: true` stays malformed regardless
        // of whatever is in `records` — the flag must survive a save/reload,
        // never heal itself back to a trusted empty journal. Anything that is
        // not literally `false` is a shape this crate never writes, so it is
        // read as untrustworthy rather than as a truthiness question.
        match map.get("malformed") {
            None | Some(serde_json::Value::Bool(false)) => {}
            _ => return Ok(Self::malformed()),
        }
        let Some(records_value) = map.remove("records") else {
            return Ok(Self::malformed());
        };
        let serde_json::Value::Array(items) = records_value else {
            return Ok(Self::malformed());
        };
        // The cap is a durable invariant, not just something live append
        // respects: restoring 65 records would leave this build permanently
        // over budget with no path back under it.
        if items.len() > MAX_TEAM_COMMAND_JOURNAL {
            return Ok(Self::malformed());
        }
        let mut records: Vec<TeamCommandRecord> = Vec::with_capacity(items.len());
        for item in items {
            match serde_json::from_value::<TeamCommandRecord>(item) {
                // Two records under one id make `find` order-dependent, so the
                // same redelivery could replay either one's outcome. There is
                // no safe tie-break; refuse the journal instead.
                Ok(record)
                    if records
                        .iter()
                        .any(|seen| seen.command_id == record.command_id) =>
                {
                    return Ok(Self::malformed())
                }
                Ok(record) => records.push(record),
                Err(_) => return Ok(Self::malformed()),
            }
        }
        Ok(Self {
            records,
            malformed: false,
        })
    }
}

/// Backend kind safe for a driver cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationBackendKind {
    LegacyEmbedded,
    Cloud,
    LocalSidecar,
    UnknownNonExecuting,
}

/// Sanitized team status for the content-blind driver cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverRunStatus {
    Queued,
    Running,
    PausePending,
    Paused,
    AwaitingUser,
    Done,
    Escalated,
    Blocked,
    Resolving,
    Failed,
    Interrupted,
    Cancelled,
}

impl DriverRunStatus {
    pub fn from_team_status(status: crate::team::TeamRunStatus) -> Self {
        match status {
            crate::team::TeamRunStatus::Queued => Self::Queued,
            crate::team::TeamRunStatus::Running => Self::Running,
            crate::team::TeamRunStatus::PausePending => Self::PausePending,
            crate::team::TeamRunStatus::Paused => Self::Paused,
            crate::team::TeamRunStatus::AwaitingUser => Self::AwaitingUser,
            crate::team::TeamRunStatus::Done => Self::Done,
            crate::team::TeamRunStatus::Escalated => Self::Escalated,
            crate::team::TeamRunStatus::Blocked => Self::Blocked,
            crate::team::TeamRunStatus::Resolving => Self::Resolving,
            crate::team::TeamRunStatus::Failed => Self::Failed,
            crate::team::TeamRunStatus::Interrupted => Self::Interrupted,
            crate::team::TeamRunStatus::Cancelled => Self::Cancelled,
        }
    }
}

/// Sanitized team phase for the content-blind driver cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverPhase {
    Intake,
    Design,
    DesignReview,
    Planning,
    SubTasks,
    MrGate,
    Wrapping,
    Finished,
}

impl DriverPhase {
    pub fn from_team_phase(phase: crate::team::TeamPhase) -> Self {
        match phase {
            crate::team::TeamPhase::Intake => Self::Intake,
            crate::team::TeamPhase::Design => Self::Design,
            crate::team::TeamPhase::DesignReview => Self::DesignReview,
            crate::team::TeamPhase::Planning => Self::Planning,
            crate::team::TeamPhase::SubTasks => Self::SubTasks,
            crate::team::TeamPhase::MrGate => Self::MrGate,
            crate::team::TeamPhase::Wrapping => Self::Wrapping,
            crate::team::TeamPhase::Finished => Self::Finished,
        }
    }
}

/// Stable role vocabulary for content-blind protocol v1.
///
/// This intentionally mirrors today's local [`crate::team::TeamRole`] variants
/// without reusing that enum on the wire; local runtime roles may evolve without
/// silently changing the v1 protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriverRole {
    Tl,
    Dev,
    Reviewer,
}

impl DriverRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tl => "tl",
            Self::Dev => "dev",
            Self::Reviewer => "reviewer",
        }
    }

    fn from_wire(raw: &str) -> Option<Self> {
        match raw {
            "tl" => Some(Self::Tl),
            "dev" => Some(Self::Dev),
            "reviewer" => Some(Self::Reviewer),
            _ => None,
        }
    }

    pub fn from_team_role(role: crate::team::TeamRole) -> Self {
        match role {
            crate::team::TeamRole::Tl => Self::Tl,
            crate::team::TeamRole::Dev => Self::Dev,
            crate::team::TeamRole::Reviewer => Self::Reviewer,
        }
    }

    pub fn as_team_role(self) -> crate::team::TeamRole {
        match self {
            Self::Tl => crate::team::TeamRole::Tl,
            Self::Dev => crate::team::TeamRole::Dev,
            Self::Reviewer => crate::team::TeamRole::Reviewer,
        }
    }
}

impl From<crate::team::TeamRole> for DriverRole {
    fn from(role: crate::team::TeamRole) -> Self {
        Self::from_team_role(role)
    }
}

impl Serialize for DriverRole {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for DriverRole {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::from_wire(&raw)
            .ok_or_else(|| de::Error::custom(format!("unsupported driver role `{raw}`")))
    }
}

/// A local artifact handle. The handle is opaque; resolving it is local-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub artifact_id: ArtifactId,
    pub kind: ArtifactKind,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Closed artifact classes. The bytes behind these classes never cross this
/// protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    TaskSpec,
    Plan,
    Design,
    Report,
    SubTaskBrief,
    WorkspaceDiff,
    ReviewVerdict,
    TranscriptDigest,
}

/// Which local template slot an artifact satisfies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactBindingSlot {
    TaskSpec,
    Plan,
    Design,
    Report,
    SubTaskBrief,
    Diff,
    Verdict,
    PriorSummary,
}

/// Binding from a closed slot to a local artifact reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactBinding {
    pub slot: ArtifactBindingSlot,
    pub artifact: ArtifactRef,
}

/// Minimal cursor a content-blind driver can use to choose the next command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriverCursor {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub protocol_version: u32,
    pub backend: OrchestrationBackendKind,
    pub status: DriverRunStatus,
    pub phase: DriverPhase,
    pub state_revision: u64,
    pub last_command_seq: u64,
    pub last_event_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_flight_command_id: Option<CommandId>,
    pub current_sub_task_index: u32,
    pub sub_task_count: u32,
    pub current_rounds_used: u32,
    pub max_review_rounds: u32,
    pub design_review_rounds: u32,
    pub mr_rounds_used: u32,
    pub tl_generation: u32,
    pub pause_requested: bool,
    pub awaiting_user: bool,
    #[serde(default)]
    pub artifacts: BoundedVec<ArtifactRef, MAX_CURSOR_ARTIFACTS>,
}

impl DriverCursor {
    pub fn from_team_run(
        run: &crate::team::TeamRun,
        artifacts: Vec<ArtifactRef>,
    ) -> Result<Self, ProtocolValueError> {
        if run.driver_progress.is_malformed() {
            return Err(ProtocolValueError::MalformedDriverProgress);
        }
        let protocol_version = run
            .orchestration_backend
            .supported_protocol_version()
            .ok_or(ProtocolValueError::UnknownBackend)?;
        let current = run.current_sub_task();
        let current_rounds_used = current
            .and_then(|index| run.sub_tasks.get(index))
            .map(|task| task.rounds_used)
            .unwrap_or(0);
        Ok(Self {
            protocol_version,
            backend: run.orchestration_backend.kind(),
            status: DriverRunStatus::from_team_status(run.status),
            phase: DriverPhase::from_team_phase(run.phase),
            state_revision: run.driver_progress.state_revision,
            last_command_seq: run.driver_progress.last_command_seq,
            last_event_seq: run.driver_progress.last_event_seq,
            in_flight_command_id: run.driver_progress.in_flight_command_id.clone(),
            current_sub_task_index: bounded_usize_to_u32(current.unwrap_or(run.sub_tasks.len())),
            sub_task_count: bounded_usize_to_u32(run.sub_tasks.len()),
            current_rounds_used,
            max_review_rounds: run.max_review_rounds,
            design_review_rounds: run.design_review_rounds,
            mr_rounds_used: run.mr_rounds_used,
            tl_generation: bounded_usize_to_u32(run.tl_generation_count()),
            pause_requested: run.pause_requested,
            awaiting_user: run.awaiting.is_some(),
            artifacts: BoundedVec::new("artifacts", artifacts)?,
        })
    }
}

fn bounded_usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Command envelope with stable identity and expected revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriverCommandEnvelope {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub protocol_version: u32,
    pub command_id: CommandId,
    pub sequence: u64,
    pub expected_revision: u64,
    pub command: DriverCommand,
}

/// Closed commands a future content-blind driver may ask the local executor to
/// perform. Template ids and artifact bindings select audited local behavior;
/// they do not carry prompts or commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DriverCommand {
    RequireWorkspace {},
    StartThread {
        role: DriverRole,
    },
    ResumeOrStartThread {
        role: DriverRole,
        candidates: BoundedVec<ThreadHandle, MAX_CANDIDATE_THREADS>,
    },
    RunTemplate {
        thread: ThreadHandle,
        role: DriverRole,
        template_id: TemplateId,
        bindings: BoundedVec<ArtifactBinding, MAX_COMMAND_BINDINGS>,
    },
    CheckpointCommit {},
    CollectDiff {
        scope: DiffScope,
    },
    MergeBase {
        target: MergeBaseTarget,
    },
    Commit {
        message_template_id: TemplateId,
        bindings: BoundedVec<ArtifactBinding, MAX_COMMAND_BINDINGS>,
    },
    PauseAtBoundary {},
    SettleRun {
        status: DriverRunStatus,
    },
}

const DRIVER_COMMAND_FIELDS: &[&str] = &[
    "kind",
    "role",
    "candidates",
    "thread",
    "template_id",
    "bindings",
    "scope",
    "target",
    "message_template_id",
    "status",
];

const DRIVER_COMMAND_KINDS: &[&str] = &[
    "require_workspace",
    "start_thread",
    "resume_or_start_thread",
    "run_template",
    "checkpoint_commit",
    "collect_diff",
    "merge_base",
    "commit",
    "pause_at_boundary",
    "settle_run",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriverCommandField {
    Kind,
    Role,
    Candidates,
    Thread,
    TemplateId,
    Bindings,
    Scope,
    Target,
    MessageTemplateId,
    Status,
}

impl DriverCommandField {
    fn as_str(self) -> &'static str {
        match self {
            Self::Kind => "kind",
            Self::Role => "role",
            Self::Candidates => "candidates",
            Self::Thread => "thread",
            Self::TemplateId => "template_id",
            Self::Bindings => "bindings",
            Self::Scope => "scope",
            Self::Target => "target",
            Self::MessageTemplateId => "message_template_id",
            Self::Status => "status",
        }
    }
}

impl<'de> Deserialize<'de> for DriverCommandField {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FieldVisitor;

        impl<'de> Visitor<'de> for FieldVisitor {
            type Value = DriverCommandField;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a driver command field")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "kind" => Ok(DriverCommandField::Kind),
                    "role" => Ok(DriverCommandField::Role),
                    "candidates" => Ok(DriverCommandField::Candidates),
                    "thread" => Ok(DriverCommandField::Thread),
                    "template_id" => Ok(DriverCommandField::TemplateId),
                    "bindings" => Ok(DriverCommandField::Bindings),
                    "scope" => Ok(DriverCommandField::Scope),
                    "target" => Ok(DriverCommandField::Target),
                    "message_template_id" => Ok(DriverCommandField::MessageTemplateId),
                    "status" => Ok(DriverCommandField::Status),
                    _ => Err(de::Error::unknown_field(value, DRIVER_COMMAND_FIELDS)),
                }
            }
        }

        deserializer.deserialize_identifier(FieldVisitor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriverCommandKind {
    RequireWorkspace,
    StartThread,
    ResumeOrStartThread,
    RunTemplate,
    CheckpointCommit,
    CollectDiff,
    MergeBase,
    Commit,
    PauseAtBoundary,
    SettleRun,
}

impl DriverCommandKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::RequireWorkspace => "require_workspace",
            Self::StartThread => "start_thread",
            Self::ResumeOrStartThread => "resume_or_start_thread",
            Self::RunTemplate => "run_template",
            Self::CheckpointCommit => "checkpoint_commit",
            Self::CollectDiff => "collect_diff",
            Self::MergeBase => "merge_base",
            Self::Commit => "commit",
            Self::PauseAtBoundary => "pause_at_boundary",
            Self::SettleRun => "settle_run",
        }
    }
}

impl<'de> Deserialize<'de> for DriverCommandKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct KindVisitor;

        impl<'de> Visitor<'de> for KindVisitor {
            type Value = DriverCommandKind;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a driver command kind")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "require_workspace" => Ok(DriverCommandKind::RequireWorkspace),
                    "start_thread" => Ok(DriverCommandKind::StartThread),
                    "resume_or_start_thread" => Ok(DriverCommandKind::ResumeOrStartThread),
                    "run_template" => Ok(DriverCommandKind::RunTemplate),
                    "checkpoint_commit" => Ok(DriverCommandKind::CheckpointCommit),
                    "collect_diff" => Ok(DriverCommandKind::CollectDiff),
                    "merge_base" => Ok(DriverCommandKind::MergeBase),
                    "commit" => Ok(DriverCommandKind::Commit),
                    "pause_at_boundary" => Ok(DriverCommandKind::PauseAtBoundary),
                    "settle_run" => Ok(DriverCommandKind::SettleRun),
                    _ => Err(de::Error::unknown_variant(value, DRIVER_COMMAND_KINDS)),
                }
            }
        }

        deserializer.deserialize_str(KindVisitor)
    }
}

fn read_map_field<'de, A, T>(
    map: &mut A,
    slot: &mut Option<T>,
    field: &'static str,
) -> Result<(), A::Error>
where
    A: MapAccess<'de>,
    T: Deserialize<'de>,
{
    if slot.is_some() {
        return Err(de::Error::duplicate_field(field));
    }
    *slot = Some(map.next_value()?);
    Ok(())
}

fn required_map_field<T, E>(slot: Option<T>, field: &'static str) -> Result<T, E>
where
    E: de::Error,
{
    slot.ok_or_else(|| de::Error::missing_field(field))
}

fn reject_command_extra<T, E>(
    slot: Option<T>,
    field: &'static str,
    kind: &'static str,
) -> Result<(), E>
where
    E: de::Error,
{
    if slot.is_some() {
        return Err(de::Error::custom(format!(
            "field {field} is not valid for {kind} command"
        )));
    }
    Ok(())
}

fn command_field_allowed_for_kind(kind: DriverCommandKind, field: DriverCommandField) -> bool {
    match kind {
        DriverCommandKind::RequireWorkspace
        | DriverCommandKind::CheckpointCommit
        | DriverCommandKind::PauseAtBoundary => false,
        DriverCommandKind::StartThread => matches!(field, DriverCommandField::Role),
        DriverCommandKind::ResumeOrStartThread => {
            matches!(
                field,
                DriverCommandField::Role | DriverCommandField::Candidates
            )
        }
        DriverCommandKind::RunTemplate => matches!(
            field,
            DriverCommandField::Thread
                | DriverCommandField::Role
                | DriverCommandField::TemplateId
                | DriverCommandField::Bindings
        ),
        DriverCommandKind::CollectDiff => matches!(field, DriverCommandField::Scope),
        DriverCommandKind::MergeBase => matches!(field, DriverCommandField::Target),
        DriverCommandKind::Commit => matches!(
            field,
            DriverCommandField::MessageTemplateId | DriverCommandField::Bindings
        ),
        DriverCommandKind::SettleRun => matches!(field, DriverCommandField::Status),
    }
}

impl<'de> Deserialize<'de> for DriverCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct CommandVisitor;

        impl<'de> Visitor<'de> for CommandVisitor {
            type Value = DriverCommand;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a closed driver command object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut kind = None;
                let mut role = None;
                let mut candidates = None;
                let mut thread = None;
                let mut template_id = None;
                let mut bindings = None;
                let mut scope = None;
                let mut target = None;
                let mut message_template_id = None;
                let mut status = None;

                while let Some(field) = map.next_key()? {
                    if let Some(kind) = kind {
                        if field != DriverCommandField::Kind
                            && !command_field_allowed_for_kind(kind, field)
                        {
                            return Err(de::Error::custom(format!(
                                "field {} is not valid for {} command",
                                field.as_str(),
                                kind.as_str()
                            )));
                        }
                    }
                    match field {
                        DriverCommandField::Kind => read_map_field(&mut map, &mut kind, "kind")?,
                        DriverCommandField::Role => read_map_field(&mut map, &mut role, "role")?,
                        DriverCommandField::Candidates => {
                            read_map_field(&mut map, &mut candidates, "candidates")?
                        }
                        DriverCommandField::Thread => {
                            read_map_field(&mut map, &mut thread, "thread")?
                        }
                        DriverCommandField::TemplateId => {
                            read_map_field(&mut map, &mut template_id, "template_id")?
                        }
                        DriverCommandField::Bindings => {
                            read_map_field(&mut map, &mut bindings, "bindings")?
                        }
                        DriverCommandField::Scope => read_map_field(&mut map, &mut scope, "scope")?,
                        DriverCommandField::Target => {
                            read_map_field(&mut map, &mut target, "target")?
                        }
                        DriverCommandField::MessageTemplateId => read_map_field(
                            &mut map,
                            &mut message_template_id,
                            "message_template_id",
                        )?,
                        DriverCommandField::Status => {
                            read_map_field(&mut map, &mut status, "status")?
                        }
                    }
                }

                let kind: DriverCommandKind = required_map_field(kind, "kind")?;
                match kind {
                    DriverCommandKind::RequireWorkspace => {
                        reject_command_extra(role, "role", kind.as_str())?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::RequireWorkspace {})
                    }
                    DriverCommandKind::StartThread => {
                        let role = required_map_field(role, "role")?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::StartThread { role })
                    }
                    DriverCommandKind::ResumeOrStartThread => {
                        let role = required_map_field(role, "role")?;
                        let candidates = required_map_field(candidates, "candidates")?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::ResumeOrStartThread { role, candidates })
                    }
                    DriverCommandKind::RunTemplate => {
                        let thread = required_map_field(thread, "thread")?;
                        let role = required_map_field(role, "role")?;
                        let template_id = required_map_field(template_id, "template_id")?;
                        let bindings = required_map_field(bindings, "bindings")?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::RunTemplate {
                            thread,
                            role,
                            template_id,
                            bindings,
                        })
                    }
                    DriverCommandKind::CheckpointCommit => {
                        reject_command_extra(role, "role", kind.as_str())?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::CheckpointCommit {})
                    }
                    DriverCommandKind::CollectDiff => {
                        let scope = required_map_field(scope, "scope")?;
                        reject_command_extra(role, "role", kind.as_str())?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::CollectDiff { scope })
                    }
                    DriverCommandKind::MergeBase => {
                        let target = required_map_field(target, "target")?;
                        reject_command_extra(role, "role", kind.as_str())?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::MergeBase { target })
                    }
                    DriverCommandKind::Commit => {
                        let message_template_id =
                            required_map_field(message_template_id, "message_template_id")?;
                        let bindings = required_map_field(bindings, "bindings")?;
                        reject_command_extra(role, "role", kind.as_str())?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::Commit {
                            message_template_id,
                            bindings,
                        })
                    }
                    DriverCommandKind::PauseAtBoundary => {
                        reject_command_extra(role, "role", kind.as_str())?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        reject_command_extra(status, "status", kind.as_str())?;
                        Ok(DriverCommand::PauseAtBoundary {})
                    }
                    DriverCommandKind::SettleRun => {
                        let status = required_map_field(status, "status")?;
                        reject_command_extra(role, "role", kind.as_str())?;
                        reject_command_extra(candidates, "candidates", kind.as_str())?;
                        reject_command_extra(thread, "thread", kind.as_str())?;
                        reject_command_extra(template_id, "template_id", kind.as_str())?;
                        reject_command_extra(bindings, "bindings", kind.as_str())?;
                        reject_command_extra(scope, "scope", kind.as_str())?;
                        reject_command_extra(target, "target", kind.as_str())?;
                        reject_command_extra(
                            message_template_id,
                            "message_template_id",
                            kind.as_str(),
                        )?;
                        Ok(DriverCommand::SettleRun { status })
                    }
                }
            }
        }

        deserializer.deserialize_map(CommandVisitor)
    }
}

/// Diff target selected without exposing refs or paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffScope {
    Head,
    CurrentSubTask,
    MergeBaseTarget,
}

/// Merge-base target selected by local policy, never by a driver-supplied ref.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeBaseTarget {
    PinnedTarget,
}

/// Event envelope returned by the local executor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriverEventEnvelope {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub protocol_version: u32,
    pub event_id: EventId,
    pub sequence: u64,
    pub command_id: CommandId,
    pub observed_revision: u64,
    pub event: DriverEvent,
}

/// Closed events a local executor may return to a content-blind driver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DriverEvent {
    CommandAccepted {},
    CommandRejected {
        reason: CommandRejection,
    },
    WorkspaceReady {},
    ThreadReady {
        thread: ThreadHandle,
        role: DriverRole,
    },
    TurnFinished {
        outcome: TurnOutcomeKind,
        artifact: Option<ArtifactRef>,
    },
    DiffCollected {
        changed: bool,
        artifact: ArtifactRef,
    },
    MergeBaseResolved {
        available: bool,
        artifact: Option<ArtifactRef>,
    },
    CommitRecorded {
        changed: bool,
        artifact: Option<ArtifactRef>,
    },
    CursorAdvanced {
        cursor: DriverCursor,
    },
    RunSettled {
        status: DriverRunStatus,
    },
}

const DRIVER_EVENT_FIELDS: &[&str] = &[
    "kind",
    "reason",
    "thread",
    "role",
    "outcome",
    "artifact",
    "changed",
    "available",
    "cursor",
    "status",
];

const DRIVER_EVENT_KINDS: &[&str] = &[
    "command_accepted",
    "command_rejected",
    "workspace_ready",
    "thread_ready",
    "turn_finished",
    "diff_collected",
    "merge_base_resolved",
    "commit_recorded",
    "cursor_advanced",
    "run_settled",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriverEventField {
    Kind,
    Reason,
    Thread,
    Role,
    Outcome,
    Artifact,
    Changed,
    Available,
    Cursor,
    Status,
}

impl DriverEventField {
    fn as_str(self) -> &'static str {
        match self {
            Self::Kind => "kind",
            Self::Reason => "reason",
            Self::Thread => "thread",
            Self::Role => "role",
            Self::Outcome => "outcome",
            Self::Artifact => "artifact",
            Self::Changed => "changed",
            Self::Available => "available",
            Self::Cursor => "cursor",
            Self::Status => "status",
        }
    }
}

impl<'de> Deserialize<'de> for DriverEventField {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FieldVisitor;

        impl<'de> Visitor<'de> for FieldVisitor {
            type Value = DriverEventField;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a driver event field")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "kind" => Ok(DriverEventField::Kind),
                    "reason" => Ok(DriverEventField::Reason),
                    "thread" => Ok(DriverEventField::Thread),
                    "role" => Ok(DriverEventField::Role),
                    "outcome" => Ok(DriverEventField::Outcome),
                    "artifact" => Ok(DriverEventField::Artifact),
                    "changed" => Ok(DriverEventField::Changed),
                    "available" => Ok(DriverEventField::Available),
                    "cursor" => Ok(DriverEventField::Cursor),
                    "status" => Ok(DriverEventField::Status),
                    _ => Err(de::Error::unknown_field(value, DRIVER_EVENT_FIELDS)),
                }
            }
        }

        deserializer.deserialize_identifier(FieldVisitor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriverEventKind {
    CommandAccepted,
    CommandRejected,
    WorkspaceReady,
    ThreadReady,
    TurnFinished,
    DiffCollected,
    MergeBaseResolved,
    CommitRecorded,
    CursorAdvanced,
    RunSettled,
}

impl DriverEventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::CommandAccepted => "command_accepted",
            Self::CommandRejected => "command_rejected",
            Self::WorkspaceReady => "workspace_ready",
            Self::ThreadReady => "thread_ready",
            Self::TurnFinished => "turn_finished",
            Self::DiffCollected => "diff_collected",
            Self::MergeBaseResolved => "merge_base_resolved",
            Self::CommitRecorded => "commit_recorded",
            Self::CursorAdvanced => "cursor_advanced",
            Self::RunSettled => "run_settled",
        }
    }
}

impl<'de> Deserialize<'de> for DriverEventKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct KindVisitor;

        impl<'de> Visitor<'de> for KindVisitor {
            type Value = DriverEventKind;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a driver event kind")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "command_accepted" => Ok(DriverEventKind::CommandAccepted),
                    "command_rejected" => Ok(DriverEventKind::CommandRejected),
                    "workspace_ready" => Ok(DriverEventKind::WorkspaceReady),
                    "thread_ready" => Ok(DriverEventKind::ThreadReady),
                    "turn_finished" => Ok(DriverEventKind::TurnFinished),
                    "diff_collected" => Ok(DriverEventKind::DiffCollected),
                    "merge_base_resolved" => Ok(DriverEventKind::MergeBaseResolved),
                    "commit_recorded" => Ok(DriverEventKind::CommitRecorded),
                    "cursor_advanced" => Ok(DriverEventKind::CursorAdvanced),
                    "run_settled" => Ok(DriverEventKind::RunSettled),
                    _ => Err(de::Error::unknown_variant(value, DRIVER_EVENT_KINDS)),
                }
            }
        }

        deserializer.deserialize_str(KindVisitor)
    }
}

fn reject_event_extra<T, E>(
    slot: Option<T>,
    field: &'static str,
    kind: &'static str,
) -> Result<(), E>
where
    E: de::Error,
{
    if slot.is_some() {
        return Err(de::Error::custom(format!(
            "field {field} is not valid for {kind} event"
        )));
    }
    Ok(())
}

fn required_artifact<E>(slot: Option<Option<ArtifactRef>>) -> Result<ArtifactRef, E>
where
    E: de::Error,
{
    required_map_field(slot, "artifact")?
        .ok_or_else(|| de::Error::custom("artifact must not be null"))
}

fn event_field_allowed_for_kind(kind: DriverEventKind, field: DriverEventField) -> bool {
    match kind {
        DriverEventKind::CommandAccepted | DriverEventKind::WorkspaceReady => false,
        DriverEventKind::CommandRejected => matches!(field, DriverEventField::Reason),
        DriverEventKind::ThreadReady => {
            matches!(field, DriverEventField::Thread | DriverEventField::Role)
        }
        DriverEventKind::TurnFinished => {
            matches!(
                field,
                DriverEventField::Outcome | DriverEventField::Artifact
            )
        }
        DriverEventKind::DiffCollected => {
            matches!(
                field,
                DriverEventField::Changed | DriverEventField::Artifact
            )
        }
        DriverEventKind::MergeBaseResolved => {
            matches!(
                field,
                DriverEventField::Available | DriverEventField::Artifact
            )
        }
        DriverEventKind::CommitRecorded => {
            matches!(
                field,
                DriverEventField::Changed | DriverEventField::Artifact
            )
        }
        DriverEventKind::CursorAdvanced => matches!(field, DriverEventField::Cursor),
        DriverEventKind::RunSettled => matches!(field, DriverEventField::Status),
    }
}

impl<'de> Deserialize<'de> for DriverEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct EventVisitor;

        impl<'de> Visitor<'de> for EventVisitor {
            type Value = DriverEvent;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a closed driver event object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut kind = None;
                let mut reason = None;
                let mut thread = None;
                let mut role = None;
                let mut outcome = None;
                let mut artifact = None;
                let mut changed = None;
                let mut available = None;
                let mut cursor = None;
                let mut status = None;

                while let Some(field) = map.next_key()? {
                    if let Some(kind) = kind {
                        if field != DriverEventField::Kind
                            && !event_field_allowed_for_kind(kind, field)
                        {
                            return Err(de::Error::custom(format!(
                                "field {} is not valid for {} event",
                                field.as_str(),
                                kind.as_str()
                            )));
                        }
                    }
                    match field {
                        DriverEventField::Kind => read_map_field(&mut map, &mut kind, "kind")?,
                        DriverEventField::Reason => {
                            read_map_field(&mut map, &mut reason, "reason")?
                        }
                        DriverEventField::Thread => {
                            read_map_field(&mut map, &mut thread, "thread")?
                        }
                        DriverEventField::Role => read_map_field(&mut map, &mut role, "role")?,
                        DriverEventField::Outcome => {
                            read_map_field(&mut map, &mut outcome, "outcome")?
                        }
                        DriverEventField::Artifact => {
                            read_map_field(&mut map, &mut artifact, "artifact")?
                        }
                        DriverEventField::Changed => {
                            read_map_field(&mut map, &mut changed, "changed")?
                        }
                        DriverEventField::Available => {
                            read_map_field(&mut map, &mut available, "available")?
                        }
                        DriverEventField::Cursor => {
                            read_map_field(&mut map, &mut cursor, "cursor")?
                        }
                        DriverEventField::Status => {
                            read_map_field(&mut map, &mut status, "status")?
                        }
                    }
                }

                let kind: DriverEventKind = required_map_field(kind, "kind")?;
                match kind {
                    DriverEventKind::CommandAccepted => {
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(artifact, "artifact", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::CommandAccepted {})
                    }
                    DriverEventKind::CommandRejected => {
                        let reason = required_map_field(reason, "reason")?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(artifact, "artifact", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::CommandRejected { reason })
                    }
                    DriverEventKind::WorkspaceReady => {
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(artifact, "artifact", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::WorkspaceReady {})
                    }
                    DriverEventKind::ThreadReady => {
                        let thread = required_map_field(thread, "thread")?;
                        let role = required_map_field(role, "role")?;
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(artifact, "artifact", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::ThreadReady { thread, role })
                    }
                    DriverEventKind::TurnFinished => {
                        let outcome = required_map_field(outcome, "outcome")?;
                        let artifact = artifact.unwrap_or(None);
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::TurnFinished { outcome, artifact })
                    }
                    DriverEventKind::DiffCollected => {
                        let changed = required_map_field(changed, "changed")?;
                        let artifact = required_artifact(artifact)?;
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::DiffCollected { changed, artifact })
                    }
                    DriverEventKind::MergeBaseResolved => {
                        let available = required_map_field(available, "available")?;
                        let artifact = artifact.unwrap_or(None);
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::MergeBaseResolved {
                            available,
                            artifact,
                        })
                    }
                    DriverEventKind::CommitRecorded => {
                        let changed = required_map_field(changed, "changed")?;
                        let artifact = artifact.unwrap_or(None);
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::CommitRecorded { changed, artifact })
                    }
                    DriverEventKind::CursorAdvanced => {
                        let cursor = required_map_field(cursor, "cursor")?;
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(artifact, "artifact", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(status, "status", kind.as_str())?;
                        Ok(DriverEvent::CursorAdvanced { cursor })
                    }
                    DriverEventKind::RunSettled => {
                        let status = required_map_field(status, "status")?;
                        reject_event_extra(reason, "reason", kind.as_str())?;
                        reject_event_extra(thread, "thread", kind.as_str())?;
                        reject_event_extra(role, "role", kind.as_str())?;
                        reject_event_extra(outcome, "outcome", kind.as_str())?;
                        reject_event_extra(artifact, "artifact", kind.as_str())?;
                        reject_event_extra(changed, "changed", kind.as_str())?;
                        reject_event_extra(available, "available", kind.as_str())?;
                        reject_event_extra(cursor, "cursor", kind.as_str())?;
                        Ok(DriverEvent::RunSettled { status })
                    }
                }
            }
        }

        deserializer.deserialize_map(EventVisitor)
    }
}

/// Closed refusal reasons. Human-readable diagnostics stay local.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandRejection {
    UnknownRevision,
    DuplicateCommand,
    StaleCommand,
    BackendMismatch,
    PermissionDenied,
    WorkspaceUnavailable,
    TemplateUnavailable,
    ArtifactUnavailable,
    ExecutorBusy,
    InvalidState,
    UnsupportedProtocol,
}

/// Closed turn outcome. Any text the provider produced is stored as a local
/// artifact and referenced separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcomeKind {
    Replied,
    Silent,
    Failed,
    Blocked,
}

/// Version range advertised by one endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ProtocolRange {
    pub min: u32,
    pub max: u32,
}

impl ProtocolRange {
    pub fn new(min: u32, max: u32) -> Result<Self, ProtocolValueError> {
        if min == 0 || max == 0 || min > max {
            return Err(ProtocolValueError::InvalidRange { min, max });
        }
        Ok(Self { min, max })
    }

    pub fn current() -> Self {
        Self {
            min: MIN_PROTOCOL_VERSION,
            max: CURRENT_PROTOCOL_VERSION,
        }
    }
}

impl<'de> Deserialize<'de> for ProtocolRange {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            min: u32,
            max: u32,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.min, wire.max).map_err(de::Error::custom)
    }
}

/// Version negotiation request. Later transports can carry this as their first
/// typed message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolHello {
    pub supported: ProtocolRange,
    pub driver_version: DriverVersion,
    pub backend: OrchestrationBackendKind,
}

/// Successful protocol negotiation result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolNegotiation {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub selected_version: u32,
}

pub fn negotiate_protocol(
    local: ProtocolRange,
    peer: ProtocolRange,
) -> Result<ProtocolNegotiation, ProtocolValueError> {
    let local_min = local.min.max(MIN_PROTOCOL_VERSION);
    let local_max = local.max.min(CURRENT_PROTOCOL_VERSION);
    if local_min > local_max {
        return Err(ProtocolValueError::UnsupportedLocalProtocolRange {
            requested_min: local.min,
            requested_max: local.max,
            supported_min: MIN_PROTOCOL_VERSION,
            supported_max: CURRENT_PROTOCOL_VERSION,
        });
    }

    let min = local_min.max(peer.min);
    let max = local_max.min(peer.max);
    if min > max {
        return Err(ProtocolValueError::NoCompatibleProtocol {
            local_min,
            local_max,
            peer_min: peer.min,
            peer_max: peer.max,
        });
    }
    Ok(ProtocolNegotiation {
        selected_version: max,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::{AwaitingUser, SubTask, SubTaskStatus, TaskSpec, TeamPhase, TeamRun};
    use std::collections::BTreeSet;

    fn token(raw: &str) -> TemplateId {
        TemplateId::new(raw).expect("valid test token")
    }

    fn artifact(raw: &str, kind: ArtifactKind) -> ArtifactRef {
        ArtifactRef {
            artifact_id: ArtifactId::new(raw).expect("valid artifact id"),
            kind,
            revision: 7,
            size_bytes: Some(42),
        }
    }

    fn binding(slot: ArtifactBindingSlot, raw: &str, kind: ArtifactKind) -> ArtifactBinding {
        ArtifactBinding {
            slot,
            artifact: artifact(raw, kind),
        }
    }

    fn assert_cloud_visible_json_is_allowlisted(value: &serde_json::Value) {
        let allowed_keys = BTreeSet::from([
            "artifact",
            "artifact_id",
            "artifacts",
            "available",
            "awaiting_user",
            "backend",
            "bindings",
            "candidates",
            "changed",
            "cloud_run_id",
            "command",
            "command_id",
            "cursor",
            "current_rounds_used",
            "current_sub_task_index",
            "design_review_rounds",
            "driver_version",
            "event",
            "event_id",
            "expected_revision",
            "fingerprint",
            "in_flight_command_id",
            "kind",
            "last_command_seq",
            "last_event_seq",
            "max",
            "max_review_rounds",
            "message_template_id",
            "min",
            "mr_rounds_used",
            "observed_revision",
            "original_kind",
            "outcome",
            "pause_requested",
            "phase",
            "protocol_version",
            "reason",
            "revision",
            "role",
            "scope",
            "selected_version",
            "sequence",
            "size_bytes",
            "slot",
            "state_revision",
            "status",
            "sub_task_count",
            "supported",
            "target",
            "template_id",
            "thread",
            "tl_generation",
        ]);

        fn walk(value: &serde_json::Value, allowed_keys: &BTreeSet<&'static str>) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, value) in map {
                        assert!(
                            allowed_keys.contains(key.as_str()),
                            "unexpected Cloud-visible key {key:?} in {map:?}"
                        );
                        walk(value, allowed_keys);
                    }
                }
                serde_json::Value::Array(values) => {
                    for value in values {
                        walk(value, allowed_keys);
                    }
                }
                serde_json::Value::String(value) => {
                    for forbidden in ["CANARY", "http://", "https://", "/", "\n", "\r"] {
                        assert!(
                            !value.contains(forbidden),
                            "Cloud-visible string {value:?} contains forbidden marker {forbidden:?}"
                        );
                    }
                }
                serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::Number(_) => {}
            }
        }

        walk(value, &allowed_keys);
    }

    fn command_envelope(command: DriverCommand, index: u64) -> DriverCommandEnvelope {
        DriverCommandEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            command_id: CommandId::new(format!("cmd-{index}")).unwrap(),
            sequence: index,
            expected_revision: 9,
            command,
        }
    }

    fn event_envelope(event: DriverEvent, index: u64) -> DriverEventEnvelope {
        DriverEventEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            event_id: EventId::new(format!("event-{index}")).unwrap(),
            sequence: index,
            command_id: CommandId::new(format!("cmd-{index}")).unwrap(),
            observed_revision: 10,
            event,
        }
    }

    macro_rules! assert_json_string_literals {
        ($ty:ty, [$(($variant:path, $literal:literal)),+ $(,)?]) => {{
            fn expected_literal(value: $ty) -> &'static str {
                match value {
                    $($variant => $literal,)+
                }
            }

            for value in [$($variant),+] {
                let literal = expected_literal(value);
                let encoded = serde_json::to_string(&value).expect("serialize enum literal");
                assert_eq!(encoded, literal);
                let decoded: $ty = serde_json::from_str(literal).expect("decode enum literal");
                assert_eq!(decoded, value);
            }
        }};
    }

    #[test]
    fn protocol_v1_enum_literals_are_pinned() {
        assert_json_string_literals!(
            OrchestrationBackendKind,
            [
                (
                    OrchestrationBackendKind::LegacyEmbedded,
                    r#""legacy_embedded""#
                ),
                (OrchestrationBackendKind::Cloud, r#""cloud""#),
                (OrchestrationBackendKind::LocalSidecar, r#""local_sidecar""#),
                (
                    OrchestrationBackendKind::UnknownNonExecuting,
                    r#""unknown_non_executing""#
                ),
            ]
        );
        assert_json_string_literals!(
            DriverRunStatus,
            [
                (DriverRunStatus::Queued, r#""queued""#),
                (DriverRunStatus::Running, r#""running""#),
                (DriverRunStatus::PausePending, r#""pause_pending""#),
                (DriverRunStatus::Paused, r#""paused""#),
                (DriverRunStatus::AwaitingUser, r#""awaiting_user""#),
                (DriverRunStatus::Done, r#""done""#),
                (DriverRunStatus::Escalated, r#""escalated""#),
                (DriverRunStatus::Blocked, r#""blocked""#),
                (DriverRunStatus::Resolving, r#""resolving""#),
                (DriverRunStatus::Failed, r#""failed""#),
                (DriverRunStatus::Interrupted, r#""interrupted""#),
                (DriverRunStatus::Cancelled, r#""cancelled""#),
            ]
        );
        assert_json_string_literals!(
            DriverPhase,
            [
                (DriverPhase::Intake, r#""intake""#),
                (DriverPhase::Design, r#""design""#),
                (DriverPhase::DesignReview, r#""design_review""#),
                (DriverPhase::Planning, r#""planning""#),
                (DriverPhase::SubTasks, r#""sub_tasks""#),
                (DriverPhase::MrGate, r#""mr_gate""#),
                (DriverPhase::Wrapping, r#""wrapping""#),
                (DriverPhase::Finished, r#""finished""#),
            ]
        );
        assert_json_string_literals!(
            DriverRole,
            [
                (DriverRole::Tl, r#""tl""#),
                (DriverRole::Dev, r#""dev""#),
                (DriverRole::Reviewer, r#""reviewer""#),
            ]
        );
        assert_json_string_literals!(
            ArtifactKind,
            [
                (ArtifactKind::TaskSpec, r#""task_spec""#),
                (ArtifactKind::Plan, r#""plan""#),
                (ArtifactKind::Design, r#""design""#),
                (ArtifactKind::Report, r#""report""#),
                (ArtifactKind::SubTaskBrief, r#""sub_task_brief""#),
                (ArtifactKind::WorkspaceDiff, r#""workspace_diff""#),
                (ArtifactKind::ReviewVerdict, r#""review_verdict""#),
                (ArtifactKind::TranscriptDigest, r#""transcript_digest""#),
            ]
        );
        assert_json_string_literals!(
            ArtifactBindingSlot,
            [
                (ArtifactBindingSlot::TaskSpec, r#""task_spec""#),
                (ArtifactBindingSlot::Plan, r#""plan""#),
                (ArtifactBindingSlot::Design, r#""design""#),
                (ArtifactBindingSlot::Report, r#""report""#),
                (ArtifactBindingSlot::SubTaskBrief, r#""sub_task_brief""#),
                (ArtifactBindingSlot::Diff, r#""diff""#),
                (ArtifactBindingSlot::Verdict, r#""verdict""#),
                (ArtifactBindingSlot::PriorSummary, r#""prior_summary""#),
            ]
        );
        assert_json_string_literals!(
            DiffScope,
            [
                (DiffScope::Head, r#""head""#),
                (DiffScope::CurrentSubTask, r#""current_sub_task""#),
                (DiffScope::MergeBaseTarget, r#""merge_base_target""#),
            ]
        );
        assert_json_string_literals!(
            MergeBaseTarget,
            [(MergeBaseTarget::PinnedTarget, r#""pinned_target""#)]
        );
        assert_json_string_literals!(
            CommandRejection,
            [
                (CommandRejection::UnknownRevision, r#""unknown_revision""#),
                (CommandRejection::DuplicateCommand, r#""duplicate_command""#),
                (CommandRejection::StaleCommand, r#""stale_command""#),
                (CommandRejection::BackendMismatch, r#""backend_mismatch""#),
                (CommandRejection::PermissionDenied, r#""permission_denied""#),
                (
                    CommandRejection::WorkspaceUnavailable,
                    r#""workspace_unavailable""#
                ),
                (
                    CommandRejection::TemplateUnavailable,
                    r#""template_unavailable""#
                ),
                (
                    CommandRejection::ArtifactUnavailable,
                    r#""artifact_unavailable""#
                ),
                (CommandRejection::ExecutorBusy, r#""executor_busy""#),
                (CommandRejection::InvalidState, r#""invalid_state""#),
                (
                    CommandRejection::UnsupportedProtocol,
                    r#""unsupported_protocol""#
                ),
            ]
        );
        assert_json_string_literals!(
            TurnOutcomeKind,
            [
                (TurnOutcomeKind::Replied, r#""replied""#),
                (TurnOutcomeKind::Silent, r#""silent""#),
                (TurnOutcomeKind::Failed, r#""failed""#),
                (TurnOutcomeKind::Blocked, r#""blocked""#),
            ]
        );
    }

    /// T4's local command journal. Additive, per this test's exhaustive-match
    /// enforcement: a new `TeamCommandKind` variant fails the crate to build
    /// here until it is pinned, same as every other closed enum in this file.
    #[test]
    fn protocol_v1_team_command_journal_literals_are_pinned() {
        assert_json_string_literals!(
            TeamCommandKind,
            [
                (TeamCommandKind::RecordIntake, r#""record_intake""#),
                (TeamCommandKind::SetPhase, r#""set_phase""#),
                (
                    TeamCommandKind::RecordDesignReviewRound,
                    r#""record_design_review_round""#
                ),
                (TeamCommandKind::ReplanSubTasks, r#""replan_sub_tasks""#),
                (
                    TeamCommandKind::AttachSubTaskThread,
                    r#""attach_sub_task_thread""#
                ),
                (
                    TeamCommandKind::SetSubTaskStatus,
                    r#""set_sub_task_status""#
                ),
                (
                    TeamCommandKind::RecordReviewRound,
                    r#""record_review_round""#
                ),
                (
                    TeamCommandKind::MarkSubTaskDigested,
                    r#""mark_sub_task_digested""#
                ),
                (TeamCommandKind::RecordMrRound, r#""record_mr_round""#),
                (TeamCommandKind::SetMrVerdict, r#""set_mr_verdict""#),
                (
                    TeamCommandKind::RecordMrDevThread,
                    r#""record_mr_dev_thread""#
                ),
                (TeamCommandKind::FinishRun, r#""finish_run""#),
                (TeamCommandKind::TakeUserNotes, r#""take_user_notes""#),
                (TeamCommandKind::SetRunStatus, r#""set_run_status""#),
                (TeamCommandKind::FailRun, r#""fail_run""#),
                (TeamCommandKind::BlockRun, r#""block_run""#),
                (TeamCommandKind::SettleRun, r#""settle_run""#),
                (TeamCommandKind::Unknown, r#""unknown""#),
            ]
        );

        let outcomes = vec![
            (TeamCommandOutcome::Applied, r#"{"outcome":"applied"}"#),
            (
                TeamCommandOutcome::Rejected {
                    reason: CommandRejection::StaleCommand,
                },
                r#"{"outcome":"rejected","reason":"stale_command"}"#,
            ),
            (
                TeamCommandOutcome::Interrupted,
                r#"{"outcome":"interrupted"}"#,
            ),
        ];
        for (value, literal) in outcomes {
            let encoded = serde_json::to_string(&value).expect("serialize team command outcome");
            assert_eq!(encoded, literal);
            let decoded: TeamCommandOutcome =
                serde_json::from_str(literal).expect("decode team command outcome");
            assert_eq!(decoded, value);
        }
    }

    fn journal_record_json(command_id: &str, sequence: u64) -> serde_json::Value {
        let fingerprint = serde_json::to_value(CommandFingerprint::from_digest([7u8; 32])).unwrap();
        serde_json::json!({
            "command_id": command_id,
            "sequence": sequence,
            "kind": "record_intake",
            "fingerprint": fingerprint,
            "expected_revision": 0,
            "state_revision": sequence,
            "last_event_seq": sequence,
            "outcome": {"outcome": "applied"},
        })
    }

    /// The cap is a durable invariant, not merely something live append
    /// happens to respect. A hand-edited or downgraded-then-upgraded state
    /// file carrying 65 records must fail closed rather than restore a
    /// journal this build then treats as trustworthy and over budget forever.
    #[test]
    fn a_restored_journal_over_the_cap_fails_closed() {
        let at_cap: Vec<_> = (0..MAX_TEAM_COMMAND_JOURNAL)
            .map(|i| journal_record_json(&format!("cmd-{i}"), i as u64 + 1))
            .collect();
        let journal: TeamCommandJournal =
            serde_json::from_value(serde_json::json!({"records": at_cap})).unwrap();
        assert!(
            !journal.is_malformed(),
            "exactly at the cap is the largest legal journal"
        );
        assert_eq!(journal.len(), MAX_TEAM_COMMAND_JOURNAL);

        let over_cap: Vec<_> = (0..=MAX_TEAM_COMMAND_JOURNAL)
            .map(|i| journal_record_json(&format!("cmd-{i}"), i as u64 + 1))
            .collect();
        let journal: TeamCommandJournal =
            serde_json::from_value(serde_json::json!({"records": over_cap})).unwrap();
        assert!(
            journal.is_malformed(),
            "one record over the cap must fail closed, never restore 65"
        );
        assert!(journal.is_empty());
    }

    /// `find` returns the FIRST match, so two records under one id make
    /// replay depend on their order in the file — the same delivery could
    /// replay `Applied` or `Rejected` depending on which was written first.
    /// There is no safe way to pick, so refuse the journal.
    #[test]
    fn a_restored_journal_with_duplicate_command_ids_fails_closed() {
        let records = vec![
            journal_record_json("cmd-1", 1),
            journal_record_json("cmd-2", 2),
            journal_record_json("cmd-1", 3),
        ];
        let journal: TeamCommandJournal =
            serde_json::from_value(serde_json::json!({"records": records})).unwrap();
        assert!(
            journal.is_malformed(),
            "a duplicated command id makes replay ambiguous and must fail closed"
        );
        assert!(journal.is_empty());
    }

    /// `malformed` is a durable safety flag. Anything in that field other
    /// than a literal `false` is a shape this crate never wrote, so it cannot
    /// be read as "trustworthy" — including the truthy-looking values a
    /// hand-edit or a foreign writer would produce.
    #[test]
    fn a_restored_journal_with_a_non_bool_malformed_field_fails_closed() {
        for weird in [
            serde_json::json!("true"),
            serde_json::json!("false"),
            serde_json::json!(1),
            serde_json::json!(0),
            serde_json::json!(null),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let journal: TeamCommandJournal = serde_json::from_value(
                serde_json::json!({"records": [], "malformed": weird.clone()}),
            )
            .unwrap();
            assert!(
                journal.is_malformed(),
                "a non-bool `malformed` must fail closed, got {weird}"
            );
        }

        let honest: TeamCommandJournal =
            serde_json::from_value(serde_json::json!({"records": [], "malformed": false})).unwrap();
        assert!(
            !honest.is_malformed(),
            "an explicit `false` is what this crate writes and stays trusted"
        );
    }

    /// D9: a journal element that will not decode must fail this journal
    /// CLOSED, never collapse to an empty (falsely "never seen this command")
    /// one.
    #[test]
    fn team_command_journal_decode_failure_fails_closed_not_empty() {
        let fingerprint = serde_json::to_value(CommandFingerprint::from_digest([0u8; 32])).unwrap();
        let corrupt = serde_json::json!({"records": [{
            "command_id": "../escape",
            "sequence": 1,
            "kind": "record_intake",
            "fingerprint": fingerprint,
            "expected_revision": 0,
            "state_revision": 0,
            "last_event_seq": 0,
            "outcome": {"outcome": "applied"},
        }]});
        let journal: TeamCommandJournal = serde_json::from_value(corrupt).unwrap();
        assert!(
            journal.is_malformed(),
            "an invalid command_id must fail the journal closed, not decode to empty"
        );
        assert!(journal.is_empty());

        let not_an_object: TeamCommandJournal =
            serde_json::from_value(serde_json::json!("oops")).unwrap();
        assert!(not_an_object.is_malformed());

        // An explicit `null` is an unexpected shape (nothing this crate ever
        // writes), not a synonym for "absent key" — that already decodes to a
        // trusted empty default via `TeamRun`'s `#[serde(default)]` and never
        // reaches this impl at all. Same call `DriverProgress` makes for the
        // same reason.
        let explicit_null: TeamCommandJournal =
            serde_json::from_value(serde_json::Value::Null).unwrap();
        assert!(explicit_null.is_malformed());

        // The one shape this impl treats as a trustworthy empty journal.
        let clean: TeamCommandJournal =
            serde_json::from_value(serde_json::json!({"records": []})).unwrap();
        assert!(!clean.is_malformed());
        assert!(clean.is_empty());

        // `malformed` must survive a save/reload cycle rather than healing
        // itself back to an empty-and-trusted journal.
        let persisted = serde_json::to_value(journal.clone()).unwrap();
        assert_eq!(
            persisted,
            serde_json::json!({"records": [], "malformed": true})
        );
        let reloaded: TeamCommandJournal = serde_json::from_value(persisted).unwrap();
        assert!(reloaded.is_malformed());
    }

    #[test]
    fn protocol_v1_driver_command_kind_literals_are_pinned() {
        const EXPECTED_DRIVER_COMMAND_KINDS: &[&str] = &[
            "require_workspace",
            "start_thread",
            "resume_or_start_thread",
            "run_template",
            "checkpoint_commit",
            "collect_diff",
            "merge_base",
            "commit",
            "pause_at_boundary",
            "settle_run",
        ];
        assert_eq!(DRIVER_COMMAND_KINDS, EXPECTED_DRIVER_COMMAND_KINDS);

        let empty_bindings =
            BoundedVec::<ArtifactBinding, MAX_COMMAND_BINDINGS>::new("bindings", Vec::new())
                .unwrap();
        let commands = vec![
            (
                DriverCommand::RequireWorkspace {},
                r#"{"kind":"require_workspace"}"#,
            ),
            (
                DriverCommand::StartThread {
                    role: DriverRole::Tl,
                },
                r#"{"kind":"start_thread","role":"tl"}"#,
            ),
            (
                DriverCommand::ResumeOrStartThread {
                    role: DriverRole::Dev,
                    candidates: BoundedVec::new(
                        "candidates",
                        vec![ThreadHandle::new("thread-command-1").unwrap()],
                    )
                    .unwrap(),
                },
                r#"{"kind":"resume_or_start_thread","role":"dev","candidates":["thread-command-1"]}"#,
            ),
            (
                DriverCommand::RunTemplate {
                    thread: ThreadHandle::new("thread-command-2").unwrap(),
                    role: DriverRole::Reviewer,
                    template_id: token("review.template"),
                    bindings: empty_bindings.clone(),
                },
                r#"{"kind":"run_template","thread":"thread-command-2","role":"reviewer","template_id":"review.template","bindings":[]}"#,
            ),
            (
                DriverCommand::CheckpointCommit {},
                r#"{"kind":"checkpoint_commit"}"#,
            ),
            (
                DriverCommand::CollectDiff {
                    scope: DiffScope::CurrentSubTask,
                },
                r#"{"kind":"collect_diff","scope":"current_sub_task"}"#,
            ),
            (
                DriverCommand::MergeBase {
                    target: MergeBaseTarget::PinnedTarget,
                },
                r#"{"kind":"merge_base","target":"pinned_target"}"#,
            ),
            (
                DriverCommand::Commit {
                    message_template_id: token("commit.message"),
                    bindings: empty_bindings,
                },
                r#"{"kind":"commit","message_template_id":"commit.message","bindings":[]}"#,
            ),
            (
                DriverCommand::PauseAtBoundary {},
                r#"{"kind":"pause_at_boundary"}"#,
            ),
            (
                DriverCommand::SettleRun {
                    status: DriverRunStatus::Done,
                },
                r#"{"kind":"settle_run","status":"done"}"#,
            ),
        ];

        let mut covered_kinds = Vec::new();
        for (command, fixture) in commands {
            let expected_kind = match &command {
                DriverCommand::RequireWorkspace {} => "require_workspace",
                DriverCommand::StartThread { .. } => "start_thread",
                DriverCommand::ResumeOrStartThread { .. } => "resume_or_start_thread",
                DriverCommand::RunTemplate { .. } => "run_template",
                DriverCommand::CheckpointCommit {} => "checkpoint_commit",
                DriverCommand::CollectDiff { .. } => "collect_diff",
                DriverCommand::MergeBase { .. } => "merge_base",
                DriverCommand::Commit { .. } => "commit",
                DriverCommand::PauseAtBoundary {} => "pause_at_boundary",
                DriverCommand::SettleRun { .. } => "settle_run",
            };
            let encoded = serde_json::to_string(&command).expect("serialize command");
            assert_eq!(encoded, fixture);
            let fixture_value: serde_json::Value =
                serde_json::from_str(fixture).expect("decode command fixture value");
            assert_eq!(
                fixture_value.get("kind").and_then(|value| value.as_str()),
                Some(expected_kind)
            );
            covered_kinds.push(expected_kind);
            let decoded: DriverCommand =
                serde_json::from_str(fixture).expect("decode command fixture");
            assert_eq!(decoded, command);
        }
        assert_eq!(covered_kinds.as_slice(), EXPECTED_DRIVER_COMMAND_KINDS);
    }

    #[test]
    fn protocol_v1_driver_event_kind_literals_are_pinned() {
        const EXPECTED_DRIVER_EVENT_KINDS: &[&str] = &[
            "command_accepted",
            "command_rejected",
            "workspace_ready",
            "thread_ready",
            "turn_finished",
            "diff_collected",
            "merge_base_resolved",
            "commit_recorded",
            "cursor_advanced",
            "run_settled",
        ];
        assert_eq!(DRIVER_EVENT_KINDS, EXPECTED_DRIVER_EVENT_KINDS);

        let cursor = DriverCursor {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            backend: OrchestrationBackendKind::Cloud,
            status: DriverRunStatus::Running,
            phase: DriverPhase::SubTasks,
            state_revision: 3,
            last_command_seq: 2,
            last_event_seq: 1,
            in_flight_command_id: None,
            current_sub_task_index: 0,
            sub_task_count: 1,
            current_rounds_used: 0,
            max_review_rounds: 2,
            design_review_rounds: 0,
            mr_rounds_used: 0,
            tl_generation: 1,
            pause_requested: false,
            awaiting_user: false,
            artifacts: BoundedVec::new("artifacts", Vec::new()).unwrap(),
        };
        let transcript = artifact("artifact.transcript.event", ArtifactKind::TranscriptDigest);
        let diff = artifact("artifact.diff.event", ArtifactKind::WorkspaceDiff);
        let report = artifact("artifact.report.event", ArtifactKind::Report);
        let events = vec![
            (
                DriverEvent::CommandAccepted {},
                r#"{"kind":"command_accepted"}"#,
            ),
            (
                DriverEvent::CommandRejected {
                    reason: CommandRejection::StaleCommand,
                },
                r#"{"kind":"command_rejected","reason":"stale_command"}"#,
            ),
            (
                DriverEvent::WorkspaceReady {},
                r#"{"kind":"workspace_ready"}"#,
            ),
            (
                DriverEvent::ThreadReady {
                    thread: ThreadHandle::new("thread-event-1").unwrap(),
                    role: DriverRole::Dev,
                },
                r#"{"kind":"thread_ready","thread":"thread-event-1","role":"dev"}"#,
            ),
            (
                DriverEvent::TurnFinished {
                    outcome: TurnOutcomeKind::Replied,
                    artifact: Some(transcript),
                },
                r#"{"kind":"turn_finished","outcome":"replied","artifact":{"artifact_id":"artifact.transcript.event","kind":"transcript_digest","revision":7,"size_bytes":42}}"#,
            ),
            (
                DriverEvent::DiffCollected {
                    changed: true,
                    artifact: diff,
                },
                r#"{"kind":"diff_collected","changed":true,"artifact":{"artifact_id":"artifact.diff.event","kind":"workspace_diff","revision":7,"size_bytes":42}}"#,
            ),
            (
                DriverEvent::MergeBaseResolved {
                    available: false,
                    artifact: None,
                },
                r#"{"kind":"merge_base_resolved","available":false,"artifact":null}"#,
            ),
            (
                DriverEvent::CommitRecorded {
                    changed: true,
                    artifact: Some(report),
                },
                r#"{"kind":"commit_recorded","changed":true,"artifact":{"artifact_id":"artifact.report.event","kind":"report","revision":7,"size_bytes":42}}"#,
            ),
            (
                DriverEvent::CursorAdvanced {
                    cursor: cursor.clone(),
                },
                r#"{"kind":"cursor_advanced","cursor":{"protocol_version":1,"backend":"cloud","status":"running","phase":"sub_tasks","state_revision":3,"last_command_seq":2,"last_event_seq":1,"current_sub_task_index":0,"sub_task_count":1,"current_rounds_used":0,"max_review_rounds":2,"design_review_rounds":0,"mr_rounds_used":0,"tl_generation":1,"pause_requested":false,"awaiting_user":false,"artifacts":[]}}"#,
            ),
            (
                DriverEvent::RunSettled {
                    status: DriverRunStatus::Cancelled,
                },
                r#"{"kind":"run_settled","status":"cancelled"}"#,
            ),
        ];

        let mut covered_kinds = Vec::new();
        for (event, fixture) in events {
            let expected_kind = match &event {
                DriverEvent::CommandAccepted {} => "command_accepted",
                DriverEvent::CommandRejected { .. } => "command_rejected",
                DriverEvent::WorkspaceReady {} => "workspace_ready",
                DriverEvent::ThreadReady { .. } => "thread_ready",
                DriverEvent::TurnFinished { .. } => "turn_finished",
                DriverEvent::DiffCollected { .. } => "diff_collected",
                DriverEvent::MergeBaseResolved { .. } => "merge_base_resolved",
                DriverEvent::CommitRecorded { .. } => "commit_recorded",
                DriverEvent::CursorAdvanced { .. } => "cursor_advanced",
                DriverEvent::RunSettled { .. } => "run_settled",
            };
            let encoded = serde_json::to_string(&event).expect("serialize event");
            assert_eq!(encoded, fixture);
            let fixture_value: serde_json::Value =
                serde_json::from_str(fixture).expect("decode event fixture value");
            assert_eq!(
                fixture_value.get("kind").and_then(|value| value.as_str()),
                Some(expected_kind)
            );
            covered_kinds.push(expected_kind);
            let decoded: DriverEvent = serde_json::from_str(fixture).expect("decode event fixture");
            assert_eq!(decoded, event);
        }
        assert_eq!(covered_kinds.as_slice(), EXPECTED_DRIVER_EVENT_KINDS);
    }

    #[test]
    fn command_and_event_round_trip() {
        let binding = binding(
            ArtifactBindingSlot::Plan,
            "artifact.plan.1",
            ArtifactKind::Plan,
        );
        let command = DriverCommandEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            command_id: CommandId::new("cmd-1").unwrap(),
            sequence: 11,
            expected_revision: 9,
            command: DriverCommand::RunTemplate {
                thread: ThreadHandle::new("thread-1").unwrap(),
                role: DriverRole::Tl,
                template_id: token("tl.plan"),
                bindings: BoundedVec::new("bindings", vec![binding.clone()]).unwrap(),
            },
        };
        let encoded = serde_json::to_string(&command).expect("serialize command");
        let decoded: DriverCommandEnvelope =
            serde_json::from_str(&encoded).expect("deserialize command");
        assert_eq!(decoded, command);

        let event = DriverEventEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            event_id: EventId::new("event-1").unwrap(),
            sequence: 12,
            command_id: command.command_id.clone(),
            observed_revision: 10,
            event: DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Replied,
                artifact: Some(binding.artifact),
            },
        };
        let encoded = serde_json::to_string(&event).expect("serialize event");
        let decoded: DriverEventEnvelope =
            serde_json::from_str(&encoded).expect("deserialize event");
        assert_eq!(decoded, event);
    }

    #[test]
    fn all_command_and_event_variants_round_trip() {
        let bindings = BoundedVec::new(
            "bindings",
            vec![binding(
                ArtifactBindingSlot::Plan,
                "artifact.plan.1",
                ArtifactKind::Plan,
            )],
        )
        .unwrap();
        let commands = vec![
            DriverCommand::RequireWorkspace {},
            DriverCommand::StartThread {
                role: DriverRole::Tl,
            },
            DriverCommand::ResumeOrStartThread {
                role: DriverRole::Dev,
                candidates: BoundedVec::new(
                    "candidates",
                    vec![ThreadHandle::new("thread-1").unwrap()],
                )
                .unwrap(),
            },
            DriverCommand::RunTemplate {
                thread: ThreadHandle::new("thread-2").unwrap(),
                role: DriverRole::Reviewer,
                template_id: token("review.template"),
                bindings: bindings.clone(),
            },
            DriverCommand::CheckpointCommit {},
            DriverCommand::CollectDiff {
                scope: DiffScope::Head,
            },
            DriverCommand::MergeBase {
                target: MergeBaseTarget::PinnedTarget,
            },
            DriverCommand::Commit {
                message_template_id: token("commit.message"),
                bindings,
            },
            DriverCommand::PauseAtBoundary {},
            DriverCommand::SettleRun {
                status: DriverRunStatus::Cancelled,
            },
        ];
        for (index, command) in commands.into_iter().enumerate() {
            let envelope = command_envelope(command, index as u64 + 1);
            let encoded = serde_json::to_string(&envelope).expect("serialize command");
            let decoded: DriverCommandEnvelope =
                serde_json::from_str(&encoded).expect("deserialize command");
            assert_eq!(decoded, envelope);
        }

        let cursor = DriverCursor {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            backend: OrchestrationBackendKind::Cloud,
            status: DriverRunStatus::Running,
            phase: DriverPhase::SubTasks,
            state_revision: 9,
            last_command_seq: 8,
            last_event_seq: 7,
            in_flight_command_id: Some(CommandId::new("cmd-8").unwrap()),
            current_sub_task_index: 1,
            sub_task_count: 3,
            current_rounds_used: 1,
            max_review_rounds: 2,
            design_review_rounds: 1,
            mr_rounds_used: 0,
            tl_generation: 2,
            pause_requested: false,
            awaiting_user: true,
            artifacts: BoundedVec::new(
                "artifacts",
                vec![artifact("artifact.cursor.1", ArtifactKind::Plan)],
            )
            .unwrap(),
        };
        let events = vec![
            DriverEvent::CommandAccepted {},
            DriverEvent::CommandRejected {
                reason: CommandRejection::UnknownRevision,
            },
            DriverEvent::WorkspaceReady {},
            DriverEvent::ThreadReady {
                thread: ThreadHandle::new("thread-3").unwrap(),
                role: DriverRole::Dev,
            },
            DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Blocked,
                artifact: None,
            },
            DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Replied,
                artifact: Some(artifact("artifact.turn.1", ArtifactKind::TranscriptDigest)),
            },
            DriverEvent::DiffCollected {
                changed: false,
                artifact: artifact("artifact.diff.1", ArtifactKind::WorkspaceDiff),
            },
            DriverEvent::MergeBaseResolved {
                available: false,
                artifact: None,
            },
            DriverEvent::CommitRecorded {
                changed: true,
                artifact: Some(artifact("artifact.report.1", ArtifactKind::Report)),
            },
            DriverEvent::CursorAdvanced { cursor },
            DriverEvent::RunSettled {
                status: DriverRunStatus::Failed,
            },
        ];
        for (index, event) in events.into_iter().enumerate() {
            let envelope = event_envelope(event, index as u64 + 1);
            let encoded = serde_json::to_string(&envelope).expect("serialize event");
            let decoded: DriverEventEnvelope =
                serde_json::from_str(&encoded).expect("deserialize event");
            assert_eq!(decoded, envelope);
        }
    }

    #[test]
    fn protocol_negotiation_selects_highest_overlap() {
        let selected = negotiate_protocol(
            ProtocolRange::new(1, 1).unwrap(),
            ProtocolRange::new(1, 4).unwrap(),
        )
        .expect("overlap");
        assert_eq!(selected.selected_version, CURRENT_PROTOCOL_VERSION);

        let clipped = negotiate_protocol(
            ProtocolRange::new(1, 3).unwrap(),
            ProtocolRange::new(1, 3).unwrap(),
        )
        .expect("overlap clipped to this crate's supported protocol");
        assert_eq!(clipped.selected_version, CURRENT_PROTOCOL_VERSION);

        let refused = negotiate_protocol(
            ProtocolRange::new(1, 1).unwrap(),
            ProtocolRange::new(2, 2).unwrap(),
        );
        assert!(matches!(
            refused,
            Err(ProtocolValueError::NoCompatibleProtocol { .. })
        ));

        let refused_future_local = negotiate_protocol(
            ProtocolRange::new(2, 3).unwrap(),
            ProtocolRange::new(2, 3).unwrap(),
        );
        assert_eq!(
            refused_future_local,
            Err(ProtocolValueError::UnsupportedLocalProtocolRange {
                requested_min: 2,
                requested_max: 3,
                supported_min: 1,
                supported_max: 1,
            })
        );
        assert_eq!(
            refused_future_local.unwrap_err().to_string(),
            "requested local protocol range 2-3 is outside this build's supported range 1-1"
        );

        let invalid: Result<ProtocolRange, _> = serde_json::from_str(r#"{"min":3,"max":2}"#);
        assert!(invalid.is_err(), "invalid ranges must fail during decode");
    }

    #[test]
    fn bounded_tokens_reject_paths_urls_and_over_limit_values() {
        assert!(ThreadHandle::new("/tmp/repo").is_err());
        assert!(ThreadHandle::new("https://example.test/run").is_err());
        assert!(ThreadHandle::new("shell echo hi").is_err());
        assert!(matches!(
            ArtifactId::new(".."),
            Err(ProtocolValueError::InvalidTokenShape {
                field: "artifact_id"
            })
        ));
        assert!(matches!(
            ArtifactId::new(".artifact"),
            Err(ProtocolValueError::InvalidTokenShape {
                field: "artifact_id"
            })
        ));
        assert!(matches!(
            ArtifactId::new("artifact..one"),
            Err(ProtocolValueError::InvalidTokenShape {
                field: "artifact_id"
            })
        ));
        assert!(ArtifactId::new("artifact.plan.1").is_ok());
        let too_long = "x".repeat(MAX_OPAQUE_ID_LEN + 1);
        assert!(CommandId::new(too_long).is_err());

        let path_like_artifact: Result<ArtifactRef, _> =
            serde_json::from_str(r#"{"artifact_id":"..","kind":"plan","revision":1}"#);
        assert!(
            path_like_artifact.is_err(),
            "path-shaped artifact ids must fail decode"
        );
    }

    #[test]
    fn bounded_collections_reject_over_limit_payloads() {
        let mut refs = Vec::new();
        for index in 0..=MAX_CURSOR_ARTIFACTS {
            refs.push(artifact(
                &format!("artifact-{index}"),
                ArtifactKind::WorkspaceDiff,
            ));
        }
        let result = BoundedVec::<ArtifactRef, MAX_CURSOR_ARTIFACTS>::new("artifacts", refs);
        assert!(matches!(
            result,
            Err(ProtocolValueError::TooManyItems { .. })
        ));

        let json = format!(
            r#"{{
                "protocol_version":1,
                "command_id":"cmd-1",
                "sequence":1,
                "expected_revision":1,
                "command":{{
                    "kind":"resume_or_start_thread",
                    "role":"dev",
                    "candidates":[{}]
                }}
            }}"#,
            (0..=MAX_CANDIDATE_THREADS)
                .map(|index| format!("\"thread-{index}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        let decoded: Result<DriverCommandEnvelope, _> = serde_json::from_str(&json);
        assert!(
            decoded.is_err(),
            "oversized candidate lists must fail closed"
        );
    }

    #[test]
    fn command_decode_rejects_unknown_payload_without_reading_value() {
        let command_with_invalid_payload = r#"{
            "protocol_version":1,
            "command_id":"cmd-1",
            "sequence":1,
            "expected_revision":1,
            "command":{"kind":"require_workspace","payload":@@@}
        }"#;
        let err = serde_json::from_str::<DriverCommandEnvelope>(command_with_invalid_payload)
            .expect_err("unknown command fields must fail before payload decode")
            .to_string();
        assert!(
            err.contains("unknown field `payload`"),
            "unexpected command decode error: {err}"
        );

        let command_with_wrong_field = r#"{
            "protocol_version":1,
            "command_id":"cmd-1",
            "sequence":1,
            "expected_revision":1,
            "command":{"kind":"require_workspace","bindings":@@@}
        }"#;
        let err = serde_json::from_str::<DriverCommandEnvelope>(command_with_wrong_field)
            .expect_err("wrong command fields must fail before payload decode")
            .to_string();
        assert!(
            err.contains("field bindings is not valid for require_workspace command"),
            "unexpected command field decode error: {err}"
        );

        let event_with_invalid_payload = r#"{
            "protocol_version":1,
            "event_id":"event-1",
            "sequence":1,
            "command_id":"cmd-1",
            "observed_revision":1,
            "event":{"kind":"command_accepted","log":@@@}
        }"#;
        let err = serde_json::from_str::<DriverEventEnvelope>(event_with_invalid_payload)
            .expect_err("unknown event fields must fail before payload decode")
            .to_string();
        assert!(
            err.contains("unknown field `log`"),
            "unexpected event decode error: {err}"
        );

        let event_with_wrong_field = r#"{
            "protocol_version":1,
            "event_id":"event-1",
            "sequence":1,
            "command_id":"cmd-1",
            "observed_revision":1,
            "event":{"kind":"command_accepted","cursor":@@@}
        }"#;
        let err = serde_json::from_str::<DriverEventEnvelope>(event_with_wrong_field)
            .expect_err("wrong event fields must fail before payload decode")
            .to_string();
        assert!(
            err.contains("field cursor is not valid for command_accepted event"),
            "unexpected event field decode error: {err}"
        );
    }

    #[test]
    fn bounded_collections_stop_before_decoding_over_limit_item() {
        let mut candidates = (0..MAX_CANDIDATE_THREADS)
            .map(|index| format!("\"thread-{index}\""))
            .collect::<Vec<_>>();
        candidates.push(r#""/tmp/secret""#.to_string());
        let json = format!(
            r#"{{
                "protocol_version":1,
                "command_id":"cmd-1",
                "sequence":1,
                "expected_revision":1,
                "command":{{
                    "kind":"resume_or_start_thread",
                    "role":"dev",
                    "candidates":[{}]
                }}
            }}"#,
            candidates.join(",")
        );
        let err = serde_json::from_str::<DriverCommandEnvelope>(&json)
            .expect_err("over-limit candidates must fail")
            .to_string();
        assert!(
            err.contains("too many items"),
            "expected collection bound error, got {err}"
        );
        assert!(
            !err.contains("invalid character"),
            "over-limit candidate item should not be decoded as a thread handle: {err}"
        );

        let too_long = "x".repeat(MAX_OPAQUE_ID_LEN + 1);
        let json = format!(
            r#"{{
                "protocol_version":1,
                "command_id":"cmd-1",
                "sequence":1,
                "expected_revision":1,
                "command":{{
                    "kind":"resume_or_start_thread",
                    "role":"dev",
                    "candidates":["{too_long}"]
                }}
            }}"#
        );
        let err = serde_json::from_str::<DriverCommandEnvelope>(&json)
            .expect_err("over-limit thread handles must fail")
            .to_string();
        assert!(
            err.contains("thread_handle is too long"),
            "unexpected token bound error: {err}"
        );
    }

    #[test]
    fn cloud_visible_json_shape_is_structurally_allowlisted() {
        let task_spec = artifact("artifact.task.1", ArtifactKind::TaskSpec);
        let plan = artifact("artifact.plan.1", ArtifactKind::Plan);
        let design = artifact("artifact.design.1", ArtifactKind::Design);
        let report = artifact("artifact.report.1", ArtifactKind::Report);
        let sub_task = artifact("artifact.subtask.1", ArtifactKind::SubTaskBrief);
        let diff = artifact("artifact.diff.1", ArtifactKind::WorkspaceDiff);
        let verdict = artifact("artifact.verdict.1", ArtifactKind::ReviewVerdict);
        let transcript = artifact("artifact.transcript.1", ArtifactKind::TranscriptDigest);

        let cursor = DriverCursor {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            backend: OrchestrationBackendKind::Cloud,
            status: DriverRunStatus::Running,
            phase: DriverPhase::SubTasks,
            state_revision: 9,
            last_command_seq: 8,
            last_event_seq: 7,
            in_flight_command_id: Some(CommandId::new("cmd-8").unwrap()),
            current_sub_task_index: 1,
            sub_task_count: 3,
            current_rounds_used: 1,
            max_review_rounds: 2,
            design_review_rounds: 1,
            mr_rounds_used: 0,
            tl_generation: 2,
            pause_requested: false,
            awaiting_user: false,
            artifacts: BoundedVec::new(
                "artifacts",
                vec![
                    task_spec,
                    plan.clone(),
                    design,
                    report.clone(),
                    sub_task,
                    diff.clone(),
                    verdict,
                    transcript.clone(),
                ],
            )
            .unwrap(),
        };

        let bindings = BoundedVec::new(
            "bindings",
            vec![
                binding(
                    ArtifactBindingSlot::TaskSpec,
                    "artifact.task.2",
                    ArtifactKind::TaskSpec,
                ),
                binding(
                    ArtifactBindingSlot::Plan,
                    "artifact.plan.2",
                    ArtifactKind::Plan,
                ),
                binding(
                    ArtifactBindingSlot::Design,
                    "artifact.design.2",
                    ArtifactKind::Design,
                ),
                binding(
                    ArtifactBindingSlot::Report,
                    "artifact.report.2",
                    ArtifactKind::Report,
                ),
                binding(
                    ArtifactBindingSlot::SubTaskBrief,
                    "artifact.subtask.2",
                    ArtifactKind::SubTaskBrief,
                ),
                binding(
                    ArtifactBindingSlot::Diff,
                    "artifact.diff.2",
                    ArtifactKind::WorkspaceDiff,
                ),
                binding(
                    ArtifactBindingSlot::Verdict,
                    "artifact.verdict.2",
                    ArtifactKind::ReviewVerdict,
                ),
                binding(
                    ArtifactBindingSlot::PriorSummary,
                    "artifact.summary.2",
                    ArtifactKind::TranscriptDigest,
                ),
            ],
        )
        .unwrap();

        let mut samples = vec![
            serde_json::to_value(OrchestrationBackendRef::LegacyEmbedded).unwrap(),
            serde_json::to_value(OrchestrationBackendRef::Cloud {
                protocol_version: SupportedProtocolVersion::current(),
                driver_version: DriverVersion::new("driver.1").unwrap(),
                cloud_run_id: DriverRunId::new("cloud-run-1").unwrap(),
            })
            .unwrap(),
            serde_json::to_value(OrchestrationBackendRef::LocalSidecar {
                protocol_version: SupportedProtocolVersion::current(),
                driver_version: DriverVersion::new("driver.1").unwrap(),
            })
            .unwrap(),
            serde_json::to_value(OrchestrationBackendRef::UnknownNonExecuting {
                original_kind: Some(UnknownBackendKind::new("cloud_v99").unwrap()),
                protocol_version: Some(99),
                driver_version: Some(DriverVersion::new("driver.1").unwrap()),
                cloud_run_id: Some(DriverRunId::new("cloud-run-1").unwrap()),
            })
            .unwrap(),
            serde_json::to_value(ProtocolHello {
                supported: ProtocolRange::current(),
                driver_version: DriverVersion::new("driver.1").unwrap(),
                backend: OrchestrationBackendKind::Cloud,
            })
            .unwrap(),
            serde_json::to_value(ProtocolNegotiation {
                selected_version: CURRENT_PROTOCOL_VERSION,
            })
            .unwrap(),
            serde_json::to_value(cursor.clone()).unwrap(),
        ];

        for (index, command) in [
            DriverCommand::RequireWorkspace {},
            DriverCommand::StartThread {
                role: DriverRole::Tl,
            },
            DriverCommand::ResumeOrStartThread {
                role: DriverRole::Dev,
                candidates: BoundedVec::new(
                    "candidates",
                    vec![ThreadHandle::new("thread-1").unwrap()],
                )
                .unwrap(),
            },
            DriverCommand::RunTemplate {
                thread: ThreadHandle::new("thread-2").unwrap(),
                role: DriverRole::Reviewer,
                template_id: token("review.template"),
                bindings: bindings.clone(),
            },
            DriverCommand::CheckpointCommit {},
            DriverCommand::CollectDiff {
                scope: DiffScope::CurrentSubTask,
            },
            DriverCommand::MergeBase {
                target: MergeBaseTarget::PinnedTarget,
            },
            DriverCommand::Commit {
                message_template_id: token("message.commit"),
                bindings: bindings.clone(),
            },
            DriverCommand::PauseAtBoundary {},
            DriverCommand::SettleRun {
                status: DriverRunStatus::Done,
            },
        ]
        .into_iter()
        .enumerate()
        {
            samples
                .push(serde_json::to_value(command_envelope(command, index as u64 + 1)).unwrap());
        }

        for (index, event) in [
            DriverEvent::CommandAccepted {},
            DriverEvent::CommandRejected {
                reason: CommandRejection::InvalidState,
            },
            DriverEvent::WorkspaceReady {},
            DriverEvent::ThreadReady {
                thread: ThreadHandle::new("thread-3").unwrap(),
                role: DriverRole::Dev,
            },
            DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Replied,
                artifact: Some(transcript),
            },
            DriverEvent::DiffCollected {
                changed: true,
                artifact: diff,
            },
            DriverEvent::MergeBaseResolved {
                available: true,
                artifact: Some(plan),
            },
            DriverEvent::CommitRecorded {
                changed: true,
                artifact: Some(report),
            },
            DriverEvent::CursorAdvanced { cursor },
            DriverEvent::RunSettled {
                status: DriverRunStatus::Done,
            },
        ]
        .into_iter()
        .enumerate()
        {
            samples.push(serde_json::to_value(event_envelope(event, index as u64 + 1)).unwrap());
        }

        for (index, outcome) in [
            TeamCommandOutcome::Applied,
            TeamCommandOutcome::Rejected {
                reason: CommandRejection::StaleCommand,
            },
            TeamCommandOutcome::Interrupted,
        ]
        .into_iter()
        .enumerate()
        {
            samples.push(
                serde_json::to_value(TeamCommandRecord {
                    command_id: CommandId::new(format!("team-cmd-{index}")).unwrap(),
                    sequence: index as u64 + 1,
                    kind: TeamCommandKind::RecordIntake,
                    fingerprint: Some(CommandFingerprint::from_digest([index as u8; 32])),
                    expected_revision: 0,
                    state_revision: index as u64,
                    last_event_seq: index as u64,
                    outcome,
                })
                .unwrap(),
            );
        }
        // The typed in-flight marker is durable and Cloud-visible too, so it
        // walks the same allowlist as the record it becomes on restore.
        samples.push(
            serde_json::to_value(InFlightCommand {
                command_id: CommandId::new("team-cmd-in-flight").unwrap(),
                fingerprint: CommandFingerprint::from_digest([3u8; 32]),
                kind: TeamCommandKind::SetPhase,
                sequence: 7,
                expected_revision: 6,
                state_revision: 6,
                last_event_seq: 5,
            })
            .unwrap(),
        );
        // The recovery-record shape: `fingerprint: None` (D10) serializes as a
        // bare `null`, which the walk already allows unconditionally.
        samples.push(
            serde_json::to_value(TeamCommandRecord {
                command_id: CommandId::new("team-cmd-recovered").unwrap(),
                sequence: 1,
                kind: TeamCommandKind::Unknown,
                fingerprint: None,
                expected_revision: 0,
                state_revision: 0,
                last_event_seq: 0,
                outcome: TeamCommandOutcome::Interrupted,
            })
            .unwrap(),
        );

        for value in samples {
            assert_cloud_visible_json_is_allowlisted(&value);
        }
    }

    #[test]
    fn driver_roles_use_exact_protocol_v1_wire_values() {
        for (role, wire) in [
            (DriverRole::Tl, "tl"),
            (DriverRole::Dev, "dev"),
            (DriverRole::Reviewer, "reviewer"),
        ] {
            let encoded = serde_json::to_string(&role).expect("serialize role");
            assert_eq!(encoded, format!("\"{wire}\""));
            let decoded: DriverRole =
                serde_json::from_str(&encoded).expect("deserialize exact role");
            assert_eq!(decoded, role);
        }

        for alias in ["team_lead", "review", "t_l"] {
            assert!(
                serde_json::from_str::<DriverRole>(&format!("\"{alias}\"")).is_err(),
                "{alias} must not be accepted as a protocol-v1 role"
            );
        }
    }

    #[test]
    fn persisted_backend_refs_use_exact_wire_shapes() {
        let cases = [
            (
                OrchestrationBackendRef::LegacyEmbedded,
                r#"{"kind":"legacy_embedded"}"#,
            ),
            (
                OrchestrationBackendRef::Cloud {
                    protocol_version: SupportedProtocolVersion::current(),
                    driver_version: DriverVersion::new("driver.1").unwrap(),
                    cloud_run_id: DriverRunId::new("cloud-run-1").unwrap(),
                },
                r#"{"kind":"cloud","protocol_version":1,"driver_version":"driver.1","cloud_run_id":"cloud-run-1"}"#,
            ),
            (
                OrchestrationBackendRef::LocalSidecar {
                    protocol_version: SupportedProtocolVersion::current(),
                    driver_version: DriverVersion::new("driver.1").unwrap(),
                },
                r#"{"kind":"local_sidecar","protocol_version":1,"driver_version":"driver.1"}"#,
            ),
            (
                OrchestrationBackendRef::UnknownNonExecuting {
                    original_kind: Some(UnknownBackendKind::new("cloud_v99").unwrap()),
                    protocol_version: Some(99),
                    driver_version: Some(DriverVersion::new("driver.99").unwrap()),
                    cloud_run_id: Some(DriverRunId::new("cloud-run-99").unwrap()),
                },
                r#"{"kind":"unknown_non_executing","original_kind":"cloud_v99","protocol_version":99,"driver_version":"driver.99","cloud_run_id":"cloud-run-99"}"#,
            ),
        ];

        for (backend, expected) in cases {
            let encoded = serde_json::to_string(&backend).expect("serialize backend ref");
            assert_eq!(encoded, expected);
            let decoded: OrchestrationBackendRef =
                serde_json::from_str(expected).expect("deserialize pinned backend ref");
            assert_eq!(decoded, backend);
        }

        assert_eq!(
            serde_json::to_string(&OrchestrationBackendRef::unknown_non_executing()).unwrap(),
            r#"{"kind":"unknown_non_executing"}"#
        );
    }

    #[test]
    fn persisted_backend_ref_degrades_future_or_malformed_shapes() {
        let extra_cloud: OrchestrationBackendRef = serde_json::from_str(
            r#"{
                "kind":"cloud",
                "protocol_version":1,
                "driver_version":"driver.1",
                "cloud_run_id":"cloud-run-1",
                "future_field":true
            }"#,
        )
        .expect("future cloud shape must not invalidate persisted state");
        assert_eq!(
            extra_cloud.kind(),
            OrchestrationBackendKind::UnknownNonExecuting
        );
        assert_eq!(extra_cloud.original_unknown_kind(), Some("cloud"));
        match &extra_cloud {
            OrchestrationBackendRef::UnknownNonExecuting {
                protocol_version: Some(1),
                driver_version: Some(driver_version),
                cloud_run_id: Some(cloud_run_id),
                ..
            } => {
                assert_eq!(driver_version.as_str(), "driver.1");
                assert_eq!(cloud_run_id.as_str(), "cloud-run-1");
            }
            other => panic!("known Cloud identity slots should survive: {other:?}"),
        }

        let bad_cloud_id: OrchestrationBackendRef = serde_json::from_str(
            r#"{
                "kind":"cloud",
                "protocol_version":1,
                "driver_version":"driver.1",
                "cloud_run_id":"https://example.test/run"
            }"#,
        )
        .expect("malformed cloud id must degrade without invalidating state");
        assert_eq!(
            bad_cloud_id.kind(),
            OrchestrationBackendKind::UnknownNonExecuting
        );
        assert_eq!(bad_cloud_id.original_unknown_kind(), Some("cloud"));

        let duplicate_cloud_field: OrchestrationBackendRef = serde_json::from_str(
            r#"{
                "kind":"cloud",
                "protocol_version":1,
                "driver_version":"driver.1",
                "cloud_run_id":"cloud-run-1",
                "cloud_run_id":"cloud-run-2"
            }"#,
        )
        .expect("duplicate backend fields must degrade without invalidating state");
        assert_eq!(
            duplicate_cloud_field.kind(),
            OrchestrationBackendKind::UnknownNonExecuting
        );
        assert_eq!(duplicate_cloud_field.original_unknown_kind(), Some("cloud"));

        for (wire, expected_kind, expected_version) in [
            (
                r#"{"kind":"cloud","protocol_version":2,"driver_version":"driver.2","cloud_run_id":"cloud-run-2"}"#,
                "cloud",
                2,
            ),
            (
                r#"{"kind":"local_sidecar","protocol_version":0,"driver_version":"driver.0"}"#,
                "local_sidecar",
                0,
            ),
        ] {
            let backend: OrchestrationBackendRef =
                serde_json::from_str(wire).expect("unsupported versions degrade");
            assert_eq!(
                backend.kind(),
                OrchestrationBackendKind::UnknownNonExecuting
            );
            assert_eq!(backend.original_unknown_kind(), Some(expected_kind));
            assert!(matches!(
                backend,
                OrchestrationBackendRef::UnknownNonExecuting {
                    protocol_version: Some(version),
                    ..
                } if version == expected_version
            ));
        }

        let extra_legacy: OrchestrationBackendRef =
            serde_json::from_str(r#"{"kind":"legacy_embedded","driver_version":"future"}"#)
                .expect("future legacy shape must not invalidate persisted state");
        assert_eq!(
            extra_legacy.kind(),
            OrchestrationBackendKind::UnknownNonExecuting
        );
        assert_eq!(
            extra_legacy.original_unknown_kind(),
            Some("legacy_embedded")
        );

        let missing_kind_backend: OrchestrationBackendRef =
            serde_json::from_str(r#"{}"#).expect("empty backend object must decode");
        assert_eq!(
            missing_kind_backend,
            OrchestrationBackendRef::unknown_non_executing()
        );

        let null_backend: OrchestrationBackendRef =
            serde_json::from_str(r#"null"#).expect("null backend must decode");
        assert_eq!(
            null_backend,
            OrchestrationBackendRef::unknown_non_executing()
        );

        let scalar_backend: OrchestrationBackendRef =
            serde_json::from_str(r#""cloud_v99""#).expect("scalar future backend must decode");
        assert_eq!(
            scalar_backend.kind(),
            OrchestrationBackendKind::UnknownNonExecuting
        );
        assert_eq!(scalar_backend.original_unknown_kind(), Some("cloud_v99"));

        let encoded = serde_json::to_string(&scalar_backend).expect("serialize unknown backend");
        assert!(
            encoded.contains(r#""original_kind":"cloud_v99""#),
            "unknown backend kind must survive one relay rewrite: {encoded}"
        );
        assert!(
            !encoded.contains("future_backend_id"),
            "unsupported future payload fields are intentionally not retained"
        );

        let future_object_backend: OrchestrationBackendRef = serde_json::from_str(
            r#"{
                "kind":"cloud_v99",
                "future_backend_id":"opaque-future-id",
                "future_protocol_version":99
            }"#,
        )
        .expect("future object backend must decode");
        assert_eq!(
            future_object_backend.kind(),
            OrchestrationBackendKind::UnknownNonExecuting
        );
        assert_eq!(
            future_object_backend.original_unknown_kind(),
            Some("cloud_v99")
        );
        let encoded =
            serde_json::to_string(&future_object_backend).expect("serialize future object backend");
        assert!(encoded.contains(r#""original_kind":"cloud_v99""#));
        assert!(
            !encoded.contains("future_backend_id")
                && !encoded.contains("future_protocol_version"),
            "unknown future backend payload fields must not become a generic persistence blob: {encoded}"
        );
    }

    #[test]
    fn persisted_driver_progress_keeps_valid_identity_and_drops_bad_shapes() {
        let future_shaped: DriverProgress = serde_json::from_str(
            r#"{
                "state_revision":42,
                "last_command_seq":7,
                "last_event_seq":6,
                "in_flight_command_id":"cmd-future",
                "future_progress_field":{"ignored":true}
            }"#,
        )
        .expect("valid progress plus future fields must decode");
        assert_eq!(future_shaped.state_revision, 42);
        assert_eq!(future_shaped.last_command_seq, 7);
        assert_eq!(future_shaped.last_event_seq, 6);
        assert_eq!(
            future_shaped
                .in_flight_command_id
                .as_ref()
                .map(|id| id.as_str()),
            Some("cmd-future")
        );
        assert!(
            future_shaped.is_malformed(),
            "a newer progress field must leave a durable fail-closed marker"
        );
        let future_persisted =
            serde_json::to_string(&future_shaped).expect("persist future-shaped progress marker");
        assert!(
            future_persisted.contains(r#""malformed":true"#),
            "{future_persisted}"
        );
        assert!(!future_persisted.contains("future_progress_field"));
        let future_restored: DriverProgress =
            serde_json::from_str(&future_persisted).expect("restore future-shaped progress marker");
        assert!(future_restored.is_malformed());

        let clean: DriverProgress = serde_json::from_str(
            r#"{
                "state_revision":42,
                "last_command_seq":7,
                "last_event_seq":6,
                "in_flight_command_id":"cmd-current"
            }"#,
        )
        .expect("known progress fields must decode");
        assert!(!clean.is_malformed());

        let malformed: DriverProgress = serde_json::from_str(
            r#"{
                "state_revision":"forty-two",
                "last_command_seq":-1,
                "last_event_seq":{"future":true},
                "in_flight_command_id":"https://example.test/cmd"
            }"#,
        )
        .expect("malformed progress must not invalidate persisted state");
        assert_eq!(malformed.state_revision, 0);
        assert_eq!(malformed.last_command_seq, 0);
        assert_eq!(malformed.last_event_seq, 0);
        assert!(malformed.in_flight_command_id.is_none());
        assert!(malformed.is_malformed());
        let persisted = serde_json::to_string(&malformed).expect("persist malformed marker");
        assert!(persisted.contains(r#""malformed":true"#), "{persisted}");
        let restored: DriverProgress =
            serde_json::from_str(&persisted).expect("restore malformed marker");
        assert!(restored.is_malformed());

        let whole_value_malformed: DriverProgress = serde_json::from_str(r#"["future-progress"]"#)
            .expect("future progress shape must not invalidate persisted state");
        assert!(whole_value_malformed.is_malformed());

        let null_progress: DriverProgress = serde_json::from_str("null")
            .expect("explicit null progress must not invalidate persisted state");
        assert!(null_progress.is_malformed());

        let float_counter: DriverProgress = serde_json::from_str(r#"{"state_revision":17.0}"#)
            .expect("float counter must not invalidate persisted state");
        assert!(float_counter.is_malformed());

        let mut run = TeamRun::new(
            "team-malformed-progress".to_string(),
            TaskSpec::default(),
            "/tmp/content-blind-test".to_string(),
            "device-1".to_string(),
        );
        run.driver_progress = float_counter;
        assert_eq!(
            DriverCursor::from_team_run(&run, Vec::new()),
            Err(ProtocolValueError::MalformedDriverProgress),
            "malformed persisted counters must never become an executable zero cursor"
        );

        run.driver_progress = DriverProgress::default();
        run.orchestration_backend = OrchestrationBackendRef::unknown_non_executing();
        assert_eq!(
            DriverCursor::from_team_run(&run, Vec::new()),
            Err(ProtocolValueError::UnknownBackend),
            "an inert backend must not produce an executable-looking cursor"
        );
        assert_eq!(
            ProtocolValueError::UnknownBackend.to_string(),
            "this build does not understand the orchestration backend"
        );

        run.driver_progress = DriverProgress::malformed();
        assert_eq!(
            DriverCursor::from_team_run(&run, Vec::new()),
            Err(ProtocolValueError::MalformedDriverProgress),
            "malformed progress remains the primary recovery diagnostic"
        );
    }

    #[test]
    fn commands_reject_unknown_variants_and_escape_hatch_fields() {
        let unknown_command = r#"{
            "protocol_version":1,
            "command_id":"cmd-1",
            "sequence":1,
            "expected_revision":1,
            "command":{"kind":"send_raw_prompt","template_id":"x"}
        }"#;
        assert!(serde_json::from_str::<DriverCommandEnvelope>(unknown_command).is_err());

        let command_bodies = [
            r#"{"kind":"require_workspace"}"#,
            r#"{"kind":"start_thread","role":"tl"}"#,
            r#"{"kind":"resume_or_start_thread","role":"dev","candidates":[]}"#,
            r#"{"kind":"run_template","thread":"thread-1","role":"tl","template_id":"tl.intake","bindings":[]}"#,
            r#"{"kind":"checkpoint_commit"}"#,
            r#"{"kind":"collect_diff","scope":"head"}"#,
            r#"{"kind":"merge_base","target":"pinned_target"}"#,
            r#"{"kind":"commit","message_template_id":"commit.message","bindings":[]}"#,
            r#"{"kind":"pause_at_boundary"}"#,
            r#"{"kind":"settle_run","status":"done"}"#,
        ];
        let forbidden_fields = [
            "task",
            "task_text",
            "user_prose",
            "repository_content",
            "cwd",
            "path",
            "prompt",
            "transcript",
            "diff_text",
            "finding",
            "findings",
            "log",
            "url",
            "shell_command",
            "payload",
            "blob",
            "message",
            "text",
        ];
        for body in command_bodies {
            let prefix = body.strip_suffix('}').expect("command object body");
            for forbidden in forbidden_fields {
                let command = format!("{prefix},\"{forbidden}\":\"CANARY\"}}");
                let raw = format!(
                    r#"{{
                    "protocol_version":1,
                    "command_id":"cmd-1",
                    "sequence":1,
                    "expected_revision":1,
                    "command":{command}
                }}"#
                );
                assert!(
                    serde_json::from_str::<DriverCommandEnvelope>(&raw).is_err(),
                    "{forbidden} must not be accepted on command body {body}"
                );
            }
        }
    }

    #[test]
    fn unknown_fields_on_cursor_and_events_fail_closed() {
        let cursor_with_path = r#"{
            "protocol_version":1,
            "backend":"cloud",
            "status":"running",
            "phase":"sub_tasks",
            "state_revision":1,
            "last_command_seq":1,
            "last_event_seq":1,
            "current_sub_task_index":0,
            "sub_task_count":1,
            "current_rounds_used":0,
            "max_review_rounds":2,
            "design_review_rounds":0,
            "mr_rounds_used":0,
            "tl_generation":1,
            "pause_requested":false,
            "awaiting_user":false,
            "artifacts":[],
            "cwd":"/tmp/repo"
        }"#;
        assert!(serde_json::from_str::<DriverCursor>(cursor_with_path).is_err());

        let event_with_log = r#"{
            "protocol_version":1,
            "event_id":"event-1",
            "sequence":1,
            "command_id":"cmd-1",
            "observed_revision":1,
            "event":{"kind":"command_rejected","reason":"invalid_state","log":"CANARY"}
        }"#;
        assert!(serde_json::from_str::<DriverEventEnvelope>(event_with_log).is_err());
    }

    #[test]
    fn wire_messages_reject_unsupported_protocol_versions() {
        let zero_version = r#"{
            "protocol_version":0,
            "command_id":"cmd-1",
            "sequence":1,
            "expected_revision":1,
            "command":{"kind":"require_workspace"}
        }"#;
        assert!(serde_json::from_str::<DriverCommandEnvelope>(zero_version).is_err());

        let future_version = format!(
            r#"{{
                "protocol_version":{},
                "event_id":"event-1",
                "sequence":1,
                "command_id":"cmd-1",
                "observed_revision":1,
                "event":{{"kind":"command_accepted"}}
            }}"#,
            CURRENT_PROTOCOL_VERSION + 1
        );
        assert!(serde_json::from_str::<DriverEventEnvelope>(&future_version).is_err());
    }

    #[test]
    fn driver_cursor_projection_excludes_sensitive_run_fields() {
        let mut run = TeamRun::new(
            "team-sensitive".to_string(),
            TaskSpec {
                title: "CANARY_TASK_TITLE".to_string(),
                context: "CANARY_CONTEXT_PROSE".to_string(),
                acceptance_criteria: "CANARY_ACCEPTANCE".to_string(),
                agreed_scope: "CANARY_SCOPE".to_string(),
                quality_rules: "CANARY_RULES".to_string(),
            },
            "/Users/example/private/repo/.sealwire/worktrees/canary".to_string(),
            "device-sensitive".to_string(),
        );
        run.status = crate::team::TeamRunStatus::AwaitingUser;
        run.phase = TeamPhase::SubTasks;
        run.tl_thread_id = "tl-sensitive".to_string();
        run.branch = "task/secret-branch".to_string();
        run.target_ref = "refs/heads/private-main".to_string();
        run.sub_tasks = vec![SubTask {
            id: "st-sensitive".to_string(),
            title: "CANARY_SUBTASK_TITLE".to_string(),
            brief: "CANARY_SUBTASK_BRIEF".to_string(),
            status: SubTaskStatus::Implementing,
            rounds_used: 1,
            result_summary: Some("CANARY_RESULT_SUMMARY".to_string()),
            error: Some("CANARY_SUBTASK_ERROR".to_string()),
            ..SubTask::default()
        }];
        run.unresolved = vec!["CANARY_FINDING_TEXT".to_string()];
        run.error = Some("CANARY_ERROR_LOG".to_string());
        run.awaiting = Some(AwaitingUser {
            thread_id: "dev-sensitive".to_string(),
            request_id: "ask-sensitive".to_string(),
            role: "dev".to_string(),
            asked_at: 1,
        });
        run.driver_progress.state_revision = 4;
        run.driver_progress.last_command_seq = 2;
        run.driver_progress.last_event_seq = 3;
        run.driver_progress.in_flight_command_id = Some(CommandId::new("cmd-2").unwrap());

        let cursor = DriverCursor::from_team_run(
            &run,
            vec![artifact("artifact.task.1", ArtifactKind::TaskSpec)],
        )
        .expect("cursor");
        let encoded = serde_json::to_string(&cursor).expect("serialize cursor");

        for canary in [
            "CANARY_TASK_TITLE",
            "CANARY_CONTEXT_PROSE",
            "CANARY_ACCEPTANCE",
            "CANARY_SCOPE",
            "CANARY_RULES",
            "/Users/example/private/repo",
            "tl-sensitive",
            "task/secret-branch",
            "private-main",
            "CANARY_SUBTASK_TITLE",
            "CANARY_SUBTASK_BRIEF",
            "CANARY_RESULT_SUMMARY",
            "CANARY_FINDING_TEXT",
            "CANARY_ERROR_LOG",
            "dev-sensitive",
            "ask-sensitive",
        ] {
            assert!(
                !encoded.contains(canary),
                "cursor leaked sensitive canary {canary}: {encoded}"
            );
        }
        assert!(encoded.contains("artifact.task.1"));
        assert!(encoded.contains("\"state_revision\":4"));
        assert!(encoded.contains("\"awaiting_user\":true"));
    }
}
