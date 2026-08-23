# Imágenes adjuntas al crear una actividad

Estado: **aprobada e implementada** (2026-08-19) · Módulo: `activities`

Las dos decisiones de forma las cerró el usuario antes de escribir código: la imagen se ve como
**miniatura en la lista de adjuntos** (no embebida a lo ancho dentro de la actividad), y en el
**muro** sigue yendo solo el chip (que ahora dice *"1 imagen"*), no una miniatura en la tarjeta.

## Problema

Al crear una actividad el docente puede adjuntar PDF, Word, Excel y enlaces, pero **no una
imagen**: `EXT_ALLOWED` (routes/activities.js) acepta solo `.pdf .doc .docx .xls .xlsx`. La
foto del pizarrón, el mapa, la consigna escaneada o la captura de un ejercicio —lo que más
rápido se genera en el aula— hoy hay que subirla a Drive y pegar el enlace.

Es la única pata que falta, y eso lo hace más raro todavía:

- el **visor de adjuntos ya sabe mostrar imágenes** a pantalla completa (`_isImage` en
  `public/js/course.js`), pero ninguna imagen puede llegar nunca hasta ahí;
- el **alumno ya puede entregar imágenes** (`EXT_SUBMISSIONS` incluye jpg/png/gif);
- la **docente ya comparte fotos en la sala en vivo** desde el 19/08.

## Alcance

1. Las **dos** pantallas de creación aceptan imágenes:
   - el creador de pantalla completa (`views/activities/new.ejs`),
   - el modal rápido de la materia (`views/course.ejs` + `public/js/course.js`), que es el
     mismo que abre el botón "Crear actividad" de la sala en vivo.
2. Extensiones: las mismas que el resto de la plataforma — `.jpg .jpeg .png .webp .gif .heic
   .heif` (`EXT_IMAGENES` de `config/imagePresets.js`). **HEIC incluido**: es lo que sale de
   la cámara del iPhone y ya nos mordió una vez.
3. Toda imagen se recomprime a **WebP** antes de tocar el disco, con un preset propio
   (`adjunto`), igual que avatares, portadas, novedades y la sala.
4. El alumno la ve en la lista de adjuntos **con miniatura**; al tocarla se abre a pantalla
   completa en el visor que ya existe, con su botón de descarga.

**Fuera de alcance:** agregar o quitar adjuntos al **editar** una actividad ya creada
(`PUT /activities/:id` no toca adjuntos hoy para ningún tipo de archivo, así que sería una
feature aparte); pegar o arrastrar imágenes dentro del texto de la consigna; imágenes en las
plantillas del gestor de actividades.

## Modelo

**Sin cambios de esquema.** La imagen es un `attachment` más: `{ type: 'file', name, url,
mime }`. Se distingue de un PDF por la extensión del nombre, que es lo que ya mira el visor.

Consecuencia: **nada que migrar en producción**, y las actividades viejas siguen igual.

## Rutas

### `POST /activities/upload-image?courseId=…` — nueva

Espeja a `/upload-attachment`, pero con el pipeline de imágenes:

| | `/upload-attachment` (existente) | `/upload-image` (nueva) |
|---|---|---|
| storage de multer | disco | **memoria** |
| tope de entrada | 50 MB | **20 MB** (`MAX_INPUT_BYTES`) |
| qué se guarda | el archivo tal cual | WebP recomprimido (preset `adjunto`) |
| respuesta | `{ url, name, mime }` | `{ url, name, mime }` — **idéntica** |

Misma respuesta a propósito: el frontend mete lo que devuelve cualquiera de las dos en el
mismo `uploadedFiles`, y `POST /create` no se entera de la diferencia.

El archivo se guarda en el directorio que ya se usa para los adjuntos del docente:
`public/archivos/{schoolId}/actividades/{courseId}/`.

### `POST /activities/create` — un solo agregado

El modal rápido hoy manda los archivos crudos en el campo `files`. Las **imágenes** no van
por ahí: se pre-suben a `/upload-image` apenas se eligen y viajan en `uploadedFiles`, el
campo que ya existía para el creador de pantalla completa. Los PDF/Word/Excel del modal
siguen exactamente igual.

Se agrega una validación que faltaba: una entrada de `uploadedFiles` solo se acepta si su
`url` empieza con `/archivos/`. Hoy el servidor guarda como adjunto cualquier URL que le
manden en ese campo, y eso lo termina viendo el alumno.

### Permiso antes de multer

`exigirGestorDelCurso` — guard nuevo — resuelve el curso desde `?courseId=` y corta con
404/403 **antes** de que multer empiece a recibir el cuerpo. Lo usan las dos rutas de
subida. Es la regla que ya dejó escrita la sala en vivo: el chequeo tardío deja el archivo
escrito igual, y hoy `/upload-attachment` escribe 50 MB en el disco de una materia ajena
antes de contestar 403 y borrarlos.

## Preset de imagen

`PRESETS.adjunto` en `config/imagePresets.js`: 2000×2000, `fit: 'inside'`, calidad 82.

