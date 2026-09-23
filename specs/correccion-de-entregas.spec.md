# Corrector de entregas

Estado: **borrador — decisiones de fondo cerradas por el usuario, 2026-09-21** · Módulo:
`activities` · Rol: docente (y lo que el alumno deja de ver / pasa a ver)

Entrega **única** (un commit). Las fases de más abajo son orden de construcción, no entregas
mergeables por separado. El usuario la prueba en local antes de que se pushee.

---

## Objetivo

Que el docente pueda corregir **un alumno a la vez**, con la entrega abierta a la izquierda y
la nota, la devolución y los comentarios a la derecha, pasando de alumno con ‹ ›, y decidiendo
**cuándo** el alumno ve la corrección — sin perder nada de la planilla que usa hoy, que sigue
siendo el modo por defecto.

Y de paso, arreglar cuatro cosas que hoy no se pueden hacer:

- **mirar cómodo una foto**, que es el 88% de lo que entregan (§ censo, y por eso § B empieza
  por ahí);
- **abrir un `.docx`**: hoy no se previsualiza en ninguna parte (RN-12: no es un problema de
  "entorno local", es la cookie);
- **abrir un plano**: los que la escuela sube son `.dwg` (§ I);
- **entregar un PowerPoint**: se puede compartir en la sala en vivo pero **no** adjuntar a una
  actividad ni recibirlo como entrega (§ J).

## Problema

### Lo que hay hoy

`loadTeacherDetail` (`public/js/course.js:1910`) pinta el modal de detalle: metadatos, adjuntos
de la consigna, barra de visibilidad, barra de entregas tardías, resumen
(**calificados / entregaron / vieron**), la **tabla de todos los alumnos**
(Alumno · Nota · Devolución al alumno · Visto · Entrega), estadísticas + histograma, y abajo
**Exportar Excel** + **Guardar**. Cada fila de Entrega trae los archivos, la fecha, el `Act:` de
la última edición y el botón **Rehacer** (`permitirRehacer`, `course.js:1893`).

Corregir una entrega, hoy, es esto: hacer clic en un archivo → se abre
`openAttachmentPreview` (`course.js:148`), que monta un **overlay a pantalla completa**
(`.att-preview-overlay`, z-index 10000) que **tapa la tabla entera** → leer → Esc → buscar otra
vez la fila del alumno entre treinta → escribir la nota. Por cada alumno, por cada archivo.

### Los cuatro problemas concretos

1. **El visor tapa el formulario.** No se puede leer y escribir la nota al mismo tiempo. Y lo
   que se mira es casi siempre **una foto**, que ni siquiera se puede agrandar ni enderezar.
2. **Office no se previsualiza nunca** (RN-12), y el cartel echa la culpa al "entorno local",
   lo que hace creer que en producción sí anda.
3. **Guardar publica en el acto.** No existe "corrijo los 30 y los devuelvo juntos".
4. **Los planos no se abren.** Y los que hay son **DWG**, que es justo el formato sin visor.

Y uno que aparece al mirar el modelo: **al reenviar, los archivos anteriores se borran del
disco** (`models/Submission.js:20` lo dice, y el `unlink` está en `routes/activities.js:1393-1397`).
Si el alumno reemplaza el archivo después de que el docente lo corrigió, lo corregido ya no
existe en ninguna parte.

### Censo de lo entregado, medido en producción (2026-09-21)

**15.136 archivos** en `archivos/entregas`:

| ext | cantidad | total | el más grande |
|---|---:|---:|---:|
| `.webp` | 7.772 | 1.157 MB | 954 KB |
| `.jpg` | 4.823 | 3.111 MB | 4,2 MB |
| `.pdf` | 1.446 | 1.884 MB | **19,6 MB** |
| `.jpeg` | 527 | 330 MB | 3,0 MB |
| **`.docx`** | **296** | 93 MB | 5,6 MB |
| `.png` | 215 | 274 MB | 6,1 MB |
| `.zip` | 24 | 6,4 MB | 826 KB |
| **`.xlsx`** | **19** | 0,4 MB | 39 KB |
| **`.dwg`** | **13** | 1,0 MB | 120 KB |
| **`.dxf`** | **1** | — | 5,3 KB |
| `.doc` / `.xls` | **0** | — | — |

Lo que este censo decide, y está citado en cada regla que toca:

1. **El 88% de las entregas son fotos** (13.337 de 15.136). Los alumnos fotografían el trabajo
   hecho a mano. **El caso dominante del visor partido no es un documento: es una imagen**, y a
   menudo torcida. § B arranca por ahí (RN-05b).
2. **Office le sirve a 296 archivos reales**, no a un caso hipotético. Pero el `.xlsx` son
   **19 archivos, ninguno mayor a 39 KB** — ese dato es el que hizo tachar el atajo de SheetJS
   (ver *Lo que queda afuera*).
3. **Cero `.doc` y cero `.xls`** aunque están permitidos desde siempre. Dato para dimensionar;
   **no se saca nada** (RN-01).
4. **13 DWG contra 1 DXF.** Una feature de CAD que solo abriera `.dxf` le serviría a 1 archivo
   de 14 (§ I). El espejo local no lo habría mostrado: ahí los `.dxf` son 7 stubs de 42 bytes.
5. **El PDF más grande pesa 19,6 MB contra un tope de 20** (`SUBMISSION_MAX_SIZE`,
   `routes/activities.js:183`). Están rozando el techo. **Riesgo adyacente, no de esta spec**:
   queda anotado y nada más.
6. **Ninguna extensión inesperada**: lo que hay en disco coincide con las listas permitidas.

> ⚠️ **Este censo mide lo que ENTRÓ, no lo que se INTENTÓ.** Un archivo rechazado no llega al
> disco y **tampoco deja rastro**: el `fileFilter` hace `cb(null, false)` sin loguear la
> extensión (`routes/activities.js:198`) y los reportes de `routes/diagnostico.js` solo cubren
> motivos de red (`red`, `timeout`, `http`, `abortada`). **Hoy el sistema no puede contestar qué
> formato le está faltando a la escuela.** Esa es la razón de ser de § K, que entra en esta
> misma entrega.

## Responsabilidades

Esta spec es dueña de:

- el **Modo Corrector** (visor partido, navegación, filtros) y del interruptor que lo enciende;
- el **visor de imagen** del panel, que es el caso mayoritario;
- la **cadena de previsualización de documentos** (xlsx → Microsoft → LibreOffice → Descargar)
  y de la **cadena de CAD** (DWG → ODA → DXF → visor);
- el estado **borrador / devuelta** de una calificación (`returnedAt`);
- el **hilo de comentarios privados** de una entrega, en los dos sentidos, y su no-leído;
- el **historial de versiones** de una entrega y de dónde viven los archivos viejos;
- la **entrada de `.ppt` / `.pptx`** a los formatos permitidos (§ J);
- el **log de formatos rechazados** (§ K), que es una pieza chica y separable.

## No responsabilidades

- **No toca la planilla** ni nada de lo que hace (RN-01). No se borra el overlay a pantalla
  completa, ni el histograma, ni el Excel, ni Rehacer, ni Visto, ni la barra de tardías. **No se
  saca ningún formato** de las listas, ni siquiera los que tienen 0 archivos.
- **No cambia cómo se sirve ningún archivo**: `.dwg`, `.dxf` y todo lo demás siguen
  `attachment` con su mime y `nosniff` (RN-39).
- **No toca el gradebook, el panel directivo, jefatura ni preceptoría**, salvo lo que RN-28
  obliga a NO cambiar.
- **No manda correos ni notificaciones push.** Sí hay indicador **dentro de la app** de
  comentario sin leer (RN-31c, RN-31d): sin eso el hilo de dos puntas sería un buzón que nadie
  abre.
- **No sube `SUBMISSION_MAX_SIZE`** (el punto 5 del censo). Es de otra feature.
- **No reescribe `EdicionEntrega`** más allá del estado nuevo (RN-26).

## Decisiones ya cerradas (usuario, 2026-09-21)

| # | decisión | |
|---|---|---|
| **D1** | *"no podrás eliminar nada de lo que estaba"* | La planilla queda intacta **y es el modo por defecto**. |
| **D2** | *"el docente podrá cambiar el modo de vista como lo tenía antes"* | Toggle Planilla ↔ Corrector, preferencia en `User` (RN-02). |
| **D3** | *"tener que ser capaz de ser backupeable"* | Todo dato nuevo viaja en el `.tar.gz` y vuelve en el restore (§ Backup). |
| **D4** | Office: **las dos soluciones encadenadas, más descarga** | Microsoft → LibreOffice → Descargar (RN-13). |
| **D5** | **Devolver ≠ Guardar** | `returnedAt` en `gradeSchema` (RN-21 a RN-28). |
| **D6** | **Historial sí, guardando los archivos viejos** | `versions[]` embebido, tope 5 (RN-33 a RN-38). |
| **D7** | **Comentarios privados como hilo**, embebidos en `Submission` | `privateComments[]`, sin colección nueva (RN-29). |
| **D8** | **CAD se dibuja** en el navegador | DXF directo; DWG convertido en el servidor (§ I). |
| **D9** | *"que además permita descargar los archivos si no pueden visualizarlo"* | RN-19, transversal. |
| **D10** | Una sola entrega, un commit | Las fases son orden de construcción. |
| **D11** | **El borrador NO le cierra la entrega al alumno** | RN-26. |
| **D12** | **El hilo lo escriben LOS DOS**, alumno y docente | RN-31, con el aviso al docente en esta misma entrega. |
| **D13** | **El `.dwg` entra, vía ODA File Converter** | § I. |
| **D14** | **PowerPoint entra**: `.ppt` y `.pptx` se pueden adjuntar y entregar | § J. |
| **D15** | **El log de extensiones rechazadas entra en esta entrega** | § K. |

---

## Entidades / Schemas

Cero colecciones nuevas. Los campos nuevos viven todos dentro de documentos que **ya están en
el backup** (`users`, `activities`, `submissions`).

### `models/Activity.js` — `gradeSchema`

```js
// Cuándo esta corrección se le PUBLICÓ al alumno. Tres valores y los tres significan algo
// distinto — es la misma regla de `keepFiles` (AUSENTE ≠ VACÍO) de la spec de edición:
//
//   ausente (undefined) → la nota es anterior a esta feature: está DEVUELTA. El alumno la
//                         viene viendo desde el día que se la pusieron y no puede dejar de
//                         verla porque nosotros estrenemos un campo.
//   null                → BORRADOR. El docente la guardó y todavía no la devolvió.
//   Date                → devuelta, y cuándo.
//
// ⚠️ NO LLEVA `default`, y eso es lo único que impide el peor desenlace de esta feature.
// Ver RN-22: con `default: null`, todas las notas de la escuela desaparecen de la vista del
// alumno el día del deploy, y otra vez el día que alguien restaure un backup viejo.
returnedAt: { type: Date },
```

### `models/Submission.js`

```js
// Un mensaje del hilo privado entre el docente y ESTE alumno sobre ESTA entrega.
// Embebido y no en colección propia: `submissions` ya está en COLLECTIONS, así que el hilo
// viaja en el backup sin tocar la lista.
//
// La forma está copiada de models/MessageRecipient.js (threadMessageSchema), que ya hace
// exactamente esto en producción: hilo 1 a 1 + no-leído por cada punta.
const privateCommentSchema = new mongoose.Schema({
  // 'teacher' | 'student'. Es el ROL EN ESTE HILO, no el rol del usuario: quien gestiona la
  // materia escribe como 'teacher' aunque sea admin o directivo, y así el hilo se lee igual
  // aunque la persona cambie de rol después (mismo criterio que roleAtSend).
  from:   { type: String, enum: ['teacher', 'student'], required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:   { type: String, required: true, trim: true, maxlength: 2000 },
  at:     { type: Date, default: Date.now },
});

// Versión anterior de la entrega, guardada al reenviar. Los archivos NO se borran más: se
// MUEVEN a `_versiones/` dentro de la misma carpeta del alumno, que ya está respaldada.
const submissionVersionSchema = new mongoose.Schema({
  at:    { type: Date, required: true },
  text:  { type: String, default: '' },
  files: [submissionFileSchema],           // con storagePath apuntando a .../_versiones/
}, { _id: true });                          // CON _id: es la clave del enlace del historial

// ... dentro de submissionSchema:
privateComments: [privateCommentSchema],
versions:        [submissionVersionSchema],  // tope 5, se cae la más vieja (RN-34)

// ¿Hay algo en el hilo que la otra punta todavía no vio? DOS booleanos y no un `readAt`, por
// el mismo motivo que MessageRecipient lo hace así: el badge se pinta con una query indexada
// en vez de recorrer el hilo de las 30 entregas de cada actividad. Ver RN-31b.
unreadForTeacher: { type: Boolean, default: false },
unreadForStudent: { type: Boolean, default: false },
```

```js
// Índice del chip de la tarjeta de actividad: "cuántas entregas de esta actividad tienen algo
// sin leer para el docente". Espeja a messageRecipientSchema.index({ user, unreadForUser }).
submissionSchema.index({ activity: 1, unreadForTeacher: 1 });
// La punta del alumno se resuelve por el índice único { activity, student } que ya existe.
```

### `models/User.js`

```js
// Preferencia de vista del corrector de entregas. Por persona, no por actividad ni por curso.
// Vive en User —y no solo en localStorage— porque `users` está en el backup y el localStorage
// no: la docente que cambia de máquina o le formatean la netbook vuelve a su modo.
modoCorreccion: { type: String, enum: ['planilla', 'corrector'], default: 'planilla' },
```

### Disco

```
archivos/entregas/{schoolId}/{activityId}/{studentId}/            ← como hoy
archivos/entregas/{schoolId}/{activityId}/{studentId}/_versiones/ ← NUEVO (RN-33)
archivos/derivados/{schoolId}/{filename}.pdf                      ← NUEVO: Office → PDF (RN-17)
archivos/derivados/{schoolId}/{filename}.dxf                      ← NUEVO: DWG → DXF  (RN-42d)
<tmp>/classroom-cad-<uuid>/{in,out}/                              ← efímero, por conversión CAD
```

**Ninguna colección nueva. Una sola carpeta nueva, y excluida del backup a propósito.**

---

## Entradas

| de dónde | qué |
|---|---|
| Docente (pantalla) | modo de vista, filtro, alumno seleccionado, nota, devolución, comentario, "Guardar", "Devolver", "Rehacer" |
| Alumno (pantalla) | su comentario en el hilo |
| `GET /activities/:id/grades` | actividad + `studentGrades[]` (ahora con `returnedAt`) |
| `GET /activities/:id/submissions` | entregas del curso (+ `versionesCount`, `comentariosCount`, `unreadForTeacher`) |
| `GET /activities/:id/views` | acuse de lectura (sin cambios) |
| `GET /activities/:id/entrega/:studentId` | **nuevo** — el detalle pesado de UN alumno |
| Disco | el archivo de la entrega, su versión vieja, o su derivado (PDF o DXF) |
| `view.officeapps.live.com` | render del Office (se le pasa una URL firmada, RN-15) |
| `soffice` (binario del sistema) | Office → PDF cuando Microsoft no llega (RN-16) |
| `ODAFileConverter` (binario de terceros) | DWG → DXF (RN-42) |
| Navegador, al rechazar un formato | la **extensión sola**, por `POST /diagnostico/formato` (§ K) |

## Salidas

| a dónde | qué |
|---|---|
| Pantalla del docente | visor + panel del alumno, o la planilla de siempre; chips de sin leer |
| `activity.grades[]` | `points`, `feedback`, `gradedAt`, `manual`, **`returnedAt`** |
| `submission.privateComments[]`, `versions[]`, `unreadFor*` | el hilo, el historial y su no-leído |
| `user.modoCorreccion` | la preferencia |
| Pantalla del alumno | la nota **solo si está devuelta** (RN-24); el hilo, siempre |
| Auditoría | `submission.grade` (ya existe), **`submission.return`**, **`submission.comment`**, **`submission.preview_link`** |
| `archivos/derivados/` | el PDF o el DXF convertido, cacheado y **fuera del backup** (RN-17) |
| `logs/combined.log` | `evento: 'formato_rechazado'` (§ K) — **log, no dato de la app** |

---

## Reglas de negocio

### A. El modo de vista

- **RN-01 — No se saca nada.** El **Modo Planilla** es la tabla de hoy, entera: resumen,
  Nota, Devolución, Visto, Entrega, archivos clicables, Rehacer, estadísticas, histograma,
  Exportar Excel, barra de tardías, barra de visibilidad, y el overlay de previsualización a
  pantalla completa. Es el **modo por defecto** para todo el mundo y para siempre. Lo único
  que cambia en él es lo que RN-27b obliga (el botón de Devolver), lo que RN-19 agrega
  (motivo del fallo + Descargar) y lo que RN-31c agrega (el badge de sin leer).
  **Tampoco se saca ningún formato**: `.doc` y `.xls` tienen 0 archivos y se quedan igual —
  sacarlos no le devolvería nada a nadie y rompería entregas viejas si alguna aparece.

- **RN-02 — La preferencia vive en `User.modoCorreccion`, y en `localStorage` solo como
  anti-parpadeo.** Pintar con lo que dice `localStorage` (síncrono, cero fetch) y corregirlo con
  lo que ya vino del servidor. `localStorage` **nunca** es la fuente de verdad: es una cache de
  un dato que vive en la base y que por eso entra al backup (D3).

