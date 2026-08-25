# Subidas de imagen — auditoría de los seis caminos

Estado: **aprobada** (2026-08-24) · Módulos: `activities`, `announcements`, `courses`, `rooms`

## Por qué se hizo

Pedido del usuario: *"revisá todas las formas donde los docentes o alumnos suben imágenes y
chequeá que esté andando, porque sigo recibiendo problemas con ese paso pero no logro
identificar dónde"*.

La investigación anterior ([[diagnostico_subidas]], 18/08) había medido las subidas que
**fallaban en la red** y cerró bien: era el Funnel, no el código — 1003 de 1023 requests
llegaban y se procesaban. Lo que no podía ver, por construcción, es la clase de falla que se
encontró acá: **la request llega, el servidor contesta 200/201 y la imagen igual no queda**.
Una subida así se contaba como una de las 1003 exitosas.

## Los seis caminos, y en qué estado estaban

| # | Camino | Quién | Ruta | Antes |
|---|--------|-------|------|-------|
| 1 | Avatar | todos | `POST /courses/profile/avatar` | 400, pero el cartel enumeraba "JPG, PNG, WebP o GIF" — hacía dos semanas que aceptaba HEIC |
| 2 | Portada de la materia | docente | `POST /courses/:id/customize` | 🔴 **silencioso** |
| 3 | Imagen de una novedad | docente y alumno | `POST /announcements/create` | 🔴 **silencioso** |
| 4 | Imagen adjunta a la actividad | docente | `POST /activities/upload-image` | ✅ 400 con la lista |
| 5 | Foto en la sala en vivo | docente y alumno | `POST /courses/:id/sala/adjuntos/imagen` | ✅ 400 con la lista |
| 6 | Foto en la entrega | alumno | `POST /activities/:id/upload-submission-file` | 🔴 **lista propia, ya vieja** |

Los tres primeros son más viejos que los tres últimos, y ahí está toda la historia: el
`if (!req.file)` explícito se escribió en la sala (11/08) y se copió al adjunto de la
actividad (19/08) **cada vez que el caso se reportó**, pero nunca se llevó hacia atrás ni
al middleware compartido. La lección quedó escrita en dos rutas en vez de en el lugar por
el que pasan todas.

## Los tres hallazgos

### 1. 🔴 La imagen se descartaba en silencio (novedad y portada)

`fileFilter` de multer contestaba `cb(null, false)`, que significa *"descartá este archivo y
seguí"*. El handler recibe `req.file === undefined`, **indistinguible de "no adjuntó nada"**,
y las dos rutas donde la imagen es opcional hacían `if (req.file)` y seguían de largo.

Medido el 2026-08-24 contra el espejo local:

```
POST /announcements/create  con  prueba.jfif  →  201  { image: null }
POST /announcements/create  con  prueba.bmp   →  201  { image: null }
POST /announcements/create  con  prueba.avif  →  201  { image: null }
POST /courses/:id/customize con  portada.jfif →  200  { image: null }
```

La docente publica la novedad, la ve sin la foto, y **no hay nada que investigar**: no hay
cartel, no hay línea en el log, no hay código `SUB-XXXXXX` (el diagnóstico solo se dispara
cuando falla la red, no cuando el servidor contesta que sí). Es exactamente el reporte que
llegaba: *"a veces no sube la imagen"*, sin nada más.

**Arreglo**: el `fileFilter` **anota** el rechazo en `req.imagenRechazada`, y `subirImagen()`
contesta 400 con la extensión + la lista completa y lo **loguea** con `logRechazo`. Como vive
en el middleware compartido, vale para los seis caminos y para cualquiera que se agregue.

⚠️ **Y no, `cb(err)` no era la salida fácil.** El primer intento rechazaba con error, que hace
que multer aborte el parseo: el servidor contesta el 400 mientras el navegador **todavía está
subiendo**, la conexión queda a medio camino y el pedido SIGUIENTE de ese socket muere con
`fetch failed`. Se vio enseguida en el smoke — dos specs sin relación entre sí, los dos justo
después de uno que rechazaba una imagen. Con la marca, multer termina de leer el cuerpo (la
conexión queda sana, igual que antes) y el 400 sale después.

### 2. La lista de formatos rechazaba cosas que sí sabemos leer

