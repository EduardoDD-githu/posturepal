#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PosturePal - Detector de mala postura en tiempo real
====================================================

Usa la cámara web, OpenCV y MediaPipe Pose para detectar si te estás
encorvando mientras trabajas frente a la laptop.

INSTALACIÓN (una sola vez, Python 3.9 - 3.12):
    pip install opencv-python mediapipe==0.10.21 "numpy<2" pillow

USO:
    python posture_pal.py

CONTROLES:
    C -> Calibrar: siéntate con buena postura y presiona C
    Q -> Salir

CÓMO FUNCIONA LA DETECCIÓN:
    Al encorvarte, la cabeza cae hacia adelante y la nariz baja respecto
    a la línea de los hombros. Medimos:

        ratio = (y_punto_medio_hombros - y_nariz) / ancho_de_hombros

    Dividir entre el ancho de hombros hace que la medida no dependa de
    qué tan cerca o lejos estés de la cámara.
      - ratio alto  -> cuello "estirado"  -> postura correcta
      - ratio bajo  -> cabeza hundida     -> encorvado
"""

import math
import os
import platform
import sys
import threading
import time
import unicodedata
from functools import lru_cache

import cv2
import mediapipe as mp
import numpy as np

# Pillow es opcional: se usa solo para dibujar "¡" y tildes correctamente,
# porque cv2.putText no soporta caracteres fuera de ASCII.
try:
    from PIL import Image, ImageDraw, ImageFont
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# Las versiones de MediaPipe >= 0.10.31 eliminaron la API "solutions".
if not hasattr(mp, "solutions"):
    sys.exit(
        "Tu versión de MediaPipe no incluye 'mp.solutions'.\n"
        'Instala una compatible:  pip install mediapipe==0.10.21 "numpy<2"'
    )

mp_pose = mp.solutions.pose
mp_drawing = mp.solutions.drawing_utils

# =============================================================================
# CONFIGURACIÓN (ajusta estos valores a tu gusto)
# =============================================================================
CAMERA_INDEX = 0                 # 0 = cámara integrada; prueba 1 si falla
FRAME_WIDTH, FRAME_HEIGHT = 640, 480
TARGET_FPS = 30                  # FPS solicitados a la cámara

# --- Umbral de postura -------------------------------------------------------
# Si ratio < umbral  -> POSTURA INCORRECTA (encorvado).
# Este valor por defecto es solo una referencia: lo ideal es calibrar con 'C'.
DEFAULT_RATIO_THRESHOLD = 0.50
# Al calibrar, el umbral = ratio de tu buena postura * este factor.
# (0.80 = se alerta si el ratio cae más de un 20 % respecto a tu postura ideal)
CALIBRATION_FACTOR = 0.80

MIN_VISIBILITY = 0.5             # confianza mínima de nariz y hombros
SMOOTHING_ALPHA = 0.3            # suavizado del ratio (0-1; menor = más suave)

# --- Alerta sonora -----------------------------------------------------------
BAD_POSTURE_SECONDS = 2.0        # mala postura continua antes de sonar
BEEP_INTERVAL_SECONDS = 2.0      # cada cuánto se repite el sonido

# Colores en formato BGR (OpenCV)
GREEN = (0, 255, 0)
RED = (0, 0, 255)
YELLOW = (0, 215, 255)
WHITE = (255, 255, 255)

WINDOW_NAME = "PosturePal"

# Solo dibujamos la parte superior del cuerpo (cara, hombros, brazos, manos).
UPPER_BODY_CONNECTIONS = frozenset(
    (a, b) for a, b in mp_pose.POSE_CONNECTIONS if a < 23 and b < 23
)


# =============================================================================
# ALERTA SONORA (se ejecuta en un hilo para no congelar el video)
# =============================================================================
_beep_lock = threading.Lock()


def _beep_blocking():
    """Reproduce un sonido según el sistema operativo."""
    system = platform.system()
    if system == "Windows":
        import winsound
        winsound.Beep(1000, 300)   # frecuencia (Hz), duración (ms)
        winsound.Beep(750, 300)
    elif system == "Darwin":       # macOS
        os.system("afplay /System/Library/Sounds/Ping.aiff")
    else:                          # Linux u otros: campana de la terminal
        sys.stdout.write("\a")
        sys.stdout.flush()


def play_alert():
    """Lanza el sonido en segundo plano (ignora la llamada si ya está sonando)."""
    if not _beep_lock.acquire(blocking=False):
        return

    def worker():
        try:
            _beep_blocking()
        finally:
            _beep_lock.release()

    threading.Thread(target=worker, daemon=True).start()


# =============================================================================
# LÓGICA DE CÁLCULO DE POSTURA
# =============================================================================
def analyze_posture(landmarks, width, height):
    """
    Calcula el ratio de postura a partir de nariz y hombros.

    Devuelve (ratio, nariz_px, hombro_izq_px, hombro_der_px, punto_medio_px)
    o None si algún punto no es suficientemente visible.
    """
    nose = landmarks[mp_pose.PoseLandmark.NOSE.value]
    l_sh = landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER.value]
    r_sh = landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER.value]

    if min(nose.visibility, l_sh.visibility, r_sh.visibility) < MIN_VISIBILITY:
        return None

    # Coordenadas normalizadas (0-1) -> píxeles
    nose_px = (nose.x * width, nose.y * height)
    l_px = (l_sh.x * width, l_sh.y * height)
    r_px = (r_sh.x * width, r_sh.y * height)
    mid_px = ((l_px[0] + r_px[0]) / 2, (l_px[1] + r_px[1]) / 2)

    shoulder_width = math.dist(l_px, r_px)
    if shoulder_width < 1:
        return None

    # Distancia vertical nariz -> punto medio de hombros, normalizada.
    ratio = (mid_px[1] - nose_px[1]) / shoulder_width
    return ratio, nose_px, l_px, r_px, mid_px


# =============================================================================
# RENDERIZADO DE TEXTO (con soporte para "¡" y tildes)
# =============================================================================
_FONT_CANDIDATES = [
    "arialbd.ttf",                                           # Windows
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",     # macOS
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # Linux
    "DejaVuSans-Bold.ttf",
]


@lru_cache(maxsize=None)
def _load_font(size):
    """Busca una fuente TrueType disponible en el sistema (None si no hay)."""
    if not PIL_AVAILABLE:
        return None
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return None


def draw_texts(frame, items):
    """
    Dibuja varios textos sobre el frame.
    items: lista de (texto, (x, y_superior), tamaño_px, color_bgr)
    """
    if not items:
        return

    if PIL_AVAILABLE and all(_load_font(size) for _, _, size, _ in items):
        # Ruta preferida: Pillow (soporta Unicode completo)
        img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(img)
        for text, pos, size, (b, g, r) in items:
            draw.text(pos, text, font=_load_font(size), fill=(r, g, b))
        frame[:] = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    else:
        # Plan B: OpenCV puro (se eliminan "¡" y tildes, que no soporta)
        for text, (x, y), size, color in items:
            ascii_text = (unicodedata.normalize("NFKD", text)
                          .encode("ascii", "ignore").decode())
            cv2.putText(frame, ascii_text, (x, y + size),
                        cv2.FONT_HERSHEY_SIMPLEX, size / 32, color, 2,
                        cv2.LINE_AA)


def draw_dark_bands(frame, top_h, bottom_h):
    """Franjas semitransparentes arriba y abajo para que el texto se lea bien."""
    h, w = frame.shape[:2]
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, top_h), (0, 0, 0), -1)
    cv2.rectangle(overlay, (0, h - bottom_h), (w, h), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)


# =============================================================================
# PROGRAMA PRINCIPAL
# =============================================================================
def main():
    # --- 1. CAPTURA DE CÁMARA (OpenCV) ---------------------------------------
    cap = cv2.VideoCapture(CAMERA_INDEX)
    if not cap.isOpened():
        sys.exit(f"No se pudo abrir la cámara (índice {CAMERA_INDEX}). "
                 "Cierra otras apps que la usen o cambia CAMERA_INDEX.")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    cap.set(cv2.CAP_PROP_FPS, TARGET_FPS)

    # Estado del programa
    threshold = DEFAULT_RATIO_THRESHOLD
    smoothed_ratio = None        # ratio suavizado (None = no hay usuario)
    bad_since = None             # momento en que empezó la mala postura
    last_beep = 0.0
    fps = 0.0
    prev_time = time.monotonic()
    notice_text, notice_until = "", 0.0   # mensajes temporales (calibración)

    print("PosturePal iniciado. Presiona 'C' para calibrar y 'Q' para salir.")

    # --- 2. PROCESAMIENTO CON MEDIAPIPE POSE ---------------------------------
    # model_complexity=0 (modelo ligero) asegura ~30 FPS en CPU de laptop.
    # Cámbialo a 1 si quieres más precisión y tu equipo lo aguanta.
    with mp_pose.Pose(model_complexity=0,
                      smooth_landmarks=True,
                      min_detection_confidence=0.5,
                      min_tracking_confidence=0.5) as pose:
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    print("No se pudo leer el frame de la cámara.")
                    break

                frame = cv2.flip(frame, 1)          # efecto espejo
                h, w = frame.shape[:2]

                # MediaPipe necesita RGB; marcar como solo-lectura acelera
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                results = pose.process(rgb)

                # --- 3. LÓGICA DE DETECCIÓN ----------------------------------
                measurement = None
                if results.pose_landmarks:
                    measurement = analyze_posture(
                        results.pose_landmarks.landmark, w, h)

                now = time.monotonic()
                if measurement is None:
                    state = "NO_USER"
                    smoothed_ratio = None
                else:
                    ratio = measurement[0]
                    smoothed_ratio = (ratio if smoothed_ratio is None else
                                      SMOOTHING_ALPHA * ratio
                                      + (1 - SMOOTHING_ALPHA) * smoothed_ratio)
                    state = "GOOD" if smoothed_ratio >= threshold else "BAD"

                # Temporizador de mala postura + alerta sonora
                bad_elapsed = 0.0
                if state == "BAD":
                    if bad_since is None:
                        bad_since = now
                    bad_elapsed = now - bad_since
                    if (bad_elapsed >= BAD_POSTURE_SECONDS
                            and now - last_beep >= BEEP_INTERVAL_SECONDS):
                        play_alert()
                        last_beep = now
                else:
                    bad_since = None   # se reinicia al corregir la postura

                # --- 4. RENDERIZADO EN PANTALLA ------------------------------
                color = {"GOOD": GREEN, "BAD": RED, "NO_USER": YELLOW}[state]

                # Esqueleto de la parte superior del cuerpo
                if results.pose_landmarks:
                    mp_drawing.draw_landmarks(
                        frame,
                        results.pose_landmarks,
                        UPPER_BODY_CONNECTIONS,
                        landmark_drawing_spec=mp_drawing.DrawingSpec(
                            color=color, thickness=3, circle_radius=4),
                        connection_drawing_spec=mp_drawing.DrawingSpec(
                            color=color, thickness=3),
                    )

                # Línea de medición: hombros y nariz -> punto medio
                if measurement is not None:
                    _, nose_px, l_px, r_px, mid_px = measurement
                    p = lambda pt: (int(pt[0]), int(pt[1]))
                    cv2.line(frame, p(l_px), p(r_px), WHITE, 2, cv2.LINE_AA)
                    cv2.line(frame, p(nose_px), p(mid_px), WHITE, 2,
                             cv2.LINE_AA)
                    cv2.circle(frame, p(mid_px), 6, WHITE, -1)

                # FPS reales
                dt = now - prev_time
                prev_time = now
                if dt > 0:
                    fps = 0.9 * fps + 0.1 * (1.0 / dt) if fps else 1.0 / dt

                # Franjas oscuras + textos
                big = max(20, int(w * 0.045))   # tamaño del mensaje principal
                small = max(14, int(w * 0.026))
                top_h, bottom_h = big + 24, small * 2 + 20
                draw_dark_bands(frame, top_h, bottom_h)

                main_text = {
                    "GOOD": "POSTURA CORRECTA",
                    "BAD": "¡ALERTA: CORRIGE TU POSTURA!",
                    "NO_USER": "No se detectan tu cabeza y hombros",
                }[state]
                texts = [(main_text, (15, 12), big, color)]

                if state == "BAD":
                    texts.append((f"Mala postura: {bad_elapsed:.1f} s",
                                  (15, top_h + 8), small, RED))
                if now < notice_until:
                    texts.append((notice_text, (15, top_h + 8 + small + 6),
                                  small, WHITE))

                ratio_txt = (f"{smoothed_ratio:.2f}"
                             if smoothed_ratio is not None else "--")
                texts.append((f"Ratio: {ratio_txt}  |  Umbral: {threshold:.2f}"
                              f"  |  FPS: {fps:.0f}",
                              (15, h - bottom_h + 8), small, WHITE))
                texts.append(("[C] Calibrar postura     [Q] Salir",
                              (15, h - bottom_h + 8 + small + 6), small, WHITE))
                draw_texts(frame, texts)

                cv2.imshow(WINDOW_NAME, frame)

                # --- 5. TECLADO ----------------------------------------------
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), ord("Q")):
                    break
                if key in (ord("c"), ord("C")):
                    if smoothed_ratio is not None:
                        threshold = smoothed_ratio * CALIBRATION_FACTOR
                        notice_text = (f"Calibrado: umbral = {threshold:.2f}")
                        print(notice_text)
                    else:
                        notice_text = "No se pudo calibrar: no te detecto."
                    notice_until = now + 2.5

                # También sale si se cierra la ventana con la "X"
                if cv2.getWindowProperty(WINDOW_NAME,
                                         cv2.WND_PROP_VISIBLE) < 1:
                    break

        except KeyboardInterrupt:
            pass
        finally:
            # --- 6. LIMPIEZA ---------------------------------------------
            cap.release()
            cv2.destroyAllWindows()
            print("PosturePal cerrado.")


if __name__ == "__main__":
    main()