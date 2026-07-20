//! Regression guard for the Railway deploy config (`railway.toml`).
//!
//! Bug: the VAPID keypair is persisted to `<cwd>/.agent-relay/vapid.key`
//! (`push.rs::vapid_key_path`, defaulting to the process cwd). In the broker
//! image that cwd is `WORKDIR /app` — the *ephemeral* container filesystem, not
//! the `/data` volume. `railway.toml` pinned the state/postgres paths to the
//! volume but never set `RELAY_VAPID_KEY_PATH`, so every redeploy/restart
//! regenerated the keypair. Existing web-push subscriptions are bound (via
//! `applicationServerKey`) to the *old* VAPID public key, so after a restart the
//! relay signs pushes with a mismatched private key and FCM returns 403 — which
//! `send_one` does not prune, so delivery silently stops forever.
//!
//! This test locks in that the deploy start command persists the VAPID key on
//! the durable volume (`$state_dir`, i.e. `${RAILWAY_VOLUME_MOUNT_PATH:-/data}`).

use std::path::PathBuf;

fn railway_toml() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../railway.toml");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

/// Extract the single-line `startCommand = "..."` value from `[deploy]`.
fn start_command(toml: &str) -> String {
    let line = toml
        .lines()
        .find(|l| l.trim_start().starts_with("startCommand"))
        .expect("railway.toml [deploy] must define startCommand");
    let first = line.find('"').expect("startCommand value must be quoted");
    let last = line.rfind('"').expect("startCommand value must be quoted");
    assert!(last > first, "malformed startCommand quoting: {line}");
    line[first + 1..last].to_string()
}

#[test]
fn deploy_persists_vapid_key_on_the_volume() {
    let cmd = start_command(&railway_toml());

    // The start command exposes the persistent volume as the `state_dir` shell
    // var (`${RAILWAY_VOLUME_MOUNT_PATH:-/data}`) and already pins state/postgres
    // there. Web push only survives restarts if the VAPID key lives there too.
    assert!(
        cmd.contains("RELAY_VAPID_KEY_PATH"),
        "railway.toml startCommand must export RELAY_VAPID_KEY_PATH so the VAPID \
         keypair persists across restarts; otherwise it is regenerated on the \
         ephemeral container FS each deploy and existing web-push subscriptions \
         start getting FCM 403s.\nstartCommand: {cmd}"
    );

    assert!(
        cmd.contains("state_dir/vapid.key"),
        "RELAY_VAPID_KEY_PATH must resolve under $state_dir (the /data volume), \
         not the ephemeral container filesystem (WORKDIR /app).\nstartCommand: {cmd}"
    );
}
