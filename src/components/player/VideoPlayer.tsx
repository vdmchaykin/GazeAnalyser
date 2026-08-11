import { useEffect, useRef, useState, useCallback } from "react";
import {
  Play, Pause, Eye, EyeOff, Volume2, VolumeX, Maximize2, ScanEye, CircleDot, Route, Cloud,
} from "lucide-react";
import type {
  CloudGaze, Fixation, GazePrediction, PupilData, SceneMotionData, SurfacePositionsData,
} from "@/types";
import {
  applyMat, chainTo, matFrom8, nearestIndex, unitSquareToQuad, type Mat3,
} from "@/lib/sceneAnchor";
import { ScanpathPanel, type AnchorStats } from "./ScanpathPanel";

// Trailing time window (seconds) of fixations drawn in the scanpath overlay.
const SCANPATH_WINDOW_S = 3;

const API = "http://localhost:8765";

interface VideoPlayerProps {
  recordingId: string;
  hasEyeVideo: boolean;
}

interface DragPos { x: number; y: number }

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function findNearest<T extends { timestamp_ns: number }>(preds: T[], targetNs: number): T | null {
  if (preds.length === 0) return null;
  let lo = 0, hi = preds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (preds[mid].timestamp_ns < targetNs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(preds[lo - 1].timestamp_ns - targetNs) < Math.abs(preds[lo].timestamp_ns - targetNs)) lo--;
  return preds[lo];
}