`.jfif` **es un JPEG**: es lo que guarda Chrome en Windows con "Guardar imagen como", así que
le pasaba a cualquiera que bajara una lámina. `.avif` es lo que sirven hoy muchos sitios.
Los dos los decodifica sharp sin problema.

**Arreglo**: `EXT_IMAGENES` pasa a `.jpg .jpeg .jfif .png .webp .gif .avif .tif .tiff .heic
.heif`. `.bmp` queda afuera **a propósito**: este libvips no lo decodifica, y aceptarlo por
extensión cambiaría un rechazo honesto por un *"El archivo no es una imagen válida"* que
miente sobre un BMP sano. Los `accept=` de las seis pantallas se alinearon con la lista
(conservando `image/*`, que es lo que hace aparecer la cámara en el celular).

### 3. La entrega del alumno era el único camino sin optimizador

Tenía **su propia lista** de extensiones, escrita a mano, que se quedó sin `.heic` ni
`.webp` cuando el resto de la aplicación ya los aceptaba. El alumno que entregaba la foto de
su carpeta desde un iPhone recibía:

> Tipo de archivo no permitido (PDF, Word, Excel, **imágenes** o ZIP)

— un cartel que nombra a las imágenes entre lo permitido mientras rechaza una.

Y lo que sí entraba se guardaba **entero**: varios MB por alumno por entrega, y cuanto más
tarda una subida más expuesta está a los cortes de 1-2 minutos del Funnel.

**Arreglo** (decisión del usuario, 2026-08-24): ruta propia
`POST /activities/:id/upload-submission-image` — multer en memoria → sharp → WebP → disco,
igual que el adjunto del docente. Medido: 776 KB → 184 KB (76 % menos). La respuesta es
idéntica a la de la ruta de archivos, así que el submit no distingue por dónde entró.

## Reglas que deja

1. **Un rechazo de subida siempre se ve**: cartel para el usuario y línea en el log. Un fallo
   que no deja rastro no se puede arreglar, y este vivió semanas. Las dos formas de escribirlo
   mal están las dos probadas: `cb(null, false)` a secas descarta en silencio, `cb(err)` corta
   la conexión a mitad de subida. Lo correcto es anotar y contestar después de multer.
2. **La lista de imágenes vive en un solo lugar** (`config/imagePresets.js`), con su copia
   obligada para el navegador (`public/js/adjuntosActividad.js`) y un test que las compara.
   Ninguna pantalla arma su propia lista: el bug nº 3 fue exactamente eso.
3. **Toda imagen pasa por el optimizador antes de tocar el disco.** Ya no hay excepciones.
4. **El permiso se chequea antes de multer**, no adentro del handler.

## Lo que NO se cambió, y por qué

- **`.bmp` sigue rechazado**: libvips no lo decodifica (ver arriba).
- **Los documentos de la entrega** (PDF, Word, Excel, ZIP) siguen en `diskStorage` y enteros:
  no hay nada que optimizar y son de hasta 20 MB, que no tienen por qué pasar por RAM. El
  spec `entrega-pdf-no-se-toca` vigila esa frontera.
- **Las imágenes siguen en `EXT_SUBMISSIONS`** aunque ya no entren por ahí: un navegador con
  el JS viejo en cache manda la foto a la ruta de archivos, y es mejor que se guarde entera a
  que le rebote.
- **Los 429 del `uploadLimiter` siguen sin contarse** en el panel del monitor: `registrarBloqueo`
  se llama solo desde el `handler` del `generalLimiter`, y los baldes de telemetría guardan un
  único `limite` por minuto — sumar un segundo limiter mezclaría 12000 con 1800 y haría
  ilegible el pico. Queda anotado; mientras tanto los 429 **sí** quedan en el access log.

## El HEIC del iPhone: medido, y la respuesta es que NO

Verificado el 2026-08-24 en las dos máquinas (Windows de desarrollo y Ubuntu de producción,
las dos con libvips 8.17.3):

```
input: { file: true, buffer: true, stream: true, fileSuffix: [ '.avif' ] }
```

**`fileSuffix` trae `.avif` y nada más.** El loader heif existe, pero está compilado para
**AV1** (AVIF); el HEIC del iPhone es **HEVC**, que tiene patentes y no viene en el binario
precompilado de sharp. O sea: **este servidor no puede leer un HEIC de iPhone**, y no es un
problema de configuración de la aplicación.

