// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by the browser for native messaging (autofill): bridge only, no UI.
    if notiq_lib::autofill::is_native_host_launch() {
        notiq_lib::autofill::run_native_host();
        return;
    }
    notiq_lib::run()
}
