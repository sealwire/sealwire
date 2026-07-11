//! IP blocklist for the broker.
//!
//! Enforcement mechanism only: the broker loads a set of banned IPs / CIDRs from
//! a Postgres `banned_ips` table and rejects matching connections. Deciding whom
//! to ban (auto-ban rules, an admin UI) is deliberately left to a private
//! operator plane — here we only provide the safely-callable "reject a banned
//! IP" primitive.
//!
//! Ban / unban is a plain SQL write, so a dynamic ban takes effect on the next
//! refresh without restarting the broker:
//!   INSERT INTO banned_ips (ip_or_cidr, reason) VALUES ('1.2.3.4', 'abuse');
//!   INSERT INTO banned_ips (ip_or_cidr, reason) VALUES ('10.0.0.0/8', 'range');
//!   DELETE FROM banned_ips WHERE ip_or_cidr = '1.2.3.4';

use std::net::IpAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use relay_util::trimmed_option_string;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tracing::{info, warn};

/// Postgres URL backing the blocklist. Point it at the same database as the
/// control plane. When unset, the blocklist is disabled (nothing is banned).
pub const BANNED_IPS_POSTGRES_URL_ENV: &str = "RELAY_BROKER_BANNED_IPS_POSTGRES_URL";

/// How often the broker reloads the blocklist from Postgres so manual bans take
/// effect without a restart.
const BLOCKLIST_REFRESH_SECS: u64 = 30;

/// A cheaply-cloneable handle to the current set of banned networks. Reads are
/// lock-guarded and happen on every inbound connection, so keep the set small.
#[derive(Clone)]
pub struct Blocklist {
    nets: Arc<RwLock<Vec<IpNet>>>,
}

impl Blocklist {
    /// A blocklist that never bans anything (feature disabled).
    pub fn disabled() -> Self {
        Self {
            nets: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Whether `ip` is covered by any banned address or CIDR range.
    pub fn is_banned(&self, ip: IpAddr) -> bool {
        let ip = normalize_ip(ip);
        self.nets
            .read()
            .expect("blocklist lock should not be poisoned")
            .iter()
            .any(|net| net.contains(&ip))
    }

    fn store(&self, nets: Vec<IpNet>) {
        *self
            .nets
            .write()
            .expect("blocklist lock should not be poisoned") = nets;
    }

    /// Build a blocklist directly from string entries (bare IP or CIDR), for
    /// tests that need a known set without a database.
    #[cfg(test)]
    pub(crate) fn from_entries(entries: &[&str]) -> Self {
        let blocklist = Self::disabled();
        blocklist.store(
            entries
                .iter()
                .filter_map(|entry| parse_ban_entry(entry))
                .collect(),
        );
        blocklist
    }

    /// Connect to Postgres, ensure the schema, load the current blocklist, and
    /// spawn a background task that refreshes it periodically. Must run inside a
    /// Tokio runtime.
    pub async fn connect(url: &str) -> Result<Self, String> {
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(url)
            .await
            .map_err(|error| {
                format!("failed to connect to {BANNED_IPS_POSTGRES_URL_ENV}: {error}")
            })?;
        initialize_banned_ips_schema(&pool).await?;

        let blocklist = Self::disabled();
        let (nets, skipped) = load_banned_nets(&pool).await?;
        info!(
            count = nets.len(),
            skipped, "broker ip blocklist loaded from postgres"
        );
        blocklist.store(nets);

        let refresh = blocklist.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(BLOCKLIST_REFRESH_SECS));
            ticker.tick().await; // first tick is immediate; we already loaded above
            loop {
                ticker.tick().await;
                match load_banned_nets(&pool).await {
                    Ok((nets, skipped)) => {
                        if skipped > 0 {
                            warn!(skipped, "broker ip blocklist has unparseable entries");
                        }
                        refresh.store(nets);
                    }
                    Err(error) => warn!(%error, "failed to refresh broker ip blocklist"),
                }
            }
        });

