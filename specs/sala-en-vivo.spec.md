# Sala en vivo de la materia (presencia + chat) y panel de clases en curso

> **Estado: APROBADA por el usuario el 2026-08-06.** Pendiente de tests e implementación
> (flujo SDD: arquitecto → spec aprobada → **tester** → implementador → revisor).
>
> Decisiones cerradas con el usuario, todas el 2026-08-06 — **no reabrirlas sin él**:
> chat grupal donde todos leen y escriben (RN-14) · historial archivado por clase (RN-01) ·
> dirección entra en observación silenciosa pero auditada (RN-19, RN-20) · el preceptor entra
> siempre visible (RN-26) · las rutas de la sala fuera del `generalLimiter` (RN-09) ·
> purga de mensajes a los 3 meses conservando la asistencia (RN-23) · autocierre a las 3 h
> (RN-08).
>
> **Se implementa en dos fases mergeables por separado**, en este orden:
> **Fase A — la sala** (modelos, rutas de curso, solapa "En vivo", backup).
> **Fase B — los paneles de supervisión**: tarjetas de clases en curso para **dirección**
> (`/directivo/en-vivo`, ingreso en observación) y para **preceptoría**
> (`/preceptor/en-vivo`, acotado a sus divisiones, ingreso visible).
> La Fase B depende de la A; la A se puede mergear y usar sola.

## Objetivo

Que la docente pueda abrir, cuando empieza la clase, un espacio dentro de su materia donde
**ve quiénes se van conectando** —círculos de perfil que aparecen solos— y pueda **hablar con
ellos**, con emojis, sin salir de la plataforma. Que ese mismo espacio deje, sin trabajo
extra, el **registro de quién estuvo presente** en cada clase y la **conversación archivada**.

Y que la directora vea desde su panel, en tarjetas, **qué clases se están dictando ahora
mismo** y pueda entrar a mirar cualquiera. El **preceptor** ve lo mismo, acotado a sus
divisiones, y entra **a la vista de todos**: es quien se ocupa de la asistencia y de los
chicos que faltan, así que su presencia en la sala tiene que ser evidente, no silenciosa.

## Responsabilidades

- Definir el **ciclo de vida de una sesión de sala**: abrir, estar en curso, cerrar,
  autocerrar.
- Definir el **modelo de presencia** (quién está conectado ahora, quién estuvo y cuánto).
- Definir el **chat**: mensajes, emojis, reacciones, moderación y borrado.
- Definir el **transporte** (polling con cursor) y su costo, compatible con PM2 en cluster.
- Definir la **solapa "En vivo"** dentro de la materia y el **historial por clase**.
- Definir el **panel `/directivo/en-vivo`** con sus tarjetas y el **modo observación**.
- Definir el **panel `/preceptor/en-vivo`**, acotado al alcance por divisiones, con **ingreso
  visible**.
- Definir el **permiso de acceso a la sala** sin tocar `canManage()`.
- Garantizar que todo lo nuevo **entra al backup** y a la **auditoría**.

## No responsabilidades

- **No es videollamada ni audio.** Es texto y presencia. Si algún día hace falta video, será
  un link externo pegado en la sala, no una feature de esta spec.
- **No es mensajería privada.** No hay DM alumno↔alumno ni alumno↔docente fuera de la sala.
  Todo mensaje ocurre dentro de una sesión, a la vista de todos los presentes (RN-14).
- **No reemplaza la asistencia oficial** de la escuela. Es un registro de conexión a la sala,
  no un acto administrativo. La vista lo dice con todas las letras (RN-15).
- **No notifica.** Sin mails, sin push, sin campanita. El alumno se entera al entrar a la
  materia. El usuario ya descartó notificaciones para el panel directivo (`agente.md:1259`) y
  esta spec no las reintroduce por la ventana.
- **No toca `Course.canManage()`** ni ningún middleware de rol existente. Ver RN-11.
- **No agrega dependencias npm.** Sin socket.io, sin librería de emoji picker. Ver RN-03.
- **No hay adjuntos ni imágenes en el chat** en esta versión. Texto y emojis. Subir archivos
  abre moderación de contenido, cupo de disco y el `uploadLimiter` — es otra spec.
- **No modifica datos existentes.** Tres colecciones nuevas; ni una migración.

## Entidades/Schemas

Tres modelos nuevos. **Ninguna colección existente se modifica.**

### `models/RoomSession.js` (nuevo)

```js
{
  course:   ObjectId ref Course,  required   // materia
  school:   ObjectId ref School,  required   // DENORMALIZADA — ver RN-16
  division: ObjectId ref Division, required  // DENORMALIZADA — para la tarjeta del directivo
  openedBy: ObjectId ref User,    required
  openedAt: Date, default Date.now
  closedAt: Date, default null               // null = abierta. Único criterio de "en vivo"
  closedBy: ObjectId ref User,    default null
  autoClosed: Boolean, default false         // true = la cerró el autocierre (RN-08)
  title:    String, trim, default ''         // opcional: "Repaso unidad 3"
  lastActivityAt: Date, default Date.now     // último mensaje o ping. Alimenta el autocierre
  lastSeq:  Number, default 0                // contador de mensajes — ver RN-04
  settings: {
    studentsCanWrite: Boolean, default true  // false = modo "solo yo escribo"
    reactionsOn:      Boolean, default true
  }
  mutedStudents: [ObjectId ref User]         // silenciados SOLO en esta sesión (RN-13)
}
// timestamps: true
```

Índices:
```js
{ school: 1, closedAt: 1 }      // panel del directivo: salas abiertas de mi escuela
{ course: 1, openedAt: -1 }     // historial "clases anteriores" de la materia
```

### `models/RoomMessage.js` (nuevo)

```js
{
  session:  ObjectId ref RoomSession, required
  course:   ObjectId ref Course,      required   // denormalizada: purga y export por materia
  author:   ObjectId ref User,        required
  authorName: String, default ''                 // snapshot, igual criterio que AuditLog:7-12
  authorRole: String, default ''                 // 'teacher' | 'student' | 'directivo' | ...
  kind:     String, enum ['text','system'], default 'text'
  text:     String, trim, required, maxlength 500
  seq:      Number, required                     // 1..N dentro de la sesión — ver RN-04
  reactions: [{ emoji: String, users: [ObjectId ref User] }]
  deletedAt: Date, default null                  // soft delete — ver RN-12
  deletedBy: ObjectId ref User, default null
}
// timestamps: true
```

Índices:
```js
{ session: 1, seq: 1 }          // el cursor del poll. Es LA query caliente
```

`authorName`/`authorRole` son snapshot a propósito, por el mismo motivo que en
`models/AuditLog.js:4-12`: si mañana se borra al usuario, la transcripción de una clase de
hace ocho meses tiene que seguir siendo legible.

### `models/RoomPresence.js` (nuevo)

```js
{
  session:   ObjectId ref RoomSession, required
  course:    ObjectId ref Course,      required
  user:      ObjectId ref User,        required
  userName:  String, default ''        // snapshot (misma razón que arriba)
  userRole:  String, default ''        // distingue docente de alumno en el conteo
  firstSeenAt: Date, default Date.now
  lastPingAt:  Date, default Date.now
  pings:       Number, default 1       // cantidad de pings recibidos — ver RN-06
}
```

Índices:
```js
{ session: 1, user: 1 }  // ÚNICO — un documento por persona y sesión
{ session: 1, lastPingAt: -1 }
```

### `services/liveRoom.js` (nuevo)

Todas las constantes en un solo lugar, con su fundamento escrito al lado:

```js
const POLL_MS          = 4000;        // cada cuánto pollea el alumno/docente (RN-03)
const DIRECTIVO_POLL_MS= 15000;       // cada cuánto se repintan las tarjetas (RN-17)
const ONLINE_WINDOW_MS = 45000;       // "conectado ahora" = ping en los últimos 45 s (RN-05)
const AUTO_CLOSE_MS    = 3*60*60*1000;// 3 h sin actividad → autocierre (RN-08)
const MSG_MAX          = 500;         // caracteres por mensaje
const MSG_PER_MIN      = 10;          // mensajes por usuario por minuto (RN-09)
const EMOJIS = ['👋','👍','✋','❓','😀','🎉','✅','😕','❤️','😮','🙏','👏'];

// Funciones PURAS (se testean sin base):
//   isOnline(lastPingAt, now)          → Boolean
//   presenceSummary(presences, total, now) → { presentes, total, conectados: [...] }
//   shouldAutoClose(session, now)      → Boolean
//   sanitizeText(raw)                  → String (trim, colapsa saltos, corta en MSG_MAX)
//
// Funciones con base:
//   openSession(course, user)          → RoomSession
//   closeSession(session, user, {auto}) → RoomSession
//   postMessage(session, user, text)   → RoomMessage  (asigna seq atómicamente)
//   touchPresence(session, user)       → upsert
//   getOpenSessions(schoolId)          → [ tarjetas ] (un solo aggregate — RN-17)
//   exportSession(sessionId)           → { csvAsistencia, csvTranscripcion }
```

