/*
 * PosturePal (versión web de escritorio)
 * ======================================
 * Misma lógica que posture_pal.py, pero corre en el navegador con
 * MediaPipe Tasks Vision (WebAssembly + GPU).
 *
 *   ratio = (y_punto_medio_hombros - y_nariz) / ancho_de_hombros
 *     - ratio alto  -> cuello "estirado"  -> postura correcta
 *     - ratio bajo  -> cabeza hundida     -> encorvado
 */
import { FilesetResolver, PoseLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";
import { drawRatioChart, drawTimeline } from "./charts.js";
import { startDemo, stopDemo } from "./demo.js";

// =============================================================================
// CONFIGURACIÓN
// =============================================================================
const WASM_PATH = new URL("../vendor/mediapipe/wasm", import.meta.url).href;
const MODEL_PATH = new URL("../models/pose_landmarker_lite.task", import.meta.url).href;
const STYLES_URL = new URL("../css/styles.css", import.meta.url).href;

// Sin calibrar usamos este ratio "de buena postura" de referencia.
// Con sensibilidad media da un umbral de ~0.50, igual que el script original.
const DEFAULT_BASELINE = 0.625;
// Sensibilidad: el slider (0-100) se convierte en el factor de calibración.
// 0 -> 0.70 (alerta si el ratio cae un 30 %), 100 -> 0.92 (cae un 8 %).
const FACTOR_MIN = 0.70, FACTOR_MAX = 0.92;

const MIN_VISIBILITY = 0.5;       // confianza mínima de nariz y hombros
const SMOOTHING_ALPHA = 0.3;      // suavizado del ratio (0-1; menor = más suave)
const BEEP_INTERVAL_MS = 2500;    // cada cuánto se repite el sonido
const CALIBRATION_SECONDS = 3;
const CHART_WINDOW_MS = 60_000;   // el gráfico en vivo muestra 60 s
const CHART_SAMPLE_MS = 100;
const AWAY_RESETS_BREAK_MS = 60_000; // 1 min fuera de cámara cuenta como pausa
const BACKGROUND_TICK_MS = 100;   // ritmo de detección con la pestaña oculta

const COLORS = { GOOD: "#3ef0a1", BAD: "#ff5d6c", NO_USER: "#ffc857" };

// Índices de MediaPipe Pose
const NOSE = 0, LEFT_SHOULDER = 11, RIGHT_SHOULDER = 12;
const UPPER_BODY_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS
  .filter(({ start, end }) => start < 23 && end < 23);

const STORAGE_KEY = "posturepal.settings.v1";

// =============================================================================
// ELEMENTOS
// =============================================================================
const $ = (id) => document.getElementById(id);
const el = {
  intro: $("intro"), app: $("app"),
  startBtn: $("start-btn"), loadStatus: $("load-status"), errorBox: $("error-box"), installBtn: $("install-btn"),
  stageHome: $("stage-home"), stage: $("stage"), video: $("video"), canvas: $("overlay"),
  pipPlaceholder: $("pip-placeholder"), pipReturnBtn: $("pip-return-btn"),
  status: $("status"), statusText: $("status-text"), badTimer: $("bad-timer"),
  gaugeZone: $("gauge-zone"), gaugeThreshold: $("gauge-threshold"), gaugeBaseline: $("gauge-baseline"), gaugeMarker: $("gauge-marker"),
  countdown: $("countdown"), countdownNum: $("countdown-num"), countdownArc: $("countdown-arc"),
  pausedOverlay: $("paused-overlay"),
  sessionTime: $("session-time"), sessionLabel: $("session-label"),
  chart: $("chart"), timeline: $("timeline"),
  ringFill: $("ring-fill"), scoreValue: $("score-value"), scoreState: $("score-state"), scoreHint: $("score-hint"),
  mGood: $("m-good"), mAlerts: $("m-alerts"), mStreak: $("m-streak"), mRatio: $("m-ratio"), mTilt: $("m-tilt"), mLean: $("m-lean"),
  calibrateBtn: $("calibrate-btn"), pauseBtn: $("pause-btn"), pauseLabel: $("pause-label"), pauseIcon: $("pause-icon"),
  pipBtn: $("pip-btn"), flipBtn: $("flip-btn"), notifyRow: $("notify-row"), soundBtn: $("sound-btn"), soundLabel: $("sound-label"), soundWaves: $("sound-waves"),
  sensitivity: $("sensitivity"), sensitivityOut: $("sensitivity-out"),
  delay: $("delay"), delayOut: $("delay-out"), volume: $("volume"), volumeOut: $("volume-out"),
  breakSelect: $("break-select"), notifyToggle: $("notify-toggle"), fps: $("fps"),
  toast: $("toast"), breakBanner: $("break-banner"), breakDone: $("break-done"),
  helpBtn: $("help-btn"), helpDialog: $("help-dialog"), endBtn: $("end-btn"),
  reportDialog: $("report-dialog"), reportChart: $("report-chart"),
  rDuration: $("r-duration"), rGood: $("r-good"), rScore: $("r-score"), rAlerts: $("r-alerts"),
  rStreak: $("r-streak"), rAway: $("r-away"), rVerdict: $("r-verdict"),
  csvBtn: $("csv-btn"), resumeBtn: $("resume-btn"), newBtn: $("new-btn"),
  favicon: $("favicon"), srAnnouncer: $("sr-announcer"), srAlert: $("sr-alert"),
};
const ctx = el.canvas.getContext("2d");
const RING_LENGTH = 2 * Math.PI * 86;
const COUNTDOWN_LENGTH = 2 * Math.PI * 54;

// =============================================================================
// ESTADO
// =============================================================================
const settings = loadSettings();
let landmarker = null;
let stream = null;
let running = false;
let paused = false;
let frameScheduled = false;
let lastVideoTime = -1;
let lastDetectTs = 0;
let pipWin = null;
let facingMode = "user";
// En celulares pedimos menos resolución (el modelo no necesita más) y así va más fluido
const IS_TOUCH = window.matchMedia("(pointer: coarse)").matches;
let wakeLock = null;
let audioCtx = null;
let toastTimer = 0;

let session;          // estadísticas de la sesión actual (ver resetSession)
let smoothedRatio = null;
let metrics = null;   // última medición { ratio, tilt, lean, ... }
let state = "NO_USER";
let announcedState = null;
let badSince = null;
let lastBeep = 0;
let prevFrameTime = 0;
let fps = 0;
let calibration = null;

function resetSession() {
  session = {
    activeMs: 0, goodMs: 0, badMs: 0, awayMs: 0,
    alerts: 0, streakMs: 0, bestStreakMs: 0,
    scoreSum: 0, scoreCount: 0,
    live: [],          // muestras cada 100 ms para el gráfico de 60 s
    log: [],           // una muestra por segundo para la línea de tiempo y el CSV
    lastLiveSample: 0, lastLogSecond: -1,
    sinceBreakMs: 0, noUserMs: 0, breakShown: false,
  };
  badSince = null;
  el.breakBanner.hidden = true;
}
resetSession();

// =============================================================================
// AJUSTES GUARDADOS (localStorage puede fallar en modo privado)
// =============================================================================
function loadSettings() {
  const defaults = { baseline: null, sensitivity: 50, sound: true, delay: 2, volume: 60, breakMinutes: 0, notify: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return defaults;
  }
}
function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* sin almacenamiento */ }
}