        Ok(blocklist)
    }

    /// Build from the environment: enabled when [`BANNED_IPS_POSTGRES_URL_ENV`]
    /// is set and reachable, otherwise disabled (fail-open — a blocklist outage
    /// must not take the broker down).
    pub async fn from_env() -> Self {
        match trimmed_option_string(std::env::var(BANNED_IPS_POSTGRES_URL_ENV).ok()) {
            Some(url) => match Self::connect(&url).await {
                Ok(blocklist) => blocklist,
                Err(error) => {
                    warn!(%error, "broker ip blocklist disabled (failed to initialize)");
                    Self::disabled()
                }
            },
            None => Self::disabled(),
        }
    }
}

/// Treat an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) as its underlying IPv4,
/// so a ban on the v4 address matches regardless of how the socket surfaced it.
fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

async fn initialize_banned_ips_schema(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS banned_ips (
            ip_or_cidr TEXT PRIMARY KEY,
            reason     TEXT,
            created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint)
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create banned_ips table: {error}"))?;
    Ok(())
}

async fn load_banned_nets(pool: &PgPool) -> Result<(Vec<IpNet>, usize), String> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT ip_or_cidr FROM banned_ips")
        .fetch_all(pool)
        .await
        .map_err(|error| format!("failed to load banned_ips: {error}"))?;
    let mut nets = Vec::with_capacity(rows.len());
    let mut skipped = 0usize;
    for (entry,) in rows {
        match parse_ban_entry(&entry) {
            Some(net) => nets.push(net),
            None => {
                skipped += 1;
                warn!(entry = %entry, "skipping unparseable banned_ips entry");
            }
        }
    }
    Ok((nets, skipped))
}

/// Parse a `banned_ips` entry into an [`IpNet`]. Accepts a bare address
/// (`1.2.3.4`, `2001:db8::1`) or a CIDR range (`1.2.3.0/24`, `2001:db8::/32`).
fn parse_ban_entry(entry: &str) -> Option<IpNet> {
    let entry = entry.trim();
    if entry.is_empty() {
        return None;
    }
    let net = if entry.contains('/') {
        entry.parse::<IpNet>().ok()?
    } else {
        match entry.parse::<IpAddr>().ok()? {
            IpAddr::V4(v4) => IpNet::V4(Ipv4Net::new(v4, 32).ok()?),
            IpAddr::V6(v6) => IpNet::V6(Ipv6Net::new(v6, 128).ok()?),
        }
    };
    // Collapse IPv4-mapped entries (bare or CIDR) to IPv4 so they match plain
    // IPv4 clients, which arrive normalized to IPv4 in `is_banned`.
    Some(normalize_net(net))
}

