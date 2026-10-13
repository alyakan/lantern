// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--permission-helper") {
        let socket = std::env::var("LANTERN_SOCKET").ok();
        let orchestrator = std::env::var("LANTERN_ROLE").is_ok_and(|r| r == "main");
        let _ = lantern_lib::permission::helper::run_helper_as(std::io::stdin().lock(), std::io::stdout().lock(), socket.as_deref(), orchestrator);
        return;
    }
    lantern_lib::run()
}
