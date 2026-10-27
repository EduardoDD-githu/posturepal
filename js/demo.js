/*
 * Animación de la portada: una figura alterna entre postura correcta y
 * encorvada, mostrando cómo cambia el ratio h ÷ w.
 */
const $ = (id) => document.getElementById(id);
const SHOULDER_Y = 185, SHOULDER_W = 160, CX = 200;
const DEMO_THRESHOLD = 0.45, BAR_MAX = 0.8;   // el umbral queda en el 56 % de la barra
const CYCLE_MS = 7000;

let rafId = 0;

/** 0 = derecho, 1 = encorvado. Mantiene cada postura un rato y transiciona suave. */
function slouchAt(t) {
  const p = (t % CYCLE_MS) / CYCLE_MS;
  const ease = (x) => x * x * (3 - 2 * x);
  if (p < 0.35) return 0;
  if (p < 0.5) return ease((p - 0.35) / 0.15);
  if (p < 0.85) return 1;
  return 1 - ease((p - 0.85) / 0.15);
}

function frame(s) {
  const headY = 78 + s * 52;
  const noseY = headY + 12;
  const sy = SHOULDER_Y + s * 4;
  const lx = CX - SHOULDER_W / 2, rx = CX + SHOULDER_W / 2;
  const ratio = (sy - noseY) / SHOULDER_W;
  const bad = ratio < DEMO_THRESHOLD;

  $("demo-head").setAttribute("cy", headY);
  $("demo-nose").setAttribute("cy", noseY);
  $("demo-neck").setAttribute("y1", noseY);
  $("demo-neck").setAttribute("y2", sy);
  for (const id of ["demo-ls", "demo-rs", "demo-mid"]) $(id).setAttribute("cy", sy);
  $("demo-shoulders").setAttribute("y1", sy);
  $("demo-shoulders").setAttribute("y2", sy);
  $("demo-h-label").setAttribute("y", (noseY + sy) / 2 + 5);
  $("demo-body").setAttribute("d",
    `M ${lx} ${sy} C ${lx - 38} ${sy + 4} ${lx - 52} ${sy + 40} ${lx - 56} 320 L ${rx + 56} 320 C ${rx + 52} ${sy + 40} ${rx + 38} ${sy + 4} ${rx} ${sy} Z`);

  $("demo-ratio").textContent = ratio.toFixed(2);
  $("demo-bar-fill").style.width = `${Math.min(100, (ratio / BAR_MAX) * 100)}%`;
  $("demo-chip-text").textContent = bad ? "¡Corrige tu postura!" : "Postura correcta";
  $("demo-svg").closest(".demo-frame").classList.toggle("is-bad", bad);
}

export function startDemo() {
  document.querySelector(".demo-threshold").style.left = `${(DEMO_THRESHOLD / BAR_MAX) * 100}%`;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { frame(0); return; }
  const loop = (t) => { frame(slouchAt(t)); rafId = requestAnimationFrame(loop); };
  rafId = requestAnimationFrame(loop);
}

export function stopDemo() {
  cancelAnimationFrame(rafId);
}
