# PosturePal

Detector de mala postura en tiempo real con inteligencia artificial (MediaPipe Pose).

El proyecto tiene dos versiones:

| Versión | Archivo | Para qué |
|---|---|---|
| **Web (recomendada)** | carpeta [`web/`](web/) | Panel de escritorio en el navegador (Chrome/Edge recomendados), sin instalar nada. |
| Escritorio (original) | [`posture_pal.py`](posture_pal.py) | Script de Python con OpenCV. |

### Funciones de la versión web

- Video en vivo con esqueleto, línea de medición y medidor vertical del ratio.
- **Puntaje de postura** de 0 a 100 (100 = tu postura calibrada, 50 = el umbral).
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

Todo el procesamiento ocurre **dentro de tu computadora** (WebAssembly + GPU). El video nunca se sube a ningún servidor.

---

## Publicarla gratis (≈10 minutos) — GitHub Pages

La cámara del celular **solo funciona en páginas `https://`**, por eso hay que publicarla (no basta abrir el archivo). GitHub Pages es gratis, permanente y ya trae https.

1. Crea una cuenta gratis en <https://github.com> (si no tienen).
2. Arriba a la derecha: **+ → New repository**.
   - Nombre: `posturepal` · Marcar **Public** · **Create repository**.
3. En la página del repositorio nuevo, haz clic en **“uploading an existing file”**.
4. Abre la carpeta `web` en tu computadora, **selecciona todo lo que hay dentro** (no la carpeta, sino su contenido: `index.html`, `css`, `js`, `models`, `vendor`, `icons`, etc.) y arrástralo a la página. Espera a que suba todo (≈27 MB) y pulsa **Commit changes**.
5. Ve a **Settings → Pages**. En *Branch* elige **main** y carpeta **/ (root)** → **Save**.
6. Espera 1–2 minutos. La app quedará en:

   ```
   https://TU-USUARIO.github.io/posturepal/
   ```

### Alternativa: Netlify Drop
Crea una cuenta gratis en <https://app.netlify.com/drop> y arrastra la carpeta `web` completa. Te da una dirección `https://algo.netlify.app` al instante (se puede renombrar en *Site settings*).

---

## Para la feria de ciencias

1. Abre `https://TU-USUARIO.github.io/posturepal/cartel.html` en la computadora.
2. Verifica que la dirección de arriba sea la correcta y pulsa **Imprimir**. Sale una hoja con el **código QR** e instrucciones.
3. Los visitantes escanean el QR con la cámara de su celular → se abre en Safari/Chrome → **Iniciar cámara** → **Calibrar** → se encorvan y suena la alerta.

**Consejos:**
- La primera vez cada celular descarga ≈17 MB (el modelo de IA). Después queda guardado y abre sin internet. Si el wifi de la feria es malo, que usen sus datos móviles.
- Abran el QR con la **cámara normal** del teléfono. Si lo abren dentro de Instagram/WhatsApp/TikTok, la cámara puede no funcionar: hay que abrirlo en Safari o Chrome.
- En iPhone el sonido no se escucha si el interruptor de silencio está activado; la alerta visual (pantalla roja) igual aparece. En Android además vibra.
- Lleven un soporte o apoyen el teléfono frente a ustedes para que se vean cabeza y hombros.

---

## Probarla en tu computadora (sin publicar)

Desde la carpeta del proyecto:

```bash
python -m http.server 8000 --directory web
```

y abre <http://localhost:8000>. (En `localhost` la cámara funciona sin https; desde otro celular de la misma red no.)

## Si cambian el código

Después de editar archivos dentro de `web/`, abre `web/sw.js` y sube la versión (`posturepal-v1` → `posturepal-v2`). Así los teléfonos que ya la abrieron descargan la versión nueva.

## Créditos y licencias

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 0.10.35 y el modelo *Pose Landmarker Lite* — © Google, licencia Apache 2.0.
- [qrcodejs](https://github.com/davidshimjs/qrcodejs) — licencia MIT.