const baseline = () => settings.baseline ?? DEFAULT_BASELINE;
const calibrationFactor = () => FACTOR_MIN + (FACTOR_MAX - FACTOR_MIN) * (settings.sensitivity / 100);
// La alarma salta cuando el puntaje baja de este valor (margen amplio: avisa
// en cuanto empiezas a hundirte, no solo cuando ya estás muy encorvado).
const ALERT_SCORE = 80;
// Postura que se considera "muy encorvada" (puntaje 50) según la sensibilidad.
const slouchLimit = () => baseline() * calibrationFactor();

/** Puntaje 0-100: 100 = tu postura calibrada, 50 = muy encorvado. */
function postureScore(ratio) {
  const lim = slouchLimit(), base = baseline();
  return Math.max(0, Math.min(100, 50 + 50 * (ratio - lim) / (base - lim)));
}

/** Ratio en el que el puntaje vale ALERT_SCORE: por debajo, mala postura. */
const threshold = () => {
  const lim = slouchLimit(), base = baseline();
  return lim + ((ALERT_SCORE - 50) / 50) * (base - lim);
};

// =============================================================================
// LÓGICA DE CÁLCULO DE POSTURA
// =============================================================================
/**
 * Calcula el ratio de postura a partir de nariz y hombros, y además la
 * inclinación de hombros y la desviación lateral de la cabeza (en grados).
 * Devuelve null si algún punto no es suficientemente visible.
 */
function analyzePosture(landmarks, width, height) {
  const nose = landmarks[NOSE], lSh = landmarks[LEFT_SHOULDER], rSh = landmarks[RIGHT_SHOULDER];
  const vis = (p) => p.visibility ?? 1;
  if (Math.min(vis(nose), vis(lSh), vis(rSh)) < MIN_VISIBILITY) return null;

  // Coordenadas normalizadas (0-1) -> píxeles
  const px = (p) => ({ x: p.x * width, y: p.y * height });
  const n = px(nose), l = px(lSh), r = px(rSh);
  const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };

  const shoulderWidth = Math.hypot(l.x - r.x, l.y - r.y);
  if (shoulderWidth < 1) return null;

  const deg = (rad) => (rad * 180) / Math.PI;
  return {
    // Distancia vertical nariz -> punto medio de hombros, normalizada.
    ratio: (mid.y - n.y) / shoulderWidth,
    tilt: deg(Math.atan2(Math.abs(l.y - r.y), Math.abs(l.x - r.x))),
    lean: deg(Math.atan2(Math.abs(n.x - mid.x), Math.max(1, mid.y - n.y))),
    nose: n, left: l, right: r, mid,
  };
}

// =============================================================================
// MODELO Y CÁMARA
// =============================================================================
async function loadModel() {
  if (landmarker) return landmarker;
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, options("GPU"));
  } catch (err) {
    console.warn("GPU no disponible, usando CPU:", err);
    landmarker = await PoseLandmarker.createFromOptions(vision, options("CPU"));
  }
  return landmarker;
}

