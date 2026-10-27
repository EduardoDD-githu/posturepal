/*
 * Gráficos en <canvas> sin librerías: ratio en el tiempo y línea de tiempo de la sesión.
 */
const GOOD = "#3ef0a1", BAD = "#ff5d6c", AWAY = "#2a333d";
const MUTED = "rgba(139,151,165,.9)";

/** Ajusta el canvas a su tamaño en pantalla (nítido en pantallas de alta densidad). */
function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, rect.width, rect.height);
  return { c, w: rect.width, h: rect.height };
}

/**
 * Dibuja el ratio en el tiempo. La línea es verde sobre el umbral y roja debajo.
 * points: [{ t, ratio|null }] ; opts: { tStart, tEnd, threshold, baseline, xLabels: [[t, texto]] }
 */
export function drawRatioChart(canvas, points, { tStart, tEnd, threshold, baseline, xLabels = [] }) {
  const { c, w, h } = fit(canvas);
  if (w < 10) return;
  const padL = 40, padR = 8, padT = 8, padB = 22;

  let lo = Math.min(threshold, baseline), hi = Math.max(threshold, baseline);
  for (const p of points) if (p.ratio !== null) { lo = Math.min(lo, p.ratio); hi = Math.max(hi, p.ratio); }
  const span = Math.max(hi - lo, 0.2);
  lo -= span * 0.15; hi += span * 0.15;

  const x = (t) => padL + ((t - tStart) / Math.max(1, tEnd - tStart)) * (w - padL - padR);
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);

  // Rejilla y etiquetas del eje Y
  c.font = '500 10px "JetBrains Mono", monospace';
  c.textBaseline = "middle";
  c.fillStyle = MUTED;
  c.strokeStyle = "rgba(255,255,255,.05)";
  c.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    const yy = Math.round(y(v)) + 0.5;
    c.beginPath(); c.moveTo(padL, yy); c.lineTo(w - padR, yy); c.stroke();
    c.textAlign = "right";
    c.fillText(v.toFixed(2), padL - 8, yy);
  }
  c.textBaseline = "alphabetic";
  xLabels.forEach(([t, text], i) => {
    c.textAlign = i === 0 ? "left" : i === xLabels.length - 1 ? "right" : "center";
    c.fillText(text, x(t), h - 6);
  });

  // Zona de mala postura (debajo del umbral)
  const yThr = y(threshold);
  c.fillStyle = "rgba(255,93,108,.06)";
  c.fillRect(padL, yThr, w - padL - padR, h - padB - yThr);

  // Línea de postura ideal y umbral
  c.setLineDash([2, 4]);
  c.strokeStyle = "rgba(62,240,161,.5)";
  c.beginPath(); c.moveTo(padL, y(baseline)); c.lineTo(w - padR, y(baseline)); c.stroke();
  c.setLineDash([6, 5]);
  c.strokeStyle = "rgba(255,255,255,.7)";
  c.beginPath(); c.moveTo(padL, yThr); c.lineTo(w - padR, yThr); c.stroke();
  c.setLineDash([]);

  // Trazo del ratio (con huecos cuando no se detecta a nadie)
  const path = new Path2D();
  let drawing = false;
  for (const p of points) {
    if (p.ratio === null) { drawing = false; continue; }
    const px = x(p.t), py = y(p.ratio);
    if (drawing) path.lineTo(px, py); else path.moveTo(px, py);
    drawing = true;
  }
  c.lineWidth = 2;
  c.lineJoin = "round";
  c.lineCap = "round";
  for (const [color, top, bottom] of [[GOOD, 0, yThr], [BAD, yThr, h]]) {
    c.save();
    c.beginPath(); c.rect(0, top, w, bottom - top); c.clip();
    c.strokeStyle = color;
    c.shadowColor = color;
    c.shadowBlur = 8;
    c.stroke(path);
    c.restore();
  }
}

/** Barra de la sesión completa: un segmento por segundo, coloreado por estado. */
export function drawTimeline(canvas, log) {
  const { c, w, h } = fit(canvas);
  if (!log.length) return;
  const n = log.length;
  const segW = w / n;
  c.save();
  c.beginPath();
  c.roundRect(0, 0, w, h, h / 2);
  c.clip();
  for (let i = 0; i < n; i++) {
    const st = log[i].state;
    c.fillStyle = st === "GOOD" ? GOOD : st === "BAD" ? BAD : AWAY;
    c.fillRect(Math.floor(i * segW), 0, Math.ceil(segW) + 1, h);
  }
  c.restore();
}