- **RN-03 — Guardar la preferencia no puede romper nada.** `PATCH /courses/profile/preferencias`
  falla **abierto**: si la request falla, el modo igual cambia en pantalla y en `localStorage`,
  y no se muestra ningún error. Cambiar de vista no es una operación que pueda fallar delante
  de una docente que está corrigiendo.

- **RN-04 — El toggle está donde se lo busca**: en la cabecera del modal de detalle, a la
  derecha del título, como par de botones (`Planilla` / `Corrector`). Cambiar de modo **no
  recarga los datos**: los tres `fetch` de `loadTeacherDetail` ya corrieron y los dos modos leen
  del mismo objeto en memoria.

### B. El visor partido (P1) — y la foto primero

- **RN-05 — `openAttachmentPreview` se parte en dos, y ninguna de las dos mitades se borra.**
  - `renderVisor(att, opciones) → { html, motivo, acciones[] }` — **función pura**, sin DOM,
    sin `document`, testeable con `node --test`. Decide **qué** se muestra.
  - `montarVisorPantallaCompleta(att)` — el overlay de hoy, idéntico, que ahora llama a
    `renderVisor`.
  - `montarVisorEnPanel(att, contenedor)` — lo mismo dentro de la columna izquierda.

  Las dos monturas comparten decisión. Es la misma razón por la que `notaValidaManual` vive en
  `public/js/devoluciones.js` y la importan el navegador y el servidor: **un archivo no puede
  previsualizarse de una manera en el overlay y de otra en el panel**.

- **RN-05b — ⭐ El visor por defecto del panel es el de IMÁGENES, porque el 88% de lo que se
  corrige es una foto** (13.337 de 15.136, § censo). Hoy la imagen se muestra con un
  `<img style="max-width:100%">` y nada más (`course.js:200-203`), que alcanza para mirar un
  adjunto y **no** alcanza para corregir un ejercicio manuscrito. El visor de imagen del panel
  tiene, como mínimo:
  - **Zoom** (rueda del mouse y botones +/−) y **arrastrar** para moverse dentro de la foto.
    Es lo que hace legible una cuenta escrita a lápiz fotografiada de lejos.
  - **Rotar 90°** en los dos sentidos. Es el caso más frecuente y el más barato de resolver:
    el alumno saca la foto apaisada y la entrega torcida. La rotación es **solo de la vista**:
    no se reescribe el archivo del alumno ni se guarda nada.
  - **Ajustar a la pantalla / tamaño real**, y doble clic para alternar entre los dos.
  - **Pasar entre las fotos de la MISMA entrega** sin salir del panel (‹ › chicas o miniaturas),
    porque una entrega manuscrita suelen ser varias hojas: **751 entregas tienen 2 o más
    archivos** (medición de `specs/edicion-de-la-entrega.spec.md`), y el máximo observado es 19.
  - **Teclado**: `+` / `−`, `r` rotar, `0` ajustar, `←` `→` entre fotos, `Esc` cerrar.
  - Estas acciones también valen en el **overlay a pantalla completa** (RN-05: una sola
    decisión, dos monturas), así que el docente que se queda en Modo Planilla **también** gana
    el zoom y la rotación. Es lo que hace que la mejora llegue al 88% sin obligar a nadie a
    cambiar de modo.
  - **[TACHABLE: el teclado y el paso entre fotos.** El zoom y el rotar, no: son el pedido
    implícito del censo.**]**

- **RN-05c — El visor de imagen no depende de nada nuevo.** Es CSS `transform` sobre un `<img>`:
  ni librerías, ni canvas, ni servidor. Y soporta los cuatro formatos que hay en disco
  (`.webp`, `.jpg`, `.jpeg`, `.png`) más `.gif`, que salen todos de `Adjuntos.esImagen()` — la
  regla compartida que ya decide qué es una imagen (`course.js:44`), y que **no se toca**.

- **RN-06 — El layout es 2 columnas a la izquierda el documento.** Visor ~62% / panel ~38%,
  con el panel scrolleable por su cuenta. El modal pasa de `min(1100px, 95vw)` a
  `min(1500px, 98vw)` **solo en Modo Corrector** (`.modal-detail.is-corrector`), para no
  cambiarle el ancho a la planilla. **[TACHABLE: los porcentajes y el ancho.]**
  Abajo de 1024 px apila (visor arriba, panel abajo); abajo de 768 px **no se ofrece** y el
  toggle queda oculto. **[TACHABLE: el corte de 768.]**

- **RN-07 — El panel derecho y la fila de la planilla son el mismo dato.** Los dos leen y
  escriben `window._devolucionesOriginales` (el snapshot que ya existe, `course.js:2002`) y el
  mismo buffer de cambios sin guardar. Cambiar de modo con la nota escrita y sin guardar
  **no la pierde**. Lo que se manda al servidor lo sigue decidiendo `recolectarDevoluciones()`,
  sin tocarla.

- **RN-08 — El panel del alumno tiene todo lo que tiene su fila.** Nombre + email, estado de
  entrega con fecha y `Act:`, **Visto** con fechas, nota, devolución, lista de archivos,
  **Rehacer**, hilo de comentarios e historial. Si algo de la fila no estuviera en el panel, el
  Modo Corrector sería un modo con menos información, y RN-01 estaría escrita para nada.

### C. Navegación y filtros (P2, P3)

- **RN-09 — `ordenCorreccion(alumnos, filtro)` es pura y CONGELA el orden al entrar al Modo
  Corrector.** Las flechas ‹ › recorren ese array, **en el orden filtrado de la planilla**,
  nunca alfabético por su cuenta.
  Congelado significa: guardar una nota **no reordena** ni saca al alumno de la lista aunque
  deje de cumplir el filtro. Sin esto, corregir al alumno #7 con el filtro *"Entregados sin
  calificar"* lo expulsa de la lista en el momento en que se lo califica y ‹ › salta a
  cualquier lado. El contador dice **"7 de 23"** sobre el array congelado.

- **RN-10 — Las flechas no pierden lo escrito.** Pasar de alumno con la nota sin guardar la
  deja en el buffer (RN-07) y **no** dispara un guardado. Cerrar el modal con cambios sin
  guardar pide confirmación nombrando cuántos. **[TACHABLE: que además autoguarde al pasar.]**

- **RN-11 — `estadoDeEntrega({ sub, grade }) → 'sin_entregar' | 'entregado_sin_calificar' |
  'borrador' | 'devuelto'` es pura** y es la única fuente de los chips, del filtro y del color
  del ítem en la lista de alumnos:

  | chip | qué muestra |
  |---|---|
  | **Todos** | todos los inscriptos (default) |
  | **Entregados sin calificar** | `sub && points == null` |
  | **Sin entregar** | `!sub` |
  | **Calificados** | `points != null` (borrador **y** devuelta) |
  | *Sin devolver* | `points != null && !estaDevuelta(grade)` — **[TACHABLE: chip extra]** |

  El filtro vive en la planilla y **alimenta** al corrector. Filtrar **no cambia** el resumen de
  arriba ni las estadísticas: esos siguen contando sobre el curso entero, como hoy.

### D. Previsualización de documentos: la cadena (P4)

- **RN-12 — El bug que esto arregla, escrito para que no se vuelva a diagnosticar mal.**
  `openAttachmentPreview` arma la URL de Microsoft como
  `https://view.officeapps.live.com/op/embed.aspx?src=<origen público del archivo>`
  (`course.js:189`). Microsoft **descarga el archivo desde sus propios servidores**, sin
  cookie. Pero `GET /activities/submission-file/:filename` está detrás de `requireAuth`
  (`routes/activities.js:1055`), y `requireAuth` **redirige a `/login`**
  (`middleware/auth.js:19-21`). Microsoft recibe un 302 a una página HTML de login y muestra
  su error genérico. **Hoy, en producción, ninguno de los 296 `.docx` entregados se
  previsualiza.**
  Dos cosas lo mantuvieron invisible:
  1. el cartel culpa al *"entorno local"* (`course.js:174-186`), que solo se muestra en
     `localhost` — así que en producción ni siquiera aparece esa pista;
  2. **el Office del DOCENTE sí funciona**: sus adjuntos viven en `public/archivos/`, que se
     sirve con `express.static('public')` **sin guarda** (`server.js:226`). Microsoft los baja
     sin problema. O sea: funciona justo en el caso que el docente prueba primero.

- **RN-13 — La cadena, en orden, con caída automática.** Cubre
  **`.doc` · `.docx` · `.xls` · `.xlsx` · `.ppt` · `.pptx`** (los dos últimos entran con § J):

  ```
  paso 0.5 (Office)      → si YA hay PDF derivado cacheado, se usa DIRECTO     [RN-16c]
  paso 1                 → URL FIRMADA → view.officeapps.live.com              [RN-15]
       ↓ si tarda más de 8 s, o el iframe no carga
  paso 2                 → PDF convertido con LibreOffice (normalmente ya
                           disparado por el prefetch, así que es instantáneo)   [RN-16]
       ↓ si no hay LibreOffice, el archivo es muy grande, o la conversión falla
  paso 3                 → botón Descargar, con el motivo en pantalla           [RN-20]
  ```

  Cada caída es **automática y silenciosa hacia adelante**: ningún paso puede dejar la pantalla
  en blanco esperando. El único estado terminal es el paso 3, que **siempre** está disponible.
  Los 8 segundos son un `setTimeout` que se cancela con el `onload` del iframe;
  `view.officeapps.live.com` es cross-origin, así que **no se puede leer si cargó bien o cargó
  un error** — por eso el disparador es el tiempo, no el contenido. **Los 8 s se sostienen
  gracias al prefetch** (RN-16b). **[TACHABLE: los 8 s.]**

- **RN-14 — ~~El atajo del `.xlsx` con SheetJS~~ — TACHADO por el usuario el 2026-09-21.**
  El `.xlsx` **va por la cadena normal**, igual que el `.docx`: paso 1 (URL firmada) y paso 2
  (LibreOffice). No hay paso 0 y **no se suma ningún parseo de planillas en el navegador**.

  El motivo queda acá porque es lo que evita que alguien lo reproponga: el atajo le habría
  servido al **0,13% de las entregas** (19 `.xlsx`, el mayor de 39 KB), y a cambio pedía
  `xlsx@0.18.5` —que **no tiene fix publicado en npm** para su prototype pollution ni para su
  ReDoS (`agente.md:464`)— corriendo sobre archivos subidos por alumnos, más un Web Worker
  (patrón que hoy no existe en el proyecto) y un bundling más. **LibreOffice ya convierte
  `.xlsx` a PDF por el paso 2**, que es el mismo camino de los 296 `.docx` y no agrega ninguna
  superficie nueva.

  ⚠️ El paquete `xlsx` **sigue en el proyecto** y no se toca: lo usa
  `GET /:id/export-grades` (`routes/activities.js:1520`) en el **servidor**. Lo que esta
  decisión descarta es llevarlo al **navegador** para previsualizar archivos de alumnos.

- **RN-15 — La URL firmada.** `POST /activities/submission-file/:filename/enlace` devuelve
  `{ url, expiraEn }`, donde `url` apunta a **otra ruta**,
  `GET /activities/entrega-firmada/:filename?exp=<ms>&sig=<hex>`, que **no pasa por
  `requireAuth`**.
  - **Ruta separada, no un `if` dentro de la ruta con guarda.** Un bypass condicional adentro
    de una ruta autenticada es como nacen los agujeros de auth.
  - Firma: `HMAC-SHA256(filename + '.' + exp + '.' + docenteId)` con clave derivada de
    `JWT_SECRET`, comparada con `crypto.timingSafeEqual` (precedente:
    `models/ContactVerification.js:129`).
  - **TTL 5 minutos. Un archivo por enlace.** El `filename` va dentro de la firma.
  - **Cada emisión se audita** (`submission.preview_link`). Solo la emite quien puede ver el
    archivo por la ruta normal (`course.canManage`); el **alumno no puede emitir enlaces
    firmados de nada**, ni de lo suyo.
  - ⚠️ **La contrapartida, escrita:** durante esos 5 minutos, **cualquiera que tenga el enlace
    exacto baja el archivo sin estar logueado**. Se acota con TTL corto, un archivo y
    auditoría. Es una exposición **menor** que la de los adjuntos del docente, que son públicos
    y para siempre (RN-12, punto 2) — pero acá el archivo es de un menor, así que el TTL no se
    estira sin volver a discutirlo.
  - ⚠️ **Rotar `JWT_SECRET` invalida los enlaces vivos.** Inofensivo: duran 5 minutos.
  - Solo se emite para el paso 1. Un PDF, una imagen, un DXF o un derivado **nunca** lo
    necesitan: los dibuja el navegador del docente, que ya tiene la cookie.

- **RN-16 — La conversión con LibreOffice, y lo que la medición cambió.**
  - **Es un binario del sistema, no una dependencia de npm.** Se detecta una sola vez y se
    cachea en una promesa, **exactamente** como `services/backupCompressor.js` hace con
    Ghostscript (`detectarGs`, líneas 133-163). **Si no está, el paso 2 no existe y la cadena
    cae al 3 sin un solo error.** (Hoy **sí está**, en los dos lados — ver § Dependencias. La
    detección se mantiene igual: "está instalado" es una propiedad de dos máquinas concretas,
    no del repo.)
  - Comando: `soffice --headless --norestore --convert-to pdf --outdir <derivados> <archivo>`.
    Para `.ppt/.pptx` el filtro es `impress_pdf_Export`.
  - ⚠️ **Mediciones del 2026-09-21:**

    | caso | tiempo |
    |---|---|
    | `.docx` de 19 KB → PDF de 3 páginas (primera vez) | **3.525 ms** |
    | el mismo, **segunda conversión seguida** | **3.696 ms** |
    | `.pptx` fabricado → PDF de 2 páginas (`impress_pdf_Export`) | **1.080 ms** |

    Dos lecturas, y la segunda es la que manda:
    1. el tiempo depende del documento y de la máquina (1 a 4 s), así que **no se promete un
       número**;
    2. ⭐ **no hay calentamiento**: la segunda conversión **no fue más rápida** que la primera,
       porque cada `--convert-to` **levanta un proceso nuevo**. El arranque de LibreOffice se
       paga **entero, en cada conversión**. De ahí salen RN-16b y RN-16c.
  - **Topes**: 15 MB de archivo y **45 s** de timeout. El 45 no es "mucho": es el arranque + un
    documento grande. **[TACHABLE: los dos números.]**

- **RN-16b — La cache deja de ser una optimización: es la pieza central. Y por eso hay
  prefetch.**
  - Resultado cacheado en `archivos/derivados/{schoolId}/{filename}.pdf`. **La cache no se
    invalida nunca y no hace falta**: el `filename` de una entrega es único por subida
    (`uniqueFilename`, `routes/activities.js:96`). **Cada archivo se convierte una sola vez en
    su vida.**
  - **La conversión arranca cuando el docente ABRE a ese alumno**, no cuando hace clic en el
    archivo: `GET /activities/:id/entrega/:studentId` encola, *fire-and-forget*, los archivos
    Office de esa entrega que no estén cacheados. Los segundos transcurren mientras lee el panel.
  - **El prefetch NUNCA le gana la cola a un pedido real.** Es especulativo: prioridad baja y,
    si la cola está llena, **se descarta** en vez de encolarse.
  - **Cuánto cuesta**: una clase de 30 con un `.docx` cada uno ≈ 30 × 4 s = **120 s de CPU**
    repartidos en la hora que dura corregir ≈ **3% de un núcleo**, y se paga **una sola vez por
    archivo**. Es barato justamente porque la cola es de a uno y la cache es permanente.
  - **[TACHABLE: prefetchear también al alumno SIGUIENTE de `ordenCorreccion`.]**
  - **[TACHABLE: LibreOffice residente.** `soffice --headless --accept="socket,host=127.0.0.1,
    port=2002;urp;"` + cliente UNO evitaría el arranque. Contras: un proceso permanente más en
    un VPS donde **la CPU es uno de los riesgos ya medidos**, memoria reservada todo el día
    para algo que se usa a ráfagas, y un proceso más que se cuelga y hay que vigilar (se cruza
    con `tools/vigia-produccion.js`). **Por defecto: NO.** Con el prefetch, esos segundos ya no
    los espera nadie.**]**

- **RN-16c — Si el PDF derivado ya está en la cache, se usa DIRECTO, sin pasar por Microsoft.**
  Es más rápido (archivo local contra viaje a Microsoft), no expone nada (no hay que emitir
  enlace firmado, RN-15) y no depende de un tercero.
  **No contradice D4**: D4 ordena la cadena para el caso en que **no hay nada**; acá ya hay un
  PDF hecho. La contra, escrita: a partir de la segunda apertura el docente ve **el render de
  LibreOffice** y no el de Microsoft, que para un `.docx` complejo puede diferir en fuentes y
  saltos de página. **[TACHABLE: si se tacha, la cadena arranca siempre en el paso 1 y se paga
  el enlace firmado en cada apertura.]**