async function openCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const size = IS_TOUCH ? { width: { ideal: 640 }, height: { ideal: 480 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode, ...size, frameRate: { ideal: 30 } },
  });
  el.video.srcObject = stream;
  await el.video.play();
  lastVideoTime = -1;
  // Efecto espejo solo con la cámara frontal
  el.stage.classList.toggle("mirror", facingMode === "user");
  // El recuadro de la cámara toma la forma real del video (vertical en celulares)
  const card = el.stageHome.closest(".stage-card");
  if (el.video.videoWidth) card.style.setProperty("--ar", `${el.video.videoWidth} / ${el.video.videoHeight}`);
  // Mostrar "Cámara" solo si hay más de una
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  el.flipBtn.hidden = devices.filter((d) => d.kind === "videoinput").length < 2;
}

async function flipCamera() {
  facingMode = facingMode === "user" ? "environment" : "user";
  try {
    await openCamera();
    smoothedRatio = null;
    showToast(facingMode === "user" ? "Cámara frontal" : "Cámara trasera");
  } catch {
    facingMode = facingMode === "user" ? "environment" : "user";
    await openCamera().catch(() => {});
    showToast("No hay otra cámara disponible.");
  }
}

function cameraErrorMessage(err) {
  if (!window.isSecureContext) return "La cámara solo funciona en páginas seguras (https:// o localhost).";
  if (!navigator.mediaDevices?.getUserMedia) return "Este navegador no permite usar la cámara. Usa Chrome, Edge o Firefox actualizados.";
  switch (err?.name) {
    case "NotAllowedError":
      return "Bloqueaste el permiso de la cámara. Haz clic en el ícono de cámara de la barra de direcciones, permite el acceso y vuelve a intentarlo.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No se encontró ninguna cámara web conectada.";
    case "NotReadableError":
      return "La cámara está siendo usada por otra aplicación (Zoom, Teams, OBS…). Ciérrala e inténtalo de nuevo.";
    default:
      return `No se pudo iniciar: ${err?.message || err}`;
  }
}

// =============================================================================
// SONIDO
// =============================================================================
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { audioCtx = null; }
}

/** Reproduce una secuencia de tonos [[frecuencia, inicio_s, duración_s], ...]. */
function playTones(tones) {
  if (!settings.sound || !audioCtx || settings.volume === 0) return;
  const t0 = audioCtx.currentTime;
  const peak = 0.5 * (settings.volume / 100);
  for (const [freq, offset, dur] of tones) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + offset);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + offset);
    osc.stop(t0 + offset + dur);
  }
}
// Mismos tonos que la versión de escritorio en Python: 1000 Hz y 750 Hz
const playAlert = () => playTones([[1000, 0, 0.28], [750, 0.3, 0.28]]);
const playChime = () => playTones([[660, 0, 0.18], [880, 0.18, 0.18], [1320, 0.36, 0.35]]);

