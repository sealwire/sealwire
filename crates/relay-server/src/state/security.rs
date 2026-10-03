use crate::protocol::SecurityMode;

#[derive(Clone, Copy, Debug)]
pub(crate) struct SecurityProfile;

impl SecurityProfile {
    pub(crate) fn from_env() -> Result<Self, String> {
        if let Ok(value) = std::env::var("RELAY_SECURITY_MODE") {
            validate_security_mode(&value)?;
        }
        Ok(Self)
    }

    #[cfg(test)]
    pub(crate) fn private() -> Self {
        Self
    }

    pub(crate) fn mode(self) -> SecurityMode {
        SecurityMode::Private
    }

    pub(crate) fn e2ee_enabled(self) -> bool {
        true
    }

    pub(crate) fn broker_can_read_content(self) -> bool {
        false
    }

    pub(crate) fn audit_enabled(self) -> bool {
        false
    }

    pub(crate) fn summary(self) -> &'static str {
        "Remote connections are end-to-end encrypted; the broker cannot read content."
    }
}

fn validate_security_mode(value: &str) -> Result<(), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "private" => Ok(()),
        _ => Err("Only end-to-end encrypted remote connections are supported; remove RELAY_SECURITY_MODE or set it to private".to_string()),
    }
}

#[cfg(test)]
mod tests;