export function VideoPlayer({ recordingId, hasEyeVideo }: VideoPlayerProps) {
  const sceneRef = useRef<HTMLVideoElement>(null);
  const eyeRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const gazeDotRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  // Refs for rAF loop (no re-render needed when these change)
  const predsRef = useRef<GazePrediction[]>([]);
  const naturalSizeRef = useRef({ w: 1920, h: 1080 });

  // Pupil Cloud gaze overlay refs (csv/gaze.csv) + the canvas that links the two
  // gaze dots when both overlays are on.
  const cloudDotRef = useRef<HTMLDivElement>(null);
  const cloudRef = useRef<CloudGaze[]>([]);
  const linkCanvasRef = useRef<HTMLCanvasElement>(null);

  // Scanpath overlay refs
  const scanCanvasRef = useRef<HTMLCanvasElement>(null);
  const scanRafRef = useRef<number>(0);
  const fixationsRef = useRef<Fixation[]>([]);

  // Scene-frame index. Every per-frame product (surface corners, egomotion) is
  // keyed by scene frame, so playback position has to resolve to a real frame.
  const sceneTsRef = useRef<Float64Array>(new Float64Array(0));   // device ts (ns) per frame
  const sceneRelRef = useRef<Float64Array>(new Float64Array(0));  // seconds since frame 0

  // Scanpath anchoring inputs — surface corners per frame and per-frame-pair
  // egomotion. Both optional; without them fixations are drawn where measured.
  const surfaceRef = useRef<(number[] | null)[]>([]);
  const motionRef = useRef<(Mat3 | null)[]>([]);
  const anchorStatsRef = useRef<AnchorStats>({ surface: 0, flow: 0, fixed: 0 });

  // Pupil overlay refs
  const eyePipRef = useRef<HTMLDivElement>(null);
  const pupilDotLRef = useRef<HTMLDivElement>(null);
  const pupilDotRRef = useRef<HTMLDivElement>(null);
  const pupilRafRef = useRef<number>(0);
  const pupilsRef = useRef<PupilData[]>([]);
  const eyeNaturalSizeRef = useRef({ w: 384, h: 192 });
  // Last known fitted-ellipse geometry [A, B, angle] per eye, so the overlay
  // holds its shape through frames where detection dropped out.
  const lastEllLRef = useRef<[number, number, number]>([20, 20, 0]);
  const lastEllRRef = useRef<[number, number, number]>([20, 20, 0]);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [showEye, setShowEye] = useState(true);
  const [eyePos, setEyePos] = useState<DragPos>({ x: 16, y: 16 });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef<DragPos>({ x: 0, y: 0 });

  const [showGaze, setShowGaze] = useState(false);
  const [gazeLoaded, setGazeLoaded] = useState(false);

  const [showCloudGaze, setShowCloudGaze] = useState(false);
  const [cloudLoaded, setCloudLoaded] = useState(false);

  // Options for the compare panel that appears once both gaze overlays are on.
  const [linkGaze, setLinkGaze] = useState(true);

  const [showPupils, setShowPupils] = useState(false);
  const [pupilsLoaded, setPupilsLoaded] = useState(false);

  const [showScanpath, setShowScanpath] = useState(false);
  const [scanpathLoaded, setScanpathLoaded] = useState(false);

  // Scene anchoring for the scanpath: transport past fixations into the current
  // frame so they stay on their target instead of on a screen position.
  const [anchorScene, setAnchorScene] = useState(true);
  const [surfaceLocalized, setSurfaceLocalized] = useState<number | null>(null);
  const [motionSolved, setMotionSolved] = useState<number | null>(null);

  // Which overlays actually have generated data — drives whether each toggle
  // button is enabled. Fetched up front so a user can't turn on an overlay that
  // would render nothing.
  const [avail, setAvail] = useState({ gaze: false, pupils: false, fixations: false, cloud: false });

  // Fetch analysis state up front so overlay buttons can be disabled when their
  // data hasn't been generated yet (gaze mapping / pupils / fixations).
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/recordings/${recordingId}/gaze/state`)
      .then((r) => r.json())
      .then((s: { pupils_done?: boolean; mapping_done?: boolean; fixations_done?: boolean; cloud_gaze_done?: boolean }) => {
        if (!cancelled) {
          setAvail({
            gaze: !!s.mapping_done,
            pupils: !!s.pupils_done,
            fixations: !!s.fixations_done,
            cloud: !!s.cloud_gaze_done,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [recordingId]);

  // Sync scene → eye on seek
  const syncEye = useCallback((time: number) => {
    if (eyeRef.current) eyeRef.current.currentTime = time;
  }, []);

  const togglePlay = () => {
    const v = sceneRef.current;
    const e = eyeRef.current;
    if (!v) return;
    if (v.paused) { v.play(); e?.play(); }
    else { v.pause(); e?.pause(); }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (sceneRef.current) sceneRef.current.currentTime = t;
    syncEye(t);
    setCurrentTime(t);
  };

  const handleSpeedChange = (s: number) => {
    setSpeed(s);
    if (sceneRef.current) sceneRef.current.playbackRate = s;
    if (eyeRef.current) eyeRef.current.playbackRate = s;
  };

  const handleMute = () => {
    const next = !muted;
    setMuted(next);
    if (sceneRef.current) sceneRef.current.muted = next;
  };

  // Dragging logic for eye PiP
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragOffset.current = { x: e.clientX - eyePos.x, y: e.clientY - eyePos.y };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const container = containerRef.current.getBoundingClientRect();
    const eyeW = 240, eyeH = 160;
    const x = Math.max(0, Math.min(e.clientX - dragOffset.current.x - container.left, container.width - eyeW));
    const y = Math.max(0, Math.min(e.clientY - dragOffset.current.y - container.top, container.height - eyeH));
    setEyePos({ x, y });
  };

  const onPointerUp = () => setDragging(false);

  // When eye video becomes visible again — sync and resume if scene is playing
  useEffect(() => {
    const e = eyeRef.current;
    const v = sceneRef.current;
    if (!e || !v || !showEye) return;
    e.currentTime = v.currentTime;
    e.playbackRate = speed;
    if (!v.paused) e.play();
  }, [showEye]);

  // Video event listeners
  useEffect(() => {
    const v = sceneRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => {
      setDuration(v.duration);
      if (v.videoWidth > 0) naturalSizeRef.current = { w: v.videoWidth, h: v.videoHeight };
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, []);

  // Track eye video natural size for pupil coordinate mapping
  useEffect(() => {
    const e = eyeRef.current;
    if (!e) return;
    const onMeta = () => {
      if (e.videoWidth > 0) eyeNaturalSizeRef.current = { w: e.videoWidth, h: e.videoHeight };
    };
    e.addEventListener("loadedmetadata", onMeta);
    return () => e.removeEventListener("loadedmetadata", onMeta);
  }, [hasEyeVideo]);

  // Load gaze predictions when overlay is first enabled
  useEffect(() => {
    if (!showGaze || gazeLoaded) return;
    fetch(`${API}/api/recordings/${recordingId}/gaze/predictions`)
      .then((r) => r.json())
      .then((data: GazePrediction[]) => {
        predsRef.current = data;
        setGazeLoaded(true);
      })
      .catch(() => {});
  }, [showGaze, gazeLoaded, recordingId]);

  // Load Pupil Cloud gaze when its overlay is first enabled
  useEffect(() => {
    if (!showCloudGaze || cloudLoaded) return;
    fetch(`${API}/api/recordings/${recordingId}/gaze/cloud`)
      .then((r) => r.json())
      .then((data: CloudGaze[]) => {
        cloudRef.current = data;
        setCloudLoaded(true);
      })
      .catch(() => {});
  }, [showCloudGaze, cloudLoaded, recordingId]);

  // Load fixations when the scanpath overlay is first enabled
  useEffect(() => {
    if (!showScanpath || scanpathLoaded) return;
    fetch(`${API}/api/recordings/${recordingId}/gaze/fixations`)
      .then((r) => r.json())
      .then((data: Fixation[]) => {
        fixationsRef.current = data;
        setScanpathLoaded(true);
      })
      .catch(() => {});
  }, [showScanpath, scanpathLoaded, recordingId]);

  // Drop the per-recording caches when the player switches recording, so a stale
  // frame index can never be applied to another recording's video.
  useEffect(() => {
    sceneTsRef.current = new Float64Array(0);
    sceneRelRef.current = new Float64Array(0);
    surfaceRef.current = [];
    motionRef.current = [];
    setSurfaceLocalized(null);
    setMotionSolved(null);
  }, [recordingId]);

  // Scene-frame timestamps — the bridge between playback position and the gaze
  // clock. The scene video and the gaze stream start a few frames apart, which a
  // fraction-of-the-clip mapping cannot express, and every per-frame product is
  // addressed by frame index anyway.
  useEffect(() => {
    if (!(showGaze || showCloudGaze || showScanpath) || sceneTsRef.current.length) return;
    fetch(`${API}/api/recordings/${recordingId}/gaze/scene-timestamps`)
      .then((r) => r.json())
      .then(({ ts_ns }: { ts_ns: number[] }) => {
        if (!ts_ns?.length) return;
        const ts = Float64Array.from(ts_ns);
        const rel = new Float64Array(ts.length);
        for (let i = 0; i < ts.length; i++) rel[i] = (ts[i] - ts[0]) / 1e9;
        sceneTsRef.current = ts;
        sceneRelRef.current = rel;
      })
      .catch(() => {});
  }, [showGaze, showCloudGaze, showScanpath, recordingId]);

  // Anchoring inputs. Refetched whenever the overlay is turned on, so regenerating
  // either file and reopening the overlay is enough to pick it up.
  const loadSurface = useCallback(() => {
    fetch(`${API}/api/recordings/${recordingId}/aoi/surface-positions/data`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SurfacePositionsData | null) => {
        surfaceRef.current = d?.corners ?? [];
        setSurfaceLocalized(d ? d.localized : null);
      })
      .catch(() => {});
  }, [recordingId]);

  const loadMotion = useCallback(() => {
    fetch(`${API}/api/recordings/${recordingId}/motion/data`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SceneMotionData | null) => {
        motionRef.current = (d?.h ?? []).map((h) => (h ? matFrom8(h) : null));
        setMotionSolved(d ? d.solved : null);
      })
      .catch(() => {});
  }, [recordingId]);

  useEffect(() => {
    if (!showScanpath) return;
    loadSurface();
    loadMotion();
  }, [showScanpath, loadSurface, loadMotion]);

  /** Playback position → scene frame index, or -1 when there is no .time file. */
  const frameAt = useCallback((t: number): number => {
    const rel = sceneRelRef.current;
    return rel.length ? nearestIndex(rel, t) : -1;
  }, []);

  // Load pupils data when overlay is first enabled
  useEffect(() => {
    if (!showPupils || pupilsLoaded) return;
    fetch(`${API}/api/recordings/${recordingId}/gaze/pupils`)
      .then((r) => r.json())
      .then((data: PupilData[]) => {
        pupilsRef.current = data;
        setPupilsLoaded(true);
      })
      .catch(() => {});
  }, [showPupils, pupilsLoaded, recordingId]);

  // rAF loop for pupil overlay on eye PiP
  useEffect(() => {
    if (!showPupils || !showEye) {
      if (pupilDotLRef.current) pupilDotLRef.current.style.display = "none";
      if (pupilDotRRef.current) pupilDotRRef.current.style.display = "none";
      cancelAnimationFrame(pupilRafRef.current);
      return;
    }

    const tick = () => {
      const e = eyeRef.current;
      const dL = pupilDotLRef.current;
      const dR = pupilDotRRef.current;
      const pip = eyePipRef.current;
      const preds = pupilsRef.current;

      if (!e || !dL || !dR || !pip || preds.length === 0) {
        pupilRafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Raw pupils.csv holds one row per eye-video frame, in order, so map by
      // playback position → row index. This is robust to corrupted/non-monotonic
      // timestamps (which would break a findNearest binary search and freeze the
      // overlay on frame 0).
      const dur = e.duration || 1;
      const frac = Math.min(1, Math.max(0, e.currentTime / dur));
      const idx = Math.min(preds.length - 1, Math.round(frac * (preds.length - 1)));
      const pred = preds[idx];

      if (!pred) {
        dL.style.display = "none";
        dR.style.display = "none";
        pupilRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const { w: ew, h: eh } = eyeNaturalSizeRef.current;
      const pw = pip.clientWidth;
      const ph = pip.clientHeight;
      // object-cover: fill container while maintaining aspect ratio (may crop)
      const scale = Math.max(pw / ew, ph / eh);
      const ox = (pw - ew * scale) / 2;
      const oy = (ph - eh * scale) / 2;
      const mid = ew / 2;

      // Resolve the fitted ellipse for one eye. A/B are full axis lengths and
      // angle rotates the A axis (OpenCV fitEllipse convention). Fall back to a
      // circle of `diameter` when a proper fit is unavailable, and reuse the
      // last known geometry so the marker doesn't collapse on dropped frames.
      const ellipseOf = (
        A: number | null, B: number | null, angle: number | null,
        diameter: number | null,
        lastEll: React.MutableRefObject<[number, number, number]>,
      ): [number, number, number] => {
        if (A !== null && B !== null && angle !== null) {
          lastEll.current = [A, B, angle];
        } else if (diameter !== null) {
          lastEll.current = [diameter, diameter, 0];
        }
        return lastEll.current;
      };

      // Position a div-based ellipse (border-radius:50%) centred on (x, y),
      // scaled from eye-video pixels to on-screen pixels and rotated to match
      // the fit. Its own width/height are the two axes so CSS rotate keeps the
      // A axis aligned with `angle`.
      const drawEllipse = (
        d: HTMLDivElement, x: number, y: number,
        A: number, B: number, angle: number,
      ) => {
        const w = A * scale;
        const h = B * scale;
        d.style.display = "block";
        d.style.width = `${w}px`;
        d.style.height = `${h}px`;
        d.style.left = `${x - w / 2}px`;
        d.style.top = `${y - h / 2}px`;
        d.style.transform = `rotate(${angle}deg)`;
      };

      if (pred.xL !== null && pred.yL !== null) {
        const [A, B, ang] = ellipseOf(pred.A_L, pred.B_L, pred.angle_L, pred.diameter_L, lastEllLRef);
        drawEllipse(dL, ox + pred.xL * scale, oy + pred.yL * scale, A, B, ang);
      } else {
        dL.style.display = "none";
      }

      if (pred.xR !== null && pred.yR !== null) {
        const [A, B, ang] = ellipseOf(pred.A_R, pred.B_R, pred.angle_R, pred.diameter_R, lastEllRRef);
        drawEllipse(dR, ox + (mid + pred.xR) * scale, oy + pred.yR * scale, A, B, ang);
      } else {
        dR.style.display = "none";
      }

      pupilRafRef.current = requestAnimationFrame(tick);
    };

    pupilRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(pupilRafRef.current);
  }, [showPupils, showEye]);

  // rAF loop — updates both gaze dots (mapped + Pupil Cloud) directly in DOM and
  // draws the link between them, bypassing React state. Both sources are sampled
  // at the same playback fraction so the distance readout compares like with like.
  useEffect(() => {
    const clear = () => {
      if (gazeDotRef.current) gazeDotRef.current.style.display = "none";
      if (cloudDotRef.current) cloudDotRef.current.style.display = "none";
      const c = linkCanvasRef.current;
      const cx = c?.getContext("2d");
      if (c && cx) cx.clearRect(0, 0, c.width, c.height);
    };

    if (!showGaze && !showCloudGaze) {
      clear();
      cancelAnimationFrame(rafRef.current);
      return;
    }

    // Match a source to the current playback position by fraction of its own
    // timespan — each CSV has its own sampling rate and clock offset.
    const sampleAt = <T extends { timestamp_ns: number }>(arr: T[], frac: number): T | null => {
      if (arr.length === 0) return null;
      const t0 = arr[0].timestamp_ns;
      const t1 = arr[arr.length - 1].timestamp_ns;
      return findNearest(arr, t0 + frac * (t1 - t0));
    };

    const tick = () => {
      const v = sceneRef.current;
      const container = containerRef.current;

      if (!v || !container) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const { w, h } = naturalSizeRef.current;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const scale = Math.min(cw / w, ch / h);
      const ox = (cw - w * scale) / 2;
      const oy = (ch - h * scale) / 2;

      // Prefer the real scene frame's device timestamp; the fraction mapping is
      // only a fallback for recordings without a scene .time file.
      const frac = Math.min(1, Math.max(0, v.currentTime / (v.duration || 1)));
      const idx = frameAt(v.currentTime);
      const tsNs = idx >= 0 ? sceneTsRef.current[idx] : null;
      const sample = <T extends { timestamp_ns: number }>(arr: T[]): T | null =>
        tsNs !== null ? findNearest(arr, tsNs) : sampleAt(arr, frac);

      const pred = showGaze ? sample(predsRef.current) : null;
      const cloud = showCloudGaze ? sample(cloudRef.current) : null;

      // Scene-pixel coordinates of each dot (null when its source has no sample).
      const pPt = pred ? { x: pred.pred_gaze_x, y: pred.pred_gaze_y } : null;
      const cPt = cloud ? { x: cloud.x, y: cloud.y } : null;

      const place = (dot: HTMLDivElement | null, pt: { x: number; y: number } | null) => {
        if (!dot) return;
        if (!pt) { dot.style.display = "none"; return; }
        dot.style.display = "block";
        dot.style.left = `${ox + pt.x * scale - 12}px`;
        dot.style.top = `${oy + pt.y * scale - 12}px`;
      };
      place(gazeDotRef.current, pPt);
      place(cloudDotRef.current, cPt);

      // Link line + distance label between the two gaze estimates.
      const canvas = linkCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
          canvas.width = Math.round(cw * dpr);
          canvas.height = Math.round(ch * dpr);
          canvas.style.width = `${cw}px`;
          canvas.style.height = `${ch}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        if (linkGaze && pPt && cPt) {
          const x1 = ox + pPt.x * scale, y1 = oy + pPt.y * scale;
          const x2 = ox + cPt.x * scale, y2 = oy + cPt.y * scale;
          // Distance is reported in scene-camera pixels, not screen pixels, so it
          // stays comparable regardless of window size.
          const distPx = Math.hypot(pPt.x - cPt.x, pPt.y - cPt.y);

          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();

          const label = `${Math.round(distPx)} px`;
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          ctx.font = "600 12px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
          ctx.fillRect(mx - tw / 2 - 5, my - 9, tw + 10, 18);
          ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
          ctx.fillText(label, mx, my);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(rafRef.current); clear(); };
  }, [showGaze, showCloudGaze, linkGaze, frameAt]);

  // rAF loop — draws the scanpath (fixations + saccades) on a canvas overlay
  useEffect(() => {
    const canvas = scanCanvasRef.current;
    if (!showScanpath) {
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(scanRafRef.current);
      return;
    }

    const tick = () => {
      const v = sceneRef.current;
      const container = containerRef.current;
      const fixations = fixationsRef.current;

      if (!v || !canvas || !container || fixations.length === 0) {
        scanRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Keep the canvas backing store matched to the container (crisp on HiDPI).
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Same scene-px → screen transform as the gaze dot (object-contain fit).
      const { w, h } = naturalSizeRef.current;
      const scale = Math.min(cw / w, ch / h);
      const ox = (cw - w * scale) / 2;
      const oy = (ch - h * scale) / 2;

      // Current scene frame and the gaze-clock time it stands for.
      const curIdx = frameAt(v.currentTime);
      let targetNs: number;
      if (curIdx >= 0) {
        targetNs = sceneTsRef.current[curIdx];
      } else {
        const t0 = fixations[0].start_ts_ns;
        const t1 = fixations[fixations.length - 1].end_ts_ns;
        targetNs = t0 + (v.currentTime / (v.duration || 1)) * (t1 - t0);
      }
      const windowNs = SCANPATH_WINDOW_S * 1e9;

      // Visible = active or ended within the trailing window; never future ones.
      const vis = fixations.filter(
        (f) => f.start_ts_ns <= targetNs && f.end_ts_ns >= targetNs - windowNs,
      );
      if (vis.length === 0) {
        anchorStatsRef.current = { surface: 0, flow: 0, fixed: 0 };
        scanRafRef.current = requestAnimationFrame(tick);
        return;
      }

      // ── Anchoring ───────────────────────────────────────────────────────────
      // Every fixation older than the current frame was measured in a frame the
      // camera has since moved away from. Two transports bring it back onto its
      // target, tried in this order:
      //
      //  1. the AoI surface as seen in THIS frame — a fixation on the paper keeps
      //     normalized surface coordinates, which are valid in every frame where
      //     the surface is localized. Exact, and it never accumulates error.
      //  2. scene egomotion — chain the frame-to-frame homographies from the
      //     fixation's own frame up to this one. Works anywhere, but assumes a
      //     rotation-dominated camera and drifts as the chain grows, which is why
      //     it is only the fallback.
      const corners = anchorScene && curIdx >= 0 ? surfaceRef.current[curIdx] ?? null : null;
      const surfH = corners ? unitSquareToQuad(corners) : null;

      const motion = motionRef.current;
      // The chain never has to reach further back than the trailing window (plus
      // one fixation's worth of slack), which bounds both cost and drift.
      const chainFrom = Math.max(0, frameAt(Math.max(0, v.currentTime - SCANPATH_WINDOW_S - 1)));
      let chain: Mat3[] | null = null;
      const chainAt = (idx: number): Mat3 | null => {
        if (!anchorScene || curIdx < 0 || motion.length === 0) return null;
        if (!chain) chain = chainTo(motion, chainFrom, curIdx);
        return chain[Math.min(curIdx, Math.max(chainFrom, idx)) - chainFrom] ?? null;
      };

      const stats: AnchorStats = { surface: 0, flow: 0, fixed: 0 };
      const anchor = (f: Fixation): [number, number] => {
        if (surfH && f.on_surface && f.norm_x !== null && f.norm_y !== null) {
          stats.surface++;
          return applyMat(surfH, f.norm_x, f.norm_y);
        }
        // The stored coordinate is the median over the fixation, so its middle
        // frame is where that coordinate is most nearly true.
        const midNs = (f.start_ts_ns + f.end_ts_ns) / 2;
        const m = chainAt(nearestIndex(sceneTsRef.current, midNs));
        if (m) {
          stats.flow++;
          return applyMat(m, f.x_px, f.y_px);
        }
        stats.fixed++;
        return [f.x_px, f.y_px];
      };

      // Resolved once per rendered frame; the saccade and circle passes reuse it.
      const pts = vis.map(anchor);
      anchorStatsRef.current = stats;

      const sx = (i: number) => ox + pts[i][0] * scale;
      const sy = (i: number) => oy + pts[i][1] * scale;
      // Fade older fixations by how long ago they ended.
      const alphaOf = (f: Fixation) => {
        const age = Math.max(0, targetNs - f.end_ts_ns);
        return Math.max(0.25, 1 - 0.75 * (age / windowNs));
      };
      const radiusOf = (f: Fixation) => 7 + Math.sqrt(f.duration_ms) * 0.7;

      // Saccade lines (drawn under the circles)
      ctx.lineWidth = 2;
      for (let i = 1; i < vis.length; i++) {
        ctx.strokeStyle = `rgba(251, 191, 36, ${alphaOf(vis[i]) * 0.6})`;
        ctx.beginPath();
        ctx.moveTo(sx(i - 1), sy(i - 1));
        ctx.lineTo(sx(i), sy(i));
        ctx.stroke();
      }

      // Fixation circles + order numbers
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < vis.length; i++) {
        const f = vis[i];
        const a = alphaOf(f);
        const r = radiusOf(f);
        const x = sx(i);
        const y = sy(i);
        const current = f.start_ts_ns <= targetNs && f.end_ts_ns >= targetNs;

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(251, 191, 36, ${a * 0.3})`;
        ctx.fill();
        ctx.lineWidth = current ? 3 : 2;
        ctx.strokeStyle = current
          ? `rgba(255, 255, 255, ${a})`
          : `rgba(245, 158, 11, ${a})`;
        ctx.stroke();

        ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
        ctx.fillText(String(f.fixation_id), x, y);
      }

      scanRafRef.current = requestAnimationFrame(tick);
    };

    scanRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(scanRafRef.current);
  }, [showScanpath, anchorScene, frameAt]);

  // Space bar toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Video container */}
      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Scene video */}
        <video
          ref={sceneRef}
          src={`${API}/api/recordings/${recordingId}/video/scene`}
          className="w-full h-full object-contain"
          muted={muted}
          playsInline
          preload="metadata"
        />

        {/* Eye video — draggable PiP */}
        {hasEyeVideo && (
          <div
            ref={eyePipRef}
            className={`absolute rounded-lg overflow-hidden border-2 border-zinc-600
                        shadow-xl shadow-black/50 select-none
                        ${dragging ? "cursor-grabbing border-indigo-400" : "cursor-grab"}`}
            style={{
              left: eyePos.x, top: eyePos.y,
              width: 240, height: 160,
              zIndex: 10,
              display: showEye ? "block" : "none",
            }}
            onPointerDown={onPointerDown}
          >
            <video
              ref={eyeRef}
              src={`${API}/api/recordings/${recordingId}/video/eye`}
              className="w-full h-full object-cover"
              muted playsInline preload="metadata"
            />
            <div className="absolute top-1.5 left-2 text-[10px] text-white/70
                            bg-black/50 px-1.5 py-0.5 rounded pointer-events-none">
              Eye Camera
            </div>
            {/* Fitted pupil ellipses — left eye (cyan) and right eye (yellow).
                border-radius:50% makes the rotated div a true ellipse. */}
            <div
              ref={pupilDotLRef}
              className="absolute pointer-events-none border-2 border-cyan-400 bg-cyan-400/20 shadow shadow-cyan-400/50"
              style={{ display: "none", borderRadius: "50%" }}
            />
            <div
              ref={pupilDotRRef}
              className="absolute pointer-events-none border-2 border-yellow-400 bg-yellow-400/20 shadow shadow-yellow-400/50"
              style={{ display: "none", borderRadius: "50%" }}
            />
          </div>
        )}

        {/* Scanpath overlay — fixations + saccades drawn by rAF onto canvas */}
        <canvas
          ref={scanCanvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ display: showScanpath ? "block" : "none", zIndex: 7 }}
        />

        {/* Link between the two gaze dots — drawn by the same rAF loop */}
        <canvas
          ref={linkCanvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ display: showGaze && showCloudGaze && linkGaze ? "block" : "none", zIndex: 7 }}
        />

        {/* Gaze dot — always in DOM when showGaze, position updated by rAF */}
        <div
          ref={gazeDotRef}
          className="absolute pointer-events-none"
          style={{ display: "none", width: 24, height: 24, zIndex: 8 }}
        >
          <div className="w-full h-full rounded-full bg-red-500/30 border-2 border-red-500 shadow-lg shadow-red-500/50" />
          <div className="absolute rounded-full bg-red-400" style={{ width: 6, height: 6, left: 9, top: 9 }} />
        </div>

        {/* Pupil Cloud gaze dot (csv/gaze.csv) */}
        <div
          ref={cloudDotRef}
          className="absolute pointer-events-none"
          style={{ display: "none", width: 24, height: 24, zIndex: 8 }}
        >
          <div className="w-full h-full rounded-full bg-sky-500/30 border-2 border-sky-400 shadow-lg shadow-sky-500/50" />
          <div className="absolute rounded-full bg-sky-300" style={{ width: 6, height: 6, left: 9, top: 9 }} />
        </div>

        {/* Compare panel — only meaningful while both gaze overlays are visible */}
        {showGaze && showCloudGaze && (
          <div
            className="absolute top-4 right-4 w-56 rounded-lg border border-zinc-700
                       bg-zinc-900/90 backdrop-blur px-3 py-2.5 shadow-xl shadow-black/50"
            style={{ zIndex: 20 }}
          >
            <p className="text-[11px] font-medium text-zinc-300 mb-2">Gaze comparison</p>
            <div className="flex flex-col gap-1 mb-2 text-[11px] text-zinc-400">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" /> Mapped (this app)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" /> Pupil Cloud
              </span>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={linkGaze}
                onChange={(e) => setLinkGaze(e.target.checked)}
                className="accent-indigo-500 cursor-pointer"
              />
              Connecting line + distance
            </label>
          </div>
        )}

        {/* Scanpath anchoring controls + the scene-motion job they depend on */}
        {showScanpath && (
          <ScanpathPanel
            recordingId={recordingId}
            anchor={anchorScene}
            onAnchorChange={setAnchorScene}
            surfaceLocalized={surfaceLocalized}
            motionSolved={motionSolved}
            statsRef={anchorStatsRef}
            onMotionReady={loadMotion}
          />
        )}

        {/* Center play/pause click area */}
        <div
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          style={{ zIndex: 5 }}
          onClick={togglePlay}
        >
          {!playing && (
            <div className="w-16 h-16 rounded-full bg-black/40 flex items-center justify-center">
              <Play className="w-8 h-8 text-white ml-1" />
            </div>
          )}
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex flex-col gap-2 px-4 py-3 bg-zinc-900 border-t border-zinc-800">
        {/* Seekbar */}
        <div className="relative h-1.5 group">
          <div className="absolute inset-0 bg-zinc-700 rounded-full" />
          <div
            className="absolute inset-y-0 left-0 bg-indigo-500 rounded-full pointer-events-none"
            style={{ width: `${progress}%` }}
          />
          <input
            ref={seekRef}
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={currentTime}
            onChange={handleSeek}
            className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
          />
        </div>

        {/* Buttons row */}
        <div className="flex items-center gap-3">
          <button onClick={togglePlay}
            className="text-white hover:text-indigo-400 transition-colors cursor-pointer">
            {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>

          <button onClick={handleMute}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer">
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <span className="text-xs text-zinc-400 tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className="flex-1" />

          {/* Speed */}
          <div className="flex items-center gap-1">
            {[0.1, 0.25, 0.5, 1, 2].map((s) => (
              <button
                key={s}
                onClick={() => handleSpeedChange(s)}
                className={`text-xs px-2 py-0.5 rounded transition-colors cursor-pointer
                  ${speed === s ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                {s}×
              </button>
            ))}
          </div>

          {/* Gaze overlay toggle */}
          <button
            onClick={() => setShowGaze((v) => !v)}
            disabled={!avail.gaze}
            title={!avail.gaze ? "No gaze data — run gaze mapping first" : showGaze ? "Hide gaze overlay" : "Show gaze overlay"}
            className={`p-1.5 rounded transition-colors
              disabled:opacity-30 disabled:cursor-not-allowed
              ${avail.gaze ? "cursor-pointer" : ""}
              ${showGaze ? "text-red-400 hover:text-red-300" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            <ScanEye className="w-4 h-4" />
          </button>

          {/* Reference-gaze overlay toggle — draws Pupil Cloud's raw gaze ALONGSIDE
              the mapped one for comparison. Unrelated to the Gaze section's source
              selector, which picks what the whole pipeline runs on. */}
          <button
            onClick={() => setShowCloudGaze((v) => !v)}
            disabled={!avail.cloud}
            title={!avail.cloud
              ? "No reference gaze — csv/gaze.csv not found"
              : showCloudGaze ? "Hide reference gaze (Pupil Cloud)" : "Show reference gaze (Pupil Cloud)"}
            className={`p-1.5 rounded transition-colors
              disabled:opacity-30 disabled:cursor-not-allowed
              ${avail.cloud ? "cursor-pointer" : ""}
              ${showCloudGaze ? "text-sky-400 hover:text-sky-300" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            <Cloud className="w-4 h-4" />
          </button>

          {/* Scanpath overlay toggle */}
          <button
            onClick={() => setShowScanpath((v) => !v)}
            disabled={!avail.fixations}
            title={!avail.fixations ? "No fixations — run fixation detection first" : showScanpath ? "Hide scanpath" : "Show scanpath (fixations)"}
            className={`p-1.5 rounded transition-colors
              disabled:opacity-30 disabled:cursor-not-allowed
              ${avail.fixations ? "cursor-pointer" : ""}
              ${showScanpath ? "text-amber-400 hover:text-amber-300" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            <Route className="w-4 h-4" />
          </button>

          {/* Pupil overlay toggle */}
          {hasEyeVideo && (
            <button
              onClick={() => setShowPupils((v) => !v)}
              disabled={!avail.pupils}
              title={!avail.pupils ? "No pupil data — run pupil detection first" : showPupils ? "Hide pupil overlay" : "Show pupil overlay"}
              className={`p-1.5 rounded transition-colors
                disabled:opacity-30 disabled:cursor-not-allowed
                ${avail.pupils ? "cursor-pointer" : ""}
                ${showPupils ? "text-cyan-400 hover:text-cyan-300" : "text-zinc-600 hover:text-zinc-400"}`}
            >
              <CircleDot className="w-4 h-4" />
            </button>
          )}

          {/* Eye toggle */}
          {hasEyeVideo && (
            <button
              onClick={() => setShowEye(!showEye)}
              title={showEye ? "Hide eye camera" : "Show eye camera"}
              className={`p-1.5 rounded transition-colors cursor-pointer
                ${showEye ? "text-indigo-400 hover:text-indigo-300" : "text-zinc-600 hover:text-zinc-400"}`}
            >
              {showEye ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          )}

          <button
            onClick={() => sceneRef.current?.requestFullscreen()}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