- **RN-17 — `archivos/derivados/` va a `CARPETAS_EXCLUIDAS`, con el motivo escrito.**
  - Entra a `RUTAS` en `services/diskStats.js` (para que el panel de disco del superadmin la
    cuente — que es donde se va a ver crecer la cache — y para que `backupCarpetas.test.js` la
    vea), y a `CARPETAS_EXCLUIDAS` en `routes/backup.js` con el texto: *"se regenera del
    original; respaldarla duplica el peso sin agregar información"*.
  - **Cuadra con `planDeCarpetas()` y con el test**, punto por punto:
    - `planDeCarpetas()` se arma **solo desde `CARPETAS`**, así que `derivados` nunca aparece en
      el plan de restore: **una restauración no la toca**. Correcto — es una cache local con
      claves únicas: lo que sobra no lo referencia nadie y lo que falta se regenera.
    - *"toda carpeta que la app escribe está respaldada o excluida a propósito"*: ✅ excluida.
    - *"el backup no respalda carpetas que ya no existen en el inventario"*: ✅ no se toca
      `CARPETAS`.
    - *"ninguna carpeta está respaldada y excluida a la vez"*: ✅ está en una sola lista.
    - *"cada exclusión dice por qué"*: ✅ el motivo pasa los 15 caracteres — y deja de ser un
      test vacío, porque `CARPETAS_EXCLUIDAS` está **vacía** hoy (`routes/backup.js:143`).
    - *"los ids de las carpetas son estables y únicos"*: ✅ no se agrega ningún id.
  - **El derivado se borra con su original** (rotación de versiones, retiro, borrado de la
    actividad): es una copia del trabajo de un menor y no puede sobrevivir al original.
    `cleanup-files.js` suma `archivos/derivados` como cuarto árbol, con una regla de huérfano
    más simple: un derivado cuyo nombre base no esté en `refEntregas` se borra.

- **RN-18 — ⚠️ La cola de a uno es SOLO para Office. El CAD no la usa, y no es un olvido.**

  | conversión | costo por archivo, **una invocación por archivo** | política |
  |---|---|---|
  | LibreOffice (Office → PDF) | **1.080 a 3.696 ms**, con piso de arranque que no se amortiza | cola de a uno + prefetch + cache (RN-16b) |
  | ODA (DWG → DXF) | **524 ms** en el VPS · **1.066 ms** en el Windows local | **por demanda, en el clic**; sin cola y sin prefetch |

  Medio segundo se puede esperar mirando la pantalla; cuatro, no. Poner el CAD detrás de la cola
  de Office haría que un plano quede **atrás de una conversión de cuatro segundos** que no tiene
  nada que ver con él.
  - **Office**: cola de a uno, tope de 5 en espera, `409 CONVERSION_EN_CURSO` al que no entra.
  - **CAD**: se convierte al pedirlo. Lo que lo acota es el tope de entrada (RN-41), no una cola.

  ⚠️ **Ojo con el número que NO hay que usar**: el lote de 13 planos tardó **798 ms en total**,
  o sea **61 ms por archivo** — pero eso es **una sola invocación de ODA sobre una carpeta con
  13 archivos**, y ahí el arranque del proceso se reparte entre los 13. **Nuestra arquitectura
  paga el arranque entero en cada archivo** (RN-42b: una carpeta temporal con un solo archivo),
  así que el costo real es el de la columna de arriba, **8,6× el del lote**. Comparar los 61 ms
  contra LibreOffice sería comparar un promedio amortizado contra un costo suelto.
  - **[TACHABLE: convertir en UN solo llamado todos los `.dwg` de la MISMA entrega.** Recupera la
    amortización y es seguro, porque la carpeta temporal la armamos nosotros y sigue conteniendo
    solo archivos de ese alumno (RN-42b no se viola). No se hace ahora porque una entrega con
    varios planos es un caso que el censo no muestra: de 13 planos, ninguna entrega tiene más
    de uno.**]**
  ⚠️ **La cola vive en memoria del worker, y PM2 corre en cluster con 2 workers**: el techo real
  de Office es **2 conversiones simultáneas, no 1**. Es la misma corrección que ya está anotada
  para el rate limit ("el techo real es 2x por los 2 workers"). Dos consecuencias, y la primera
  vale **también** para el CAD, que sin cola puede tener varias en vuelo:
  1. la carpeta temporal de CAD es **única por trabajo** (RN-42b), no compartida;
  2. la escritura en la cache va a un nombre temporal y se `rename` al final (atómico).

### E. Descargar siempre (D9, transversal)

- **RN-19 — Todo archivo de una entrega tiene, siempre, un camino a la descarga.** Sea cual sea
  su formato, y falle lo que falle: formato sin visor, LibreOffice ausente, ODA ausente, plano
  pasado de tamaño, conversión fallida, visor de Microsoft caído, Worker colgado, archivo que
  no está en disco. **El botón Descargar nunca desaparece**: está en la barra del visor (los
  dos: overlay y panel) y en la lista de archivos del panel. Usa la ruta de siempre con `?dl=1`
  (`course.js:231`), que fuerza `attachment`.
  **Lo que se descarga es siempre el archivo que entregó el alumno, no el derivado.** Si un DWG
  se convirtió a DXF para dibujarlo, Descargar baja **el DWG**.

- **RN-20 — Cuando no se pudo previsualizar, la pantalla dice POR QUÉ, no solo que no.**
  `renderVisor` devuelve un `motivo` de una lista cerrada, y cada motivo tiene su texto:

  | motivo | texto en pantalla |
  |---|---|
  | `formato_sin_visor` | *"Este tipo de archivo no se puede ver acá. Descargalo para abrirlo con la app correspondiente."* (el de hoy) |
  | `office_no_cargo` | *"El visor de Microsoft no respondió. Probamos convertirlo…"* → y después el motivo del paso 2 |
  | `sin_conversor` | *"El servidor no tiene instalado el conversor de documentos, así que este archivo solo se puede descargar."* |
  | `sin_conversor_cad` | *"El servidor no tiene instalado el conversor de planos, así que este `.dwg` solo se puede descargar."* |
  | `archivo_muy_grande` | *"El archivo pesa N MB y el visor admite hasta M. Descargalo para abrirlo."* |
  | `conversion_fallida` | *"No se pudo convertir el archivo para verlo acá (puede estar dañado o protegido con contraseña)."* |
  | `plano_muy_grande` | *"El plano pesa N MB y el visor admite hasta M. Descargalo y abrilo con AutoCAD."* |
  | `archivo_no_esta` | *"El archivo no está en el servidor. Avisale al alumno que lo vuelva a subir."* |

  El texto sale del módulo, no del HTML: el cartel de la pantalla y el mensaje de la API dicen
  lo mismo porque **son** lo mismo.

### F. Devolver ≠ Guardar (P5, D5) — la parte peligrosa

- **RN-21 — `returnedAt` tiene tres valores y `estaDevuelta(grade)` es la única que los lee.**

  ```js
  // public/js/correccion.js — la importan el navegador y el servidor, igual que devoluciones.js
  function estaDevuelta(grade) {
    if (!grade) return false;
    if (grade.returnedAt === undefined) return true;   // legado: ya la vio, y la sigue viendo
    return grade.returnedAt !== null;                  // null = borrador; Date = devuelta
  }
  ```

  **AUSENTE ≠ NULL**, la misma red de seguridad que `keepFiles` en
  `specs/edicion-de-la-entrega.spec.md`: la diferencia entre *"esto es anterior a la feature"* y
  *"alguien decidió esto"*. `undefined` sobrevive al JSON, al dump del backup y al restore.

- **RN-22 — `returnedAt` NO lleva `default`. Ni `null`, ni `Date.now`.** El punto más caro de
  equivocarse de toda la feature, con dos escenarios:
  - **(a) el día del deploy.** Con `default: null`, el próximo `Activity.findById()` materializa
    `returnedAt: null` en las miles de notas ya cargadas: **todas las notas de la escuela
    desaparecen de la vista del alumno de golpe**.
  - **(b) al restaurar un backup anterior a la feature.** Aunque (a) se esquivara con una
    migración, el backup de julio **no la trae**, y al restaurarlo Mongoose vuelve a
    materializar el default de los campos ausentes: *una restauración no es byte a byte*. Por
    eso la protección **no puede ser una migración**: tiene que ser la semántica del campo.
  - Con `default: Date.now` tampoco: una nota de marzo leída hoy figuraría *"devuelta hoy"*.
  - **Corolario**: `POST /:id/grade` **siempre** escribe `returnedAt` explícitamente.

- **RN-22b — En `POST /:id/grade`, el flag `devolver` AUSENTE significa DEVOLVER.** Tercera vez
  que aparece la misma doctrina, y acá es lo que contiene el radio de explosión:
  - `devolver: false` → borrador (`returnedAt = null`). **Es la única forma de crear un
    borrador**, y es explícita.
  - `devolver: true` o **ausente** → devuelta (`returnedAt = new Date()`).
  - Así, **todo cliente que ya existe sigue publicando exactamente como hoy**: las tres
    pantallas que cargan notas, los 8 llamados de `tests/smoke/specs.js` y cualquier `curl`.

- **RN-23 — Una nota devuelta no vuelve a borrador.** Si `estaDevuelta(grade)` era `true` antes
  de la edición, sigue siendo `true` después, incluso con `devolver: false`. El borrador solo
  existe **antes** de la primera devolución. Sin esta regla, editar una nota vieja la
  escondería del alumno que ya la había visto, de a uno por vez y sin que nadie se entere.

- **RN-24 — Qué ve el alumno mientras la nota está en borrador: exactamente lo de siempre antes
  de tener nota.** No hay cartel nuevo.
  - `GET /activities/course/:courseId` (la única puerta del alumno a su nota,
    `routes/activities.js:308-322`) **omite `myGrade` entero** cuando la nota no está devuelta.
    No alcanza con anular `points`: el alumno también vería `feedback` (`course.js:2272`) y el
    chip *"devolución sin nota"* de `estadoActividad.js:79`. En borrador **no viaja nada**.
  - ⚠️ El **comentario privado no está sujeto a esto** (RN-31): llega siempre. Si el docente
    escribe la nota adentro de un comentario, la nota llega. Es una decisión suya, no un
    agujero.

- **RN-25 — El autocalificador nunca queda retenido en borrador.** El bloque de `autoGraded`
  (`routes/activities.js:1435-1454`) escribe con `manual: false` por un camino que **no pasa**
  por `POST /:id/grade`: se escribe con `returnedAt: new Date()`, siempre.

- **RN-26 — El borrador NO cierra la edición del alumno (D11).** Lo que cierra la edición pasa a
  ser **la devolución**, no la existencia de la nota:

  ```
  corregida = points != null  &&  manual !== false  &&  estaDevuelta(grade)
  ```

  - **Por qué**: con la regla vieja, una nota en borrador le contestaría al alumno *"El docente
    ya corrigió tu entrega"* por una nota que **no puede ver**. Y como el flujo natural del
    corrector es *"corrijo los 30 y devuelvo al final"*, congelaría al curso entero.
  - **Los cinco lugares que comparten la regla NO se tocan, ninguno.** Ese es el dividendo de
    haberlos unificado en `specs/edicion-de-la-entrega.spec.md`:

    | # | dónde | por qué no cambia |
    |---|---|---|
    | 1 | `exigirAlumnoQuePuedeEntregar` (middleware, antes de multer) | le pasa al módulo el subdocumento crudo de `activity.grades`, que **ya incluye** `returnedAt` |
    | 2 | `POST /:id/upload-submission-file` | usa la misma guarda que el 1 desde el 2026-09-04 |
    | 3 | `POST /:id/submit` | ídem |
    | 4 | `renderSubmissionSection()` → `canEdit` | le pasa `act.myGrade`, que en borrador es **null entero** (RN-24) → lee "sin nota" → editable |
    | 5 | `renderRunnerSection()` → `locked` | interactivas: `manual: false` ya las excluía |

    **Lo único que cambia es la línea del módulo** (`public/js/edicionEntrega.js`, rama
    `corregida`), que pasa a llamar a `Correccion.estaDevuelta()`. Y eso obliga a que
    `correccion.js` se cargue **antes** que `edicionEntrega.js` en `views/course.ejs`, que a su
    vez va antes de `course.js`: el test de orden de `<script>` se extiende a tres.
  - **Las notas legadas** (campo ausente) leen `estaDevuelta === true`: **la matriz entera de
    `tests/unit/edicionEntrega.test.js` sigue dando lo mismo**.
  - **Lo que esto abre**: entre el borrador y la devolución, el alumno puede cambiar el archivo
    que el docente acaba de corregir. Lo tapan el historial (§ H) y el aviso del panel
    **"La entrega cambió después de que la corregiste"** cuando
    `submission.updatedAt > grade.gradedAt`, con enlace a la versión que el docente había leído.
    **[TACHABLE: el aviso — pero sin él, D11 pierde su red.]**

- **RN-26b — `reopenedAt` se cierra con la DEVOLUCIÓN, no con el borrador.** Hoy poner nota
  cierra una entrega reabierta (`routes/activities.js:789-794`), y la razón escrita es *"rehizo,
  lo corregí de nuevo, se cierra"* — ese "se cierra" pertenece al momento en que al alumno se le
  avisa. Si un borrador cerrara la reapertura, un docente que corrige 30 en borrador cerraría 30
  reaperturas **antes de devolver nada**, y varias de esas entregas estaban abiertas *solo* por
  la reapertura (plazo vencido).
  ⚠️ Esto **precisa**, sin contradecir, el CA-17 de `specs/edicion-de-la-entrega.spec.md`: sigue
  siendo verdad para todos los clientes de hoy gracias a RN-22b. Lo que se agrega es que **un
  borrador explícito no la cierra**.

- **RN-27 — Devolver.** `POST /activities/:id/devolver` con `{ studentIds: [...] }`.
  - Escribe `returnedAt = new Date()`. **No toca** `points` ni `feedback`. Cierra `reopenedAt`.
  - Solo devuelve lo que tiene algo que devolver: `points != null || feedback.trim() !== ''`.
    Un alumno sin nada se omite y vuelve en `omitidas[]`; no es un error.
  - `puedeDevolver(grade)` es pura y gobierna el botón **y** la ruta.
  - Auditoría: **`submission.return`**, una entrada **por alumno**.
  - Permiso: `course.canManage`. El alumno recibe **403**.

- **RN-27b — En Modo Planilla el botón principal sigue publicando.** Si "Guardar" dejara
  borradores, **la docente que nunca cambia de modo dejaría de publicar notas sin enterarse**.
  - **Modo Planilla**: primario **"Guardar y devolver"** (donde está hoy "Guardar") + secundario
    **"Guardar sin devolver"**.
  - **Modo Corrector**: secundario **"Guardar"** + primario **"Devolver"**.
  - `resumenGuardado` suma el caso: *"✓ 4 nota(s) guardada(s) — sin devolver todavía"*.
    **[TACHABLE: las etiquetas.]**
  - El resumen de arriba agrega **"N sin devolver"** en ámbar cuando hay borradores.

- **RN-28 — Nada de lo que ve el PERSONAL filtra por `returnedAt`.** Gradebook, directivo,
  jefatura, preceptoría, el Excel y el contador *"N calificados"* siguen mostrando **todas** las
  notas. Un borrador es una nota puesta. Lo único que cambia es informativo: el Excel suma una
  columna *"Devuelta"*. **[TACHABLE: la columna.]**

### G. El hilo de comentarios privados (P6, D7, D12)

- **RN-29 — El hilo va embebido en `Submission.privateComments[]`.** No hay colección nueva y
  por lo tanto **no se toca `COLLECTIONS`**. La forma —hilo + un booleano de no-leído por
  punta— está **copiada de `models/MessageRecipient.js`**, que hace exactamente esto en
  producción desde la mensajería del superadmin. No se inventa un mecanismo nuevo para un
  problema ya resuelto en la casa.

- **RN-30 — `feedback` se conserva y no cambia de significado.** Sigue siendo *la devolución de
  la actividad*: la columna de la planilla, lo que ve el alumno en su modal y lo que exporta el
  Excel. El hilo es **otra cosa**. **No se migra `feedback` al hilo, ni se sincronizan.**

- **RN-31 — Escriben los dos, y el comentario llega siempre (D12).**
  - **El docente** que gestiona la materia escribe cuando quiera.
  - **El alumno** escribe sobre **su propia entrega**, y **en cualquier momento**: antes de que
    le corrijan, con la nota en borrador y después de devuelta. No se le pide permiso al estado
    de la nota, porque los dos casos que justifican el hilo pasan antes de la devolución: *"subí
    el archivo equivocado, el bueno es el segundo"* y *"no entendí el punto 3"*.
  - **El comentario NO espera a la devolución, en ninguna dirección.** Un comentario del docente
    durante el borrador es el *"te faltó el punto 3, rehacelo"* que este proyecto ya decidió que
    tiene que llegar (corrección del 04/09 en `edicion-de-la-entrega`: *la devolución escrita
    sin nota es el pedido de rehacer*). Y compone con RN-26: durante el borrador la entrega
    sigue abierta, así que el alumno **puede** hacer lo que se le pide.
  - ⚠️ **Limitación, escrita y aceptada: el hilo es de la ENTREGA, así que existe cuando existe
    la entrega.** El alumno que todavía no entregó no tiene hilo; en el panel, su caja aparece
    **deshabilitada** con el motivo: *"El hilo se abre con la entrega."* No se crea una
    `Submission` vacía para alojar un comentario: rompería el contador *"N entregaron"*
    (`Object.keys(subMap).length`, `course.js:1974`) y el estado `mySubmission`. Ni se cuelga de
    `activity.grades[]`: una entrada vacía haría que el panel directivo deje de ver la actividad
    como *vencida sin calificar* (`services/divisionDetail.js:58` pregunta por
    `grades.length === 0`).

