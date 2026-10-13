// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--permission-helper") {
        let socket = std::env::var("LANTERN_SOCKET").ok();
        // Only the main agent's helper is started with the secret, which is also what makes it offer the orchestra tools.
        let token = std::env::var("LANTERN_TOKEN").ok().filter(|t| !t.is_empty());
        let _ = lantern_lib::permission::helper::run_helper_as(std::io::stdin().lock(), std::io::stdout().lock(), socket.as_deref(), token.as_deref());
        return;
    }
    lantern_lib::run()
}