### El instrumento mentía (otra vez)

`heifSoportado()` miraba `sharp.format.heif.input.buffer`, que da `true` igual. Y esa función
decide **la severidad del log**: cada foto de iPhone rechazada dejaba un

> WARN — No se pudo decodificar un HEIC/HEIF (el loader está disponible)

…culpando a la foto de la docente y mandando a quien investigara a la capa equivocada. Es el
mismo modo de falla que ya habían tenido `mb()` y `veredicto()` en el diagnóstico de subidas:
la herramienta no se rompe, **afirma con seguridad algo que no midió**.

Ahora `heifSoportado()` lee la lista de sufijos, que es lo que libvips arma según los
decodificadores que encontró de verdad.

### Qué ve la persona

Como el códec no está, el `.heic` se rechaza **en el fileFilter, en el primer segundo**, en
vez de dejar que la foto de 5 MB viaje entera por la red del aula para morir al decodificar.
El cartel es el mismo en los dos caminos (una constante compartida,
`MENSAJE_HEIC_SIN_CODEC`):

> No pudimos leer esta foto de iPhone. Volvé a enviarla como JPG: en el iPhone,
> Ajustes → Cámara → Formatos → "Más compatible".

Y la falta de códec se avisa **una sola vez al arrancar el worker**, no en cada intento: es un
hecho de la instalación, no de cada foto.

### Decisión del usuario: opción A — las cámaras en "Más compatible"

No se reconstruye sharp. Y eso tiene una consecuencia en el código que **no es evidente**:

⚠️ **`.heic` NO va en los `accept=` de los formularios**, aunque sí esté en `EXT_IMAGENES`.
Safari en iOS decide qué mandar mirando el `accept`: con `image/*` **convierte la foto a JPG en
el camino**, pero si el formulario dice que acepta HEIC, le manda el original. Nombrarlas ahí
es pedirle al teléfono justo lo único que no sabemos leer. (Este spec nació listándolas — se
corrigió al elegir la opción A.)

Siguen en `EXT_IMAGENES` igual, y no es contradicción: si un HEIC llega de todas formas (desde
la app Archivos, desde un navegador de terceros), la persona recibe el cartel que le explica
qué hacer y no un "formato no permitido" que no explica nada.

El cartel da **dos consejos y en ese orden**, porque resuelven cosas distintas: elegir la foto
desde **Fotos** arregla la que ya sacaron y tienen que entregar hoy; el ajuste de la cámara
evita que vuelva a pasar.

### Si algún día se cambia de idea (opción B)

Hay que reconstruir sharp contra un libvips del sistema que traiga libheif con el decodificador
HEVC (`libde265`), que Ubuntu sí empaqueta:

```bash
sudo apt install libvips-dev libheif-dev libde265-0
cd /home/walter/classroom
SHARP_FORCE_GLOBAL_LIBVIPS=1 npm install --build-from-source sharp
```

Es una tarea de servidor con su riesgo (compila). El día que se haga hay que **revisar las
dos caras**: el rechazo rápido del `fileFilter` se apaga solo (pregunta por `heifSoportado()`),
pero los `accept=` hay que volver a tocarlos a mano.

## Lo que queda para producción

**Cuántas veces pasó de verdad.** El log lo sabe, y es la única medición que falta:

```bash
grep -h "decodificar HEIC" /home/walter/classroom/logs/*.log | wc -l
```

Si el número es alto, conviene evaluar la reconstrucción de sharp de acá arriba; si es cero o
casi, alcanza con el cartel. Ojo al leer las líneas VIEJAS: dicen "el loader está disponible"
porque las escribió la versión que se equivocaba.

## Tests

- `tests/unit/subidaImagenes.test.js` (24) — una sola lista; el rechazo que deja marca sin
  cortar la conexión; el códec HEIC y la detección que antes mentía; lo que declara cada
  pantalla; y el reparto de la entrega.
- `tests/smoke/specs.js`, sobre los 10 specs de imagen que ya existían:
  `novedad-imagen-rara-avisa-en-vez-de-descartar`, `novedad-imagen-jfif-entra`,
  `portada-imagen-rara-avisa`, `entrega-foto-se-recomprime`, `entrega-foto-de-iphone`,
  `entrega-foto-de-un-ajeno-no-entra`.
