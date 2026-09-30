use std::cmp::Ordering;

pub const MIN_RELAY_VERSION_ENV: &str = "RELAY_BROKER_MIN_RELAY_VERSION";
pub const DEFAULT_MIN_RELAY_VERSION: &str = "0.11.3";
pub const UPDATE_INSTRUCTIONS: &str = "Update SealWire: npm users can run `npx sealwire@latest` or `npm install -g sealwire@latest`; desktop users should install the latest app release";

#[derive(Clone)]
pub struct MinRelayVersion {
    text: String,
    parts: [u32; 3],
}

impl MinRelayVersion {
    pub(crate) fn from_env() -> Self {
        let text = std::env::var(MIN_RELAY_VERSION_ENV)
            .unwrap_or_else(|_| DEFAULT_MIN_RELAY_VERSION.to_string());
        Self::parse(text).unwrap_or_else(|| {
            panic!("{MIN_RELAY_VERSION_ENV} must be a stable major.minor.patch version")
        })
    }

    pub fn parse(text: String) -> Option<Self> {
        let parts = parse_version(&text)?;
        Some(Self { text, parts })
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn check(&self, client_version: Option<&str>) -> Result<(), String> {
        let Some(version) = client_version.and_then(parse_version) else {
            return Err(format!(
                "relay client_version is missing or invalid; minimum supported SealWire version is {}. {UPDATE_INSTRUCTIONS}",
                self.text,
            ));
        };
        if version.cmp(&self.parts) == Ordering::Less {
            return Err(format!(
                "SealWire client {} is too old; minimum supported version is {}. {UPDATE_INSTRUCTIONS}",
                client_version.unwrap_or_default(),
                self.text,
            ));
        }
        Ok(())
    }
}

fn parse_version(text: &str) -> Option<[u32; 3]> {
    let mut parts = text.split('.');
    let mut parsed = [0; 3];
    for item in &mut parsed {
        let part = parts.next()?;
        if part.is_empty()
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *item = part.parse().ok()?;
    }
    parts.next().is_none().then_some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_all_three_version_components() {
        let minimum = MinRelayVersion {
            text: "0.12.3".to_string(),
            parts: [0, 12, 3],
        };
        assert!(minimum.check(Some("0.12.2")).is_err());
        assert!(minimum.check(Some("0.11.99")).is_err());
        assert!(minimum.check(Some("0.12.3")).is_ok());
        assert!(minimum.check(Some("0.13.0")).is_ok());
        assert!(minimum.check(None).is_err());
        assert!(minimum.check(Some("0.12.3-beta.1")).is_err());
    }
}