### `routes/rooms.js` (nuevo)

Router propio montado en `/courses` **antes** de `courseRoutes` en `server.js`. No hay
colisión con `router.get('/:id')` de `routes/courses.js:519` —`/courses/:id/sala` no matchea
un path de un solo segmento— pero se monta primero igual, para que el orden sea explícito.

### `models/Course.js` — método nuevo (no se modifica ninguno existente)

```js
// ¿Puede ENTRAR a la sala en vivo de esta materia? Es canManage() MÁS el equipo directivo
// de la escuela, MÁS el preceptor cuyo alcance incluye la división de esta materia.
// Deliberadamente separado de canManage(): sumar 'directivo' allá le daría también crear
// actividades, calificar y borrar en las 419 materias, que NO es lo pedido. Entrar a la sala
// no habilita abrirla, cerrarla ni moderarla: eso sigue pidiendo canManage.
//
// El segundo argumento es el alcance del preceptor YA RESUELTO por loadPreceptorScope
// (middleware/preceptor.js:35). No se resuelve acá adentro porque requiere una query, y un
// método de instancia sincrónico no puede hacerla. FAIL-CLOSED: si no se pasa el alcance,
// un preceptor NO entra — nunca "sin alcance = todas", misma regla que models/User.js:78-84.
courseSchema.methods.canWatchLive = function (user, scopeDivisionIds = []) { ... }
```

### Vistas

| Archivo | Qué es |
|---|---|
| `views/partials/live-room.ejs` (nuevo) | **La sala.** Un solo partial, dos contenedores (RN-18) |
| `views/course.ejs` (mod) | Solapa "En vivo" que incluye el partial |
| `views/rooms/standalone.ejs` (nuevo) | Contenedor mínimo del mismo partial, para quien no tiene acceso a la materia entera |
| `views/rooms/session.ejs` (nuevo) | Historial de una clase cerrada: transcripción + asistencia |
| `views/partials/live-cards.ejs` (nuevo) | **Las tarjetas.** Compartidas por los dos paneles (RN-27) |
| `views/directivo/en-vivo.ejs` (nuevo) | Contenedor del partial, con el nav de directivo |
| `views/preceptor/en-vivo.ejs` (nuevo) | Contenedor del partial, con el nav de preceptoría |
| `views/partials/directivo-nav.ejs` (mod) | Solapa "En vivo" |
| `views/partials/preceptor-nav.ejs` (mod) | Solapa "En vivo" |

### `config/sections.js` — entrada nueva

```js
{ key: 'directivo_envivo', panel: 'directivo',  label: 'En vivo', icon: 'sensors',
  path: '/directivo/en-vivo', roles: ['directivo', 'admin', 'superadmin'] },
{ key: 'preceptor_envivo', panel: 'preceptor', label: 'En vivo', icon: 'sensors',
  path: '/preceptor/en-vivo', roles: ['preceptor', 'directivo', 'admin', 'superadmin'] },
```

Ninguna `locked`: mirar las clases en curso es una capacidad institucionalmente sensible y
tiene que poder apagarse por escuela desde `/superadmin/roles` (RN-22). `preceptor_envivo` es
además **la primera solapa configurable del panel de preceptoría** —hoy solo existe
`preceptor_dashboard`, que va `locked` por ser el destino del redirect de "/"
(`config/sections.js:58-62`)—. Esa invariante no se toca: la solapa nueva se puede apagar sin
dejar a nadie afuera de su propio panel.

### `config/audit-actions.js` — acciones nuevas

```js
'room.open':           { label: 'abrió la sala en vivo',      icon: 'sensors',        color: '#137333', category: 'course' },
'room.close':          { label: 'cerró la sala en vivo',      icon: 'sensors_off',    color: '#ea8600', category: 'course' },
'room.observe':        { label: 'observó una sala en vivo',   icon: 'visibility',     color: '#9334e6', category: 'course' },
'room.join_staff':     { label: 'ingresó a una sala en vivo', icon: 'login',          color: '#0d7377', category: 'course' },
'room.delete_message': { label: 'borró un mensaje de la sala',icon: 'delete',         color: '#ea4335', category: 'course' },
'room.mute':           { label: 'silenció a un alumno en la sala', icon: 'volume_off',color: '#ea8600', category: 'course' },
```

### `routes/backup.js` — las tres colecciones al array `COLLECTIONS` (`:55`)

```js
{ name: 'roomsessions',  model: RoomSession },
{ name: 'roommessages',  model: RoomMessage },
{ name: 'roompresences', model: RoomPresence },
```

**Es un requisito, no un extra.** El backup no es un `mongodump`: enumera colecciones a mano.
Sin esta línea el chat no se respalda y nadie se entera hasta el día que haga falta (RN-21).

## Entradas

### Sala (Fase A)

| Ruta | Método | Parámetros | Quién |
|---|---|---|---|
| `/courses/:id/sala` | GET | `?sesion=<id>` (opcional: ver una cerrada) | `canWatchLive` o alumno del curso |
| `/courses/:id/sala/abrir` | POST | `title` (opcional, ≤80) | `canManage` |
| `/courses/:id/sala/cerrar` | POST | — | `canManage` |
| `/courses/:id/sala/poll` | GET | `since` (Number, default 0) | igual que GET sala |
| `/courses/:id/sala/mensajes` | POST | `text` (≤500, requerido) | presentes con permiso de escritura (RN-13) |
| `/courses/:id/sala/mensajes/:mid` | DELETE | — | `canManage` |
| `/courses/:id/sala/mensajes/:mid/reaccion` | POST | `emoji` (de `EMOJIS`) | presentes |
| `/courses/:id/sala/config` | POST | `studentsCanWrite`, `reactionsOn` (Boolean) | `canManage` |
| `/courses/:id/sala/silenciar/:uid` | POST | `muted` (Boolean) | `canManage` |
| `/courses/:id/sala/:sid/export` | GET | `tipo=asistencia\|transcripcion` | `canWatchLive` |

### Paneles de supervisión (Fase B)

| Ruta | Método | Parámetros | Quién |
|---|---|---|---|
| `/directivo/en-vivo` | GET | — | `directivo`, `admin`, `superadmin` con escuela |
| `/directivo/en-vivo/poll` | GET | — | ídem |
| `/preceptor/en-vivo` | GET | — | `ROLES_CON_ACCESO` de `middleware/preceptor.js:16` |
| `/preceptor/en-vivo/poll` | GET | — | ídem |
| `/courses/:id/sala/presentarme` | POST | — | directivo en observación (RN-20) |

El ingreso desde una tarjeta **de dirección** es `GET /courses/:id/sala?modo=observacion`
(RN-19). El ingreso desde una tarjeta **de preceptoría** es `GET /courses/:id/sala` a secas:
visible, sin parámetro y sin opción de esconderse (RN-26).

## Salidas

### `GET /courses/:id/sala/poll`

```
{ estado: 'abierta' | 'cerrada',
  sessionId, seq,                      // seq = último asignado; el cliente lo manda como `since`
  puedoEscribir: Boolean,              // false si silenciado, si modo solo-docente, o si observo
  mensajes: [ { seq, id, kind, autor, rol, esMio, texto, hora, reacciones:[{emoji,n,mia}] } ],
  presencia: {
    total: N,                          // alumnos matriculados en la materia
    presentes: N,                      // alumnos con ping en los últimos 45 s
    conectados: [ { id, nombre, avatar, inicial, rol } ],   // ordenados: docentes primero
    ausentes:   [ { id, nombre, inicial } ]                 // para pintarlos en gris
  },
  settings: { studentsCanWrite, reactionsOn } }
```

`mensajes` trae **solo los de `seq > since`**. En el primer poll (`since=0`) devuelve los
últimos 100 y el cliente pinta desde ahí.