- **RN-31b — El no-leído son DOS booleanos en la entrega, no un `readAt` por comentario.**
  - Escribe el docente → `unreadForStudent = true`. Escribe el alumno → `unreadForTeacher = true`.
  - El docente abre `GET /activities/:id/entrega/:studentId` → `unreadForTeacher = false`.
    El alumno abre `GET /activities/:id/my-submission` → `unreadForStudent = false`.
    (Se marca al abrir **el detalle**, que es donde el hilo se pinta. **No** en
    `POST /:id/view`, que se dispara igual aunque el hilo no se haya mirado.)
  - Por qué dos booleanos: es el comentario de `MessageRecipient` (*"Evita recorrer todos los
    hilos para pintar '3 respuestas nuevas'"*). Con marcas por comentario, pintar el chip de una
    tarjeta obligaría a traer y recorrer los 30 hilos de esa actividad en cada carga.
  - **Es "hay algo sin leer", no "cuántos".** El chip cuenta **entregas** con algo sin leer, que
    es el dato accionable (*a cuántos les tengo que contestar*).

- **RN-31c — Cómo se entera el docente, sin abrir a los 30.** Tres lugares, todos aditivos:
  1. **Tarjeta de la actividad**: un tercer chip al lado de `viewed-chip` y `submitted-chip`
     (`course.js:1176-1190`), mismo formato y mismo lugar. Solo aparece si hay algo:
     `<N> sin leer`, en ámbar, ícono `forum`. El número sale de **un tercer aggregate** en la
     rama `isOwner` de `GET /activities/course/:courseId`, dentro del `Promise.all` que ya corre
     dos (`routes/activities.js:261-273`). Es la query para la que se agrega el índice
     `{ activity: 1, unreadForTeacher: 1 }`.
  2. **Planilla**: un punto ámbar junto al nombre del alumno en la celda *Alumno* (no una
     columna nueva: con `table-layout: fixed` una sexta columna aprieta las cinco que ya están).
  3. **Resumen** (`gt-summary`): *"· **N** con comentarios sin leer"*, con el mismo formato que
     *calificados / entregaron / vieron*. Y el punto ámbar en la lista del Modo Corrector.
  - **[TACHABLE: un filtro más "Con comentarios sin leer" en los chips de RN-11.]**

- **RN-31d — Cómo se entera el alumno.** El mismo mecanismo del otro lado: `obj.mySubmission`
  (que ya viaja con `{ at }`) suma `comentariosSinLeer: bool`. La tarjeta muestra *"Comentario
  nuevo"* y el modal abre el hilo con los no leídos marcados. No hay correo ni push.

- **RN-32 — Permisos, rutas separadas y límites.**
  - **Rutas separadas por rol, no una ruta con un `if` adentro** (mismo criterio que RN-15):
    - docente → `POST /activities/:id/entrega/:studentId/comentario`, guarda `course.canManage`;
    - alumno → `POST /activities/:id/mi-comentario`, **sin `:studentId` en la URL**: el alumno
      sale de la sesión. Así no existe el parámetro que habría que validar.
  - **Un alumno no puede leer el hilo de otro.** `GET /:id/entrega/:studentId` es solo del
    docente; la puerta del alumno es `GET /:id/my-submission`, que por construcción es la suya.
    ⚠️ **Antecedente `fuga_datos_api_curso`: la pantalla decía 403 y la API 200.** El criterio
    de aceptación no prueba la pantalla: prueba **cada endpoint JSON** (CA-45).
  - **Largo**: 2.000 caracteres por comentario (el tope de `threadMessageSchema`), 100
    comentarios por entrega.
  - **Rate limit por USUARIO, no por IP.** `express-rate-limit` con `keyGenerator` sobre
    `res.locals.user._id`, igual que `diagLimiter` (`routes/diagnostico.js:63`): **toda la
    escuela sale por una sola IP NAT**. Tope: **20 comentarios por 5 minutos por persona**
    (techo real 40 por los 2 workers). **[TACHABLE: el número.]**
  - **El texto se pinta con `textContent`, nunca con `innerHTML`.**

- **RN-32b — Qué pasa al restaurar un backup anterior a la feature.** Los documentos vuelven
  **sin** `privateComments` ni `unreadFor*`. Mongoose materializa el array ausente como **`[]`**
  y los booleanos como **`false`**: hilo vacío, nada sin leer. **Correcto**, y acá sí se puede
  usar el default —al revés que en RN-22— porque el valor por defecto coincide con "no pasó
  nada", que es lo que había antes de la feature. **La regla no es "no uses defaults": es "el
  default tiene que decir la verdad sobre los datos que ya existen".**

### H. Historial de la entrega (P7, D6)

- **RN-33 — El `unlink` pasa a ser un `rename`.** El bloque de `routes/activities.js:1390-1398`
  deja de borrar el archivo que quedó afuera y lo **mueve** a `_versiones/` dentro de la misma
  carpeta del alumno, que ya está en `CARPETAS` (id `entregas`). **Cero superficie nueva de
  backup.**
  - Se escribe una entrada en `versions[]` con `at`, `text` y los archivos movidos.
  - Si el `rename` falla, **se borra como hoy** y se loguea. Guardar el historial no puede
    romper la entrega del alumno.
  - Retirar la entrega (`DELETE /:id/submission`) **sí** borra todo, versiones incluidas.

- **RN-34 — Tope de 5 versiones por entrega; se cae la más vieja y sus archivos se borran.**
  `recortarVersiones(versiones, nueva, tope)` es pura. Por qué hay tope: hoy existe un **tope
  natural de una versión por alumno** y esta feature lo saca. `archivos/entregas` es el **99,8%
  del peso del backup** (6.760 MB de los 6.774 del censo), y el backup viaja por FTP a la PC del
  dueño. **[TACHABLE: el 5.]**

- **RN-35 — ⚠️ `cleanup-files.js` borra todas las versiones si no se lo toca.** Construye
  `refEntregas` **solo** con `Submission.files[].storagePath` (líneas 121-128) y después borra
  del disco todo lo que no esté en ese Set (líneas 164-177). Los archivos de `_versiones/` no
  están referenciados, así que **el primer `npm run cleanup` se lleva el historial entero, en
  silencio y con un cartel que dice que liberó espacio**. La query pasa a incluir
  `versions.files[].storagePath`. Misma familia de bug que el borrado de datos de prueba del
  07/09: filtrar por lo que corresponde, no por lo que está a mano.

- **RN-36 — El borrado en cascada de la actividad se lleva las versiones.**
  `DELETE /activities/:id` (`routes/activities.js:892-898`) pasa a recorrer también
  `versions[].files[]`, a borrar `_versiones/` de cada alumno y a borrar los derivados. Si no,
  quedan archivos de menores sin ningún documento que los nombre — y como `cleanup-files.js` ya
  los va a referenciar (RN-35), **no los limpiaría nunca más**.

- **RN-37 — Quién ve el historial.** El docente que gestiona la materia y **el propio alumno**
  sobre su entrega. `GET /activities/submission-file/:filename` extiende su búsqueda a
  `versions.files.filename` conservando **exactamente** la misma guarda de hoy.
  Se lee como línea de tiempo: *"Versión 2 — 14 sep, 10:42 · 2 archivos"*, la actual arriba
  marcada **Actual**, y cada archivo con su visor y su Descargar (RN-19).

- **RN-38 — Cruce con `specs/backup-incremental.spec.md`.** `_versiones/` es el caso ideal de esa
  spec: crece por acumulación y **no cambia hacia atrás**. Pero para un incremental que compare
  por ruta, un archivo que se **mueve** es una baja y un alta: el mismo archivo se sube una vez
  más. Aceptable (pasa una sola vez por archivo), y conviene que esté escrito antes de que
  alguien lo lea como un bug del incremental.

### I. CAD en el navegador (P8, D8, D13)

```
.dwg → ODA File Converter (servidor, bajo xvfb-run) → .dxf derivado → visor en el navegador
.dxf → visor en el navegador (directo, sin tocar el servidor)
cualquiera falla → botón Descargar con el motivo (RN-19 / RN-20)
```

**Estado: la cadena está instalada y probada en las dos plataformas** (2026-09-21, § Dependencias
2b), contra los 13 planos reales de los alumnos. Lo que sigue son reglas con números medidos, no
con supuestos.

#### Lo que vale para cualquier CAD

- **RN-39 — ⭐ El plano se DIBUJA EN EL NAVEGADOR, que ya tiene la cookie de sesión.**
  - **No necesita URL firmada** (RN-15 no aplica): lo baja el `fetch()` del docente, con su
    cookie, por la ruta autenticada de siempre.
  - **Ni el `.dwg` ni el `.dxf` cambian cómo se sirven**: siguen `attachment` con su mime
    (`image/vnd.dwg`, `image/vnd.dxf`) y `nosniff`, que es la decisión de seguridad tomada el
    2026-08-29. **A `fetch()` el `Content-Disposition` no le importa**: lee el cuerpo igual.
    `VER_EN_LINEA` (`services/liveRoom.js`) **no se toca**, y los dos tests de
    `tests/unit/subidaPlanos.test.js` que lo afirman siguen en verde **sin cambiarlos**.
  - Lo único que el servidor hace por el CAD es **producir un `.dxf` a partir de un `.dwg`**
    (RN-42a). El dibujo nunca sale del navegador.

- **RN-40 — El texto que viene adentro de un DXF se pinta en canvas o por `textContent`, NUNCA
  por `innerHTML`. Y vale igual para el DXF DERIVADO.** Un `.dxf` es **texto plano**: nombres de
  capa, cotas, entidades `TEXT`. El que sale del conversor es tan de un alumno como el que sube
  él: **lo produjo ODA a partir del archivo del alumno, no lo escribió el servidor.** Pasar por
  un conversor no sanitiza nada.
  `dxf-viewer` dibuja sobre WebGL/canvas, así que la regla se cumple sola — pero se escribe
  igual, porque lo que suele filtrarse es lo de al lado: el **panel de capas**, el nombre del
  archivo y los mensajes de error. Todo eso va por `textContent`.

- **RN-41 — Los topes salen de lo medido, y el segundo se DERIVA del primero.**

  Medición del 2026-09-21 sobre **los 13 planos reales de producción**, convertidos con ODA:

  | | valor medido |
  |---|---|
  | resultados | **13 de 13**, con geometría real: 115 a 1.379 entidades, 2 a 10 capas |
  | lote completo, una invocación (13 archivos) | 798 ms → 61 ms/archivo ⚠️ **no es nuestro caso**, ver RN-18 |
  | **un archivo, una invocación** (lo que hacemos) | **524 ms** en el VPS · **1.066 ms** en Windows |
  | expansión DWG → DXF | **2,5× a 5,8×** (123 KB → 567 KB; 49 KB → 120 KB) |
  | mayor DXF derivado del parque real | **568 KB** |
  | peso total de los 13 derivados | **4,4 MB** |
  | versiones de origen | **12× `AC1032`** (AutoCAD 2018+) y **1× `AC1024`** (AutoCAD 2010) — ODA leyó las dos sin chistar. El parque es moderno **pero mezclado**: no se puede asumir una sola versión |

  ⭐ **Para dimensionar `archivos/derivados/`, lo que sirve es la PROPORCIÓN, no el total**: un
  DXF pesa **del orden de 5 veces su DWG**. Los 4,4 MB de hoy no dicen nada; la regla "×5" es la
  que contesta cuando la escuela tenga 500 planos en vez de 13.

  | tope | valor | de dónde sale |
  |---|---|---|
  | **dibujar un DXF** (subido **o** derivado) | **10 MB** | ~18× el mayor derivado real (568 KB); ~1.900× el único `.dxf` subido (5,3 KB) |
  | **entrada al conversor** (`.dwg`) | **1,5 MB** | ~12× el mayor `.dwg` real (120 KB), **y elegido para que su peor expansión medida entre en el tope de dibujo**: 1,5 × 5,8 = 8,7 MB < 10 |
  | timeout de una conversión CAD | **10 s** | ~9× el **peor** caso medido (1.066 ms, Windows). Se calibra contra la máquina lenta, no contra el VPS: **la de desarrollo es el doble de lenta**, así que es el piso de referencia, no el techo |

  - **El segundo tope no es independiente del primero: se calcula con la expansión medida.**
    Así no existe el caso "pasó el filtro de entrada y el resultado no se puede dibujar", que es
    la incoherencia que tenía este bloque cuando la expansión era una suposición.
  - **Hoy no rebota ningún archivo existente** (márgenes de 12× y 18×), que es la prueba de que
    el tope no es una restricción encubierta. Un DWG de más de 1,5 MB —un plano de obra de
    verdad— da `archivo_muy_grande` + **Descargar el `.dwg`** (RN-19): es honesto, porque su DXF
    de ~9 MB tampoco se dibujaría cómodo en la pestaña de nadie.
  - El tope de subida (`SUBMISSION_MAX_SIZE`, 20 MB) **no se toca**.
  - **[TACHABLE: los tres números. Si se mueve el de dibujo, hay que recalcular el de entrada
    con la misma división — no tocarlos por separado.]**

#### Específico del DXF (no cambia nada de lo que ya estaba)

- **RN-42 — El `.dxf` se dibuja directo, sin pasar por el servidor.** `fetch` de la ruta de
  siempre → `ArrayBuffer` → `dxf-viewer`. Sin conversión, sin cola, sin cache, sin CPU del
  servidor y sin enlace firmado. **Es el camino corto y el único que funciona sin instalar
  nada.**

#### Específico del DWG (lo nuevo)

- **RN-42a — El `.dwg` se convierte a `.dxf` en el servidor, POR DEMANDA, y después sigue el
  camino del DXF.** No hay un visor de DWG: hay un conversor. El derivado se sirve por
  `GET /activities/submission-file/:filename/dxf` (con `requireAuth` y el mismo permiso que el
  original), y de ahí en adelante es RN-42 palabra por palabra — **incluida RN-40**.
  - **Por demanda, en el clic**: medio segundo en el VPS (RN-18). **Sin cola y sin prefetch**, al
    revés que Office. La cache (RN-42d) igual hace que el segundo acceso sea instantáneo.
  - **Probado contra el parque real**: 13 de 13 planos de producción convertidos con geometría
    real (115 a 1.379 entidades, 2 a 10 capas), incluidos un `AC1024` de 2010 y doce `AC1032`
    de 2018+. **No se asume una sola versión de AutoCAD**: el parque es moderno pero mezclado.

- **RN-42b — ⚠️ El CLI de ODA trabaja sobre CARPETAS, no sobre archivos sueltos.** Sus
  parámetros son: **carpeta de origen, carpeta de destino, versión de salida, formato de
  salida, recursivo (0/1), auditar (0/1)** y **filtro de entrada** (ej. `*.DWG`). Convierte
  **todo lo que matchee el filtro en la carpeta de origen**. Consecuencias, todas obligatorias:
  1. **Nunca se lo apunta a `archivos/entregas/...`.** Con el recursivo en 1, o con un filtro
     amplio, se llevaría medio árbol de entregas a la carpeta de destino. La entrada es
     **siempre** una carpeta temporal recién creada.
  2. Por conversión: `<tmp>/classroom-cad-<uuid>/in/` (una copia del único `.dwg`) y `/out/`.
     Se convierte, se levanta el resultado, se mueve a la cache y **se limpia todo en un
     `finally`**, también si la conversión falló o tiró timeout.
  3. **Carpeta única por trabajo (`uuid`).** No es cinturón y tiradores: el CAD **no tiene cola**
     (RN-18) y además **PM2 corre 2 workers**, así que dos conversiones simultáneas son el caso
     normal, no el raro. Con carpeta compartida, la segunda le levantaría el `out/` a la primera.
  4. **Recursivo = 0**, siempre, y filtro acotado a la extensión exacta.
  5. **Auditar = 1** (reparar al vuelo). Un DWG corrupto de un alumno es un caso real y reparar
     puede ser justo lo que salve la previsualización. **Es seguro porque el original nunca está
     ahí**: ODA trabaja sobre la **copia** del punto 2, así que aunque la auditoría reescriba el
     archivo de entrada, el archivo del alumno no se toca. Si la reparación fracasa →
     `conversion_fallida` + Descargar. **[TACHABLE: el flag de auditoría, si enlentece de más.]**
  6. El **orden exacto de los argumentos** se confirma contra la ayuda del binario; esta spec
     fija los **valores**, no la sintaxis.

- **RN-42c — La detección busca por PATRÓN, nunca por una ruta con la versión adentro.** Es el
  precedente de `detectarGs` (`services/backupCompressor.js:133-163`) —promesa cacheada,
  candidatos por plataforma, `logger.info` con la instrucción de instalación cuando falta— con
  una diferencia: ahí los candidatos son nombres fijos (`gs`, `gswin64c`); **acá el candidato de
  Windows es un patrón.**

  | plataforma | qué se busca | qué NO |
  |---|---|---|
  | Linux (VPS) | **`/usr/bin/ODAFileConverter`**, el estable | ❌ `/usr/bin/ODAFileConverter_27.1.0.0/`, que convive al lado **con la versión adentro** |
  | Windows (local) | el **primer match** de `%LOCALAPPDATA%\Programs\ODA\ODAFileConverter *\ODAFileConverter.exe` | ❌ la ruta literal `…\ODAFileConverter 27.1.0\…` |
  | las dos | `ODA_FILE_CONVERTER_BIN` si está seteada, con prioridad sobre todo | |

  ⚠️ **Por qué esto es una regla y no un detalle de implementación**: hardcodear
  `ODAFileConverter 27.1.0` funciona hoy y **se rompe en silencio con la próxima versión**. El
  síntoma llegaría meses después como *"dejó de previsualizar planos"*, sin relación aparente
  con una actualización que hizo otra persona. Es exactamente la forma de falla que este
  proyecto ya conoce: no da error, deja de hacer algo.

  **El camino degradado sigue existiendo aunque el binario ya esté instalado** (§ Dependencias):
  con ODA ausente o caído, un `.dwg` muestra `sin_conversor_cad` + **Descargar**, y **nada más de
  la feature se rompe** — el DXF se sigue dibujando, el Office se sigue convirtiendo, el
  corrector funciona igual. Ya no es "el estado por defecto", pero sí es **el estado de todo
  servidor nuevo** (RN-42e). Tiene criterio de aceptación propio (CA-54).

- **RN-42d — El `.dxf` derivado se cachea en `archivos/derivados/`, con el mismo mecanismo y la
  misma exclusión que los PDF de Office.** `archivos/derivados/{schoolId}/{filename}.dxf`. Todo
  lo de RN-17 aplica sin cambios: la carpeta ya está en `RUTAS` y en `CARPETAS_EXCLUIDAS`,
  `planDeCarpetas()` no la toca en el restore, el derivado se borra con su original, y los cinco
  tests de `backupCarpetas.test.js` cuadran igual — **no hay carpeta nueva por el CAD, es la
  misma**. Clave única por subida ⇒ **cada DWG se convierte una sola vez en su vida**.

- **RN-42e — ⚠️⚠️ En Linux, ODA SIEMPRE se invoca con `xvfb-run -a`. Nunca directo.** Y la
  instalación **no es un paquete: son once, más un symlink.** Esto dejó de ser un riesgo
  hipotético el 2026-09-21: se instaló, falló dos veces, y así se resolvió.

  **Los tres intentos, con su error, porque el error es el dato:**

  | intento | qué pasó |
  |---|---|
  | 1. el `.deb` solo, invocado directo | `libGL.so.1: cannot open shared object file` |
  | 2. con `xvfb` | `Could not load the Qt platform plugin "xcb"` |
  | 3. con las 7 librerías que faltaban + el symlink | ✅ funciona |

  Las que faltaban se encontraron con un **`ldd` al plugin `libqxcb.so`**, no adivinando. **El
  inventario completo, literal, porque ningún `apt install` lo trae solo:**

  ```bash
  apt-get install -y --no-install-recommends \
    libgl1 xvfb libxcb-util1 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
    libxcb-render-util0 libxcb-shape0 libxcb-xkb1 libxkbcommon-x11-0
  ln -s libxcb-util.so.1 /usr/lib/x86_64-linux-gnu/libxcb-util.so.0
  ```

  ⭐ **Por qué esto es una RN y no un comentario en el código**: si alguien lo llama sin
  `xvfb-run`, **falla con un error de OpenGL** (`libGL.so.1`) que **no se parece en nada a
  "falta una pantalla"** y manda la investigación para cualquier lado — a buscar drivers de
  video en un servidor que no tiene monitor. El que escribe el `execFile` tiene que saber esto
  **antes**, no después.

  **Qué significa para una mudanza de servidor**: no es "instalar un paquete". Son **11
  paquetes, un symlink y una forma particular de invocarlo**, más la descarga manual del
  binario (§ Dependencias, punto 2).
  Es exactamente el tipo de cosa sobre la que `specs/escalado-multi-maquina.spec.md` dice que el
  deploy **miente diciendo OK**: el servidor nuevo arranca, sirve todo y contesta `/health`
  perfecto, con los planos cayendo al botón Descargar y nadie enterándose. Por eso el
  `logger.info` del arranque (RN-42c) es el único aviso, y por eso CA-54(b) prueba ese camino
  aunque hoy el binario esté instalado.

- **RN-42f — La salida es idéntica entre plataformas, y por eso la verificación local vale.**
  El mismo DWG produjo **165.584 bytes en Windows** y **165.579 en el VPS**: **5 bytes de
  diferencia, en el encabezado**. Lo que el usuario ve al probar en su máquina es lo que va a
  ver la escuela.
  El que **no** es igual es el tiempo: **1.066 ms en Windows contra 524 ms en el VPS**. La
  máquina de desarrollo es **el doble de lenta**, o sea **el peor caso, no el mejor** — y por eso
  los timeouts de RN-41 se calibran contra ella y no contra el número optimista del servidor.

- **RN-42g — El `.dwg` NO se sirve distinto que hoy.** Sigue siendo `attachment` con
  `image/vnd.dwg` y `nosniff`. Lo único que cambia es que ahora **existe un derivado** que el
  navegador puede dibujar. `EXT_SUBMISSIONS` y los otros lugares de formatos **no se tocan por
  el CAD**: el `.dwg` ya se aceptaba desde el 2026-08-29.

- **RN-43 — El bundle se arma con esbuild, exactamente como `build:mediasoup`.**
  ```json
  "build:dxf": "esbuild --bundle --format=iife --global-name=DxfViewer --minify --target=es2019 --outfile=public/js/dxf-viewer.bundle.js node_modules/dxf-viewer/src/index.js"
  ```
  - `dxf-viewer` (MIT, sobre three.js) y `three` van como **devDependencies**: el bundle se
    commitea, y el webhook de deploy hace `git pull` + `pm2 reload`, **no** `npm install`.
  - **Carga diferida**: el bundle pesa cientos de KB (three.js adentro). El `<script>` **no** va
    en `course.ejs`; se inyecta la primera vez que alguien abre un plano.
  - **[TACHABLE: `dxf-viewer`.** Si no rinde, la alternativa es `three-dxf`; lo que **no** es
    negociable es RN-39, RN-40 y RN-41.**]**

### J. PowerPoint entra: los 7 lugares (D14)

- **RN-44 — `.ppt` y `.pptx` se pueden adjuntar y entregar. Van LOS DOS.** Hoy hay una asimetría
  que no decidió nadie: **la sala en vivo ya los acepta** —`EXT_ARCHIVOS`
  (`services/liveRoom.js:139`) y el `accept=` de `views/partials/live-room.ejs:434`— así que un
  docente puede compartir un PowerPoint en clase **pero no adjuntarlo a la actividad ni
  recibirlo como entrega**. Esto la corrige.
  **Faltan exactamente siete lugares** (los dos de la sala ya están):

  | # | lugar | constante / elemento |
  |---|---|---|
  | 1 | `routes/activities.js:82` | `EXT_ALLOWED` (adjunto del docente) |
  | 2 | `routes/activities.js:93` | `EXT_SUBMISSIONS` (entrega del alumno) |
  | 3 | `views/activities/new.ejs:325` | `DOC_EXTS` |
  | 4 | `public/js/course.js:2409` | `SUB_ALLOWED_EXTS` |
  | 5 | `views/activities/new.ejs:70` | `accept=` de `#fileInput` |
  | 6 | `views/course.ejs:427` | `accept=` de `#activityFileInput` |
  | 7 | `public/js/course.js:2526` | `accept=` de `#subFileInput` |

- **RN-44b — ⚠️ El olvido de un `accept=` no da error: da un archivo en gris.** El explorador de
  Windows deja el archivo **deshabilitado**, la persona concluye que la plataforma no lo acepta,
  y **no hay cartel, ni error, ni línea en el log**. Es el modo de falla más caro de los siete,
  porque es el único que **no se puede diagnosticar después**. Por eso tiene criterio de
  aceptación propio (CA-63) y por eso § K existe.

- **RN-44c — Los carteles tienen que nombrar PowerPoint.** Dos están escritos a mano y hay que
  tocarlos: el del alumno (`course.js:2660`, *"Podés subir PDF, Word, Excel, ZIP, un plano de
  AutoCAD…"*) y el del docente en `new.ejs`. `tests/unit/subidaPlanos.test.js` ya exige que
  estos carteles nombren el `.dwg` y el `.dxf`; el test se extiende para exigir PowerPoint con
  el mismo criterio. Los carteles que salen de la lista (`Aceptamos ${EXT_SUBMISSIONS.join}`) se
  actualizan solos: esa es la diferencia y por eso son mejores.

- **RN-44d — El test que ata las listas se extiende, no se duplica.**
  `tests/unit/subidaPlanos.test.js` es el que compara las listas entre sí — **es el único que va
  a avisar si falta uno de los siete**. Se generaliza de "los planos" a "los formatos que tienen
  que estar en todas las listas", con `.ppt`/`.pptx` sumados a `PLANOS` o en una constante
  hermana. **[TACHABLE: si conviene renombrar el archivo a `formatosPermitidos.test.js`.]**

- **RN-44e — PowerPoint entra a la cadena de Office sin nada nuevo.** Verificado el 2026-09-21:
  LibreOffice convierte un `.pptx` a PDF con el filtro `impress_pdf_Export` en **1.080 ms**
  (2 páginas). O sea que RN-13 pasa a cubrir seis extensiones sin agregar una sola pieza.
  Las seis extensiones recorren **la misma cadena, sin excepciones ni atajos por formato**
  (RN-14): el visor de Microsoft abre el `.pptx` igual que el `.docx`, y si falla, LibreOffice
  lo convierte igual que a los otros.
  - **Octavo lugar, opcional**: `EXT_COLOR` (`public/js/course.js:11`) no tiene entrada para
    `PPT`/`PPTX`, así que la tarjeta los pinta gris. Conviene darles el naranja de PowerPoint,
    con la regla que el propio archivo escribe: **el recuadro lleva el texto en BLANCO, así que
    el color tiene que llegar a 4,5:1 contra blanco**. **[TACHABLE: el hex exacto, a verificar
    con el medidor de contraste.]**

### K. El log de formatos rechazados (D15)

> **Pieza chica, independiente y revisable por su cuenta.** No toca el corrector: se puede leer,
> aprobar y hasta implementar sola. **El objetivo no es auditar: es poder contestar dentro de
> dos semanas qué formato le está faltando a la escuela**, que hoy es imposible.

- **RN-45 — Loguean los CINCO filtros, y ninguno queda afuera.** El inventario completo:

  | # | dónde | lista | quién sube |
  |---|---|---|---|
  | 1 | `routes/activities.js:150` | `EXT_ALLOWED` | docente, adjunto al crear la actividad |
  | 2 | `routes/activities.js:198` | `EXT_SUBMISSIONS` | **alumno, entrega** ← el que más importa |
  | 3 | `routes/activities.js:552` | `EXT_ALLOWED` | docente, pre-subida del adjunto |
  | 4 | `routes/rooms.js:978` | `live.EXT_ARCHIVOS` | personal, adjunto de la sala en vivo |
  | 5 | `middleware/image-upload.js:64` | `EXT_IMAGENES` | todos, cualquier camino de imagen |

  **Los cinco loguean, así que no hay lista de exclusiones que justificar.** El 5 ya tiene medio
  camino hecho: importa `logRechazo` y su `ExtensionNoPermitidaError` ya guarda `this.ext`
  (`middleware/image-upload.js:28-34`); solo hay que sumarle el evento.

- **RN-46 — Se loguea la EXTENSIÓN SOLA. Nunca el nombre del archivo.** Los alumnos nombran las
  entregas con su propio nombre (`TP3-Juan-Perez.docx`): el nombre completo es un dato personal
  y no aporta nada a la pregunta. Se registran: **la extensión, quién (de la sesión, no del
  cliente), su rol, la escuela y por qué ruta**. El nombre completo **no**, en ningún campo.

- **RN-47 — La extensión viene del cliente, o sea que es mentira posible.** Mismo criterio que
  `routes/diagnostico.js` (*"todo lo que entra acá lo escribe el cliente… se recorta, se castea
  y se encierra en una lista de valores conocidos antes de tocar el log"*):

  ```js
  // minúsculas, máximo 10 caracteres, solo [a-z0-9]. Todo lo demás se guarda como '(invalida)'.
  const m = String(nombre || '').toLowerCase().match(/\.([^.\\/]{1,10})$/);
  const ext = m && /^[a-z0-9]{1,10}$/.test(m[1]) ? '.' + m[1] : (m ? '(invalida)' : '(sin_ext)');
  ```

  Sin esto, un nombre con una "extensión" de 2.000 caracteres **inunda el log y tapa otra
  cosa** — y `logs/combined.log` **no rota** (`agente.md:461`), así que el daño no se limpia
  solo. Los tres valores posibles son: una extensión sana, `(invalida)` o `(sin_ext)`.

- **RN-48 — ⭐ El rechazo hay que capturarlo en el NAVEGADOR, o el log va a quedar vacío y va a
  mentir.** Es el punto que decide si esto sirve o no sirve.
  El `fileFilter` del servidor **casi nunca se va a disparar**, porque el rechazo ocurre antes:
  primero el `accept=` (que deja el archivo **en gris** en el explorador, así que la persona ni
  lo selecciona) y después la lista de JS (`uploadSubFile`, `course.js:2657`). Si solo se
  loguea en el servidor, **el log queda casi vacío y la conclusión sería "no falta ningún
  formato", que es exactamente la conclusión falsa que este cambio busca evitar.**
  Entonces:
  1. **El chequeo de JS reporta.** Donde hoy hay un `showUploadErrModal` y un `return`
     (`course.js:2657-2663` y su gemelo del docente), además se manda el reporte. El cartel ya
     existe y ya nombra la lista: lo único nuevo es el `fetch` de una línea.
  2. **[TACHABLE — y recomendado: aflojar el `accept=` y dejar que el rechazo lo haga el JS.]**
     Cambiar los tres `accept=` de actividades (lugares 5, 6 y 7 de RN-44) por uno amplio hace
     que el explorador **no esconda nada**, y que quien elija un formato no permitido reciba
     **un cartel que dice qué formato es y por qué no entra** en vez del archivo en gris.
     Resuelve dos problemas con un cambio: mata el peor modo de falla de RN-44b y **convierte un
     silencio en un dato**.
     - **La contra**: el explorador deja de filtrar, así que alguien puede elegir cualquier cosa
       —incluido un video de 2 GB—. **No cuesta ancho de banda**: el chequeo de JS corre **al
       seleccionar**, antes de subir un solo byte. El costo real es ruido en la elección.
     - **Recomendación: aflojarlo ahora y revisarlo cuando el log conteste** (dos semanas). Es
       reversible en una línea por input, y el experimento tiene fecha de vencimiento.

- **RN-49 — El dato va por `routes/diagnostico.js`, en una ruta propia.**
  `POST /diagnostico/formato`, body `{ ext, ruta }`.
  - **Se reusa el módulo** porque ya tiene todo lo que hace falta: `requireAuth`, rate limit por
    persona, los helpers de recorte (`texto`, `entero`) y la disciplina escrita de no confiar en
    el cliente.
  - **Pero NO se reusa `/subida`**, y por eso `MOTIVOS` no cambia: `/subida` exige un `codigo`
    `SUB-XXXXXX` y contesta otra pregunta (cuántos bytes llegaron). Meter los rechazos ahí
    produciría reportes sin bytes que harían mentir al `veredicto()` de `tools/ver-subida.js`.
  - El servidor escribe con `logger.warn` y **la marca `evento: 'formato_rechazado'`**, igual
    que `subida_fallida`. Campos: `evento`, `ext`, `ruta`, `origen` (`navegador` | `servidor`),
    `usuario`, `rol`, `escuela`, `requestId`.
  - Del lado del servidor (los 5 filtros de RN-45) se usa **`logRechazo`**
    (`middleware/route-log.js:59`), que ya existe **para exactamente esto**: su comentario dice
    que nació porque la sala rechazaba los `.heic` y *"el log quedaba MUDO… un log vacío parecía
    'no pasó nada' cuando en realidad pasaba todo el tiempo"*. Es la misma frase que justifica
    § K entero.

- **RN-50 — Hay que poder leer el RESUMEN, no una línea por evento.** `tools/ver-formatos.js`,
  hermano de `tools/ver-subida.js`:

  ```
  node tools/ver-formatos.js            # últimos 30 días, agrupado
  node tools/ver-formatos.js --mes      # el mes calendario
  ```

  Sale una tabla: **extensión · cuántas veces · cuántas personas distintas · por qué ruta ·
  primera y última vez**, ordenada por cantidad. Eso es lo que contesta la pregunta; una línea
  suelta por evento no la contesta.
  ⚠️ Y que diga también lo que **no** puede saber: si el `accept=` sigue estricto (RN-48 sin
  aflojar), la tabla mide **solo a quien encontró la forma de intentarlo igual**, que es un
  piso, no un total. Esa advertencia va impresa en la salida de la herramienta, no en un
  comentario del código.

- **RN-51 — Rate limit: el mismo presupuesto que diagnóstico, por persona.** 30 por hora por
  persona (`diagLimiter`, `routes/diagnostico.js:58-67`), con `keyGenerator` sobre el usuario.
  ⚠️ **Techo real 60 por los 2 workers de PM2**, como todo límite en memoria de este proyecto.
  Alcanza de sobra: **perder un reporte al limitador no es grave**, porque lo que importa es el
  agregado y quien rebotó 31 veces en una hora ya produjo la señal en los primeros 30.

- **RN-52 — Esto es LOG, no dato de la aplicación.** No toca `COLLECTIONS`, no toca `CARPETAS`,
  no crea ningún modelo. Va a `logs/combined.log`, que **no está en `RUTAS`**
  (`services/diskStats.js:37-54`) ni en `CARPETAS`, así que **los dos tests de backup siguen en
  verde sin tocarlos**: `backupCobertura.test.js` porque no hay modelo nuevo, y
  `backupCarpetas.test.js` porque no hay carpeta nueva. Y si algún día alguien quisiera
  respaldarlo, la respuesta es que no: un log de rechazos no es un dato que haya que poder
  restaurar.

---

## Casos de uso

| CU | quién | qué | acción auditable |
|---|---|---|---|
| **CU-01** | docente | Cambia entre Planilla y Corrector | — |
| **CU-02** | docente | **Mira una foto con zoom y la endereza** | — |
| **CU-03** | docente | Corrige un alumno y **guarda** (borrador) | `submission.grade` |
| **CU-04** | docente | **Devuelve** uno o varios alumnos | `submission.return` |
| **CU-05** | docente | Pasa al siguiente / anterior con ‹ › | — |
| **CU-06** | docente | Filtra la planilla por estado | — |
| **CU-07** | docente | Previsualiza un `.docx` que hasta hoy no se veía | `submission.preview_link` |
| **CU-08** | docente | Ve el PDF convertido de un Office que Microsoft no abrió | — |
| **CU-09** | docente | **Recibe y abre un `.pptx`** | — |
| **CU-10** | docente / alumno | **Descarga** lo que no se puede previsualizar | — |
| **CU-11** | docente | Abre un `.dxf` y lo mira dibujado | — |
| **CU-12** | docente | Abre un **`.dwg`** y lo mira dibujado (vía derivado) | — |
| **CU-13** | docente | Escribe un comentario privado | `submission.comment` |
| **CU-14** | **alumno** | **Contesta en el hilo de su entrega** | `submission.comment` |
| **CU-15** | docente | Ve desde la lista de actividades que tiene comentarios sin leer | — |
| **CU-16** | alumno | Ve en su tarjeta que le contestaron | — |
| **CU-17** | docente / alumno | Abre una **versión anterior** de la entrega | — |
| **CU-18** | alumno | Reenvía: su archivo viejo pasa a `_versiones/` | `submission.update` |
| **CU-19** | alumno | Ve su nota **recién cuando se la devuelven** | — |
| **CU-20** | cualquiera | **Elige un formato que no entra y recibe un cartel** (que además reporta) | — |
| **CU-21** | el dueño | **Pregunta qué formato le falta a la escuela** y obtiene una tabla | — |
| **CU-22** | superadmin | Backup y restore sin perder nada de lo nuevo | `backup.create` / `backup.restore` |

---

## Contratos de endpoints

### Nuevos

| método | ruta | body / query | responde | permiso |
|---|---|---|---|---|
| `PATCH` | `/courses/profile/preferencias` | `{ modoCorreccion }` | `{ ok, modoCorreccion }` | el propio usuario |
| `GET` | `/activities/:id/entrega/:studentId` | — | `{ submission, grade, view }`; **marca leído** y **dispara el prefetch** | `course.canManage` |
| `POST` | `/activities/:id/devolver` | `{ studentIds: [] }` | `{ ok, devueltas, omitidas }` | `course.canManage` |
| `POST` | `/activities/:id/entrega/:studentId/comentario` | `{ texto }` | `{ comentario }` | `course.canManage` |
| `POST` | `/activities/:id/mi-comentario` | `{ texto }` | `{ comentario }` | alumno dueño (sale de la sesión) |
| `POST` | `/activities/submission-file/:filename/enlace` | — | `{ url, expiraEn }` | `course.canManage` |
| `GET` | `/activities/entrega-firmada/:filename` | `?exp&sig` | el archivo, `inline` | **la firma** (sin `requireAuth`) |
| `GET` | `/activities/submission-file/:filename/pdf` | — | el PDF derivado | igual que el original |
| `GET` | `/activities/submission-file/:filename/dxf` | — | el DXF derivado de un `.dwg` | igual que el original |
| `POST` | `/diagnostico/formato` | `{ ext, ruta }` | `{ ok: true }` | cualquiera autenticado (§ K) |

### Modificados

| ruta | qué cambia |
|---|---|
| `POST /activities/:id/grade` | acepta `devolver?: boolean` (**ausente = devolver**, RN-22b) y escribe `returnedAt` siempre explícito. `reopenedAt` se cierra solo al devolver (RN-26b). |
| `GET /activities/:id/grades` | cada `studentGrade` suma `returnedAt` |
| `GET /activities/:id/submissions` | suma `versionesCount`, `comentariosCount`, `unreadForTeacher` — **no** los arrays |
| `GET /activities/course/:courseId` | docente: tercer aggregate → `comentariosSinLeer` (RN-31c). Alumno: **omite `myGrade` entero** si no está devuelta (RN-24) y suma `mySubmission.comentariosSinLeer` |
| `GET /activities/:id/my-submission` | devuelve `privateComments[]` y **marca `unreadForStudent = false`** |
| `GET /activities/submission-file/:filename` | busca también en `versions.files.filename`; misma guarda |
| `POST /activities/:id/submit` | mueve a `_versiones/` en vez de borrar; recorta a 5 |
| `DELETE /activities/:id` · `DELETE /activities/:id/submission` | borran también versiones y derivados |

---

## Criterios de aceptación

**Modo de vista**

- **CA-01** *(RN-01)* — Con la preferencia en `planilla`, el modal se ve **idéntico** a hoy.
- **CA-02** *(RN-02)* — Cambia a Corrector, cierra sesión, entra desde **otra máquina**: abre en
  Corrector.
- **CA-03** *(RN-03)* — Con el `PATCH` respondiendo 500, el modo igual cambia y no hay error.
- **CA-04** *(RN-07)* — Nota escrita en Corrector **sin guardar** → aparece en la Planilla, y al
  revés.

**El visor de imagen (el 88%)**

- **CA-05** *(RN-05b)* — Sobre una foto: zoom con la rueda, arrastrar, **rotar 90°**, ajustar a
  pantalla y volver a tamaño real. La rotación **no** modifica el archivo del alumno (se
  descarga igual que se subió).
- **CA-06** *(RN-05b)* — Con una entrega de 3 fotos se pasa entre las tres **sin salir del
  panel**.
- **CA-07** *(RN-05b)* — Las mismas acciones existen en el **overlay a pantalla completa**: el
  docente que nunca cambia de modo también gana el zoom y la rotación.
- **CA-08** *(RN-05c)* — Funciona con `.webp`, `.jpg`, `.jpeg`, `.png` y `.gif`, y la decisión
  de "esto es una imagen" sigue saliendo de `Adjuntos.esImagen()`.

**Navegación y filtros**

- **CA-09** *(RN-09)* — Con el filtro *Entregados sin calificar* y 23 alumnos: dice **"1 de
  23"**; al calificar al #7 y apretar ›, va al **#8**, y el contador sigue diciendo 23.
- **CA-10** *(RN-09)* — El orden de ‹ › es **el mismo** que el de la planilla filtrada.
- **CA-11** *(RN-10)* — Con 4 notas sin guardar, cerrar pide confirmación y nombra las 4.

**Office y la cadena**

- **CA-12** *(RN-12, RN-15)* — Un `.docx` entregado se **ve en producción**. (Hoy falla.)
- **CA-13** *(RN-15)* — El enlace firmado: (a) con firma correcta y dentro de los 5 min devuelve
  el archivo **sin cookie**; (b) vencido → **403 `ENLACE_VENCIDO`**; (c) con `sig` alterada →
  **403 `FIRMA_INVALIDA`**; (d) la firma de A pidiendo B → **403**.
- **CA-14** *(RN-15)* — Un **alumno** pidiendo enlace de su propio archivo recibe **403**.
- **CA-15** *(RN-15)* — Cada emisión deja una entrada `submission.preview_link`.
- **CA-16** *(RN-16)* — **Con `soffice` inaccesible**, abrir un `.docx` no tira error: cae al
  paso 3 con el texto de `sin_conversor` y el botón Descargar.
- **CA-17** *(RN-16b)* — La **segunda** apertura del mismo `.docx` no lanza ningún `soffice`.
- **CA-18** *(RN-18)* — Dos conversiones a la vez **en el mismo worker**: la segunda recibe
  **409 `CONVERSION_EN_CURSO`** y termina mostrándose; nunca hay dos `soffice` en ese worker.
- **CA-19** *(RN-16b)* — Abrir a un alumno **dispara** la conversión de sus Office sin que nadie
  haga clic, y **no la dispara** si el derivado ya está cacheado.
- **CA-20** *(RN-14)* — Un `.xlsx` recorre **exactamente la misma cadena** que un `.docx`: pide
  enlace firmado y, si Microsoft no responde, cae al PDF de LibreOffice. **No existe ninguna
  rama de código que parsee planillas en el navegador**, y `xlsx` no aparece en ningún bundle
  servido al cliente — sigue siendo solo del servidor, para `export-grades`.

**Descargar siempre (D9)**

- **CA-21** *(RN-19)* — Para **cada** formato de `EXT_SUBMISSIONS` —ahora incluidos `.ppt` y
  `.pptx`— hay botón Descargar en el visor y en el panel, y baja con `attachment`.
- **CA-22** *(RN-19)* — Para un `.dwg` dibujado vía derivado, Descargar baja **el `.dwg`**.
- **CA-23** *(RN-20)* — Cada uno de los 8 motivos se puede provocar y muestra **su** texto.
- **CA-24** *(RN-19)* — Con el archivo borrado del disco pero el documento en la base:
  `archivo_no_esta`, y **no** queda un spinner girando.

**Devolver ≠ Guardar**

- **CA-25** *(RN-22a)* — Sobre una base **anterior a la feature**, todas las notas existentes
  siguen viéndose. El test fija que `gradeSchema.path('returnedAt').defaultValue` es `undefined`.
- **CA-26** *(RN-22b)* — Se restaura un `.tar.gz` **anterior** a la feature y `estaDevuelta()` da
  `true` para todas esas notas. Es el escenario que una migración **no** habría cubierto.
- **CA-27** *(RN-21)* — `estaDevuelta()`: `undefined` → `true`, `null` → `false`, `Date` → `true`.
- **CA-28** *(RN-22b)* — `POST /:id/grade` **sin** el flag `devolver` deja la nota **devuelta**:
  los 8 llamados que ya existen en `tests/smoke/specs.js` pasan **sin tocarlos**.
- **CA-29** *(RN-24)* — Guardado con `devolver: false`: el alumno **no recibe `myGrade`** (ni
  `points` ni `feedback`), la tarjeta dice *Entregada*. Después de Devolver, aparece todo.
- **CA-30** *(RN-23)* — Sobre una nota **ya devuelta**, guardar con `devolver: false` la edita y
  el alumno ve el valor nuevo **en el acto**.
- **CA-31** *(RN-25)* — La nota autocalificada se ve **al instante**, sin que nadie devuelva.
- **CA-32** *(RN-26)* — Con la nota en **borrador** el alumno **puede** editar (200); después de
  Devolver recibe **403** `corregida`. La matriz vieja de `edicionEntrega.test.js` pasa **sin
  cambios**.
- **CA-33** *(RN-26)* — Los cinco lugares **no cambian**: un barrido verifica que ninguno tenga
  la condición escrita a mano y que el único que nombra `returnedAt` en esa decisión sea
  `edicionEntrega.js` llamando al módulo.
- **CA-34** *(RN-26b)* — Con una entrega reabierta: `devolver: false` **no** cierra la
  reapertura; devolver **sí**.
- **CA-35** *(RN-27)* — `POST /:id/devolver` con 3 alumnos, uno sin nada: devuelve 2, omite 1,
  deja **2** entradas `submission.return`; un alumno recibe 403.
- **CA-36** *(RN-27b)* — En Planilla, el botón principal guarda **y devuelve** en un clic.
- **CA-37** *(RN-28)* — Gradebook, directivo y Excel muestran los borradores igual que las
  devueltas.

**El hilo de dos puntas**

- **CA-38** *(RN-29)* — Un comentario sobrevive al ciclo backup → restore **sin tocar
  `COLLECTIONS`**, y `backupCobertura.test.js` sigue en verde.
- **CA-39** *(RN-30)* — Comentar **no** cambia la columna *Devolución al alumno* ni el Excel.
- **CA-40** *(RN-31)* — El **alumno** comenta y el docente lo ve; el docente contesta y el alumno
  lo ve. Los dos pueden comentar **con la nota en borrador**, y el comentario del docente le
  llega al alumno **aunque la nota no esté devuelta**.
- **CA-41** *(RN-31)* — Un alumno que **no entregó** no tiene hilo: caja deshabilitada con el
  motivo, `POST /:id/mi-comentario` → **404 `SIN_ENTREGA`**, y el contador *"N entregaron"* **no
  cambia**.
- **CA-42** *(RN-31b)* — Escribe el alumno → `unreadForTeacher = true`; el docente abre
  `GET /:id/entrega/:studentId` → `false`. **`POST /:id/view` NO lo apaga.**
- **CA-43** *(RN-31c)* — Con 3 entregas con algo sin leer: chip **"3 sin leer"** en la tarjeta,
  *"3 con comentarios sin leer"* en el resumen y 3 puntos ámbar. Con 0, **no aparece ningún
  chip**.
- **CA-44** *(RN-31c)* — El chip sale de **un solo aggregate** agregado al `Promise.all` que ya
  existe: la solapa no suma una request por actividad.
- **CA-45** *(RN-32, antecedente `fuga_datos_api_curso`)* — El alumno **B** recibe **403/404,
  nunca 200 con datos** en **cada endpoint JSON** que toca el hilo de **A**:
  `GET /:id/entrega/:A`, `POST /:id/entrega/:A/comentario`, y `POST /:id/mi-comentario`
  intentando escribir en la entrega de A. **Se prueban los endpoints, no la pantalla.**
- **CA-46** *(RN-32)* — Comentario 101 → **400 `HILO_LLENO`**; 2.001 caracteres → **400
  `COMENTARIO_LARGO`**; texto con `<script>` se ve como texto en las dos puntas.
- **CA-47** *(RN-32)* — El rate limit es **por persona**: dos alumnos desde la **misma IP** (la
  NAT de la escuela) no se bloquean entre ellos; el mismo alumno 21 veces en 5 min → **429**.
- **CA-48** *(RN-32b)* — Restaurado un backup anterior: `privateComments: []`, los dos booleanos
  en `false`, y **ningún chip de sin leer aparece de la nada**.

**Historial**

- **CA-49** *(RN-33)* — Entrega A, reenvía B: la entrega tiene B, `versions[0]` tiene A, **y A
  sigue en el disco** en `_versiones/`, descargable.
- **CA-50** *(RN-34)* — Al sexto reenvío hay 5 versiones y los archivos de la primera **ya no
  están**.
- **CA-51** *(RN-35)* — `cleanup-files.js --dry-run` sobre una entrega con versiones reporta
  **0** a borrar. (Sin el arreglo, reporta todas.)
- **CA-52** *(RN-36)* — Borrar la actividad deja la carpeta **vacía**: ni actuales, ni
  `_versiones/`, ni derivados.
- **CA-53** *(RN-37)* — El alumno **B** pidiendo una versión de **A** recibe **403**; A recibe
  **200**.

**CAD**

- **CA-54** *(RN-42c, RN-42e)* — **El camino degradado, con sus dos modos de falla.** Sigue
  valiendo **aunque el binario ya esté instalado**, porque es el estado de todo servidor nuevo:
  (a) ODA **ausente** (detección apuntada a un binario inexistente) → `sin_conversor_cad` +
  Descargar;
  (b) ODA **presente pero muriendo** — el caso real del 2026-09-21: sin `xvfb-run` da
  `libGL.so.1: cannot open shared object file`, y sin las librerías `xcb` da
  `Could not load the Qt platform plugin "xcb"` → `conversion_fallida` + Descargar.
  En los **dos**: **nada de 500, nada de spinner eterno**, y el `.dxf`, el Office y el resto del
  corrector siguen funcionando igual.
- **CA-54b** *(RN-42c)* — **La detección no hardcodea ninguna ruta con versión.** Un test fija
  que: en Linux se busca `/usr/bin/ODAFileConverter` y **no** el directorio versionado que
  convive al lado; en Windows se busca **por patrón** bajo `%LOCALAPPDATA%\Programs\ODA\`, de
  modo que **renombrar la carpeta de `27.1.0` a otra versión lo sigue encontrando**; y
  `ODA_FILE_CONVERTER_BIN` le gana a las dos.
- **CA-54c** *(RN-42e)* — **En Linux la invocación va envuelta en `xvfb-run -a`.** Un barrido del
  código verifica que no exista ninguna llamada directa al binario en esa plataforma. (Si se
  cuela, el error que produce habla de OpenGL y manda la investigación para cualquier lado.)
- **CA-55** *(RN-42)* — Un `.dxf` se **dibuja**, se sigue sirviendo `attachment` +
  `image/vnd.dxf`, y **no** se pide enlace firmado.
- **CA-56** *(RN-42a, RN-42f)* — Un `.dwg` se **dibuja** vía derivado, y el `.dwg` se sigue
  sirviendo `attachment` + `image/vnd.dwg`.
- **CA-57** *(RN-42b)* — La conversión CAD **nunca** recibe como origen un directorio de
  `archivos/entregas`: un test fija que la entrada está bajo `os.tmpdir()`, que el flag recursivo
  es `0`, y que la carpeta temporal **se borra también cuando la conversión falla** (`finally`).
- **CA-58** *(RN-42b)* — Dos conversiones CAD simultáneas usan **carpetas distintas**.
- **CA-59** *(RN-42d)* — El segundo acceso al mismo `.dwg` **no** lanza ODA; borrar la entrega
  borra el `.dxf` derivado.
- **CA-60** *(RN-40)* — Un DXF **derivado** con un nombre de capa que contiene
  `<img onerror=...>` se dibuja sin ejecutar nada.
- **CA-61** *(RN-41)* — Un `.dxf` de 12 MB → `plano_muy_grande` + Descargar sin colgar la
  pestaña; un `.dwg` de 2 MB → `archivo_muy_grande` y **no se manda a convertir**. **Ninguno de
  los 14 archivos reales de producción rebota** (márgenes de 12× y 18×).
- **CA-61b** *(RN-41, RN-18)* — Un `.dwg` real se convierte **en el clic, sin pasar por la cola
  de Office**: con una conversión de Office en curso, el plano **no espera** a que termine.
- **CA-61c** *(RN-42a)* — Los **13 planos reales** (12 `AC1032` + 1 `AC1024`) se convierten y se
  dibujan: el test no asume una sola versión de AutoCAD.
- **CA-62** *(RN-43)* — El bundle existe y su `<script>` **no** está en `course.ejs`.

**PowerPoint**

- **CA-63** *(RN-44, RN-44b)* — **El test de los siete lugares.** Un `.pptx` real:
  (a) lo adjunta el docente al crear la actividad; (b) lo entrega el alumno; (c) **el `accept=`
  de los tres inputs lo ofrece** — verificado leyendo el atributo, no a ojo, porque su olvido
  **no da error**: deja el archivo en gris sin cartel ni log.
- **CA-64** *(RN-44d)* — `subidaPlanos.test.js` extendido **falla** si se saca `.pptx` de
  cualquiera de las siete listas.
- **CA-65** *(RN-44c)* — Los dos carteles escritos a mano nombran PowerPoint; los que salen de
  la lista se actualizaron solos.
- **CA-66** *(RN-44e)* — Un `.pptx` entregado **se previsualiza** por la cadena de Office.

**El log de formatos (§ K)**

- **CA-67** *(RN-45)* — Los **cinco** filtros dejan una línea `evento: 'formato_rechazado'`. Un
  test recorre los cinco y verifica que ninguno rechaza en silencio.
- **CA-68** *(RN-46)* — La línea **no contiene el nombre del archivo** en ningún campo, y **sí**
  contiene usuario, rol, escuela y ruta. El usuario sale de la sesión, no del body.
- **CA-69** *(RN-47)* — `ARCHIVO.PPTX` se guarda como `.pptx`. Los otros dos valores salen de
  **ramas distintas y es fácil confundirlas**: `(invalida)` es cuando el largo **sí** entra
  (1 a 10 caracteres) pero hay algo que no es `[a-z0-9]` — `archivo.p ptx`, `archivo.dwg™`;
  `(sin_ext)` es **todo lo demás**, y ahí cae también el nombre con una "extensión" de 2.000
  caracteres, porque el regex de RN-47 pide entre 1 y 10 caracteres **pegados al final** y con
  2.000 no matchea nada.

  ⚠️ **Corrección de este criterio.** La primera redacción decía que los 2.000 caracteres
  daban `(invalida)`. Era un defecto **de este CA**, no de RN-47: el pseudocódigo de la regla
  siempre dijo lo mismo que el código. Lo cazó el tester antes de implementar y quedó atado en
  `tests/unit/formatoRechazado.test.js`, con las dos ramas separadas y un test propio para el
  nombre largo. El resultado práctico no cambia: el log no se inunda igual, porque los 2.000
  caracteres nunca llegan a escribirse.
- **CA-70** *(RN-48)* — **El rechazo del navegador reporta**: elegir un formato no permitido
  dispara `POST /diagnostico/formato` **además** del cartel, y **no sube un solo byte**.
- **CA-71** *(RN-49)* — `MOTIVOS` de `/subida` **no cambia**, y `tools/ver-subida.js` sigue
  mostrando exactamente lo mismo que antes.
- **CA-72** *(RN-50)* — `tools/ver-formatos.js` agrupa por extensión con cantidad, personas
  distintas y ruta; e **imprime la advertencia** de que mide un piso si el `accept=` sigue
  estricto.
- **CA-73** *(RN-51)* — El límite es por persona: dos personas de la misma IP no se bloquean.
- **CA-74** *(RN-52)* — `COLLECTIONS`, `CARPETAS` y `RUTAS` **no cambian por § K**, y los dos
  tests de backup pasan **sin modificarlos**.

---

## Errores posibles

| CÓDIGO | HTTP | mensaje al usuario | cuándo |
|---|---|---|---|
| `PREFERENCIA_INVALIDA` | 400 | *"Ese modo de vista no existe."* | `modoCorreccion` fuera del enum |
| `SIN_ACCESO` | 403 | *"Sin acceso"* | quien no gestiona la materia toca una ruta del docente |
| `NADA_PARA_DEVOLVER` | 400 | *"No hay ninguna corrección para devolver: falta la nota o la devolución escrita."* | `POST /devolver` sin nadie devolvible |
| `FIRMA_INVALIDA` | 403 | *"El enlace no es válido."* | HMAC que no coincide o firmado para otro archivo |
| `ENLACE_VENCIDO` | 403 | *"El enlace venció. Volvé a abrir la vista previa."* | `exp` en el pasado |
| `SIN_CONVERSOR` | 501 | *"El servidor no tiene instalado el conversor de documentos, así que este archivo solo se puede descargar."* | no hay `soffice` |
| `SIN_CONVERSOR_CAD` | 501 | *"El servidor no tiene instalado el conversor de planos, así que este `.dwg` solo se puede descargar."* | no hay `ODAFileConverter` |
| `ARCHIVO_DEMASIADO_GRANDE` | 413 | *"El archivo pesa N MB y el visor admite hasta M. Descargalo para abrirlo."* | pasa el tope de conversión |
| `CONVERSION_EN_CURSO` | 409 | *"Estamos preparando la vista previa…"* | la cola está ocupada |
| `CONVERSION_FALLIDA` | 422 | *"No se pudo convertir el archivo para verlo acá (puede estar dañado o protegido con contraseña)."* | `soffice` u ODA fallaron, timeout, o sin salida (incluye el caso `xvfb`) |
| `ARCHIVO_NO_ENCONTRADO` | 404 | *"El archivo no está en el servidor. Avisale al alumno que lo vuelva a subir."* | el documento lo nombra, el disco no lo tiene |
| `SIN_ENTREGA` | 404 | *"El hilo se abre con la entrega."* | comentar sobre una entrega que no existe |
| `COMENTARIO_VACIO` | 400 | *"Escribí algo antes de enviar el comentario."* | `texto` vacío |
| `COMENTARIO_LARGO` | 400 | *"El comentario no puede superar los 2000 caracteres."* | supera `maxlength` |
| `HILO_LLENO` | 400 | *"Este hilo llegó al máximo de comentarios."* | 100 comentarios |
| `DEMASIADOS_COMENTARIOS` | 429 | *"Esperá un momento antes de mandar otro comentario."* | rate limit por persona |
| `FORMATO_NO_PERMITIDO` | 400 | *"«.xyz» no se puede subir acá. Aceptamos: …"* (la lista, nunca escrita a mano) | los cinco filtros de RN-45 |

Los mensajes van en español; los códigos en `SCREAMING_SNAKE` en inglés.

---

## Backup — la respuesta punto por punto (D3)

| pregunta | respuesta |
|---|---|
| **¿Colecciones nuevas?** | **Ninguna.** El hilo y su no-leído (RN-29) y las versiones (RN-33) van **embebidos** en `Submission`, ya en `COLLECTIONS`. La preferencia va en `User`. § K no crea ninguna: es log. Si algo obligara a crear una, va con `optional: true` **para siempre**. |
| **¿Carpetas nuevas?** | Una sola: **`archivos/derivados/`**, a **`CARPETAS_EXCLUIDAS`** con el motivo *"se regenera del original; respaldarla duplica el peso sin agregar información"* (RN-17). **El CAD no agrega otra**: los `.dxf` derivados van a la misma. `_versiones/` **no es carpeta nueva**: vive dentro de `archivos/entregas`. |
| **¿`BACKUP_FORMAT_VERSION`?** | Queda en **`1.0`**. |
| **¿Restaurar un backup anterior a la feature?** | Vuelven **sin** `returnedAt`, `privateComments`, `unreadFor*`, `versions` ni `modoCorreccion`. Y eso es lo correcto: `returnedAt` ausente lee **devuelta** (RN-21/22), los arrays ausentes leen vacíos y los booleanos `false` (RN-32b), y `modoCorreccion` toma `'planilla'`. **Ningún alumno pierde de vista una nota y ningún chip aparece de la nada.** |
| **¿Y la cache de derivados?** | `planDeCarpetas()` se arma solo desde `CARPETAS`: el restore **no la toca**. Lo que sobra lo barre `cleanup-files.js`; lo que falta se regenera al primer clic. |
| **¿Los dos tests?** | `backupCobertura.test.js` en verde porque **no hay modelo nuevo**. `backupCarpetas.test.js` en verde **porque `derivados` se declara excluida a propósito** — la diferencia exacta para la que ese test existe, y que hoy no ejercita nadie (`CARPETAS_EXCLUIDAS` está vacía). |
| **Peso** | `_versiones/` hace crecer `archivos/entregas`, ya el 99,8% del paquete. El tope de 5 (RN-34) acota el crecimiento. `derivados` no pesa **por definición**. |

---

## Tests necesarios

### Lógica pura extraída

`public/js/correccion.js` — **nuevo**, quinto hermano de `devoluciones.js`, `edicionEntrega.js`,
`estadoActividad.js` y `visibilidadActividad.js`. Se carga en `views/course.ejs` **antes que
`edicionEntrega.js`** (que ahora lo usa) y antes de `course.js`; como `require()` en
`routes/activities.js`; y en `node --test`:

| función | qué decide |
|---|---|
| `estaDevuelta(grade)` | los tres valores de `returnedAt` (RN-21) |
| `puedeDevolver(grade)` | el botón **y** la ruta (RN-27) |
| `estadoDeEntrega({ sub, grade })` | los 4 estados, chips y filtros (RN-11) |
| `ordenCorreccion(alumnos, filtro)` | el array congelado de ‹ › (RN-09) |
| `renderVisor(att, opciones)` | qué visor y, si no hay, qué motivo (RN-05, RN-20, RN-41) |
| `extensionParaLog(nombre)` | el recorte de RN-47 |

Server-only: `services/firmaArchivo.js` (RN-15), `services/conversionOffice.js` (RN-16),
`services/conversionCad.js` (RN-42), `services/versionesEntrega.js` (RN-34).

### Unit (`npm run test:unit`)

- **`tests/unit/correccion.test.js`** (nuevo) — la matriz de estados; el congelado de
  `ordenCorreccion`; `renderVisor` por cada extensión de `EXT_SUBMISSIONS` (**ninguna** sin
  camino a la descarga, CA-21); los topes de RN-41 contra los tamaños reales; el orden de los
  tres `<script>`.
- **`tests/unit/firmaArchivo.test.js`** (nuevo) — CA-13 entero, sin red.
- **`tests/unit/versionesEntrega.test.js`** (nuevo) — el tope, qué se borra, cuál cae.
- **`tests/unit/returnedAtDefault.test.js`** (nuevo) — **el más importante**: que
  `returnedAt` **no tenga default**, que un `Activity` hidratado sin el campo lea
  `estaDevuelta === true`, y que `POST /:id/grade` sin `devolver` escriba una fecha. Con un
  mensaje de error que explique la catástrofe.
- **`tests/unit/conversionCad.test.js`** (nuevo) — CA-57, CA-58, **CA-54b** (la detección por
  patrón: se le arma un árbol falso con `ODAFileConverter 27.1.0` y otro con `ODAFileConverter
  99.0.0`, y los dos tienen que encontrarse) y **CA-54c** (ninguna invocación directa en Linux).
  **Corre sin depender de que el binario esté instalado**: lo que se testea es la elección de
  ruta, los argumentos y la limpieza, no la conversión.
- **`tests/unit/formatoRechazado.test.js`** (nuevo, § K) — el recorte de RN-47 (los tres
  resultados posibles), que la línea **no** trae el nombre del archivo (CA-68), y el barrido de
  los cinco filtros (CA-67).

### Adecuar lo que ya existe

- **`tests/unit/subidaPlanos.test.js`** — ⚠️ **dos motivos, y ninguno es que falle hoy:**
  1. **PowerPoint**: es el test que ata las listas entre sí, así que se extiende a `.ppt` y
     `.pptx` y pasa a ser el guardián de los siete lugares (RN-44d, CA-64).
  2. **CAD**: sus aserciones sobre `VER_EN_LINEA` siguen siendo ciertas y **no se tocan**, pero
     su encabezado (líneas 19-21) y el test *"el previsualizador manda el plano al botón
     Descargar"* afirman que los planos **no tienen visor**, y eso pasa a ser falso para los
     dos. Se reescribe —no se borra: lo que hay que contar es **por qué** cambió— y se parte:
     el `.dxf` al visor directo, el `.dwg` al visor vía derivado, y la rama de *"no se puede
     previsualizar"* sigue existiendo para todo lo demás.
  Es el caso de CA-55 de `backupCarpetas.test.js`: *un comentario desactualizado no rompe nada,
  y por eso puede quedar años afirmando algo falso justo en el archivo que decide qué se puede
  subir.*
- **`tests/unit/devoluciones.test.js`** — el caso de `resumenGuardado` con *"sin devolver
  todavía"*. `recolectarDevoluciones` y `notaValidaManual` **no se tocan**.
- **`tests/unit/edicionEntrega.test.js`** — la fila del **borrador** (RN-26); las notas legadas
  siguen cerrando igual; el test de orden de `<script>` (línea ~277) pasa a **tres** módulos.
- **`tests/unit/backupCarpetas.test.js`** — el caso de `archivos/derivados` excluida con motivo
  (CA-74/CA-62), igual que se hizo con `salas`.
- **`tests/unit/estadoActividad.test.js`** — un grade en borrador **no** produce el chip de
  *"devolución sin nota"* (RN-24).

### Smoke (`npm run test:smoke`)

Spec **`correccion-de-entregas`**, de punta a punta: 1. el alumno entrega un `.docx` → 2. el
docente pide el enlace firmado y lo baja **sin cookie** → 3. vencido y alterado → 403 × 2 →
4. guarda con `devolver: false` → el alumno **no recibe `myGrade`** → 5. el alumno **puede**
reenviar y su `.docx` viejo queda en `versions[0]` → 6. el alumno **comenta** → el docente ve
*"1 sin leer"* → 7. el docente abre, el chip se apaga, contesta → el alumno ve *"Comentario
nuevo"* → 8. el alumno **B** prueba los tres endpoints del hilo de **A** → 403 → 9. **devolver**
→ el alumno ve la nota → 10. reenviar → 403 `corregida` → 11. `cleanup-files.js --dry-run` → 0
huérfanos → 12. borrar la actividad → nada en disco.

Spec **`planos-dwg-y-dxf-en-el-visor`**: el DXF se dibuja; el DWG **se dibuja** (el binario está
en las dos máquinas donde esto se corre) y, **con la detección apuntada a un binario inexistente,
cae al camino degradado con su motivo y su descarga** — nunca 500. Las dos mitades se corren
siempre: la segunda es la que protege al servidor que todavía no tiene ODA.

Spec **`powerpoint-entra`**: el docente adjunta un `.pptx`, el alumno entrega otro, los dos se
descargan, y los tres `accept=` lo ofrecen (CA-63).

Spec **`formato-rechazado-deja-rastro`** (§ K): subir un `.exe` por la ruta del alumno → 400 →
**hay línea con `evento: 'formato_rechazado'` y `ext: '.exe'`**, sin el nombre del archivo.

Y en la **matriz de ObjectId inválido** (`tests/smoke/specs.js:7619-7635`):
`POST /activities/${id}/devolver`, `GET /activities/${id}/entrega/xxx`,
`POST /activities/${id}/entrega/xxx/comentario`, `POST /activities/${id}/mi-comentario`.

### Roles (`npm run test:roles`)

No hay sección nueva en `config/sections.js`: la matriz de solapas × roles no cambia. Lo que se
fija en smoke: **el alumno nunca entra al corrector** — `GET /:id/entrega/:studentId`,
`POST /:id/devolver`, `POST /:id/entrega/:studentId/comentario` y
`POST /submission-file/:filename/enlace` le dan **403**, incluso sobre su propia entrega. Su
única puerta al hilo es `POST /:id/mi-comentario`.

---

## Dependencias

### 1. LibreOffice — **ya instalado** (2026-09-21)

No es un pendiente: está en las dos máquinas y **verificado convirtiendo de verdad**.

| dónde | versión | verificación |
|---|---|---|
| VPS DonWeb (`138.219.40.80`, producción) | **LibreOffice 24.2.7.2** + Ghostscript 10.02.1 | conversión headless a PDF, OK |
| Windows local (desarrollo) | **LibreOffice 26.8.0** | `.docx` de 19 KB → PDF de 3 páginas (3.525 ms) y `.pptx` → PDF de 2 páginas (1.080 ms), OK |

- Para reinstalarlo (mudanza de servidor, VPS nuevo):
  `sudo apt update && sudo apt install -y libreoffice-writer libreoffice-calc libreoffice-impress`
  (⚠️ **`impress` hace falta para el `.pptx`** de § J), y verificar con `soffice --version`.
- **La detección de RN-16 se mantiene aunque esté instalado**: "está instalado" es una propiedad
  de **dos máquinas concretas**, no del repositorio. Un clon nuevo, un contenedor de CI o el VPS
  siguiente arrancan sin él, y la feature tiene que degradar en vez de romperse.

### 2. ODA File Converter — **ya instalado en las dos plataformas** (2026-09-21)

Va aparte de LibreOffice a propósito: **no es un paquete de los repos**. Pero ya no es un
pendiente: **está instalado y probado contra los 13 planos reales de los alumnos**.

| dónde | versión | ruta | verificación |
|---|---|---|---|
| VPS DonWeb (producción) | **ODA File Converter 27.1** + 10 dependencias + el symlink | `/usr/bin/ODAFileConverter`, invocado con `xvfb-run -a` | **13 de 13** planos reales convertidos, 524 ms/archivo |
| Windows local (desarrollo) | **27.1.0** | `%LOCALAPPDATA%\Programs\ODA\ODAFileConverter 27.1.0\ODAFileConverter.exe` | mismo DWG, salida idéntica (±5 bytes), 1.066 ms |

- **Qué es**: conversor de Open Design Alliance. Se baja **a mano del sitio de ODA aceptando su
  licencia**; no está en `apt`, y **`libredwg` no existe en los repos** del VPS (`apt-cache
  search` no devuelve nada), así que no hay alternativa libre a mano.
- ⚠️ **La descarga pasa por una URL firmada que vence en 60 segundos**: **no se puede automatizar
  con un `curl` en un script de despliegue**. Es un paso manual, sí o sí — y es lo que va a
  hacer que una mudanza de servidor se lo olvide.

**Linux (el VPS), receta completa** — paquete `ODAFileConverter_QT6_lnxX64_8.3dll_27.1.deb`:

```bash
# el .deb instala pero NO arranca sin esto (RN-42e: tres intentos hasta dar con la lista)
apt-get install -y --no-install-recommends \
  libgl1 xvfb libxcb-util1 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
  libxcb-render-util0 libxcb-shape0 libxcb-xkb1 libxkbcommon-x11-0
ln -s libxcb-util.so.1 /usr/lib/x86_64-linux-gnu/libxcb-util.so.0
# y SIEMPRE se invoca así, nunca directo:
xvfb-run -a /usr/bin/ODAFileConverter <in> <out> ACAD2018 DXF 0 1 "*.DWG"
```

**Windows (la máquina de desarrollo)** — paquete
`ODAFileConverter_QT6_vc16_amd64dll_27.1.msi`:

```
msiexec /i ODAFileConverter_QT6_vc16_amd64dll_27.1.msi /qn /norestart ALLUSERS=2 MSIINSTALLPERUSER=1
```

⚠️ **Instalado para toda la máquina falla con el Error 1925 (privilegios insuficientes).** Por
eso va **solo para el usuario** — y eso es también lo que explica que la ruta caiga bajo
`AppData\Local` y no bajo `Program Files`.

- **Cómo lo encuentra el código**: por **patrón**, nunca por la ruta con la versión adentro
  (RN-42c). En Linux, `/usr/bin/ODAFileConverter` y **no** el `/usr/bin/ODAFileConverter_27.1.0.0/`
  que convive al lado. `ODA_FILE_CONVERTER_BIN` le gana a todo (env var, mismo criterio que
  `BACKUP_*_BASE`).
- **Si no está**: `sin_conversor_cad` + Descargar (RN-42c, CA-54). Ya no es el estado por
  defecto, **pero sí el de todo servidor nuevo**.
- ⚠️ **Una mudanza de servidor tiene que repetir los 11 paquetes, el symlink, la descarga manual
  y el `xvfb-run`.** Se cruza con `specs/escalado-multi-maquina.spec.md`, donde el deploy
  **miente diciendo OK**: el servidor nuevo va a arrancar, servir todo y contestar `/health`
  perfecto, **con los planos cayendo al botón Descargar y nadie enterándose**. El `logger.info`
  del arranque es el único aviso.

### 2b. Estado del lado del sistema: **nada pendiente**

| pieza | VPS producción | Windows local |
|---|---|---|
| LibreOffice | ✅ 24.2.7.2 | ✅ 26.8.0 |
| Ghostscript | ✅ 10.02.1 | — (lo usa el backup, no esta feature) |
| ODA File Converter | ✅ 27.1 + 10 deps + symlink + `xvfb-run` | ✅ 27.1.0 (per-user) |

Las dos cadenas —Office y CAD— se pueden **verificar enteras en local antes de pushear**, que es
justamente lo que la salida idéntica entre plataformas (RN-42f) hace confiable.

### 3. npm

| paquete | dónde | por qué |
|---|---|---|
| `dxf-viewer` | **devDependency** | se bundlea y se commitea; el deploy no hace `npm install` |
| `three` | **devDependency** | peer de `dxf-viewer` |
| `esbuild` | ya está (dev) | `build:dxf`, calcado de `build:mediasoup` |
| `xlsx` | **ya está** | **no se toca**: sigue siendo solo del servidor (`export-grades`). RN-14 tachado |
| `express-rate-limit` | **ya está** | el limitador por persona de RN-32 y § K |

### 4. Specs

- `specs/edicion-de-la-entrega.spec.md` — RN-26 modifica su regla y RN-26b **precisa** su CA-17.
- `specs/backup-incremental.spec.md` — RN-38.
- `specs/escalado-multi-maquina.spec.md` — ODA es un prerrequisito manual más que un deploy no
  puede garantizar.
- `specs/metricas-de-uso-y-charlas.spec.md` — precedente de cómo se documenta una carpeta que
  entra o sale del backup.

### 5. Archivos

| archivo | qué |
|---|---|
| `public/js/correccion.js` | **nuevo** — la lógica pura compartida |
| `public/js/dxf-viewer.bundle.js` | **nuevo** — `npm run build:dxf`, commiteado |
| `services/firmaArchivo.js`, `conversionOffice.js`, `conversionCad.js`, `versionesEntrega.js` | **nuevos** |
| `tools/ver-formatos.js` | **nuevo** (§ K) — el resumen por extensión |
| `public/js/course.js` | `renderVisor` + las dos monturas, **visor de imagen (zoom/rotar)**, Modo Corrector, filtros, ‹ ›, panel, hilo, historial, los chips, `SUB_ALLOWED_EXTS` + `accept=` + cartel (§ J), el reporte de rechazo (§ K) |
| `public/js/edicionEntrega.js` | la rama `corregida` llama a `Correccion.estaDevuelta()` |
| `public/css/style.css` | `.modal-detail.is-corrector`, `.corrector-*`, visor de imagen, chips |
| `views/course.ejs` | los `<script>` en orden; el toggle; el `accept=` (§ J) |
| `views/activities/new.ejs` | `DOC_EXTS`, el `accept=` y el cartel (§ J) |
| `routes/activities.js` | rutas nuevas, `rename` a `_versiones/`, `returnedAt`, filtro de `myGrade`, tercer aggregate, `EXT_ALLOWED` + `EXT_SUBMISSIONS` (§ J), los tres `fileFilter` que loguean (§ K) |
| `routes/rooms.js`, `middleware/image-upload.js` | los otros dos `fileFilter` que loguean (§ K) |
| `middleware/route-log.js` | `logFormatoRechazado()`, al lado de `logRechazo` (§ K) |
| `routes/diagnostico.js` | `POST /diagnostico/formato` (§ K) |
| `routes/courses.js` | `PATCH /profile/preferencias` |
| `models/Activity.js`, `models/Submission.js`, `models/User.js` | los campos de § Entidades + el índice |
| `routes/backup.js` | `CARPETAS_EXCLUIDAS['archivos/derivados']` con su motivo |
| `services/diskStats.js` | `RUTAS` suma `derivados` |
| `cleanup-files.js` | referencia `versions[].files[]` (RN-35) + el árbol de derivados |
| `config/audit-actions.js` | `submission.return`, `submission.comment`, `submission.preview_link` |
| `package.json` | `build:dxf` + las dos devDependencies |
| `agente.md` | changelog + LibreOffice y ODA en despliegue |

---

## Riesgos de refactorización

1. **⚠️ El default de `returnedAt` (RN-22).** Riesgo #1 y el único con consecuencia escolar:
   **todas las notas de la escuela desaparecen de la vista del alumno**. Dos disparos (deploy y
   restore), un solo remedio (no tener default). Tiene test propio.
2. **⚠️ El docente que nunca encuentra "Devolver" (RN-27b).** Lo contienen RN-22b
   (ausente = devolver) y el botón primario que sigue publicando.
3. **⚠️ `cleanup-files.js` borra el historial (RN-35).** Silencioso, con cartel de éxito.
4. **⚠️ ODA se olvida en la próxima mudanza de servidor.** Ya no es "instalar un paquete": son
   **11 paquetes, un symlink, una descarga manual con URL que vence en 60 s y una invocación con
   `xvfb-run`**. Y el deploy va a decir OK igual. El `logger.info` del arranque es el único
   aviso. **Es el riesgo operativo más probable de toda la spec**, porque no falla el día que se
   muda: falla el día que alguien abre un plano.
5. **⚠️ Una versión nueva de ODA mueve la carpeta en Windows (RN-42c).** Hardcodear
   `ODAFileConverter 27.1.0` funciona hoy y se rompe en silencio después. Por eso se busca por
   patrón, y por eso CA-54b lo fija con un test.
6. **⚠️ Un `accept=` olvidado (RN-44b).** No da error: deja el archivo en gris. Es el modo de
   falla que § K existe para hacer visible, y CA-63 para prevenir.
7. **La URL firmada abre un agujero de 5 minutos (RN-15).** Decisión, no descuido, y acotada.
8. ~~**`xlsx@0.18.5` sin fix publicado.**~~ **Riesgo eliminado**: el usuario tachó RN-14, así
   que la librería nunca llega al navegador ni toca un archivo de alumno. Queda solo en el
   servidor, donde ya estaba.
9. **La CPU del VPS (RN-16, RN-18).** LibreOffice y ODA son lo más pesado que esta app lanza, y
   **el techo real es 2 simultáneos por los 2 workers**, no 1.
10. **El peso del backup (RN-34, RN-38).** Se saca un tope natural de una versión por alumno.
11. **La carrera borrador ↔ reenvío (RN-26).** Mitigada por el historial y el aviso.
12. **El bundle de three.js (RN-43).** Cientos de KB; va diferido.
13. **`openAttachmentPreview` se usa desde varios lados.** Partirla mal rompe la previsualización
    **del alumno**. Por eso RN-05 exige que el overlay siga existiendo y llame a la misma
    función pura.
14. **`grade-table` tiene dos bloques de CSS** (`style.css:660` y `:1995`), y el segundo pisa al
    primero.
15. **El hilo no existe sin entrega (RN-31).** Limitación aceptada; la caja deshabilitada con su
    motivo impide que se lea como un bug.
16. **`logs/combined.log` no rota** (`agente.md:461`). § K agrega un evento raro, pero el recorte
    de RN-47 es lo que impide que alguien lo infle a propósito. **Riesgo preexistente**, no
    creado acá.
17. **Riesgo adyacente, fuera de alcance: el PDF más grande pesa 19,6 MB contra un tope de 20.**
    No es del corrector; queda anotado para cuando alguien decida subir
    `SUBMISSION_MAX_SIZE`.

---

## Plan de migración

**No hay script de migración, y es a propósito** (RN-22): la protección de los datos viejos es
la semántica del campo, no una `updateMany`.

| fase | qué | se puede probar solo |
|---|---|---|
| **F1** | `public/js/correccion.js` + sus tests unitarios | sí, sin levantar el server |
| **F2** | `returnedAt` (modelo + `/grade` + `devolver` + `myGrade` + `edicionEntrega`) | sí |
| **F3** | Modo Corrector: toggle, layout, `renderVisor` partido, **visor de imagen**, ‹ ›, filtros | sí |
| **F4** | Office: firma → Microsoft → LibreOffice, cache, **prefetch**, `derivados`, backup | sí |
| **F5** | Hilo de dos puntas: comentarios, no-leído, los tres chips y el del alumno | sí |
| **F6** | Historial + `cleanup-files.js` + cascadas | sí |
| **F7** | CAD: `build:dxf`, bundle, visor DXF, conversión DWG, camino degradado | sí (el degradado, incluso sin ODA) |
| **F8** | **PowerPoint: los 7 lugares + el test que los ata** | sí |
| **F9** | **§ K: el log de formatos** (es independiente: se puede revisar y probar sola) | sí |
| **F10** | Smoke + roles + `agente.md` | — |

Antes de pushear:

1. `npm run test:unit`, `npm run test:smoke`, `npm run test:roles` — **las tres**.
2. `npm run build:dxf` y que el bundle quede **commiteado**.
3. `npm run verificar:arbol` — `correccion.js`, los cuatro `services/`, `tools/ver-formatos.js`
   y el bundle son archivos nuevos: el modo de falla del 29/08 fue exactamente un archivo que
   existía solo en la carpeta.
4. Probarlo en el navegador: **una foto torcida**, un `.docx`, un `.pptx`, un `.xlsx`, un
   `.dxf`, un **`.dwg`**, un `.zip` y un PDF de 0 bytes. Y **elegir un `.exe`** para ver el
   cartel y la línea del log.
   ✅ **Se puede verificar todo en local**: LibreOffice y ODA están instalados en el Windows de
   desarrollo, y la salida de ODA es idéntica a la del VPS (RN-42f).
5. **Del lado del sistema no queda nada por instalar** (§ Dependencias 2b). Lo único a verificar
   en el VPS es que `libreoffice-impress` esté presente para el `.pptx` de § J.
6. **A las dos semanas**: `node tools/ver-formatos.js` y decidir con datos qué formato falta y
   si el `accept=` se vuelve a apretar (RN-48).

> ⚠️ **Esta feature escribe campos nuevos en `activities`, `submissions` y `users` de
> producción.** No se pushea sin avisar antes.

---

## Lo que queda afuera, y por qué

- **Subir `SUBMISSION_MAX_SIZE`** (20 MB), aunque el PDF más grande esté a 400 KB del techo. No
  es del corrector. Anotado como riesgo 17.
- **Sacar `.doc` y `.xls`** aunque tengan 0 archivos: RN-01, no se saca nada.
- **Previsualizar `.xlsx` con SheetJS en el navegador** (el ex "paso 0"): **tachado por el
  usuario el 2026-09-21**, con el motivo en RN-14. El `.xlsx` va por la cadena normal. Si
  alguna vez se repropone, el dato que lo frenó es que cubría el 0,13% de las entregas a cambio
  de llevar una librería sin parche al navegador.
- **Que el alumno adjunte archivos en el hilo**: el hilo es texto. Adjuntar es reenviar la
  entrega, que ya tiene su camino.
- **Notificar por correo** "te devolvieron la nota" o "te comentaron": el aviso vive dentro de
  la app (RN-31c, RN-31d).
- **Retirar una devolución**: RN-23 lo prohíbe a propósito.
- **Hilo con quien no entregó** (RN-31): necesitaría un lugar que exista siempre, y los dos
  candidatos rompen contadores que hoy funcionan.
- **Anotaciones sobre el documento** (subrayar el PDF, escribir encima): otra feature entera.
- **Guardar la rotación de la foto** (RN-05b): rotar es de la vista. Reescribir el archivo del
  alumno para enderezarlo es tocar su entrega, y eso necesita su propia decisión.
- **Rúbricas**: no hay pedido.
- **Corregir en el teléfono** (RN-06): el layout no entra.
- **Deduplicar archivos idénticos entre versiones**: no hay hash de contenido; el tope de 5
  resuelve el problema práctico.
- **`.dwg` sin ODA** (una librería JS que lea DWG): no existe una usable; por eso § I pasa por
  el servidor.

---

## Marcado `[TACHABLE]` — resumen

El teclado y el paso entre fotos del visor de imagen — **no** el zoom ni el rotar (RN-05b); los
porcentajes, el ancho y el corte de 768 px (RN-06); el autoguardado al pasar de alumno (RN-10);
el chip *Sin devolver* (RN-11); los 8 s de espera de Microsoft (RN-13); los 15 MB / 45 s de Office
(RN-16); el prefetch del alumno siguiente y el LibreOffice residente (RN-16b); usar el PDF
cacheado antes que Microsoft (RN-16c); el aviso *"la entrega cambió después de que la
corregiste"* (RN-26); las etiquetas de los botones (RN-27b); la columna *Devuelta* del Excel
(RN-28); el filtro *"con comentarios sin leer"* (RN-31c); los 20 comentarios por 5 minutos
(RN-32); el tope de 5 versiones (RN-34); convertir en un solo llamado todos los planos de la
misma entrega (RN-18); los tres topes de CAD — **ya calibrados con lo medido, y si se mueve el de
dibujo hay que recalcular el de entrada con la misma división** (RN-41); el flag de auditoría de
ODA (RN-42b); la elección de `dxf-viewer` (RN-43); el hex del color de PowerPoint y el rename de
`subidaPlanos.test.js` (RN-44d, RN-44e); y **aflojar el `accept=` — recomendado, y reversible en
una línea por input** (RN-48).

**Lo que ya NO es tachable porque está medido**: que el CAD vaya por demanda y el Office con
cola y prefetch (RN-18), la búsqueda del binario por patrón (RN-42c), y el `xvfb-run` con sus
once paquetes (RN-42e).
