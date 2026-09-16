use std::{
    env,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

fn main() {
    // Cargo's PROFILE env is only "debug" | "release" (from inherits), NOT the
    // custom profile name. Detect `--profile release-npm` via OUT_DIR's profile
    // directory segment, which Cargo places at target/<profile>/build/.../out.
    println!("cargo:rustc-check-cfg=cfg(sealwire_npm_release)");
    let out_dir = env::var("OUT_DIR").unwrap_or_default();
    if out_dir_is_release_npm_profile(&out_dir)
        || env::var_os("SEALWIRE_NPM_RELEASE").is_some_and(|v| v == "1")
    {
        println!("cargo:rustc-cfg=sealwire_npm_release");
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let web_root = manifest_dir.join("..").join("..").join("web");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("out dir"));
    let generated_path = out_dir.join("embedded_web_assets.rs");

    println!("cargo:rerun-if-changed={}", web_root.display());

    let mut assets = Vec::new();
    if web_root.join("index.html").exists() {
        collect_assets(&web_root, &web_root, &mut assets).expect("failed to scan web assets");
    } else {
        println!(
            "cargo:warning=relay web assets are missing at {}; embedded web UI will be empty until `npm run build` is run before compiling",
            web_root.display()
        );
    }
    assets.sort_by(|left, right| left.0.cmp(&right.0));

    let mut output = File::create(generated_path).expect("failed to create embedded asset source");
    writeln!(
        output,
        "pub(crate) static EMBEDDED_WEB_ASSETS: &[EmbeddedWebAsset] = &["
    )
    .expect("failed to write embedded asset source");
    for (asset_path, file_path) in assets {
        writeln!(
            output,
            "    EmbeddedWebAsset {{ path: {asset_path:?}, bytes: include_bytes!({:?}) }},",
            file_path.display().to_string()
        )
        .expect("failed to write embedded asset entry");
    }
    writeln!(output, "];").expect("failed to finish embedded asset source");
}

/// True when Cargo is building with `--profile release-npm`.
///
/// Custom profile names are NOT exposed via the PROFILE env (that stays
/// "release" / "debug" based on inherits). The profile directory name in
/// OUT_DIR is the supported detection signal.
fn out_dir_is_release_npm_profile(out_dir: &str) -> bool {
    Path::new(out_dir)
        .components()
        .any(|c| c.as_os_str() == "release-npm")
}

fn collect_assets(
    web_root: &Path,
    current_dir: &Path,
    assets: &mut Vec<(String, PathBuf)>,
) -> io::Result<()> {
    for entry in fs::read_dir(current_dir)? {
        let entry = entry?;
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            collect_assets(web_root, &path, assets)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(web_root)
            .expect("asset should be under web root")
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        assets.push((relative, path));
    }
    Ok(())
}
