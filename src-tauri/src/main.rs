// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--permission-helper") {
        let socket = std::env::var("LANTERN_SOCKET").ok();
        let offer = lantern_lib::permission::catalogue::Offer::from_env();
        let _ = lantern_lib::permission::helper::run_helper_as(std::io::BufReader::new(std::io::stdin()), std::io::stdout().lock(), socket.as_deref(), offer);
        return;
    }
    lantern_lib::run()
}