/// Collapse an IPv4-mapped IPv6 network (`::ffff:a.b.c.d/N`, `N >= 96`) to the
/// equivalent IPv4 network. Non-mapped or broader-than-`/96` networks are left
/// unchanged.
fn normalize_net(net: IpNet) -> IpNet {
    if let IpNet::V6(v6net) = net {
        if let Some(v4) = v6net.network().to_ipv4_mapped() {
            if let Some(v4_prefix) = v6net.prefix_len().checked_sub(96) {
                if let Ok(v4net) = Ipv4Net::new(v4, v4_prefix) {
                    return IpNet::V4(v4net);
                }
            }
        }
    }
    net
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_exact_and_cidr() {
        let blocklist = Blocklist::disabled();
        blocklist.store(vec![
            parse_ban_entry("1.2.3.4").expect("exact v4"),
            parse_ban_entry("10.0.0.0/8").expect("v4 cidr"),
            parse_ban_entry("2001:db8::/32").expect("v6 cidr"),
        ]);

        assert!(blocklist.is_banned("1.2.3.4".parse().unwrap()));
        assert!(!blocklist.is_banned("1.2.3.5".parse().unwrap()));
        assert!(blocklist.is_banned("10.9.8.7".parse().unwrap()));
        assert!(!blocklist.is_banned("11.0.0.1".parse().unwrap()));
        assert!(blocklist.is_banned("2001:db8::dead".parse().unwrap()));
        assert!(!blocklist.is_banned("2001:dead::1".parse().unwrap()));
    }

    #[test]
    fn disabled_bans_nothing() {
        let blocklist = Blocklist::disabled();
        assert!(!blocklist.is_banned("1.2.3.4".parse().unwrap()));
    }

    #[test]
    fn ipv4_mapped_v6_matches_v4_ban() {
        let blocklist = Blocklist::disabled();
        blocklist.store(vec![parse_ban_entry("1.2.3.4").expect("exact v4")]);
        let mapped: IpAddr = "::ffff:1.2.3.4".parse().unwrap();
        assert!(blocklist.is_banned(mapped));
    }

    #[test]
    fn mapped_ban_entry_matches_plain_v4() {
        // A stored `::ffff:1.2.3.4` entry must match a plain IPv4 client.
        let blocklist = Blocklist::from_entries(&["::ffff:1.2.3.4"]);
        assert!(blocklist.is_banned("1.2.3.4".parse().unwrap()));
        assert!(!blocklist.is_banned("1.2.3.5".parse().unwrap()));
    }

    #[test]
    fn mapped_cidr_entry_matches_plain_v4() {
        // `::ffff:1.2.3.0/120` == IPv4 `1.2.3.0/24`; `/128` == a single IPv4.
        let range = Blocklist::from_entries(&["::ffff:1.2.3.0/120"]);
        assert!(range.is_banned("1.2.3.5".parse().unwrap()));
        assert!(range.is_banned("1.2.3.255".parse().unwrap()));
        assert!(!range.is_banned("1.2.4.5".parse().unwrap()));

        let single = Blocklist::from_entries(&["::ffff:9.9.9.9/128"]);
        assert!(single.is_banned("9.9.9.9".parse().unwrap()));
        assert!(!single.is_banned("9.9.9.10".parse().unwrap()));
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_ban_entry("not-an-ip").is_none());
        assert!(parse_ban_entry("").is_none());
        assert!(parse_ban_entry("   ").is_none());
        assert!(parse_ban_entry("1.2.3.0/99").is_none());
    }

    // Live-Postgres test: a banned IP inserted into the table must load and match.
    // Env-gated so plain `cargo test` stays offline. Run against a throwaway DB:
    //   RELAY_BROKER_TEST_POSTGRES_URL=postgres://sealwire:dev@127.0.0.1:5433/sealwire \
    //     cargo test -p relay-broker banned_ips_load -- --nocapture
    #[tokio::test]
    async fn banned_ips_load_from_postgres() {
        let Some(url) = trimmed_option_string(std::env::var("RELAY_BROKER_TEST_POSTGRES_URL").ok())
        else {
            eprintln!("skipping banned_ips postgres test: set RELAY_BROKER_TEST_POSTGRES_URL");
            return;
        };

        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to postgres");
        initialize_banned_ips_schema(&pool).await.expect("schema");

        // TEST-NET-2 (RFC 5737) — safe to use, never a real client.
        let banned = "198.51.100.7";
        sqlx::query("DELETE FROM banned_ips WHERE ip_or_cidr = $1")
            .bind(banned)
            .execute(&pool)
            .await
            .expect("pre-clean");
        sqlx::query("INSERT INTO banned_ips (ip_or_cidr, reason) VALUES ($1, 'test')")
            .bind(banned)
            .execute(&pool)
            .await
            .expect("insert ban");

        let blocklist = Blocklist::connect(&url).await.expect("blocklist connect");

        let banned_matches = blocklist.is_banned(banned.parse().unwrap());
        let other_matches = blocklist.is_banned("198.51.100.8".parse().unwrap());

        sqlx::query("DELETE FROM banned_ips WHERE ip_or_cidr = $1")
            .bind(banned)
            .execute(&pool)
            .await
            .expect("cleanup");

        assert!(banned_matches, "the inserted banned IP should match");
        assert!(!other_matches, "an unrelated IP should not match");
    }
}
