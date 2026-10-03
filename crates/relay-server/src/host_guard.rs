//! Host-header allowlist for the local surface.
//!
//! This is the defense against DNS rebinding specifically, and it is the only
//! one that works. After a rebind the browser still sends the attacker's
//! hostname — only the resolved IP changed — so `Origin` and `Host` are both
//! `evil.example` and agree with each other. `relay_http::request_origin`
//! *derives* the expected origin from `Host`, which means the same-origin
//! check in `authorize_csrf_protection` compares the attacker's origin against
//! itself and passes. Pinning the set of hostnames we answer to is what breaks
//! that, and it has to happen before routing.
//!
//! Scope, deliberately: this stops a *browser* being used as a confused
//! deputy. It does nothing about code already running as you — that process
//! can set any header it likes.

use std::net::IpAddr;

pub fn bind_host_from_env() -> Result<IpAddr, String> {
    // Refuse retired access settings so an upgrade cannot silently remove proxy authentication.
    for name in [
        "RELAY_API_TOKEN",
        "RELAY_ALLOW_INSECURE_NO_AUTH",
        "RELAY_ALLOWED_HOSTS",
    ] {
        if std::env::var_os(name).is_some() {
            return Err(format!("{name} is no longer supported; remove it and use Cloud or a self-hosted broker for remote access"));
        }
    }
    parse_bind_host(std::env::var("BIND_HOST").ok().as_deref())
}

pub fn parse_bind_host(value: Option<&str>) -> Result<IpAddr, String> {
    let host: IpAddr = value
        .unwrap_or("127.0.0.1")
        .parse()
        .map_err(|_| "BIND_HOST must be a loopback IP address".to_string())?;
    if !host.is_loopback() {
        return Err("relay-server only supports loopback BIND_HOST; use Cloud or a self-hosted broker for remote access".to_string());
    }
    Ok(host)
}

/// Which `Host` values this process will answer to.
#[derive(Clone, Debug)]
pub struct HostPolicy;

impl HostPolicy {
    pub fn loopback_only() -> Self {
        Self
    }

    /// `raw` is the `Host` header, or the request URI's authority when the
    /// protocol carries it there instead (HTTP/2 `:authority`).
    pub fn allows_host(&self, raw: Option<&str>) -> bool {
        // HTTP/1.1 requires Host and every browser sends it. Refusing the
        // ambiguous case keeps the allowlist from being bypassed by omission.
        let Some(raw) = raw else {
            return false;
        };
        let Some(host) = normalize_host(raw) else {
            return false;
        };

        host_is_loopback(&host)
    }
}

/// Loopback origins also need the CSRF header when their port differs from the relay.
pub(crate) fn authority_is_loopback(raw: &str) -> bool {
    normalize_host(raw).is_some_and(|host| host_is_loopback(&host))
}

/// Lowercase and strip the port, handling bracketed IPv6 authorities.
fn normalize_host(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }

    // `[::1]:8787` / `[::1]`
    if let Some(rest) = lowered.strip_prefix('[') {
        let (inside, _) = rest.split_once(']')?;
        return (!inside.is_empty()).then(|| inside.to_string());
    }

    let host = match lowered.split_once(':') {
        // `127.0.0.1:8787` — a single colon followed by digits is a port.
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        // A bare IPv6 literal (`::1`) has colons that are not a port.
        _ => lowered.as_str(),
    };

    (!host.is_empty()).then(|| host.to_string())
}

fn host_is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_host_strips_ports_and_ipv6_brackets() {
        assert_eq!(
            normalize_host("127.0.0.1:8787").as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(normalize_host("LocalHost").as_deref(), Some("localhost"));
        assert_eq!(normalize_host("[::1]:8787").as_deref(), Some("::1"));
        assert_eq!(normalize_host("[::1]").as_deref(), Some("::1"));
        // A bare IPv6 literal must not lose everything after its first colon.
        assert_eq!(normalize_host("::1").as_deref(), Some("::1"));
        assert_eq!(normalize_host("  ").as_deref(), None);
    }
}
