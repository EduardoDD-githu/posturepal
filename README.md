# PosturePal

Detector de mala postura en tiempo real con inteligencia artificial (MediaPipe Pose).

El proyecto tiene dos versiones:

| Versión | Archivo | Para qué |
|---|---|---|
| **Web (recomendada)** | carpeta [`web/`](web/) | Panel de escritorio en el navegador (Chrome/Edge recomendados), sin instalar nada. |
| Escritorio (original) | [`posture_pal.py`](posture_pal.py) | Script de Python con OpenCV. |

### Funciones de la versión web

- Video en vivo con esqueleto, línea de medición y medidor vertical del ratio.
- **Puntaje de postura** de 0 a 100 (100 = tu postura calibrada; la alarma salta por debajo de 80).
- **Gráfico de los últimos 60 s** y línea de tiempo de toda la sesión.
- Métricas: % de tiempo con buena postura, alertas, mejor racha e inclinación de hombros y cabeza.
- Calibración con cuenta regresiva y ajustes de sensibilidad, retraso de la alerta y volumen.
- **Funciona en segundo plano**: sigue midiendo aunque estés en otra ventana. Además cambian el título y el ícono de la pestaña, y hay notificaciones de escritorio y una **ventana flotante** (Chrome/Edge) que queda siempre visible.
- Recordatorio de **pausas activas** cada 20 a 60 minutos.
- **Reporte de la sesión** con gráfico y botón para descargar los datos en CSV (útil para el análisis de la feria).
- Atajos: `C` calibrar · `Espacio` pausar · `F` ventana flotante · `S` sonido · `?` ayuda.

La versión web usa exactamente la misma fórmula que el script de Python:

```
ratio = (altura de los hombros − altura de la nariz) ÷ ancho de hombros
```

Todo el procesamiento ocurre **dentro del dispositivo** (WebAssembly + GPU). El video nunca se sube a ningún servidor.

---

## Sitio publicado

👉 **https://eduardodd-githu.github.io/posturepal/**

Repositorio: <https://github.com/EduardoDD-githu/posturepal>. GitHub Pages publica la rama `gh-pages`, que contiene solo la carpeta `web/`.

## Ejecutarla localmente

Desde la carpeta del proyecto:

```bash
python -m http.server 8000 --directory web
```

y abrir <http://localhost:8000>.

## Créditos y licencias

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 0.10.35 y el modelo *Pose Landmarker Lite* — © Google, licencia Apache 2.0.
- [qrcodejs](https://github.com/davidshimjs/qrcodejs) — licencia MIT.