// =============================================================================
// NOTIFICACIONES, TÍTULO Y FAVICON (para enterarte desde otra ventana)
// =============================================================================
function notify(title, body) {
  if (!settings.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  if (document.hasFocus() && !document.hidden) return;
  try {
    const n = new Notification(title, { body, icon: "icons/icon-192.png", tag: "posturepal", renotify: true, silent: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* algunos navegadores solo permiten notificar desde un service worker */ }
}

const faviconCache = {};
function faviconFor(st) {
  if (!faviconCache[st]) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#07090c";
    g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.fill();
    g.fillStyle = COLORS[st] || "#5b6775";
    g.beginPath(); g.arc(32, 32, 20, 0, Math.PI * 2); g.fill();
    faviconCache[st] = c.toDataURL();
  }
  return faviconCache[st];
}

const TITLES = {
  GOOD: "✓ Postura correcta · PosturePal",
  BAD: "⚠ ¡Corrige tu postura! · PosturePal",
  NO_USER: "… Buscándote · PosturePal",
  PAUSED: "❚❚ En pausa · PosturePal",
};

function setBodyState(st) {
  if (document.body.dataset.state === st) return;
  document.body.dataset.state = st;
  if (pipWin) pipWin.document.body.dataset.state = st;
  document.title = TITLES[st] || "PosturePal";
  el.favicon.href = faviconFor(st);
}

// =============================================================================
// BUCLE PRINCIPAL
// Normalmente usamos requestAnimationFrame (de la ventana flotante si está
// abierta). Pero el navegador deja de llamarlo cuando la ventana está oculta
// o tapada por otra, así que un Worker nos despierta cada 100 ms como respaldo:
// si hace rato que no se procesó un cuadro, lo procesa él. Así la detección y
// las alertas siguen funcionando aunque estés trabajando en otra ventana.
// =============================================================================
const ticker = new Worker(URL.createObjectURL(new Blob(
  ["let id; onmessage = (e) => { clearInterval(id); if (e.data > 0) id = setInterval(() => postMessage(0), e.data); };"],
  { type: "text/javascript" },
)));
let lastStepAt = 0;
let frameGen = 0;   // invalida cadenas de requestAnimationFrame viejas (al abrir/cerrar la ventana flotante)
ticker.onmessage = () => {
  if (running && performance.now() - lastStepAt > 2 * BACKGROUND_TICK_MS) step();
};

function scheduleFrame(restart = false) {
  if (!running) return;
  if (restart) { frameGen += 1; frameScheduled = false; }
  if (frameScheduled) return;
  const gen = frameGen;
  const win = pipWin && !pipWin.closed ? pipWin : window;
  frameScheduled = true;
  win.requestAnimationFrame(() => {
    if (gen !== frameGen) return;
    frameScheduled = false;
    step();
    scheduleFrame();
  });
}

function step() {
  lastStepAt = performance.now();
  const video = el.video;
  if (video.paused) video.play().catch(() => {});
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const now = performance.now();
  const dt = prevFrameTime ? Math.min(now - prevFrameTime, 500) : 0;
  prevFrameTime = now;
  if (dt > 0) fps = fps ? 0.9 * fps + 0.1 * (1000 / dt) : 1000 / dt;
  if (paused) return;

  // detectForVideo exige marcas de tiempo estrictamente crecientes
  lastDetectTs = Math.max(now, lastDetectTs + 1);
  const result = landmarker.detectForVideo(video, lastDetectTs);
  update(result, now, dt);
}

function update(result, now, dt) {
  const w = el.video.videoWidth, h = el.video.videoHeight;
  if (el.canvas.width !== w || el.canvas.height !== h) {
    el.canvas.width = w;
    el.canvas.height = h;
  }

  const landmarks = result.landmarks?.[0];
  metrics = landmarks ? analyzePosture(landmarks, w, h) : null;

  // --- Lógica de detección (igual que en Python) ---
  if (metrics === null) {
    state = "NO_USER";
    smoothedRatio = null;
  } else {
    smoothedRatio = smoothedRatio === null
      ? metrics.ratio
      : SMOOTHING_ALPHA * metrics.ratio + (1 - SMOOTHING_ALPHA) * smoothedRatio;
    state = smoothedRatio >= threshold() ? "GOOD" : "BAD";
  }

  // Durante la calibración no alertamos: solo juntamos muestras
  if (calibration) {
    if (smoothedRatio !== null) calibration.samples.push(smoothedRatio);
    if (state === "BAD") state = "GOOD";
  }

  accumulate(now, dt);

  // Temporizador de mala postura + alerta
  let badElapsed = 0;
  if (state === "BAD") {
    badSince ??= now;
    badElapsed = (now - badSince) / 1000;
    if (badElapsed >= settings.delay && now - lastBeep >= BEEP_INTERVAL_MS) {
      if (lastBeep < badSince) {
        // Primera alerta de este episodio de mala postura
        session.alerts += 1;
        el.srAlert.textContent = "";
        el.srAlert.textContent = "Alerta: corrige tu postura";
        if (!pipWin) notify("¡Corrige tu postura!", "Te estás encorvando. Endereza la espalda y sube la cabeza.");
      }
      playAlert();
      lastBeep = now;
    }
  } else {
    badSince = null;
  }

  draw(landmarks, metrics, w, h);
  render(badElapsed, now);
}

/** Acumula tiempos, rachas, muestras del gráfico y el recordatorio de pausa. */
function accumulate(now, dt) {
  const s = session;
  s.activeMs += dt;
  if (state === "GOOD") {
    s.goodMs += dt;
    s.streakMs += dt;
    s.bestStreakMs = Math.max(s.bestStreakMs, s.streakMs);
  } else {
    s.streakMs = state === "NO_USER" ? s.streakMs : 0;
  }
  if (state === "BAD") s.badMs += dt;

  const score = smoothedRatio === null ? null : postureScore(smoothedRatio);
  if (score !== null && !calibration) { s.scoreSum += score * dt; s.scoreCount += dt; }

  // Pausas activas: estar 1 min fuera de cámara cuenta como pausa
  if (state === "NO_USER") {
    s.awayMs += dt;
    s.noUserMs += dt;
    if (s.noUserMs >= AWAY_RESETS_BREAK_MS) { s.sinceBreakMs = 0; s.breakShown = false; el.breakBanner.hidden = true; }
  } else {
    s.noUserMs = 0;
    s.sinceBreakMs += dt;
  }
  if (settings.breakMinutes > 0 && !s.breakShown && s.sinceBreakMs >= settings.breakMinutes * 60_000) {
    s.breakShown = true;
    el.breakBanner.hidden = false;
    playChime();
    notify("Hora de una pausa activa", "Levántate y estira el cuello y los hombros durante un minuto.");
  }

  if (now - s.lastLiveSample >= CHART_SAMPLE_MS) {
    s.lastLiveSample = now;
    s.live.push({ t: now, ratio: smoothedRatio });
    while (s.live.length && s.live[0].t < now - CHART_WINDOW_MS) s.live.shift();
    if (!document.hidden) drawLiveChart(now);
  }
  const second = Math.floor(s.activeMs / 1000);
  if (second !== s.lastLogSecond) {
    s.lastLogSecond = second;
    s.log.push({ t: second, ratio: smoothedRatio, score, state });
    if (!document.hidden) drawTimeline(el.timeline, s.log);
  }
}

// =============================================================================
// DIBUJO SOBRE EL VIDEO
// =============================================================================
function draw(landmarks, m, w, h) {
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;
  const color = COLORS[state];
  const lw = Math.max(3, w / 260);

  // Esqueleto de la parte superior del cuerpo, con brillo
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = lw * 4;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const { start, end } of UPPER_BODY_CONNECTIONS) {
    ctx.moveTo(landmarks[start].x * w, landmarks[start].y * h);
    ctx.lineTo(landmarks[end].x * w, landmarks[end].y * h);
  }
  ctx.stroke();
  ctx.fillStyle = "#07090c";
  ctx.globalAlpha = 1;
  for (let i = 0; i < 23; i++) {
    const x = landmarks[i].x * w, y = landmarks[i].y * h;
    ctx.beginPath();
    ctx.arc(x, y, lw * 1.3, 0, Math.PI * 2);
    ctx.fillStyle = "#07090c";
    ctx.fill();
    ctx.lineWidth = lw * 0.7;
    ctx.stroke();
  }
  ctx.restore();

  if (!m) return;

  // Línea de medición: hombros y nariz -> punto medio
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = lw * 0.8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(m.left.x, m.left.y); ctx.lineTo(m.right.x, m.right.y);
  ctx.stroke();
  ctx.setLineDash([lw * 2.5, lw * 2]);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(m.nose.x, m.nose.y); ctx.lineTo(m.mid.x, m.mid.y);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of [m.nose, m.left, m.right]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, lw * 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(m.mid.x, m.mid.y, lw * 1.6, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();

  // Etiqueta con el ratio junto al cuello (contrarrestando el espejo del video)
  if (smoothedRatio !== null) {
    const fontPx = Math.max(14, w / 55);
    const label = `ratio ${smoothedRatio.toFixed(2)}`;
    const x = m.mid.x, y = (m.nose.y + m.mid.y) / 2;
    ctx.translate(x, y);
    if (el.stage.classList.contains("mirror")) ctx.scale(-1, 1);
    ctx.font = `600 ${fontPx}px "JetBrains Mono", monospace`;
    const tw = ctx.measureText(label).width;
    const padX = fontPx * 0.6, boxH = fontPx * 1.8, offset = fontPx * 1.2;
    ctx.fillStyle = "rgba(7,9,12,.8)";
    ctx.beginPath();
    ctx.roundRect(offset, -boxH / 2, tw + padX * 2, boxH, boxH / 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(label, offset + padX, 1);
  }
  ctx.restore();
}

function drawLiveChart(now) {
  drawRatioChart(el.chart, session.live, {
    tStart: now - CHART_WINDOW_MS, tEnd: now,
    threshold: threshold(), baseline: baseline(),
    xLabels: [[now - CHART_WINDOW_MS, "−60 s"], [now - CHART_WINDOW_MS / 2, "−30 s"], [now, "ahora"]],
  });
}

// =============================================================================
// INTERFAZ
// =============================================================================
const STATE_TEXT = {
  GOOD: "Postura correcta",
  BAD: "¡Corrige tu postura!",
  NO_USER: "No se detectan tu cabeza y hombros",
};

const fmtTime = (ms) => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

function render(badElapsed, now) {
  const s = session;
  setBodyState(calibration ? "GOOD" : state);

  // Estado sobre el video
  el.status.dataset.state = calibration ? "CAL" : state;
  el.statusText.textContent = calibration ? "Calibrando… quédate quieto" : STATE_TEXT[state];
  el.badTimer.hidden = state !== "BAD";
  if (state === "BAD") el.badTimer.textContent = `${badElapsed.toFixed(1)} s`;
  el.stage.classList.toggle("alerting", state === "BAD" && badElapsed >= settings.delay);

  // Medidor vertical
  const base = baseline(), thr = threshold();
  const lo = base * 0.35, hi = base * 1.3;
  const pct = (v) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  el.gaugeZone.style.height = pct(thr);
  el.gaugeThreshold.style.bottom = pct(thr);
  el.gaugeBaseline.style.bottom = pct(base);
  el.gaugeMarker.hidden = smoothedRatio === null;
  if (smoothedRatio !== null) el.gaugeMarker.style.bottom = pct(smoothedRatio);

  // Puntaje
  const score = smoothedRatio === null ? null : postureScore(smoothedRatio);
  el.ringFill.style.strokeDashoffset = String(RING_LENGTH * (1 - (score ?? 0) / 100));
  el.scoreValue.textContent = score === null ? "--" : String(Math.round(score));
  if (calibration) {
    el.scoreState.textContent = "Calibrando";
    el.scoreHint.textContent = "Mantén tu mejor postura unos segundos.";
  } else if (score === null) {
    el.scoreState.textContent = "Sin datos";
    el.scoreHint.textContent = "Ajusta la cámara para que se vean tu cabeza y tus hombros.";
  } else if (score >= 92) {
    el.scoreState.textContent = "Excelente";
    el.scoreHint.textContent = "Espalda recta y cabeza arriba. ¡Sigue así!";
  } else if (score >= ALERT_SCORE) {
    el.scoreState.textContent = "Bien";
    el.scoreHint.textContent = "Cuidado: tu cabeza empieza a bajar.";
  } else {
    el.scoreState.textContent = "Encorvado";
    el.scoreHint.textContent = "Endereza la espalda y sube la cabeza.";
  }

  // Métricas
  const measured = s.goodMs + s.badMs;
  el.mGood.textContent = measured > 1000 ? `${Math.round((s.goodMs / measured) * 100)}%` : "--";
  el.mAlerts.textContent = String(s.alerts);
  el.mStreak.textContent = fmtTime(s.bestStreakMs);
  el.mRatio.textContent = smoothedRatio === null ? `--/${thr.toFixed(2)}` : `${smoothedRatio.toFixed(2)}/${thr.toFixed(2)}`;
  el.mTilt.textContent = metrics ? `${metrics.tilt.toFixed(1)}°` : "--";
  el.mLean.textContent = metrics ? `${metrics.lean.toFixed(1)}°` : "--";
  el.sessionTime.textContent = fmtTime(s.activeMs);
  el.fps.textContent = `${fps.toFixed(0)} FPS · ${landmarker ? "IA activa" : ""}`;

  // Lector de pantalla: anunciar solo cambios de estado (BAD se anuncia como alerta)
  if (!calibration && state !== announcedState && state !== "BAD") el.srAnnouncer.textContent = STATE_TEXT[state];
  announcedState = state;
}

function showToast(text, ms = 2600) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  el.srAnnouncer.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty("--p", `${p}%`);
}

function renderSettings() {
  const sens = settings.sensitivity;
  el.sensitivity.value = String(sens);
  el.sensitivityOut.textContent = sens < 34 ? "Baja" : sens < 67 ? "Media" : "Alta";
  el.delay.value = String(settings.delay);
  el.delayOut.textContent = `${settings.delay} s`;
  el.volume.value = String(settings.volume);
  el.volumeOut.textContent = `${settings.volume} %`;
  el.breakSelect.value = String(settings.breakMinutes);
  el.notifyToggle.checked = settings.notify && "Notification" in window && Notification.permission === "granted";
  [el.sensitivity, el.delay, el.volume].forEach(setRangeFill);

  el.soundBtn.setAttribute("aria-pressed", String(settings.sound));
  el.soundLabel.textContent = settings.sound ? "Sonido" : "Silencio";
  el.soundWaves.style.opacity = settings.sound ? "1" : "0";
}

// =============================================================================
// CALIBRACIÓN: cuenta regresiva de 3 s y mediana del ratio
// =============================================================================
function startCalibration() {
  if (!running || calibration) return;
  if (paused) togglePause();
  unlockAudio();
  calibration = { samples: [], startedAt: performance.now() };
  el.calibrateBtn.disabled = true;
  el.countdown.hidden = false;
  el.srAnnouncer.textContent = `Calibrando. Siéntate derecho durante ${CALIBRATION_SECONDS} segundos.`;

  const totalMs = CALIBRATION_SECONDS * 1000;
  const tick = () => {
    if (!calibration) return;
    const elapsed = performance.now() - calibration.startedAt;
    el.countdownNum.textContent = String(Math.max(1, Math.ceil((totalMs - elapsed) / 1000)));
    el.countdownArc.style.strokeDashoffset = String(COUNTDOWN_LENGTH * Math.min(1, elapsed / totalMs));
    if (elapsed >= totalMs) finishCalibration();
    else setTimeout(tick, 50);
  };
  tick();
}

function finishCalibration() {
  // Mediana de la segunda mitad (cuando ya te acomodaste)
  const samples = calibration.samples.slice(Math.floor(calibration.samples.length / 2)).sort((a, b) => a - b);
  calibration = null;
  el.countdown.hidden = true;
  el.calibrateBtn.disabled = false;

  if (samples.length < 3) {
    showToast("No se pudo calibrar: no te detecto. Que se vean tu cabeza y hombros.", 3800);
    return;
  }
  settings.baseline = samples[Math.floor(samples.length / 2)];
  saveSettings();
  resetSession();   // las estadísticas empiezan de cero con la nueva referencia
  playChime();
  showToast(`Calibrado ✓ Tu postura ideal: ratio ${settings.baseline.toFixed(2)} · umbral ${threshold().toFixed(2)}`, 3500);
}

// =============================================================================
// VENTANA FLOTANTE (Document Picture-in-Picture, Chrome/Edge)
// =============================================================================
async function togglePip() {
  if (pipWin) { pipWin.close(); return; }
  if (!("documentPictureInPicture" in window)) {
    showToast("Tu navegador no soporta ventana flotante. Usa Chrome o Edge.", 3500);
    return;
  }
  try {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: 380, height: 260 });
  } catch (err) {
    console.warn(err);
    showToast("No se pudo abrir la ventana flotante.");
    return;
  }
  const link = pipWin.document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLES_URL;
  pipWin.document.head.append(link);
  pipWin.document.title = "PosturePal";
  pipWin.document.body.classList.add("pip");
  pipWin.document.body.dataset.state = document.body.dataset.state;
  pipWin.document.body.append(el.stage);
  pipWin.document.addEventListener("keydown", onKeyDown);
  el.pipPlaceholder.hidden = false;
  el.pipBtn.setAttribute("aria-pressed", "true");
  el.video.play().catch(() => {});
  scheduleFrame(true);

  pipWin.addEventListener("pagehide", () => {
    el.stageHome.prepend(el.stage);
    el.pipPlaceholder.hidden = true;
    el.pipBtn.setAttribute("aria-pressed", "false");
    pipWin = null;
    el.video.play().catch(() => {});
    scheduleFrame(true);
  });
}

