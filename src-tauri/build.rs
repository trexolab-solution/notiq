fn main() {
    // Google Drive sign-in needs the Desktop client secret at compile time (never committed).
    println!("cargo:rerun-if-env-changed=NOTIQ_GOOGLE_CLIENT_SECRET");
    tauri_build::build()
}