### `GET /directivo/en-vivo` y `GET /preceptor/en-vivo`

**La misma forma para los dos paneles** — cambia el conjunto de salas, no el contrato:

```
{ salas: [ { sessionId, courseId, materia, division, docente, aula,
             desdeMin, presentes, total, mensajes, ultimoMensajeHace,
             avatares: [ {inicial, avatar} ] } ],   // hasta 4, para los circulitos
  cerradasHoy: [ { sessionId, materia, division, desde, hasta, presentes, total } ],
  ingreso: 'observacion' | 'visible',   // cómo entra ESTE rol (RN-26) — lo lee la tarjeta
  scopeAll: Boolean,                    // preceptoría: si ve todas sus divisiones o un recorte
  activePage: 'envivo' }
```

Los `/poll` devuelven el mismo objeto en JSON. El campo `ingreso` es lo que hace que el botón
de la tarjeta diga "Ingresar sin avisar" para dirección y "Ingresar" para preceptoría, y que
apunte a la URL correcta — el partial de tarjetas es uno solo (RN-27).

## Reglas de negocio

- **RN-01 — La sala es una sesión de clase, no un chat perpetuo.** Existe entre `openedAt` y
  `closedAt`. Fuera de eso nadie escribe. Esto es lo que da el registro de asistencia por
  clase y lo que evita un chat de alumnos funcionando a las 3 de la mañana sin ningún adulto.

- **RN-02 — Una sola sesión abierta por materia.** `POST /abrir` con una sesión ya abierta
  devuelve la existente (idempotente, 200), no crea una segunda. Dos docentes de la misma
  materia (`coTeachers`) tocando "Abrir" a la vez es un caso real, no teórico.

- **RN-03 — El transporte es polling, no WebSockets.** Tres razones, todas de esta
  instalación: (1) PM2 corre **en cluster con 2 workers** (`ecosystem.config.js:16`) y un
  mensaje que entra al worker A no llegaría a los clientes del worker B sin sticky sessions
  ni adapter; con polling el estado compartido es Mongo y el problema no existe;
  (2) `compression()` (`server.js:66`) y Tailscale Funnel en el medio hacen de los streams
  largos un problema que no vale la pena para 25 chicos; (3) cero dependencias nuevas — el
  deploy sigue siendo `git pull` + `pm2 reload`. Un `GET /poll` cada 4 s son dos queries
  indexadas: con 30 personas, ~7 req/s.

- **RN-04 — El cursor es `seq`, no `createdAt`.** `seq` se asigna con
  `findOneAndUpdate({_id}, {$inc:{lastSeq:1}}, {new:true})`, que es atómico **entre los dos
  workers**. Usar fechas como cursor pierde mensajes cuando dos caen en el mismo
  milisegundo, y eso pasa justo cuando media clase contesta a la vez.

- **RN-05 — "Conectado ahora" = ping en los últimos 45 s.** Son ~3 ciclos de poll: tolera una
  pestaña trabada o un WiFi que hipa sin sacar al chico de la lista. No se usa
  `User.lastSeen` para esto: ese campo es global (`middleware/auth.js:59-66`, throttle de
  1 min) y dice "está en la plataforma", no "está en esta clase".

- **RN-05b — El PERSONAL se mide con una ventana de 3 minutos, no de 45 s**
  (`STAFF_ONLINE_WINDOW_MS`). Agregada el **2026-08-13** por un reclamo del usuario: la docente
  abría la sala, se iba a Novedades o Actividades —solapas de la misma página— y a los 45 s
  desaparecía de la sala para todos, que se lee como *"cerró la clase"*. La sala nunca se
  cerraba: el poll se corta cuando la solapa En vivo no está a la vista (ver `aLaVista()`), y
  sin poll no hay ping.
  Se arregla con **dos mitades que se necesitan**: un **latido** en el cliente (cada 20 s, solo
  para quien gestiona la sala, y solo cuando el poll normal no está corriendo) y esta ventana
  más larga en el servidor. La ventana hace falta porque con la pestaña del navegador en
  segundo plano el navegador baja los timers a uno por minuto: con 45 s, el latido throttleado
  llegaría tarde y la docente parpadearía dentro y fuera de la sala. Arrancó en 2 minutos y el
  usuario la subió a **3** el mismo día: son ~3 latidos throttleados de margen, así que hacen
  falta tres seguidos perdidos —y no uno— para que desaparezca de la sala.
  **La ventana de los alumnos NO se toca**: ese número es el "N de M presentes" de la clase y
  tiene que seguir siendo fiel. La presencia del personal no alimenta ningún conteo (RN-07),
  solo dice quién está a cargo. Y sigue siendo honesta: dice "pingueó hace menos de 3 minutos",
  no "está" — una máquina apagada se cae igual, un rato después.

- **RN-06 — La presencia se acumula, no se pisa.** `touchPresence` hace upsert con
  `$setOnInsert: {firstSeenAt}`, `$set: {lastPingAt}`, `$inc: {pings:1}`. Un alumno que entra,
  se cae y vuelve tiene **un** documento, con su primer ingreso intacto. El tiempo estimado de
  permanencia se calcula como `pings × POLL_MS`, no como `lastPing − firstSeen`: si se fue a
  la mitad y volvió al final, el segundo número mentiría a favor del alumno.

- **RN-07 — El docente también genera presencia**, con `userRole: 'teacher'`. Los conteos de
  "presentes" que se muestran son **solo de alumnos** (`total` = `course.students.length`),
  pero el círculo de la docente aparece primero en la fila. Que se vea quién está a cargo.

- **RN-08 — Autocierre a las 3 h sin actividad, sin cron.** Se evalúa **perezosamente**: cada
  `poll` y cada listado del directivo revisa `shouldAutoClose()` y cierra si corresponde, con
  `autoClosed: true` y un mensaje de sistema *"La sala se cerró automáticamente por
  inactividad."*. No se agrega un scheduler: con 2 workers, un `setInterval` correría dos
  veces y sería la cuarta forma de que este proyecto se pise a sí mismo en cluster.

- **RN-09 — Límite de escritura por USUARIO, no por IP.** 10 mensajes por minuto por usuario.
  Y —crítico— **las rutas de la sala quedan fuera del `generalLimiter`** de `server.js:85`,
  que permite 1200 req cada 15 min **por IP**: toda la escuela sale por la misma IP pública
  NAT (es el motivo documentado de que `authLimiter` sea 3000). Un poll de 4 s de 25 alumnos
  agota ese cupo en dos minutos y **rompe la aplicación entera, no solo el chat**. Se agrega
  `/sala` al `skip` del `generalLimiter` (junto a `/css/` y `/js/`) y se define un limiter
  propio en `middleware/rate-limits.js` con `keyGenerator` por `req.userId`.

- **RN-10 — El acceso a la sala es el del curso, más dirección, más el preceptor de esa
  división.** Alumno de `course.students`, o `course.canWatchLive(user, scopeDivisionIds)`.
  Un alumno de otra división no entra ni con el link. Mismo criterio de rechazo que
  `routes/courses.js:529`: 403 «Acceso denegado».

- **RN-11 — `canManage()` no se toca.** Entrar a mirar y poder gestionar son cosas distintas:
  `canManage` hoy concede crear actividades, calificar y borrar (`models/Course.js:114-124`).
  Abrir, cerrar, moderar, silenciar y configurar la sala piden `canManage`; entrar y leer
  piden `canWatchLive`.

- **RN-12 — Borrar un mensaje es soft delete.** `deletedAt`/`deletedBy` se setean y el
  mensaje se muestra como *"Mensaje eliminado por la docente"*, conservando `seq` — si
  desapareciera de la secuencia, los clientes que ya lo tienen quedarían desincronizados. El
  texto original **se conserva en la base**: es lo que permite reconstruir qué pasó si hubo un
  problema de convivencia, que es justamente cuando se borra un mensaje. Queda auditado.

- **RN-13 — La moderación dura lo que dura la clase.** `mutedStudents` vive en la sesión, no
  en el usuario ni en el curso: silenciar a alguien un martes no lo arrastra al jueves. El
  silenciado **sigue viendo** la conversación y sigue contando como presente; solo pierde el
  cuadro de escribir. Igual que `settings.studentsCanWrite: false` ("solo yo escribo"), que
  también es por sesión.