// =============================================================================
// INICIO, PAUSA Y REPORTE
// =============================================================================
async function start() {
  if (running) return;
  el.errorBox.hidden = true;
  el.startBtn.disabled = true;
  unlockAudio();
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
    el.loadStatus.textContent = "Cargando el modelo de IA…";
    await Promise.all([loadModel(), openCamera()]);
    el.loadStatus.textContent = "";
    stopDemo();
    el.intro.hidden = true;
    el.app.hidden = false;
    running = true;
    resetSession();
    prevFrameTime = 0;
    requestWakeLock();
    ticker.postMessage(BACKGROUND_TICK_MS);
    scheduleFrame(true);
    el.calibrateBtn.focus();
    if (settings.baseline === null) showToast("Siéntate derecho y pulsa «Calibrar postura» (tecla C).", 4500);
  } catch (err) {
    console.error(err);
    stream?.getTracks().forEach((t) => t.stop());
    el.loadStatus.textContent = "";
    el.errorBox.textContent = cameraErrorMessage(err);
    el.errorBox.hidden = false;
  } finally {
    el.startBtn.disabled = false;
  }
}

function togglePause(force) {
  if (!running) return;
  paused = force ?? !paused;
  el.pausedOverlay.hidden = !paused;
  el.pauseBtn.setAttribute("aria-pressed", String(paused));
  el.pauseLabel.textContent = paused ? "Seguir" : "Pausar";
  el.pauseIcon.setAttribute("d", paused ? "M7 5l12 7-12 7z" : "M8 5v14M16 5v14");
  el.sessionLabel.textContent = paused ? "En pausa" : "Sesión";
  badSince = null;
  smoothedRatio = null;
  el.stage.classList.remove("alerting");
  setBodyState(paused ? "PAUSED" : state);
  if (paused) ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
}

