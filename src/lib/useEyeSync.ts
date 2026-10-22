import { useCallback, useEffect, useRef, type RefObject } from "react";
import { API_BASE as API } from "@/lib/apiBase";
import { seekVideo, targetTime } from "@/lib/seekVideo";

// During playback the eye video is left alone as far as possible. It is 200 fps,
// and every seek restarts decoding from a keyframe. On WebKitGTK (the Tauri
// webview on Linux) changing playbackRate is ALSO a GStreamer seek. Correcting
// drift per frame, and later by nudging the rate 4×/s, both locked up the video
// pipeline while marking. So only a clear drift gets one seek, with a long
// cooldown, never while a seek is pending.
const CHECK_MS = 1000;
const SEEK_DRIFT_S = 0.3;
const SEEK_COOLDOWN_MS = 3000;

/**
 * Keeps the eye video on the same instant as the scene video.
 *
 * Both mp4s start at PTS 0, but the cameras do not start together — the eye camera
 * starts 0.6–0.9 s after the scene camera on most recordings — so the two played at
 * the same currentTime show different moments. The backend reports the offset
 * from the cameras' own timestamps; the eye video is held at
 * `scene.currentTime - offset`.
 *
 * Returns `syncEye()`: call it after every seek and before starting playback.
 * While `playing`, only a clear drift is corrected, rarely (see above).
 */
export function useEyeSync(
  recordingId: string,
  sceneRef: RefObject<HTMLVideoElement | null>,
  eyeRef: RefObject<HTMLVideoElement | null>,
  playing: boolean,
) {
  const offsetRef = useRef(0);

  // Seeks go through seekVideo, which coalesces rapid requests (see seekVideo.ts).
  const syncEye = useCallback(() => {
    const v = sceneRef.current;
    const e = eyeRef.current;
    if (!v || !e || e.readyState < 1) return;
    seekVideo(e, Math.max(0, targetTime(v) - offsetRef.current));
    if (e.playbackRate !== v.playbackRate) e.playbackRate = v.playbackRate;
  }, [sceneRef, eyeRef]);

  useEffect(() => {
    let cancelled = false;
    offsetRef.current = 0;
    fetch(`${API}/api/recordings/${recordingId}/gaze/video-sync`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { eye_offset_s: number } | null) => {
        if (cancelled || !d) return;
        offsetRef.current = d.eye_offset_s || 0;
        syncEye();
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [recordingId, syncEye]);

  // The eye video may finish loading after the scene was already positioned.
  useEffect(() => {
    const e = eyeRef.current;
    if (!e) return;
    const onMeta = () => syncEye();
    e.addEventListener("loadedmetadata", onMeta);
    return () => e.removeEventListener("loadedmetadata", onMeta);
  }, [eyeRef, syncEye]);

  useEffect(() => {
    if (!playing) return;
    let lastSeek = performance.now();
    const id = window.setInterval(() => {
      const v = sceneRef.current;
      const e = eyeRef.current;
      if (!v || !e || e.seeking || e.readyState < 2) return;
      if (performance.now() - lastSeek < SEEK_COOLDOWN_MS) return;
      const want = v.currentTime - offsetRef.current;
      if (want < 0) return;   // the eye camera has not started yet
      if (Math.abs(e.currentTime - want) > SEEK_DRIFT_S) {
        seekVideo(e, want);
        lastSeek = performance.now();
      }
    }, CHECK_MS);
    return () => window.clearInterval(id);
  }, [playing, sceneRef, eyeRef]);

  return syncEye;
}
