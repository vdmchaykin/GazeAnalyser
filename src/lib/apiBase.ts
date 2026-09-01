// Single source of truth for the backend address.
//
// In a bundled app the Rust shell picks a free port for the Python sidecar and
// injects it into the webview before any of our code runs (see src-tauri/src/lib.rs).
// Running the frontend from Vite there is no shell, so we fall back to the port
// the README tells you to start uvicorn on.
declare global {
  interface Window {
    __GAZE_API_PORT__?: number;
  }
}

export const DEV_API_PORT = 8765;

export const API_PORT = window.__GAZE_API_PORT__ ?? DEV_API_PORT;

/** e.g. "http://127.0.0.1:8765" — no trailing slash. */
export const API_BASE = `http://127.0.0.1:${API_PORT}`;
