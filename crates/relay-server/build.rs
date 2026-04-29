use std::{
    env,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

fn main() {
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