function openReport() {
  if (!running) return;
  togglePause(true);
  const s = session;
  const measured = s.goodMs + s.badMs;
  const goodPct = measured > 1000 ? Math.round((s.goodMs / measured) * 100) : null;
  const avgScore = s.scoreCount > 0 ? Math.round(s.scoreSum / s.scoreCount) : null;
  el.rDuration.textContent = fmtTime(s.activeMs);
  el.rGood.textContent = goodPct === null ? "--" : `${goodPct}%`;
  el.rScore.textContent = avgScore === null ? "--" : String(avgScore);
  el.rAlerts.textContent = String(s.alerts);
  el.rStreak.textContent = fmtTime(s.bestStreakMs);
  el.rAway.textContent = fmtTime(s.awayMs);
  el.rVerdict.textContent = goodPct === null
    ? "No hubo suficientes datos para evaluar la sesión."
    : goodPct >= 85 ? "¡Postura de campeón! Mantuviste la espalda recta casi todo el tiempo."
      : goodPct >= 60 ? "Buen trabajo. Hubo algunos momentos encorvado; intenta notar cuándo te pasa."
        : "Pasaste bastante tiempo encorvado. Prueba subir la pantalla a la altura de los ojos y tomar pausas.";
  el.reportDialog.showModal();
  const last = s.log.length ? s.log[s.log.length - 1].t : 1;
  requestAnimationFrame(() => drawRatioChart(el.reportChart, s.log, {
    tStart: 0, tEnd: Math.max(1, last),
    threshold: threshold(), baseline: baseline(),
    xLabels: [[0, "0:00"], [Math.max(1, last), fmtTime(last * 1000)]],
  }));
}