- **RN-14 — Todos ven todo lo que se escribe en la sala.** Decisión del usuario (2026-08-06):
  chat grupal, alumnos y docente se leen entre sí. No hay mensajes privados. La moderación de
  RN-12/RN-13 es la contrapartida.

- **RN-15 — Aviso permanente, visible desde que la sala se abre**, en texto fijo:
  *"Esta sala queda registrada y el equipo directivo puede supervisarla."* No dice quién ni
  cuándo, así que no rompe el modo observación (RN-19), pero hace que nadie escriba creyendo
  que está en un espacio privado. Segunda línea fija, más chica: *"El registro de conexión no
  reemplaza la asistencia oficial."* Son dos líneas de HTML y son lo que convierte esto en una
  regla conocida en vez de una vigilancia encubierta.

- **RN-16 — Multi-tenant sin excepciones.** `RoomSession.school` va denormalizada porque el
  panel del directivo lista **por escuela**: sin ese campo habría que traer todas las sesiones
  abiertas del sistema y filtrar en memoria por el curso populado. Todo `$match` del panel
  arranca por `school: res.locals.user.school`.

- **RN-17 — Las tarjetas salen de UN aggregate**, no de una query por tarjeta:
  `RoomSession` abiertas de la escuela → `$lookup` a `RoomPresence` (contando las que tienen
  `lastPingAt >= now − 45 s`) → `$lookup` a `Course` (nombre, división, docente, `students`
  para el total) → `$lookup` a `RoomMessage` para el conteo y el último. Refresco cada 15 s,
  no 4: esto es supervisión, no conversación. **Un solo `getOpenSessions(schoolId, {
  divisionIds })`** sirve a los dos paneles: dirección lo llama sin `divisionIds` (toda la
  escuela) y preceptoría con su alcance (RN-28). Dos consultas distintas para la misma
  pregunta terminarían mostrando números distintos, que es exactamente la lección que dejó
  escrita `services/divisionDetail.js:4-6`.

- **RN-18 — La sala es un solo partial en dos contenedores.** `views/partials/live-room.ejs`
  se incluye tanto desde la solapa "En vivo" de `views/course.ejs` (docente y alumnos, que ya
  están adentro de la materia) como desde `views/rooms/standalone.ejs` (dirección, que **no**
  tiene acceso a `GET /courses/:id` y no debe tenerlo). Un solo lugar donde arreglar un bug de
  la sala.

- **RN-19 — Dirección, y solo dirección, entra sin que la sala lo note.** Decisión del
  usuario (2026-08-06). Con
  `?modo=observacion`: **no** se hace `touchPresence`, **no** se emite mensaje de sistema, el
  contador de presentes no se mueve y el círculo no aparece. Para docente y alumnos la
  pantalla es idéntica.

