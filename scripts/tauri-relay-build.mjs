// A release built from the stub ships a relay whose task lists and task teams refuse
// at runtime, from a build that looked fine; so that takes an explicit opt-in.
export function relayBuildArgs({ release, privateCrate, publicOnly = false }) {
  if (release && !privateCrate && !publicOnly) {
    throw new Error(
      "tauri: refusing to build a release relay from the stub private crate.\n" +
        "  Run it through scripts/with-private.sh (npm run desktop:build does), or\n" +
        "  set RELAY_PUBLIC_ONLY=1 to build without task lists and task teams.",
    );
  }
  const args = ["build", "-p", "relay-server"];
  if (release) {
    args.push("--release");
  }
  if (privateCrate) {
    args.push("--features", "private");
  }
  return args;
}
