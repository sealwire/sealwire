//! Regression guard for the **self-host** Railway example config.
//!
//! Hosted SealWire Cloud is deployed from the private repository. The public
//! tree only keeps an explicit example under `examples/self-host-broker/`.
//!
//! Bug (historical): the VAPID keypair was persisted under the ephemeral
//! container cwd. The self-host example must keep `RELAY_VAPID_KEY_PATH` on the
//! `/data` volume.

use std::path::PathBuf;

fn railway_toml() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/self-host-broker/railway.toml");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

fn start_command(toml: &str) -> String {
    let line = toml
        .lines()
        .find(|l| l.trim_start().starts_with("startCommand"))
        .expect("self-host railway.toml [deploy] must define startCommand");
    let first = line.find('"').expect("startCommand value must be quoted");
    let last = line.rfind('"').expect("startCommand value must be quoted");
    assert!(last > first, "malformed startCommand quoting: {line}");
    line[first + 1..last].to_string()
}

#[test]
fn root_railway_toml_is_absent() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../railway.toml");
    assert!(
        !root.exists(),
        "public repo must not ship a root railway.toml (would enable accidental OpenAccess Cloud deploy)"
    );
}

#[test]
fn self_host_example_persists_vapid_key_on_the_volume() {
    let cmd = start_command(&railway_toml());

    assert!(
        cmd.contains("RELAY_VAPID_KEY_PATH"),
        "self-host railway.toml startCommand must export RELAY_VAPID_KEY_PATH.\nstartCommand: {cmd}"
    );
    assert!(
        cmd.contains("state_dir/vapid.key"),
        "RELAY_VAPID_KEY_PATH must resolve under $state_dir (/data volume).\nstartCommand: {cmd}"
    );
    assert!(
        cmd.contains("exec relay-broker"),
        "self-host example must start the public relay-broker binary"
    );
    assert!(
        !cmd.contains("sealwire-broker-private"),
        "self-host example must not start the private commercial binary"
    );
}