- **RN-20 — En observación no se puede escribir, y por eso existe "Presentarme".** El cuadro
  de escribir no se renderiza en modo observación. Es la única forma coherente: si pudiera
  escribir, se revelaría igual pero de la peor manera —de golpe y en medio de la clase. El
  botón "Presentarme" la pasa a modo visible (presencia + mensaje de sistema *"NOMBRE, del
  equipo directivo, ingresó a la sala"*) y recién ahí habilita la escritura. Aparecer es una
  decisión suya y explícita. **El ingreso en observación se audita igual** (`room.observe`,
  con `meta: { sessionId, docente, minutos }`): invisible en la sala, visible en
  `/admin/audit`. Silencioso no es secreto.

- **RN-21 — Todo lo nuevo entra al backup.** Las tres colecciones van al array `COLLECTIONS`
  de `routes/backup.js:55`, al manifiesto y al diff de restauración, en el **mismo commit**
  que crea los modelos. Además, la docente puede exportar cada clase (asistencia y
  transcripción en CSV) sin depender del backup.

- **RN-22 — La solapa de dirección se puede apagar por escuela.** `directivo_envivo` va sin
  `locked` en `config/sections.js`, así que `/superadmin/roles` puede quitársela al rol
  `directivo` y `middleware/sections.js` devuelve 403 en la ruta, no solo esconde el botón.

- **RN-23 — Retención: 3 meses de mensajes, asistencia para siempre.** Decisión del usuario
  (2026-08-06). Las sesiones y su presencia se conservan **indefinidamente**: son el registro
  de quién estuvo en cada clase, ocupan muy poco y es el dato que se puede necesitar meses
  después. Los **mensajes** de sesiones cerradas hace más de **3 meses** se purgan con un
  script manual (`cleanup-rooms.js`, con `--dry-run`, mismo patrón que `cleanup-files.js`).
  No corre solo: lo ejecuta el usuario cuando decide.

  Con 3 meses, la ventana cubre un trimestre completo —alcanza para revisar lo que pasó en
  una clase dentro del mismo período lectivo— y mantiene la colección chica. Consecuencia a
  tener presente: una clase de marzo ya no tiene transcripción en julio. **La asistencia de
  esa clase sí sigue estando**, que es lo que se consulta de verdad a la distancia. Si la
  docente necesita conservar una conversación puntual, la exporta en CSV antes (CU-10) —
  el export es la vía deliberada para eso, no el backup.

  El script imprime **qué va a borrar antes de borrarlo** (cuántas sesiones, de qué materias,
  qué rango de fechas) y pide confirmación. Borrar conversaciones de menores es una operación
  de una sola dirección: nunca en silencio.

- **RN-24 — Sin `NaN` ni división por cero.** Una materia sin alumnos matriculados
  (`total: 0`) muestra "0 presentes", no `NaN%` ni "0 de 0". Es un caso real: hay materias
  recién creadas.

- **RN-25 — ObjectId malformado responde 404, no 500.** Deuda conocida de las rutas `/:id`
  del panel (`agente.md:823`); las rutas nuevas no la heredan:
  `mongoose.isValidObjectId()` al entrar a cada handler.

- **RN-26 — El preceptor entra SIEMPRE visible, y no puede esconderse.** Decisión del usuario
  (2026-08-06), y el contraste con RN-19 es deliberado: el preceptor es quien se ocupa de la
  asistencia y de los chicos que faltan, así que su trabajo **es** aparecer —"te veo, no
  estás"—, no observar sin que se note. Al entrar: se crea su `RoomPresence`, su círculo
  aparece con la etiqueta **"Preceptoría"**, y se agrega el mensaje de sistema *"NOMBRE, de
  preceptoría, ingresó a la sala."*. Puede escribir desde el primer segundo. `?modo=observacion`
  en la URL **se ignora** para el rol `preceptor` — no es un parámetro que lo habilite: es un
  parámetro que solo dirección puede usar. Se audita con `room.join_staff`.

- **RN-27 — Un solo partial de tarjetas para los dos paneles.** `views/partials/live-cards.ejs`
  se incluye desde `views/directivo/en-vivo.ejs` y desde `views/preceptor/en-vivo.ejs`. La
  única diferencia la decide el campo `ingreso` de la salida: el destino del botón
  (`?modo=observacion` o la URL pelada) y su texto. Mismo criterio que RN-18 para la sala:
  un solo lugar donde arreglar un bug de las tarjetas.

- **RN-28 — El preceptor ve solo sus divisiones, y el alcance vacío no ve nada.** Se resuelve
  con el middleware que ya existe, `loadPreceptorScope` (`middleware/preceptor.js:35`), que
  además filtra por escuela incluso sobre `assignedDivisions` —un usuario movido de escuela
  podría arrastrar divisiones viejas pegadas (`:31-34`)—. `getOpenSessions` recibe ese arreglo
  y lo aplica en el `$match`. **Fail-closed sin excepciones**: un preceptor sin divisiones
  asignadas ve la pantalla vacía y no entra a ninguna sala, nunca "sin alcance = todas"
  (`models/User.js:78-84`). Y no alcanza con filtrar las tarjetas: entrar a
  `/courses/:id/sala` de una división fuera de alcance escribiendo la URL a mano tiene que dar
  403 — es exactamente el agujero que `inScope()` existe para tapar (`:63-67`).

- **RN-29 — Los roles con más privilegio que el preceptor entran a su panel viendo todo.**
  `directivo`, `admin` y `superadmin` están en `ROLES_CON_ACCESO` y en `ROLES_SIN_LIMITE`
  (`middleware/preceptor.js:16-19`), así que `/preceptor/en-vivo` les muestra la escuela
  entera. Pero **el modo de ingreso lo decide el rol, no el panel**: un directivo que entra a
  una sala desde la tarjeta de `/preceptor/en-vivo` sigue entrando en observación (RN-19).
  Si no, la pantalla por la que se accede se convertiría en una forma de elegir si te ven.

- **RN-30 — La hora la pone el servidor, no el navegador.** Toda hora o fecha que muestre la
  sala (mensajes, clases anteriores, transcripción y los CSV) se formatea en el servidor con
  la zona horaria de la escuela — `TZ` en `services/liveRoom.js`, `America/Argentina/Buenos_Aires`,
  configurable con `SCHOOL_TZ`. Al cliente le llega el texto ya armado (`"14:05"`), nunca la
  fecha cruda. **Motivo**: formateada en el navegador, la hora salía de la zona horaria de cada
  máquina; las del aula tienen cualquiera configurada, así que el mismo mensaje aparecía a una
  hora distinta en cada pantalla. Y el servidor de producción corre en UTC, con lo cual las
  vistas renderizadas del lado del servidor mostraban tres horas de más. Una transcripción de
  clase con horas que dependen de quién la mira no sirve como registro de nada.

## Casos de uso

| # | Caso de uso | Actor | Qué resuelve |
|---|---|---|---|
| CU-01 | Abrir la sala al empezar la clase | docente | El espacio existe solo mientras hay clase |
| CU-02 | Ver quiénes se van conectando, en círculos | docente | "¿Quiénes están hoy?" de un vistazo |
| CU-03 | Hablar con el grupo, con emojis | docente y alumnos | La conversación de la clase |
| CU-04 | Reaccionar a un mensaje | alumnos | Participar sin llenar el chat de "ok" |
| CU-05 | Borrar un mensaje fuera de lugar | docente | Moderación inmediata |
| CU-06 | Silenciar a un alumno por esta clase | docente | Moderación sin castigo permanente |
| CU-07 | Pasar la sala a "solo yo escribo" | docente | Recuperar el orden sin cerrar la sala |
| CU-08 | Cerrar la sala al terminar | docente | La clase queda archivada |
| CU-09 | Consultar una clase anterior | docente y alumnos | Transcripción + quiénes estuvieron |
| CU-10 | Exportar asistencia y transcripción | docente | Llevar el dato afuera (CSV) |
| CU-11 | Ver en tarjetas qué clases se dictan ahora | directivo | "¿Qué está pasando en la escuela?" |
| CU-12 | Entrar a mirar una clase sin interrumpir | directivo | Observación (RN-19) |
| CU-13 | Hacerse ver y participar | directivo | "Presentarme" (RN-20) |
| CU-14 | Ver qué clases de **mis** divisiones se dictan ahora | preceptor | Tarjetas acotadas al alcance |
| CU-15 | Entrar a una sala y que el curso lo vea | preceptor | Ingreso visible (RN-26) |
| CU-16 | Preguntar por un chico que no aparece conectado | preceptor | Escribe en la sala como cualquiera |
| CU-17 | Revisar quién observó o ingresó a qué sala | admin | `/admin/audit`, `room.observe` / `room.join_staff` |
| CU-18 | Que la escuela no exponga las salas a un rol | superadmin | Apagar `directivo_envivo` o `preceptor_envivo` |

Auditables (van a `config/audit-actions.js`): CU-01, CU-05, CU-06, CU-08, CU-12, CU-13, CU-15.

## Criterios de aceptación

### Lógica pura (`services/liveRoom.js`, se testea sin base de datos)

- **CA-01** — Dado `lastPingAt` hace 10 s, entonces `isOnline` es `true`; hace 60 s, `false`;
  hace exactamente 45 s, `true` (el borde es inclusivo).
- **CA-02** — Dadas 3 presencias frescas de alumno, 1 vieja y 1 de docente fresca, sobre una
  materia de 25 alumnos, entonces `presentes === 3`, `total === 25`, y la docente aparece
  **primera** en `conectados` pero **no** suma al conteo de presentes (RN-07).
- **CA-03** — Dada una materia con `total: 0`, entonces el resumen devuelve `presentes: 0`,
  `total: 0` y ningún `NaN` ni `Infinity` (RN-24).
- **CA-04** — Dada una sesión con `lastActivityAt` hace 2 h 59 min, `shouldAutoClose` es
  `false`; hace 3 h 01 min, `true`; una sesión **ya cerrada**, `false` siempre.
- **CA-05** — Dado un texto de 800 caracteres, `sanitizeText` devuelve 500; dado `"   "`,
  devuelve `''` (y el POST lo rechaza); dado un texto con 6 saltos de línea seguidos, los
  colapsa a 2.
- **CA-06** — Dado un texto con `<script>alert(1)</script>`, entonces se almacena tal cual y
  la vista lo imprime con `<%= %>` (escapado), sin ejecutarse. El HTML renderizado no contiene
  un `<script>` proveniente del mensaje.

### Sala — apertura y cierre

- **CA-07** — Dada una materia sin sala abierta, cuando la docente hace `POST /abrir`,
  entonces se crea una `RoomSession` con `closedAt: null`, `school` y `division` pobladas, y
  se registra `room.open` en auditoría.
- **CA-08** — Dada una sala ya abierta, cuando **otro** docente de la misma materia hace
  `POST /abrir`, entonces responde 200 con **la misma** sesión y **no** existe una segunda
  sesión abierta para esa materia (RN-02).
- **CA-09** — Dado un alumno, cuando hace `POST /abrir`, entonces 403 y no se crea nada.
- **CA-10** — Dada una sala abierta, cuando la docente hace `POST /cerrar`, entonces
  `closedAt` queda seteado, se agrega un mensaje `kind: 'system'`, y un `POST /mensajes`
  posterior responde 409.
- **CA-11** — Dada una sesión con `lastActivityAt` hace más de 3 h, cuando alguien hace
  `GET /poll`, entonces la sesión queda cerrada con `autoClosed: true` y el poll responde
  `estado: 'cerrada'` (RN-08).

### Sala — presencia

- **CA-12** — Dado un alumno del curso, cuando hace `GET /poll`, entonces existe **un**
  `RoomPresence` suyo para esa sesión y aparece en `conectados`.
- **CA-13** — Dado ese mismo alumno polleando 5 veces, entonces sigue habiendo **un solo**
  documento (índice único), con `pings: 5` y `firstSeenAt` sin cambios (RN-06).
- **CA-14** — Dado un alumno que dejó de pollear hace 60 s, entonces desaparece de
  `conectados`, aparece en `ausentes`, y su `RoomPresence` **sigue existiendo** con su
  `firstSeenAt` (estuvo, aunque ahora no esté).
- **CA-14b** — Dada una docente con la sala abierta que se va a otra solapa de su materia,
  cuando pasan 90 s, entonces **sigue en `conectados`** para alumnos y supervisión (RN-05b),
  mientras que un alumno con ese mismo último ping ya no. Pasada su ventana (3 minutos), la
  docente también se cae: es una tolerancia, no un "siempre presente".
- **CA-15** — Dada una sesión cerrada, cuando se consulta el historial, entonces la lista de
  quiénes estuvieron es la misma que había al cerrarla.

### Sala — mensajes

- **CA-16** — Dado un alumno presente, cuando postea "hola 👋", entonces el mensaje se guarda
  con `seq` = anterior + 1, y un `GET /poll?since=<anterior>` lo devuelve.
- **CA-17** — Dados dos mensajes posteados **en el mismo milisegundo** desde dos conexiones,
  entonces reciben `seq` distintos y consecutivos, y ningún poll pierde uno de los dos
  (RN-04). *(Test: dos POST en paralelo con `Promise.all`.)*
- **CA-18** — Dado `since` igual al último `seq`, entonces `mensajes` viene vacío (no se
  reenvía toda la conversación en cada ciclo).
- **CA-19** — Dado `since=0` en una sala con 250 mensajes, entonces devuelve los últimos 100.
- **CA-20** — Dado un texto vacío o solo espacios, entonces 400 y no se crea mensaje.
- **CA-21** — Dado un mismo usuario posteando 11 mensajes en un minuto, entonces el 11°
  recibe 429 y los 10 anteriores están guardados (RN-09).
- **CA-22** — Dado un alumno **de otra materia**, cuando postea en esta sala, entonces 403.
- **CA-23** — Dada `settings.studentsCanWrite: false`, entonces el alumno recibe 403 al
  postear, `puedoEscribir` es `false` en su poll, y **la docente sí puede** postear.
- **CA-24** — Dado un alumno en `mutedStudents`, entonces no puede postear (403), pero su
  poll sigue devolviendo mensajes y sigue contando como presente (RN-13).
- **CA-25** — Dado que la docente borra un mensaje, entonces `deletedAt` queda seteado, el
  `seq` se conserva, el poll devuelve el mensaje marcado como eliminado, el `text` original
  **sigue en la base**, y se audita `room.delete_message` (RN-12).
- **CA-26** — Dado un alumno intentando borrar un mensaje (propio o ajeno), entonces 403.
- **CA-27** — Dada una reacción con un emoji **fuera** de la lista `EMOJIS`, entonces 400.
- **CA-28** — Dado un usuario que reacciona dos veces con el mismo emoji, entonces la
  reacción se **quita** (toggle) y no queda duplicado en `users`.

### Sala — acceso y vista

- **CA-29** — Dado un alumno del curso, cuando abre `/courses/:id/sala`, entonces 200 y ve la
  sala.
- **CA-30** — Dado un alumno de **otra** división, entonces 403 «Acceso denegado» (RN-10).
- **CA-31** — Dado un `directivo` de la misma escuela, entonces 200 (`canWatchLive`).
- **CA-32** — Dado un `directivo` de **otra** escuela, entonces 403.
- **CA-33** — Dado un `directivo` **o un `preceptor`**, cuando intenta `POST /abrir`,
  `/cerrar`, `/config`, `/silenciar` o borrar un mensaje, entonces **403 en las cinco para
  ambos** — `canWatchLive` no concede gestión (RN-11).
- **CA-33b** — Dado un `preceptor` con la división de la materia en su alcance, entonces 200;
  con la división **fuera** de su alcance, 403 aunque escriba la URL a mano; con
  `assignedDivisions: []` y `allDivisions: false`, **403 siempre** (RN-28).
- **CA-34** — Dado el HTML de la sala, entonces contiene el aviso fijo de RN-15 (ambas
  líneas), tanto con la sala abierta como cerrada.
- **CA-35** — Dado `/courses/:id/sala` con `:id` malformado, entonces 404 (no 500); con un
  ObjectId válido inexistente, 404 (RN-25).
- **CA-36** — Dada una materia **sin ninguna sesión**, cuando el alumno abre la solapa,
  entonces ve el estado vacío ("La sala no está abierta"), 200, sin tabla ni chat vacío.
- **CA-37** — Dado el export `?tipo=asistencia` de una sesión cerrada, entonces devuelve un
  CSV con una fila por alumno del curso, su estado (presente/ausente), `firstSeenAt` y
  minutos estimados; `?tipo=transcripcion`, un CSV con `seq`, hora, autor, rol y texto,
  incluyendo los eliminados marcados como tales.

### Paneles de supervisión

- **CA-38** — Dadas 3 salas abiertas en su escuela y 1 en otra escuela, cuando la directora
  abre `/directivo/en-vivo`, entonces ve **3** tarjetas y ninguna de la otra escuela (RN-16).
- **CA-39** — Dada una tarjeta, entonces muestra materia, división, docente, minutos desde la
  apertura, "N de M presentes", conteo de mensajes y hasta 4 círculos de avatar.
- **CA-40** — Dadas 0 salas abiertas, entonces 200 con estado vacío (no una grilla vacía).
- **CA-41** — Dado `GET /directivo/en-vivo/poll`, entonces devuelve el mismo JSON y una sala
  cerrada entre dos pollings **desaparece** de la lista en el siguiente.
- **CA-42** — Dada una sesión cerrada hoy, entonces aparece en `cerradasHoy` con su horario y
  su conteo de presentes; una cerrada ayer, no.
- **CA-43** — Dado un `teacher`, `student` o `preceptor`, cuando abre `/directivo/en-vivo`,
  entonces 403.
- **CA-44** — Dado que el superadmin apagó `directivo_envivo` para el rol `directivo` en esa
  escuela, entonces `/directivo/en-vivo` responde 403 **y** la solapa desaparece del nav
  (RN-22).
- **CA-45** — Dado un directivo **sin escuela**, entonces ve `directivo/no-school` (200), igual
  que el resto del panel.
- **CA-46** — Dado el HTML del panel, entonces no contiene `NaN`, `Infinity` ni `undefined`,
  aunque haya una sala en una materia sin alumnos (RN-24).
- **CA-46a** — Dado un preceptor con **una** de las 3 divisiones con sala abierta en su
  alcance, cuando abre `/preceptor/en-vivo`, entonces ve **1** tarjeta (RN-28).
- **CA-46b** — Dado un preceptor **sin divisiones asignadas** (`allDivisions: false`,
  `assignedDivisions: []`), entonces ve 200 con la pantalla vacía, **cero** tarjetas, y
  entrar a cualquier sala por URL da 403. Fail-closed (RN-28).
- **CA-46c** — Dado un preceptor, cuando abre `/directivo/en-vivo`, entonces 403 (su panel es
  `/preceptor/en-vivo`; el del directivo no lo incluye).
- **CA-46d** — Dado un `directivo` abriendo `/preceptor/en-vivo`, entonces 200 y ve **todas**
  las salas de la escuela (`ROLES_SIN_LIMITE`), y el campo `ingreso` sigue siendo
  `'observacion'` — el panel por el que entró no cambia cómo lo ven (RN-29).
- **CA-46e** — Dadas las tarjetas de preceptoría, entonces el botón apunta a
  `/courses/:id/sala` **sin** `?modo=observacion`; dadas las de dirección, **con** (RN-27).

### Modo observación

- **CA-47** — Dado un directivo entrando con `?modo=observacion`, entonces **no** se crea
  `RoomPresence` suya, el conteo de presentes **no cambia**, y no se agrega ningún mensaje de
  sistema (RN-19).
- **CA-48** — Dado ese mismo ingreso, entonces el poll de un alumno de esa sala devuelve
  exactamente los mismos `conectados` que antes de que entrara.
- **CA-49** — Dado el modo observación, entonces `puedoEscribir` es `false` y un `POST
  /mensajes` responde 403 aunque quien lo haga sea directivo (RN-20).
- **CA-50** — Dado el ingreso en observación, entonces se registra un `AuditLog` con
  `action: 'room.observe'`, el actor correcto y `meta.sessionId`, y ese evento **aparece** en
  `/admin/audit` (RN-20).
- **CA-51** — Dado que la directora toca "Presentarme", entonces se crea su `RoomPresence`,
  se agrega el mensaje de sistema con su nombre, `puedoEscribir` pasa a `true` y se audita.
- **CA-52** — Dada una directora ya presentada, entonces **no** puede volver a modo
  observación en la misma sesión (el botón no existe): ya la vieron, esconderla después sería
  peor que no haber entrado.

### Ingreso del preceptor (visible)

- **CA-52a** — Dado un preceptor con la división en su alcance entrando a
  `/courses/:id/sala`, entonces se crea su `RoomPresence` con `userRole: 'preceptor'`, su
  círculo aparece en `conectados` con la etiqueta "Preceptoría", y se agrega un mensaje
  `kind: 'system'` con su nombre (RN-26).
- **CA-52b** — Dado ese mismo preceptor, entonces `puedoEscribir` es `true` y puede postear
  (200), sin necesidad de "Presentarme" — ese botón no existe para él.
- **CA-52c** — Dado un preceptor entrando con `?modo=observacion` en la URL, entonces el
  parámetro **se ignora**: se crea su presencia y se emite el mensaje de sistema igual
  (RN-26). *Es el test que impide que el modo silencioso se filtre a otro rol por la URL.*
- **CA-52d** — Dado el ingreso del preceptor, entonces se registra un `AuditLog` con
  `action: 'room.join_staff'` y `meta.sessionId`.
- **CA-52e** — Dado un preceptor que entra dos veces a la misma sesión (recarga la página),
  entonces el mensaje de sistema se emite **una sola vez** — su `RoomPresence` ya existe, y
  anunciarlo en cada F5 llenaría el chat.

### Purga (`cleanup-rooms.js`)

- **CA-52f** — Dada una sesión cerrada hace **más** de 3 meses, cuando se corre la purga,
  entonces sus `RoomMessage` se borran y su `RoomSession` y sus `RoomPresence` **quedan
  intactos** (RN-23).
- **CA-52g** — Dada una sesión cerrada hace **menos** de 3 meses, entonces sus mensajes no se
  tocan; dada una sesión **abierta** con `openedAt` de hace un año (sala olvidada que el
  autocierre ya debería haber cerrado), tampoco: el criterio es `closedAt`, nunca `openedAt`.
- **CA-52h** — Dado `--dry-run`, entonces **no se borra nada** y se imprime el resumen de lo
  que se borraría (cantidad de sesiones, materias y rango de fechas).
- **CA-52i** — Dado el modo real sin confirmación del operador, entonces el script termina sin
  borrar (RN-23).
- **CA-52j** — Dada una sesión ya purgada, cuando se abre su historial, entonces la vista
  muestra "La conversación de esta clase ya no está disponible" **y sigue mostrando la lista
  de asistencia** — no un chat vacío ni un error.

### Backup y regresión

- **CA-53** — Dado un backup generado con salas existentes, entonces el manifiesto incluye
  `roomsessions`, `roommessages` y `roompresences` con sus conteos, y el `.tar.gz` los
  contiene (RN-21).
- **CA-54** — Dado el diff de restauración, entonces las tres colecciones nuevas aparecen con
  `current` y `backup`, y un backup **viejo** (sin ellas) no rompe la pantalla de restauración
  —se listan como faltantes, que es el comportamiento que ya tiene `routes/backup.js:305`.
- **CA-55** — Dado el rate limiting, cuando 25 clientes pollean la sala durante 15 minutos
  desde la **misma IP**, entonces ninguno recibe 429 del `generalLimiter` y el resto de la
  aplicación sigue respondiendo con normalidad (RN-09). *Es el criterio que más caro sale si
  falla: no rompe el chat, rompe la escuela entera.*
- **CA-56** — Dado el conjunto de smoke tests existente, entonces sigue verde sin cambios.

## Errores posibles

| CODIGO | HTTP | Mensaje en español | Cuándo |
|---|---|---|---|
| `COURSE_NOT_FOUND` | 404 | «Curso no encontrado» | `:id` malformado o inexistente. Mismo texto que `routes/courses.js:526` |
| `ACCESS_DENIED` | 403 | «Acceso denegado» | No es alumno del curso ni `canWatchLive`; preceptor con la división fuera de su alcance (RN-28); o sección denegada (`middleware/sections.js:20`). Mismo texto que `routes/courses.js:529` |
| `NOT_A_TEACHER` | 403 | «Solo la o el docente puede hacer esto» | Abrir, cerrar, moderar, silenciar o configurar sin `canManage` |
| `ROOM_CLOSED` | 409 | «La sala está cerrada» | Postear, reaccionar o moderar en una sesión con `closedAt` |
| `ROOM_MUTED` | 403 | «No podés escribir en esta sala» | Silenciado o `studentsCanWrite: false`. Mismo texto para los dos casos: no hace falta anunciarle al curso quién está silenciado |
| `EMPTY_MESSAGE` | 400 | «El mensaje está vacío» | Texto vacío tras `sanitizeText` |
| `INVALID_EMOJI` | 400 | «Emoji no válido» | Emoji fuera de `EMOJIS` |
| `RATE_LIMITED` | 429 | «Esperá un momento antes de escribir de nuevo» | Más de 10 mensajes/minuto |
| `SESSION_NOT_FOUND` | 404 | «Clase no encontrada» | `?sesion=` / `:sid` inexistente o de otra materia |
| `SERVER_ERROR` | 500 | «Error del servidor» | Excepción no prevista |

Los códigos `SCREAMING_SNAKE` son el contrato para los tests y el `logger`; las respuestas
siguen enviando el texto plano/JSON que ya usa el resto de la app, según `req.accepts`
(mismo criterio que `middleware/sections.js:16-21`, porque la sala es toda `fetch()`).

## Tests necesarios

**Unitarios** — `tests/unit/liveRoom.test.js` con `node --test` (runner ya usado por el
proyecto, `package.json:17`). Cubren CA-01 a CA-06. La lógica de ventanas de tiempo y
autocierre no se valida con un smoke HTTP: hay que poder inyectar el `now`.

**Smoke HTTP** (`tests/smoke/specs.js`, a continuación del bloque de curso):

1. `sala-abrir-cerrar` — la docente abre (200), reabrir devuelve la misma sesión, el alumno no
   puede abrir (403), cierra (200), postear después da 409. (CA-07 a CA-10)
2. `sala-presencia` — el alumno pollea 3 veces → 1 solo `RoomPresence`, `pings: 3`, aparece en
   `conectados`. (CA-12, CA-13)
3. `sala-mensajes-cursor` — postea 3, `?since=1` devuelve 2; `?since=<último>` devuelve 0;
   dos POST en paralelo con `Promise.all` reciben `seq` distintos. (CA-16 a CA-18, **CA-17 es
   el test que justifica RN-04**)
4. `sala-moderacion` — borrar como docente (200, soft delete verificable), borrar como alumno
   (403), silenciar y verificar 403 al postear + presencia intacta, `studentsCanWrite:false` y
   verificar que la docente sí escribe. (CA-23 a CA-26)
5. `sala-acceso` — alumno del curso 200; alumno de otra división 403; directivo 200; directivo
   de otra escuela 403; preceptor con la división en alcance 200; **el mismo preceptor con la
   división fuera de alcance 403**; preceptor sin divisiones asignadas 403; directivo y
   preceptor intentando las 5 rutas de gestión → 403 en las diez.
   (CA-29 a CA-33b) **Es el bloque más importante de todos.**
6. `sala-observacion` — el directivo entra con `?modo=observacion`; se verifica que el poll del
   alumno devuelve la misma lista de conectados que antes, que no hay `RoomPresence` del
   directivo, que postear da 403, y que **sí** existe el `AuditLog` `room.observe`.
   (CA-47 a CA-50)
7. `sala-observacion-presentarse` — "Presentarme" crea presencia, mensaje de sistema y habilita
   escritura; el botón no vuelve a aparecer. (CA-51, CA-52)
8. `sala-xss` — postear `<script>alert(1)</script>` y verificar que el HTML de la sala no lo
   contiene sin escapar. (CA-06)
9. `sala-validaciones` — vacío 400, 800 caracteres se corta a 500, emoji inválido 400, 11
   mensajes en un minuto → 429. (CA-05, CA-20, CA-21, CA-27)
10. `sala-export` — CSV de asistencia y de transcripción, con las columnas esperadas. (CA-37)
11. `directivo-envivo-tarjetas` — con una sala abierta, la lista trae 1 tarjeta con los campos
    de CA-39; sin salas, estado vacío; el HTML no contiene `NaN`. (CA-38 a CA-40, CA-46)
12. `directivo-envivo-forbidden` — un `teacher` recibe 403; un `preceptor`, 403. (CA-43,
    CA-46c)
13. `directivo-envivo-section-can-be-denied` — patrón `try/finally` ya usado en
    `tests/smoke/specs.js` para otras secciones: el superadmin apaga `directivo_envivo`, se
    verifica 403, se vuelve a habilitar. **Se repite igual para `preceptor_envivo`.**
    (CA-44)
14. `preceptor-envivo-alcance` — se crea un preceptor con **una** de las divisiones con sala
    abierta; ve 1 tarjeta; se le quitan las divisiones (`POST /admin/users/:id/divisions`) y
    pasa a ver 0 y a recibir 403 al entrar. Es el test que protege RN-28, y el que más caro
    sale si falla: es el único que separa a un preceptor de las salas del resto de la escuela.
    (CA-46a, CA-46b)
15. `preceptor-envivo-ingreso-visible` — el preceptor entra; el poll de un alumno lo muestra
    en `conectados` con rol `preceptor`; hay mensaje de sistema; puede postear (200); entra de
    nuevo y **no** se duplica el mensaje; entrar con `?modo=observacion` **no** lo esconde;
    existe el `AuditLog` `room.join_staff`. (CA-52a a CA-52e)
16. `backup-incluye-salas` — generar backup y verificar las 3 colecciones en el manifiesto.
    (CA-53)
17. `sala-purga` — se fabrican dos sesiones cerradas, una con `closedAt` de hace 4 meses y
    otra de hace 1; se corre `cleanup-rooms.js --dry-run` (no borra nada) y después el modo
    real; se verifica que solo desaparecieron los mensajes de la vieja y que **las dos**
    conservan sesión y presencias. (CA-52f a CA-52i)

**Verificación manual documentada:**
- **Rate limiting (CA-55)**: con la app corriendo, 25 clientes polleando 15 minutos desde la
  misma IP; confirmar que ninguna otra ruta empieza a devolver 429. Es el riesgo #1.
- **Prueba con gente real**: una clase de verdad, con la docente y el curso. Los circulitos que
  aparecen y desaparecen se juzgan mirándolos, no leyendo un assert.
- **Móvil**: la mitad de los alumnos entra desde el celular. Sala usable en 360 px de ancho.

## Dependencias

- `models/Course.js` — método `canWatchLive` (agrega; no modifica `canManage`/`isTeacher`).
- `middleware/preceptor.js` — se **reutiliza** `loadPreceptorScope` e `inScope`. No se
  modifica: `routes/rooms.js` los monta para resolver el alcance cuando el rol es `preceptor`.
- `routes/preceptor.js` — ruta nueva `/en-vivo` + `/poll`.
- `routes/courses.js` — sin cambios; la sala vive en `routes/rooms.js`.
- `server.js` — monta `roomRoutes`; agrega `/sala` al `skip` del `generalLimiter` (`:85`).
- `middleware/rate-limits.js` — limiter nuevo por usuario.
- `config/sections.js` + `views/partials/directivo-nav.ejs` + `preceptor-nav.ejs` — solapas
  `directivo_envivo` y `preceptor_envivo`.
- `config/audit-actions.js` — 6 acciones nuevas.
- `routes/backup.js` — 3 colecciones al `COLLECTIONS` (`:55`). **Bloqueante de la Fase A.**
- `views/course.ejs` — solapa "En vivo" (patrón `data-tab` de `:86-110`).
- `agente.md` — changelog + roadmap, y el backlog, al terminar cada fase.

## Riesgos de refactorización

1. **El rate limiter por IP puede tirar abajo toda la escuela.** Es el riesgo más grave de la
   spec y no es hipotético: ya pasó el 2026-07-28 con el `uploadLimiter` aplicado a todo
   `/activities` (`middleware/rate-limits.js:1-6`). Mitigación: RN-09 + CA-55, y la primera
   clase real se hace con alguien mirando `logs/error.log`.
2. **Polling con muchas salas simultáneas.** 6 salas × 30 personas = ~45 req/s. Mongo lo
   aguanta con los índices de esta spec, pero **hay que medirlo** en la primera semana. Si
   molesta, la salida es subir `POLL_MS` a 6 s (una constante) antes que reescribir el
   transporte.
3. **La sala puede volverse un problema de convivencia.** Es la primera vez que la plataforma
   deja a alumnos —menores— escribir en un espacio compartido en tiempo real. El código ya
   tomó la postura contraria en otro lado: los datos personales del alumno no se exponen a
   compañeros (`models/User.js:99-103`). Mitigación: RN-01 (solo con la sala abierta), RN-12,
   RN-13, RN-15 y la auditoría. **Conviene que la escuela lo comunique antes de habilitarlo**,
   no después del primer incidente.
4. **Modo observación y clima laboral.** La docente no sabe que la observan (RN-19, decisión
   del usuario). Mitigación: RN-20 (auditado y consultable) + RN-15 (regla conocida por todos
   desde que la sala se abre) + RN-22 (la escuela puede apagarlo). Si aparece fricción con el
   plantel, el cambio es de una línea: pasar a ingreso visible —que es justamente lo que ya
   hace el preceptor (RN-26), así que el camino está construido y probado.
5. **Alcance del preceptor mal resuelto = fuga entre divisiones.** Es el riesgo de seguridad
   más concreto de la Fase B: un `$match` olvidado y un preceptor lee las salas de toda la
   escuela. Mitigación: se reutiliza `loadPreceptorScope`/`inScope` en vez de escribir un
   filtro nuevo, el chequeo se hace **también** al entrar a la sala y no solo al listar
   (RN-28), y `preceptor-envivo-alcance` (test 14) lo verifica quitando divisiones en caliente.
6. **Dos modos de ingreso conviviendo es una fuente de bugs sutiles.** El riesgo concreto es
   que el modo silencioso se filtre a un rol que debería ser visible, o al revés. Mitigación:
   el modo **lo decide el rol, no la URL ni el panel** (RN-26, RN-29), y hay tres tests
   dedicados a eso (CA-46d, CA-46e, CA-52c). Si alguna vez hay que agregar un tercer rol, la
   regla se toca en un solo lugar.
7. **Crecimiento de `roommessages`.** Una clase de 30 chicos hablando genera cientos de
   documentos; 400 materias por año son millones. Son documentos chicos y con un solo índice,
   pero engordan el `.tar.gz` del backup. Mitigación: RN-23 (purga manual a los 3 meses) y
   mirar el tamaño del backup después del primer trimestre — que es justo cuando la primera
   purga pasa a estar disponible.
8. **`views/course.ejs` ya tiene 948 líneas** y esta spec le suma una solapa. Mitigación:
   RN-18 — todo el peso va al partial; en `course.ejs` entran el botón de la solapa y un
   `include`.
9. **Sin cambios en la base de datos existente.** Las tres colecciones se crean solas al
   primer uso. **No hace falta aviso previo de BD** para este lote, ni migración, ni ventana de
   mantenimiento. El deploy a producción es el habitual.

## Plan de migración

**Fase A — la sala**

1. `models/RoomSession.js`, `RoomMessage.js`, `RoomPresence.js` con sus índices +
   `services/liveRoom.js` con las constantes y las funciones puras +
   `tests/unit/liveRoom.test.js`. Mergeable solo: nadie lo usa todavía y queda testeado.
2. **`routes/backup.js`**: las 3 colecciones al `COLLECTIONS`. Va acá, junto con los modelos,
   no al final — es la línea que más fácil se olvida (RN-21).
3. `models/Course.js`: `canWatchLive`. Commit chico y aislado: toca el archivo de permisos más
   sensible del proyecto y merece revisarse solo.
4. `middleware/rate-limits.js` + `skip` del `generalLimiter` en `server.js`. **Antes** de que
   exista un solo cliente polleando (RN-09).
5. `routes/rooms.js` + `views/partials/live-room.ejs` + `views/rooms/standalone.ejs`, y la
   solapa "En vivo" en `views/course.ejs`. Acá la sala ya funciona punta a punta.
6. `config/audit-actions.js` + las llamadas a `logAudit` en las rutas.
7. `views/rooms/session.ejs` (historial por clase) + export CSV, contemplando el historial ya
   purgado (CA-52j).
8. `cleanup-rooms.js` con `--dry-run` y confirmación + su entrada en `package.json`
   (`"cleanup:rooms"` / `"cleanup:rooms:dry"`, junto a las de `cleanup-files.js`). Se escribe
   ahora aunque recién sirva dentro de 3 meses: después nadie se acuerda, y los mensajes se
   acumulan igual.
9. Smoke tests 1-10 y 17. **Prueba con una clase real antes de seguir con la Fase B.**

**Fase B — los paneles de supervisión**

10. `services/liveRoom.js`: `getOpenSessions(schoolId, { divisionIds })` con el aggregate de
    RN-17, y `views/partials/live-cards.ejs` con las tarjetas. Las dos piezas que después
    comparten los dos paneles (RN-27).
11. `config/sections.js` + los dos `*-nav.ejs`: solapas `directivo_envivo` y
    `preceptor_envivo`.
12. `GET /directivo/en-vivo` + `/poll` + `views/directivo/en-vivo.ejs`.
13. Modo observación y "Presentarme" (RN-19, RN-20), con su auditoría. **Acá termina lo de
    dirección**: mergeable sin lo del preceptor.
14. `GET /preceptor/en-vivo` + `/poll` + `views/preceptor/en-vivo.ejs`, con
    `loadPreceptorScope`. **Antes de exponer la pantalla, escribir el test 14**: el filtro por
    alcance no se merguea sin su test.
15. Ingreso visible del preceptor (RN-26) + `room.join_staff`.
16. Smoke tests 11-16.
17. `agente.md`: changelog de ambas fases + el backlog actualizado.

**Rollback**: revertir los pasos 14-15 deja el panel de dirección funcionando sin el de
preceptoría. Revertir 10-16 deja la sala funcionando sin paneles de supervisión.
Revertir la Fase A entera no deja rastro en datos existentes — las tres colecciones quedan
huérfanas en Mongo, sin ninguna referencia desde el resto del modelo, y se borran a mano
cuando se quiera.