function downloadCsv() {
  const rows = ["segundo,ratio,puntaje,estado"];
  for (const r of session.log) {
    rows.push([r.t, r.ratio?.toFixed(4) ?? "", r.score === null ? "" : r.score.toFixed(1), r.state].join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `posturepal-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { wakeLock = null; }
}

// =============================================================================
// EVENTOS
// =============================================================================
el.startBtn.addEventListener("click", start);
el.calibrateBtn.addEventListener("click", startCalibration);
el.pauseBtn.addEventListener("click", () => togglePause());
el.pipBtn.addEventListener("click", togglePip);
el.flipBtn.addEventListener("click", flipCamera);
el.video.addEventListener("resize", () => {
  if (el.video.videoWidth) el.stageHome.closest(".stage-card").style.setProperty("--ar", `${el.video.videoWidth} / ${el.video.videoHeight}`);
});
el.pipReturnBtn.addEventListener("click", () => pipWin?.close());
el.soundBtn.addEventListener("click", () => {
  settings.sound = !settings.sound;
  saveSettings();
  renderSettings();
  unlockAudio();
  if (settings.sound) playTones([[880, 0, 0.12]]);
});
el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());
el.endBtn.addEventListener("click", openReport);
el.csvBtn.addEventListener("click", downloadCsv);
el.resumeBtn.addEventListener("click", () => { el.reportDialog.close(); togglePause(false); });
el.newBtn.addEventListener("click", () => { el.reportDialog.close(); resetSession(); togglePause(false); showToast("Nueva sesión iniciada"); });
el.breakDone.addEventListener("click", () => {
  session.sinceBreakMs = 0;
  session.breakShown = false;
  el.breakBanner.hidden = true;
});

el.sensitivity.addEventListener("input", () => { settings.sensitivity = Number(el.sensitivity.value); saveSettings(); renderSettings(); });
el.delay.addEventListener("input", () => { settings.delay = Number(el.delay.value); saveSettings(); renderSettings(); });
el.volume.addEventListener("input", () => { settings.volume = Number(el.volume.value); saveSettings(); renderSettings(); });
el.volume.addEventListener("change", () => { unlockAudio(); playAlert(); });
el.breakSelect.addEventListener("change", () => {
  settings.breakMinutes = Number(el.breakSelect.value);
  session.breakShown = false;
  saveSettings();
});
el.notifyToggle.addEventListener("change", async () => {
  if (!el.notifyToggle.checked) { settings.notify = false; saveSettings(); return; }
  if (!("Notification" in window)) { el.notifyToggle.checked = false; showToast("Este navegador no soporta notificaciones."); return; }
  const perm = await Notification.requestPermission();
  settings.notify = perm === "granted";
  el.notifyToggle.checked = settings.notify;
  saveSettings();
  showToast(settings.notify ? "Te avisaremos aunque estés en otra ventana." : "Permiso de notificaciones denegado en el navegador.");
});

function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  if (!running) {
    if (e.key === "Enter" && !el.intro.hidden && target === document.body) start();
    return;
  }
  if (el.reportDialog.open || el.helpDialog.open) return;
  const key = e.key.toLowerCase();
  if (key === "c") startCalibration();
  else if (key === "s") el.soundBtn.click();
  else if (key === "f") togglePip();
  else if (key === "?") el.helpDialog.showModal();
  else if (key === " " && !(target instanceof HTMLButtonElement)) { e.preventDefault(); togglePause(); }
  else return;
}
document.addEventListener("keydown", onKeyDown);

document.addEventListener("visibilitychange", () => {
  if (!running) return;
  if (document.visibilityState === "visible") {
    requestWakeLock();
    drawLiveChart(performance.now());
    drawTimeline(el.timeline, session.log);
  }
  scheduleFrame();
});

window.addEventListener("resize", () => {
  if (!running) return;
  drawLiveChart(performance.now());
  drawTimeline(el.timeline, session.log);
});

// Instalación como app. Chrome/Edge en Android y computador ofrecen su propio
// aviso (beforeinstallprompt); en iPhone y otros casos mostramos los pasos.
let deferredInstall = null;
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
el.installBtn.hidden = isStandalone;   // ya abierta como app: no hace falta

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
});
window.addEventListener("appinstalled", () => {
  el.installBtn.hidden = true;
  showToast("PosturePal quedó instalada ✓");
});

function installSteps() {
  if (isIOS) {
    return "<ol><li>Abre esta página en <b>Safari</b>.</li><li>Toca <b>Compartir</b> (el cuadro con la flecha hacia arriba).</li><li>Elige <b>Agregar a pantalla de inicio</b> y toca <b>Agregar</b>.</li></ol>";
  }
  if (/android/i.test(navigator.userAgent)) {
    return "<ol><li>Abre esta página en <b>Chrome</b>.</li><li>Toca el menú <b>⋮</b> arriba a la derecha.</li><li>Elige <b>Instalar app</b> o <b>Agregar a pantalla principal</b>.</li></ol>";
  }
  return "<ol><li>Usa <b>Chrome</b> o <b>Edge</b>.</li><li>Haz clic en el ícono de instalar al final de la barra de direcciones, o abre el menú <b>⋮</b> y elige <b>Instalar PosturePal</b>.</li><li>Si no aparece, es posible que ya esté instalada en este equipo.</li></ol>";
}

el.installBtn.addEventListener("click", async () => {
  if (deferredInstall) {
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    return;
  }
  $("install-steps").innerHTML = installSteps();
  $("install-dialog").showModal();
});

// Código QR con la dirección de la página, para abrirla en el celular
$("qr-btn").addEventListener("click", () => {
  const url = new URL("./", location.href).href;
  const box = $("qr-box");
  box.innerHTML = "";
  if (window.QRCode) new window.QRCode(box, { text: url, width: 240, height: 240, colorDark: "#07090c", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
  $("qr-url").textContent = url.replace(/^https?:\/\//, "");
  $("qr-dialog").showModal();
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW no registrado:", err));
}

// Ocultar lo que este navegador no soporta (p. ej. en celulares)
el.pipBtn.hidden = !("documentPictureInPicture" in window);
el.notifyRow.hidden = !("Notification" in window);

renderSettings();
startDemo();
