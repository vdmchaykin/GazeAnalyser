use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(not(debug_assertions))]
use tauri::{Manager, RunEvent};

/// Port the README tells you to start uvicorn on during development.
const DEV_API_PORT: u16 = 8765;

/// Ask the OS for a free port by binding to :0 and reading back what we got.
///
/// There is an unavoidable gap between closing this listener and the backend
/// binding the same port, but the window is a few milliseconds wide and the port
/// is loopback-only, so in practice this beats hoping a fixed port is free.
fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(DEV_API_PORT)
}

/// Handle on the Python backend, so it can be reaped when the app exits
/// normally. The backend also watches for our death on its own
/// (`--exit-with-parent`), which is what covers a crash or an outright kill.
#[cfg(not(debug_assertions))]
struct Backend(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Start the packaged backend on `port`.
///
/// Release builds only: in development the backend is a separate `uvicorn
/// --reload` process started by hand, and the packaged one does not exist.
///
/// It ships as a bundled *directory* rather than a Tauri sidecar because
/// PyInstaller has to emit onedir here — see backend/gazeanalyzer-backend.spec.
#[cfg(not(debug_assertions))]
fn spawn_backend(app: &tauri::AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_shell::ShellExt;

    let exe_name = if cfg!(windows) { "gazeanalyzer-backend.exe" } else { "gazeanalyzer-backend" };
    let exe = app
        .path()
        .resolve(format!("backend/{exe_name}"), tauri::path::BaseDirectory::Resource)?;

    // Packaging does not reliably preserve the executable bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&exe) {
            let mut perms = meta.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(perms.mode() | 0o755);
                let _ = std::fs::set_permissions(&exe, perms);
            }
        }
    }

    let (mut rx, child) = app
        .shell()
        .command(exe.to_string_lossy().to_string())
        .args(["--port", &port.to_string(), "--exit-with-parent"])
        .spawn()?;

    // The backend's own logging is all we get if something goes wrong at
    // startup, so forward it instead of dropping it on the floor.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => print!("[backend] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => eprint!("[backend] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(payload) => {
                    eprintln!("[backend] exited with {:?}", payload.code)
                }
                _ => {}
            }
        }
    });

    app.state::<Backend>().0.lock().unwrap().replace(child);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            let port = DEV_API_PORT;

            #[cfg(not(debug_assertions))]
            let port = {
                app.manage(Backend(std::sync::Mutex::new(None)));
                let port = pick_free_port();
                // A backend that fails to start must not cost the user the
                // window too — the frontend says so far more usefully than a
                // silent exit would.
                if let Err(e) = spawn_backend(&app.handle(), port) {
                    eprintln!("[backend] failed to start: {e}");
                }
                port
            };

            // The window is built here rather than declared in tauri.conf.json
            // because the port has to be in the webview before any of the
            // frontend runs — an injected script is the only hook early enough.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("GazeAnalyzer")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&format!("window.__GAZE_API_PORT__ = {port};"))
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        // Closing the window does not reap the child process, so do it here.
        #[cfg(not(debug_assertions))]
        if let RunEvent::Exit = event {
            if let Some(child) = _app_handle.state::<Backend>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
        let _ = &event;
    });
}