Más grande que `novedad` (1600) a propósito: una novedad se **mira**, un adjunto de
actividad muchas veces se **lee** — una consigna fotografiada, un ejercicio con números
chicos — y el alumno le va a hacer zoom. Sigue siendo ~10× menos que el original del celular.

## Reglas de negocio

- **RN-1.** Solo quien puede administrar el curso (`course.canManage`) sube imágenes a él.
  El alumno recibe 403, esté o no matriculado.
- **RN-2.** La validación de que "esto es una imagen" la hace sharp al decodificar, no la
  extensión. Un `.png` que no es un PNG se rechaza con 400.
- **RN-3.** El nombre visible lleva la extensión que quedó **en disco**: si sube
  `pizarron.jpg` se muestra `pizarron.webp`. Mostrar `.jpg` haría que el archivo descargado
  no coincida con su propio nombre (misma regla que la sala).
- **RN-4.** Si sharp no está disponible en el server, la imagen se guarda **sin optimizar**
  en vez de rechazarse. Se pierde la compresión, no el servicio.
- **RN-5.** El botón "Crear" queda deshabilitado mientras haya una imagen subiendo, en las
  dos pantallas. En el modal rápido eso no existía y hay que agregarlo.
- **RN-6.** Borrar la actividad borra sus imágenes del disco. Ya funciona sin tocar nada: el
  borrado barre todo `attachment` de tipo `file` cuya URL cuelgue de `/archivos/`.

## Errores posibles

| situación | código | mensaje |
|---|---|---|
| no es docente del curso | 403 | "Sin acceso al curso" |
| curso inexistente | 404 | "Curso no encontrado" |
| extensión fuera de la lista | 400 | "Esa imagen no se puede compartir. Aceptamos: …" |
| el archivo no es una imagen | 400 | el de `ImagenInvalidaError` |
| más de 20 MB | 413 | "La imagen es demasiado grande (máximo 20 MB)" |
| HEIC sin códec en el server | 400 | el de `imageOptimizer` (ya explica qué hacer) |

## Criterios de aceptación

1. La docente elige una foto en el creador de pantalla completa → se sube sola, la tarjeta
   muestra la **miniatura** de la imagen, y al crear la actividad queda como adjunto.
2. Lo mismo desde el modal rápido de la materia (y desde la sala en vivo, que usa ese modal).
3. Un `.heic` de iPhone entra y queda publicado como `.webp` — al alumno le llega un formato
   que su navegador entiende.
4. Una foto de 4 MB del celular queda guardada en unos cientos de KB, no en 4 MB.
5. El alumno abre la actividad, ve la miniatura y al tocarla la ve a pantalla completa.
6. Un alumno que llama a `/upload-image` de su propia materia recibe **403**.
7. Un `.txt` renombrado a `.png` recibe **400**, no un 500 ni un adjunto roto.
8. Un `.exe` recibe **400** por extensión, sin llegar a leerse.
9. Borrar la actividad deja el directorio sin la imagen.
10. Los adjuntos que NO son imágenes (PDF, Word, Excel) y los enlaces se comportan
    exactamente igual que antes, en las dos pantallas.

## Tests necesarios

- **`tests/images/optimizer.test.js`** — el preset `adjunto` respeta el aspect ratio y no
  agranda una imagen chica (criterio 4).
- **`tests/smoke/specs.js`** — spec nueva `actividad-adjunto-imagen`: la docente pre-sube un
  PNG y recibe una URL `.webp`; crea la actividad con esa URL y el adjunto aparece; el alumno
  lo ve; el alumno no puede subir (403); un PNG falso da 400; un `.txt` da 400 (criterios
  1, 3, 5, 6, 7, 8).
- **`tests/smoke/specs.js`** — extender la spec existente
  `upload-attachment-sube-y-respeta-permisos`: el 403 del alumno tiene que llegar **sin** que
  el archivo quede escrito en disco.
- **`tests/unit/adjuntosActividad.test.js`** — la regla de "qué URL se acepta en
  `uploadedFiles`" y la de "qué adjunto es una imagen", como funciones puras, más el test que
  compara la lista de extensiones del navegador contra la que autoriza el servidor.

### Lo que se agregó de más al implementar

El nombre del adjunto se pintaba **crudo** en la lista que ve el alumno
(`<span class="att-item-name">${a.name}</span>`). El nombre lo elige quien sube el archivo: uno
llamado `<img src=x onerror=…>.pdf` era un script guardado en la base que corría en la pantalla
de cada alumno del curso. Se agregó `Adjuntos.escaparTexto()` y se aplicó en los dos lugares que
esta feature toca. **Queda pendiente aparte** (misma clase de bug, otro camino): los nombres de
archivo de las **entregas del alumno** en `public/js/course.js` (líneas ~1917, ~2325, ~2527).

## Plan de migración

Ninguna. No cambia el esquema, no reescribe documentos, no toca la base de producción.
Depende de `sharp`, que ya está instalado y verificado en el server (18/08).
