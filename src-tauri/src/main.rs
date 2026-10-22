// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer hangs the webview on the proprietary NVIDIA
    // driver — here, when the scene video is seeked rapidly (clicking along the
    // timeline). Rendering through the older path avoids it. Set before WebKit
    // starts, and only when the user has not chosen otherwise.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri_app_lib::run()
}
