# Ventana de mantenimiento: esperar a que la plataforma se vacíe

> **Estado: APROBADA e IMPLEMENTADA el 2026-08-07.**
> Tests: 34 unitarios nuevos (`tests/unit/maintenanceWindow.test.js` y `maintenanceState.test.js`,
> total del proyecto 62/62) + 4 specs de humo (suite completa 220/220). Verificado además
> el ciclo entero contra el server local: ventana en espera con gente adentro → el que ya
> estaba trabajando siguió navegando mientras un login nuevo recibía 503 → al minuto de
> silencio el mantenimiento **se activó solo** (`reason: auto`, `promotedBy: empty`).
>
> Quedó fuera de lo implementado: nada. Las tres decisiones marcadas como "tachables" abajo
> se implementaron tal cual (tope de espera opcional, aviso apagado por default, sin
> historial de horarios).
>
> Decisiones cerradas con el usuario el 2026-08-07 — **no reabrirlas sin él**:
> el sistema **se activa solo** cuando la plataforma queda vacía (RN-08) · mientras espera
> **solo se bloquean los ingresos nuevos**, el que ya está adentro sigue trabajando sin
> enterarse (RN-04) · **5 minutos** de silencio es el default de "ya no está trabajando",
> editable en la pantalla (RN-02).
>
> Decisiones que tomó el arquitecto y el usuario puede tachar en la revisión: el tope de
> espera opcional (RN-09), el aviso a los que ya están adentro —apagado por default— (RN-12),
> y no mostrar historial de "mejores horarios" (ver No responsabilidades).

## Objetivo

Que el dueño del sistema pueda **pedir un mantenimiento sin cortarle el trabajo a nadie**.

Hoy el modo mantenimiento es todo-o-nada: se activa y en la request siguiente todos ven el
503, incluida la docente que estaba a mitad de una corrección y el alumno que estaba
entregando. La única forma de no arruinarle el trabajo a alguien es adivinar un horario
vacío y cruzar los dedos.

Lo que falta son dos cosas, y son las dos caras de lo mismo:

1. **Ver, en vivo, si se puede.** Un semáforo en `/superadmin/backup` que diga
   "3 personas trabajando ahora mismo" (con quiénes son y hace cuánto) o "listo, no hay
   nadie". Responder la pregunta *¿puedo hacer el mantenimiento ahora?* sin salir a mirar.
2. **Pedirlo y que espere.** Un botón "Programar mantenimiento" que deja el sistema **en
   espera**: no echa a nadie, corta la puerta de entrada, y **apenas la plataforma queda
   vacía activa el mantenimiento solo**. El dueño se va a hacer otra cosa y vuelve cuando
   el sistema ya se bloqueó.

La frase del usuario que fija el alcance del bloqueo: *"solamente se aplica esto para
aquellos que quieran entrar en ese momento"*. Entrar = loguearse. Los que ya entraron,
siguen.

## Responsabilidades

- Definir el **tercer estado** del mantenimiento (`en espera`) y su convivencia con los dos
  que ya existen (`normal`, `activo`), sin cambiar el comportamiento de ninguno.
- Definir **qué cuenta como "estar trabajando"** y con qué ventana de tiempo.
- Definir **qué se bloquea y qué no** mientras el sistema está en espera.
- Definir el **promotor automático**: quién decide que la plataforma se vació, cada cuánto,
  y cómo se comporta con 2 workers PM2.
- Definir el **panel en vivo** (semáforo, conteo, quiénes quedan) y sus endpoints.
- Definir la **salida de emergencia**: cancelar la espera, activar ya mismo igual.
- Garantizar que todo queda **auditado** y que el mantenimiento del `/restore` no se pisa
  con una espera en curso.

## No responsabilidades

- **No hay historial ni predicción de horarios.** El usuario pidió ver "cuándo puedo hacer
  el mantenimiento", y esta spec lo responde **en vivo** (¿hay gente ahora?), no
  estadísticamente (¿qué día de la semana suele estar vacío?). Un mapa de calor por hora
  necesitaría una colección nueva registrando conexiones a lo largo del tiempo —
  `User.lastSeen` solo guarda el último acceso y se pisa. Es otra spec, y arranca por
  decidir cuánto tiempo se guarda ese rastro de menores de edad.
- **No echa a nadie, nunca.** El estado "en espera" jamás corta una sesión en curso. Si el
  dueño quiere cortar ya, tiene el botón de siempre (`/maintenance/on`), que no cambia.
- **No es "Caso B".** Igual que la spec original del modo mantenimiento: la app sigue viva y
  se bloquea a propósito. Un proceso Node caído sigue siendo un tema de reverse proxy.
- **No cambia la pantalla de mantenimiento** (`views/maintenance.ejs`) ni el bypass del
  dueño ni el redirect a `/login` de los no logueados. Todo eso queda igual.
- **No agrega dependencias npm.** Un `setInterval` y una query contada.
- **No toca `middleware/auth.js`.** `lastSeen` ya se escribe con el throttle correcto (1 min)
  y esta feature se apoya en eso tal cual está.
- **No modifica ninguna colección.** Cero migraciones: el estado sigue viviendo en
  `maintenance.json`.

## Entidades/Schemas

### `maintenance.json` (raíz, gitignored) — forma extendida

Un solo archivo, tres estados posibles. `active` y `pending` **nunca son ambos `true`**.

```jsonc
// Estado ACTIVO (lo que ya existe hoy — sin cambios)
{
  "active": true,
  "message": "Estamos actualizando el sistema. Volvemos en breve.",
  "eta": "10-15 minutos",
  "activatedAt": "2026-08-07T21:04:11.000Z",
  "activatedBy": "waltermedinilla@gmail.com",
  "reason": "manual" | "restore" | "auto"   // "auto" = lo promovió una ventana en espera
}

// Estado EN ESPERA (nuevo)
{
  "active": false,
  "pending": true,
  "message": "Estamos actualizando el sistema. Volvemos en breve.",
  "eta": "10-15 minutos",
  "idleMinutes": 5,              // silencio que cuenta como "ya no está trabajando" (RN-02)
  "maxWaitMinutes": null,        // null = espera indefinida (RN-09)
  "notifyActiveUsers": false,    // banner para los que ya están adentro (RN-12)
  "requestedAt": "2026-08-07T20:31:00.000Z",
  "requestedBy": "waltermedinilla@gmail.com"
}

// Estado NORMAL: el archivo no existe.
```

Al promover, el estado activo hereda `message`, `eta` y `requestedBy` (como `activatedBy`)
de la espera, agrega `activatedAt`, `reason: "auto"` y `promotedBy: "empty" | "deadline"`.

**Compatibilidad hacia atrás**: un `maintenance.json` escrito por el código actual tiene
`active: true` y ningún `pending`. Las funciones nuevas lo leen igual que antes.

### `config/maintenance.js` — API extendida

Se conservan las cuatro exportaciones actuales con **la misma firma**; cambia una semántica
y se agregan cinco funciones:

```js
getMaintenanceState()      // ⚠️ CAMBIA: ahora devuelve el objeto SOLO si active === true.
                           //    Antes devolvía cualquier archivo existente. Es el cambio
                           //    que hace que "en espera" no bloquee (RN-03).
setMaintenanceOn({...})    // igual, escribe active:true + pending:false
setMaintenanceOff()        // igual, borra el archivo (limpia activo Y espera)
SYSTEM_OWNER_EMAIL         // igual

readRawState()             // nuevo: el objeto crudo, sea cual sea el estado, o null
getPendingState()          // nuevo: el objeto solo si pending === true && !active
setMaintenancePending({ message, eta, idleMinutes, maxWaitMinutes, notifyActiveUsers, requestedBy })
promotePending(pending, promotedBy)  // nuevo: escribe el activo heredando datos de la espera
restoreRawState(snapshot)  // nuevo: reescribe un estado crudo tal cual, o borra si es null
                           //        (lo usa el /restore para no pisar una espera — RN-16)
```

`setMaintenanceOff()` sigue siendo el único borrado y borra los dos estados: si el dueño
aprieta "desactivar" con una espera en curso, la espera también se cancela. Es lo esperable
("apagá todo") y evita un estado zombi.

### `services/maintenanceWindow.js` (nuevo)

Lógica pura + la única query. Mismo criterio que `services/liveRoom.js`: lo que depende del
paso del tiempo se aísla acá con `now` inyectable, para poder testearlo sin esperar 5 minutos.

```js
// Constantes
IDLE_DEFAULT_MIN = 5          // default acordado con el usuario
IDLE_MIN_MIN     = 1          // menos de 1 min no tiene sentido: lastSeen se escribe cada 1 min
IDLE_MAX_MIN     = 60
MAX_WAIT_MAX_MIN = 1440       // tope del tope: 24 h
CHECK_INTERVAL_MS = 30_000    // cada cuánto mira el promotor (RN-08)
ACTIVITY_LIST_MAX = 25        // cuántas personas lista el panel (RN-11)

// Puras (se testean con node --test)
normalizeIdleMinutes(v)                  → int en [1, 60], default 5 ante basura
normalizeMaxWait(v)                      → int en [1, 1440] o null
activityCutoff(idleMinutes, now)         → Date (now − idleMinutes)
deadlineOf(pending)                      → Date | null  (requestedAt + maxWaitMinutes)
shouldPromote({ pending, activeCount, now })
    → { promote: boolean, why: 'empty' | 'deadline' | null }
minutesAgo(date, now)                    → int redondeado hacia abajo, 0 si es futuro/basura

// Con base de datos
countActiveUsers({ idleMinutes, now })   → { count, byRole }
listActiveUsers({ idleMinutes, now, limit }) → [{ _id, name, role, minutesAgo }]
```

### `config/audit-actions.js` — dos acciones nuevas

```js
'system.maintenance_scheduled': { label: 'programó un mantenimiento en espera',
                                  icon: 'schedule', color: '#ea8600', category: 'system' },
'system.maintenance_cancelled': { label: 'canceló el mantenimiento en espera',
                                  icon: 'event_busy', color: '#5f6368', category: 'system' },
```

La promoción automática **reusa `system.maintenance_on`** (ya existe) con
`meta: { automatico: true, motivo: 'empty' | 'deadline', esperoMinutos: N }`. Así el panel de
auditoría no necesita una fila nueva para el evento más importante, y el filtro por
"mantenimiento activado" encuentra los tres orígenes juntos.

### Vistas

| Archivo | Cambio |
|---|---|
| `views/superadmin/backup.ejs` | La sección "Modo mantenimiento" pasa a tener tres renders (normal / en espera / activo) + el semáforo en vivo. Es donde vive todo lo nuevo de UI. |
| `views/login.ejs` | Aviso cuando hay una espera en curso: "El sistema entra en mantenimiento; no se admiten nuevos ingresos por ahora." (RN-06) |
| `views/partials/maintenance-banner.ejs` (nuevo) | Franja para los que YA están adentro. Se incluye al final de `views/partials/header.ejs` (que termina en `</nav>`, así queda arriba de todo en cada página). Solo se pinta si `res.locals.maintenancePending` existe (RN-12). |

`views/maintenance.ejs` **no se toca**.

## Entradas

Todos los endpoints cuelgan de `/superadmin/backup` (`routes/backup.js`), o sea que ya pasan
por `requireAuth` + `requireSuperAdmin` + `requireBackupAccess` (email del dueño). Ninguno
agrega su propia capa de permisos.

### `GET /superadmin/backup/maintenance-status`
Sin parámetros. **Ya existe**; se extiende la respuesta (ver Salidas). Compatible: la clave
`state` sigue significando lo mismo.

### `GET /superadmin/backup/maintenance/activity` (nuevo)
| Query | Tipo | Default | Notas |
|---|---|---|---|
| `idleMinutes` | int | 5 | Se normaliza a [1, 60]. Permite al panel previsualizar el efecto de mover el umbral **antes** de programar nada. |

Lo llama el panel cada 10 s mientras la sección está a la vista.

### `POST /superadmin/backup/maintenance/schedule` (nuevo)
| Campo | Tipo | Default | Notas |
|---|---|---|---|
| `message` | string | el de siempre | Mismo texto que ya usa `/maintenance/on`. |
| `eta` | string | `null` | Libre, ej. "10-15 minutos". |
| `idleMinutes` | int | 5 | Normalizado a [1, 60]. |
| `maxWaitMinutes` | int\|null | `null` | Normalizado a [1, 1440] o null = esperar lo que haga falta. |
| `notifyActiveUsers` | bool | `false` | Ver RN-12. |

### `POST /superadmin/backup/maintenance/cancel` (nuevo)
Sin body. Cancela **solo** una espera. Si el mantenimiento ya está activo devuelve 409 y no
hace nada (para eso está `/maintenance/off`, que es explícito).

### `POST /superadmin/backup/maintenance/on` y `/off`
**Sin cambios de firma.** `on` sigue activando ya mismo sin mirar a nadie (es la salida de
emergencia y el "no me importa, cortá igual"); `off` sigue borrando el archivo.

## Salidas

### `GET /maintenance-status`
```jsonc
{
  "state": { ... } | null,     // SOLO el estado activo. null si está en espera o normal.
  "pending": { ... } | null,   // el estado en espera, o null
  "activity": {                // foto del momento, calculada con pending.idleMinutes
    "count": 3,                // o con el default 5 si no hay espera en curso
    "ready": false,            // count === 0
    "idleMinutes": 5
  }
}
```

### `GET /maintenance/activity`
```jsonc
{
  "now": "2026-08-07T20:31:00.000Z",
  "idleMinutes": 5,
  "count": 3,
  "ready": false,
  "byRole": { "student": 2, "teacher": 1 },
  "users": [                                  // máx. 25, ordenados por lastSeen desc
    { "name": "Ana Pérez", "role": "teacher", "minutesAgo": 0 },
    { "name": "Juan Gómez", "role": "student", "minutesAgo": 3 }
  ],
  "truncated": false,                         // true si count > 25
  "pending": { "requestedAt": "...", "waitedMinutes": 12,
               "deadline": null } | null      // para el cronómetro de la pantalla
}
```

### `POST /maintenance/schedule`
```jsonc
// Había gente → queda en espera
{ "ok": true, "activated": false, "pending": { ... }, "activity": { "count": 3, ... } }

// No había nadie → se activó en el acto (RN-07)
{ "ok": true, "activated": true, "state": { ... } }
```

### `POST /maintenance/cancel`
```jsonc
{ "ok": true }
// o, si ya estaba activo:
{ "error": "El mantenimiento ya está activo. Usá \"Desactivar mantenimiento\"." }  // 409
```

### Login bloqueado (`POST /login`, `POST /register`, `POST /register/invite/:token`)
```jsonc
// 503
{ "maintenance": true, "pending": true,
  "error": "El sistema entra en mantenimiento en unos minutos y no se admiten nuevos ingresos. Volvé a intentar más tarde." }
```

## Reglas de negocio

**RN-01 — Tres estados, uno solo a la vez.**
`normal` (no hay archivo) → `en espera` (`pending:true`) → `activo` (`active:true`) → `normal`.
La transición `en espera → activo` es la única automática. Todas las demás las dispara el
dueño. No existe `activo → en espera`: una vez que se bloqueó a todos, ya no hay a quién
esperar.

**RN-02 — "Estar trabajando" = `lastSeen` dentro de la ventana de inactividad.**
Un usuario cuenta como activo si `lastSeen >= now − idleMinutes`. Default 5 min, editable en
la pantalla, acotado a [1, 60]. No se inventa una señal nueva: `checkUser` ya escribe
`lastSeen` en cada request (throttle 1 min, `middleware/auth.js:59-67`), así que cualquier
navegación real —incluido el poll de la sala en vivo, que pasa por el mismo middleware— lo
refresca. Con throttle de 1 min, una ventana de 5 min tiene 4 minutos de margen: nadie queda
marcado como ido por leer una consigna larga.

**RN-03 — El estado "en espera" NO bloquea a nadie que ya esté adentro.**
El middleware global de `server.js:398` solo mira `getMaintenanceState()`, que a partir de
ahora devuelve `null` cuando el estado es `pending`. Es decir: **el middleware no cambia una
línea** y la app funciona normal para todos los que tienen sesión. Es la parte más importante
de la spec y la razón del cambio de semántica de `getMaintenanceState()`.

**RN-04 — En espera, se bloquea la puerta de entrada y nada más.**
Devuelven 503 mientras `pending`:
- `POST /login` — el que quiere entrar en ese momento.
- `POST /register` y `POST /register/invite/:token` — crear una cuenta es la forma más
  extrema de "entrar en ese momento"; dejarla abierta sería incoherente.

**No** se bloquean: `GET /login` (se muestra con el aviso), `/logout`, estáticos, `/deploy`,
ni ninguna ruta de la app para quien ya tiene cookie. Un usuario logueado no percibe
absolutamente nada (salvo RN-12).

**RN-05 — El dueño siempre puede entrar, aun con la puerta cerrada.**
`POST /login` con `email === SYSTEM_OWNER_EMAIL` se salta el bloqueo de RN-04 (se chequea
antes de validar la contraseña, así que no revela nada que el login no revele ya). Sin esta
excepción, una cookie vencida durante una espera dejaría al dueño afuera de su propio panel
—el mismo agujero que ya se tapó el 2026-07-27 con el redirect a `/login`—.

**RN-06 — El que rebota entiende por qué.**
El 503 de RN-04 trae un mensaje explícito de "mantenimiento inminente, no hay ingresos
nuevos" (no el genérico de credenciales). `GET /login` con espera en curso pinta el mismo
aviso arriba del formulario, para que no lo descubra recién después de tipear la contraseña.

**RN-07 — Programar con la plataforma ya vacía activa en el acto.**
Si al momento del `POST /schedule` el conteo de activos es 0, no se crea ninguna espera: se
llama a `setMaintenanceOn({ reason: 'manual' })` directamente y se responde
`activated: true`. Esperar 30 s a que el promotor descubra lo que ya sabemos sería absurdo.

**RN-08 — El promotor: cada 30 s, y solo un worker.**
Un `setInterval` de 30 s arrancado en `server.js` después de `connectDB()`:
1. Lee el estado. Si no hay espera, no hace ninguna query (el caso normal cuesta una lectura
   de unos bytes, igual que el middleware).
2. Si hay espera, cuenta activos con `countActiveUsers({ idleMinutes })`.
3. `shouldPromote()` decide. Si sí → `promotePending()` + `logAudit('system.maintenance_on')`
   + `logger.info`.

Corre **solo en el worker 0** (`!process.env.NODE_APP_INSTANCE || === '0'`; PM2 lo setea en
modo cluster, en dev queda undefined y corre igual). No es un detalle de eficiencia: con los
2 workers ejecutándolo, ambos podrían leer "hay espera" en el mismo tick y escribir dos
eventos de auditoría para una sola promoción. El archivo se escribiría dos veces con lo mismo
(inofensivo), pero el registro quedaría duplicado.
Killswitch: `MAINTENANCE_SCHEDULER=false` lo apaga sin redeploy. El timer va con `.unref()`
para no demorar el shutdown.

**RN-09 — Tope de espera opcional.**
`maxWaitMinutes` (default `null` = indefinido). Si se setea, cumplido el plazo el promotor
activa igual, con `promotedBy: 'deadline'`, haya quien haya. Existe porque una espera
indefinida en horario escolar puede no llegar nunca, y el dueño se merece un "a las 22:00 se
cierra igual" en vez de tener que acordarse de volver a mirar.

**RN-10 — El dueño no cuenta como gente trabajando.**
El conteo excluye `email === SYSTEM_OWNER_EMAIL` (y a los usuarios con `active: false`, que
no pueden navegar). Sin esto el contador nunca bajaría de 1: el propio dueño mirando el panel
refresca su `lastSeen` cada 10 s y bloquearía su propio mantenimiento para siempre.

**RN-11 — El panel dice *quiénes* son, no solo cuántos.**
"3 personas" no ayuda a decidir; "Ana (docente), hace 0 min" sí —el dueño puede escribirle o
saber que es una clase en curso—. Se listan hasta 25 (nombre, rol, hace cuánto), ordenados por
actividad más reciente, con `truncated: true` si hay más. Es información de usuarios menores
de edad: solo la ve el dueño del sistema, en su propio panel, y no se persiste en ningún lado.

**RN-12 — Aviso a los que están adentro: opcional y apagado por default.**
Con `notifyActiveUsers: true`, todo usuario logueado ve una franja: "Mantenimiento
programado: guardá tu trabajo, el sistema se va a bloquear cuando termines". Apagado por
default a propósito: avisar acelera la espera (la gente cierra) pero también puede disparar
lo contrario —"si se cae, entrego ya"— y una avalancha de entregas es justo lo que no querés
antes de un mantenimiento. Que el dueño elija por caso.
El banner se pinta desde `res.locals.maintenancePending`, que setea el mismo middleware
global de `server.js` (una sola lectura de archivo, la que ya hace). Nunca se le muestra al
dueño (él ya tiene el panel).

**RN-13 — Cancelar es un botón, no un procedimiento.**
`POST /maintenance/cancel` borra la espera y listo. Disponible en todo momento desde el panel.
Auditado (`system.maintenance_cancelled`).

**RN-14 — Activar ya mismo sigue existiendo y sigue siendo instantáneo.**
`POST /maintenance/on` no consulta a nadie ni respeta esperas: pisa lo que haya con
`active: true`. Es la salida de emergencia (algo se está rompiendo y hay que cortar ahora).
El panel lo ofrece como acción secundaria, también durante una espera ("cortar igual").

**RN-15 — El estado en espera no sobrevive a un `off`.**
Ya dicho en Entidades, se explicita como regla: `setMaintenanceOff()` borra el archivo
completo. No hay forma de quedar con una espera invisible corriendo por detrás.

**RN-16 — El `/restore` no pisa una espera en curso.**
Hoy `routes/backup.js:378` guarda `alreadyInMaintenance` y en el `finally` apaga si lo prendió
él. Con tres estados eso se rompe: una espera daría `false` y el `finally` la borraría. Pasa a
guardar **el estado crudo previo** (`readRawState()`) y a restaurarlo con `restoreRawState()`
en el `finally`. Efecto: si había una espera, el restore la interrumpe con un mantenimiento
real y al terminar la espera sigue viva. Si ya estaba activo, no se toca (igual que hoy).

**RN-17 — El costo del polling del panel es del dueño y de nadie más.**
`GET /maintenance/activity` cada 10 s = 90 requests / 15 min, dentro del cupo de 1200 del
`generalLimiter` (y el monitor de superadmin ya poll-ea a 5 s, así que no es un patrón nuevo).
Cada llamada son dos queries sobre el índice `{lastSeen: 1}` que ya existe
(`models/User.js:135`). El poll **se detiene** si la pestaña está oculta
(`document.hidden`) — un panel abierto y olvidado toda la tarde no tiene por qué consumir.

## Casos de uso

**CU-01 — Mantenimiento un martes a las 19:00 (el caso real).**
El dueño entra a `/superadmin/backup`, ve "🟠 4 personas trabajando" con la lista. Deja el
umbral en 5 min, escribe "Actualización del sistema", ETA "15 minutos", y aprieta **Programar
mantenimiento**. La pantalla pasa a "⏳ En espera — 4 personas, esperando hace 0 min". Se va a
cenar. A las 19:40 el último alumno cierra el navegador; a las 19:45 pasa la ventana de 5 min
y en el chequeo siguiente el promotor activa el mantenimiento. El dueño vuelve, entra (bypass
de dueño), ve "🔴 En mantenimiento desde las 19:45 (automático)" y hace su trabajo.

**CU-02 — Alguien intenta entrar durante la espera.**
Una docente abre `/login` a las 19:20. Ve el aviso arriba del formulario. Si igual manda el
formulario, recibe el 503 con el mensaje de RN-06. Su compañera, que dejó la sesión abierta
desde las 18:00, sigue corrigiendo sin enterarse de nada.

**CU-03 — La plataforma no se vacía nunca.**
El dueño programa a las 20:00 con `maxWaitMinutes: 120`. A las 22:00 todavía quedan 2
personas. El promotor activa igual y la auditoría registra
`system.maintenance_on { automatico: true, motivo: 'deadline', esperoMinutos: 120 }`.

**CU-04 — Se arrepiente.**
Hay una espera en curso, el dueño aprieta **Cancelar espera**. El archivo se borra, los logins
vuelven a funcionar en la request siguiente en los dos workers (el estado se lee de disco sin
cache), y queda el evento `system.maintenance_cancelled`.

**CU-05 — Domingo a la mañana.**
Programa mantenimiento un domingo 9:00. No hay nadie: se activa en el acto (RN-07), sin pasar
por "en espera". Es el atajo que evita hacerle esperar 30 s por nada.

## Criterios de aceptación

### Lógica pura (`services/maintenanceWindow.js`, sin base de datos)

- **CA-01** — `normalizeIdleMinutes` devuelve 5 ante `undefined`, `null`, `''`, `'abc'`,
  `NaN` y `0`; recorta `-3 → 1`, `999 → 60`; conserva `1`, `5`, `60`; trunca `7.9 → 7`.
- **CA-02** — `normalizeMaxWait` devuelve `null` ante `undefined`, `null`, `''`, `0` y basura;
  recorta `99999 → 1440`; conserva `120`.
- **CA-03** — `activityCutoff(5, T)` devuelve exactamente `T − 5 min`.
- **CA-04** — `deadlineOf` devuelve `null` si `maxWaitMinutes` es `null`, y
  `requestedAt + maxWaitMinutes` si tiene valor. Ante un `requestedAt` inválido devuelve
  `null` (nunca una fecha `Invalid Date` que haría promover de inmediato).
- **CA-05** — `shouldPromote` con `activeCount: 0` → `{ promote: true, why: 'empty' }`.
- **CA-06** — `shouldPromote` con `activeCount: 3` y sin deadline →
  `{ promote: false, why: null }`.
- **CA-07** — `shouldPromote` con `activeCount: 3` y `now` **posterior** al deadline →
  `{ promote: true, why: 'deadline' }`; con `now` **anterior**, `false`.
- **CA-08** — `shouldPromote` con `pending: null` → `{ promote: false }` (nunca promueve algo
  que no existe).
- **CA-09** — El borde de la ventana es **inclusivo**: un `lastSeen` de exactamente
  `idleMinutes` atrás **cuenta como activo**; un milisegundo más viejo, no. (Se testea sobre
  `activityCutoff` + comparación, misma convención que `isOnline` en `liveRoom.js`.)
- **CA-10** — `minutesAgo` devuelve 0 para una fecha futura, 0 para `null`, y el piso en
  minutos para fechas pasadas (`90 s → 1`).

### Estado y transiciones (`config/maintenance.js`)

- **CA-11** — Con `active: true` en disco, `getMaintenanceState()` devuelve el objeto y
  `getPendingState()` devuelve `null`.
- **CA-12** — Con `pending: true` en disco, `getMaintenanceState()` devuelve **`null`** y
  `getPendingState()` devuelve el objeto. *(Es el criterio que garantiza RN-03.)*
- **CA-13** — Sin archivo, las tres lecturas devuelven `null`.
- **CA-14** — Con el archivo corrupto (texto no-JSON), las tres devuelven `null` y no lanzan.
- **CA-15** — `promotePending()` escribe `active: true`, `pending: false`, conserva `message`,
  `eta` y `requestedBy → activatedBy`, y agrega `reason: 'auto'` + `promotedBy`.
- **CA-16** — `setMaintenanceOff()` con una espera en curso deja las tres lecturas en `null`.
- **CA-17** — `restoreRawState(null)` borra el archivo; `restoreRawState(snapshot)` lo deja
  byte a byte equivalente al snapshot.

### Bloqueo de ingresos (smoke, con el servidor real)

- **CA-18** — Con una espera en curso, `POST /login` con credenciales **válidas** de un
  docente devuelve **503** con `maintenance: true, pending: true`, y **no** setea cookie.
- **CA-19** — Con la misma espera, un usuario **ya logueado** (cookie previa) hace
  `GET /courses` y recibe **200**. *(El corazón del pedido del usuario.)*
- **CA-20** — Con la misma espera, `GET /login` responde 200 y el HTML contiene el aviso de
  mantenimiento inminente.
- **CA-21** — Con la misma espera, `POST /login` con el email del dueño **funciona** (200 +
  cookie). *(RN-05.)*
- **CA-22** — Con la misma espera, `POST /register` devuelve 503.
- **CA-23** — Cancelada la espera, `POST /login` del docente vuelve a dar 200.
- **CA-24** — Con mantenimiento **activo** (no en espera), todo sigue exactamente como hoy:
  503 + página de mantenimiento para otros, bypass para el dueño. *(Regresión del spec
  `maintenance-toggle-blocks-and-restores`, que no se modifica.)*

### Endpoints del panel

- **CA-25** — `GET /maintenance/activity` como dueño devuelve 200 con `count`, `ready`,
  `byRole`, `users` y `now`.
- **CA-26** — El propio dueño **no** aparece en `users` ni suma a `count`, aun habiendo hecho
  la request en ese instante. *(RN-10.)*
- **CA-27** — `GET /maintenance/activity?idleMinutes=999` se comporta como `idleMinutes=60`
  y lo devuelve normalizado en la respuesta.
- **CA-28** — `users` trae como máximo 25 elementos y `truncated` es coherente con `count`.
- **CA-29** — `POST /schedule` con gente activa devuelve `activated: false` + `pending`, y
  `GET /maintenance-status` pasa a traer `state: null` y `pending: {...}`.
- **CA-30** — `POST /schedule` sin gente activa devuelve `activated: true` y
  `GET /maintenance-status` trae `state: {...}` con `reason: 'manual'`. *(RN-07.)*
- **CA-31** — `POST /cancel` con espera en curso devuelve `{ ok: true }` y deja
  `maintenance-status` en `state: null, pending: null`.
- **CA-32** — `POST /cancel` con mantenimiento **activo** devuelve **409** y el estado activo
  queda intacto.
- **CA-33** — Un admin de escuela recibe **403** en `/maintenance/activity`, `/schedule` y
  `/cancel` (misma capa que el resto de `/superadmin/backup`).
- **CA-34** — `GET /maintenance-status` conserva la clave `state` con la misma semántica que
  hoy para el estado activo. *(Regresión: la vista y el smoke actual la leen.)*

### Promoción automática

- **CA-35** — `shouldPromote` + `promotePending` encadenados sobre un estado en espera con 0
  activos dejan el archivo en estado activo con `reason: 'auto'`, `promotedBy: 'empty'`.
  *(Unitario; el `setInterval` en sí no se testea — se testea la función que decide.)*
- **CA-36** — La promoción registra un `AuditLog` con `action: 'system.maintenance_on'` y
  `meta.automatico === true`.
- **CA-37** — Con `MAINTENANCE_SCHEDULER=false` el intervalo no se arranca (verificable por
  el log de arranque; queda documentado, no testeado automáticamente).

### Auditoría y UI

- **CA-38** — Programar registra `system.maintenance_scheduled` con
  `meta: { idleMinutes, maxWaitMinutes, activosAlProgramar }`.
- **CA-39** — Las dos acciones nuevas están en `config/audit-actions.js` con `category:
  'system'` y aparecen en `/superadmin/audit` sin fila "acción desconocida".
- **CA-40** — La sección de `/superadmin/backup` renderiza los tres estados con el semáforo
  correcto: 🟢 "Listo para mantener" (count 0), 🟠 "N trabajando", ⏳ "En espera hace M min",
  🔴 "En mantenimiento".
- **CA-41** — Con `notifyActiveUsers: false` (default), un usuario logueado **no** ve ninguna
  franja. Con `true`, la ve; el dueño nunca. *(RN-12.)*
- **CA-42** — El poll del panel se detiene con `document.hidden` y se reanuda al volver.

### Regresión

- **CA-43** — `npm run test:smoke` completo en verde, incluidos los dos specs de mantenimiento
  que ya existen, sin modificarlos.
- **CA-44** — `npm run test:roles` en verde: ninguna solapa cambia de permiso.
- **CA-45** — Un `maintenance.json` con la forma **vieja** (`{active:true, message, eta,
  activatedAt, activatedBy, reason}`) sigue bloqueando igual y el botón "Desactivar" lo apaga.

## Errores posibles

| Situación | Respuesta |
|---|---|
| `maintenance.json` corrupto | Las tres lecturas devuelven `null` → el sistema queda **abierto**. Fail-open deliberado y heredado del código actual: un archivo roto no puede dejar a la escuela afuera. |
| Mongo caído cuando corre el promotor | `countActiveUsers` lanza → se atrapa, se loguea `warn` y **no se promueve** en ese tick. Nunca se activa un mantenimiento por no poder contar (eso sería promover a ciegas). |
| Mongo caído en `GET /activity` | 500 con `{ error }`; el panel muestra "No se pudo consultar" y sigue reintentando. No rompe el resto de la pantalla. |
| Disco lleno / sin permisos al escribir el estado | `POST /schedule` devuelve 500 con el mensaje de `fs`. No queda estado a medias: `setMaintenancePending` escribe el archivo entero de una. |
| `POST /cancel` sin espera en curso | `{ ok: true }` (idempotente). Cancelar algo que no existe no es un error. |
| `POST /schedule` con una espera **ya en curso** | La pisa con los parámetros nuevos y conserva el `requestedAt` original (el cronómetro no se reinicia por cambiar el mensaje). |
| `POST /schedule` con mantenimiento **ya activo** | 409: "El mantenimiento ya está activo." No tiene sentido esperar a que se vacíe algo que ya está bloqueado. |
| El worker 0 se reinicia con una espera en curso | La espera vive en disco: al arrancar, el nuevo worker 0 retoma el chequeo en el tick siguiente (≤30 s). Nada que recuperar. |
| Reloj del server corrido | Solo afecta al deadline (RN-09). El caso "empty" no depende del reloj absoluto sino de la resta contra `lastSeen`, que usa el mismo reloj. |

## Tests necesarios

**Unitarios — `tests/unit/maintenanceWindow.test.js` (nuevo)**
CA-01 a CA-10 y CA-35. `node --test`, sin base de datos, con `now` inyectado. Precedente
directo: `tests/unit/liveRoom.test.js`. Se suma a `npm run test:unit`, que ya los levanta con
`tests/unit/*.test.js` (no hay que tocar `package.json`).

**Unitarios — `tests/unit/maintenanceState.test.js` (nuevo)**
CA-11 a CA-17. Toca disco de verdad, pero contra un `MAINTENANCE_FILE` apuntado a
`os.tmpdir()` vía variable de entorno de test — hoy la ruta es una const del módulo, así que
**el implementador debe hacerla overrideable** (`process.env.MAINTENANCE_FILE || path.join(...)`).
Es el único cambio estructural que piden los tests y vale la pena: hoy `config/maintenance.js`
no es testeable sin escribir en la raíz del repo.

**Smoke — `tests/smoke/specs.js` (specs nuevos, los dos existentes no se tocan)**
- `maintenance-pending-blocks-login-not-session` → CA-18, CA-19, CA-20, CA-23.
  **Obligatorio `try/finally` dentro del `run()`** que llame a `/maintenance/off`: si una
  aserción falla con la espera puesta, los specs siguientes que loguean actores quedarían sin
  poder autenticarse. Es exactamente el problema que ya documenta el spec de toggle actual.
- `maintenance-pending-owner-can-login` → CA-21.
- `maintenance-activity-endpoint` → CA-25, CA-26, CA-27, CA-28.
- `maintenance-schedule-and-cancel` → CA-29, CA-31, CA-32, CA-38.
- `maintenance-access-denied-pending-endpoints` → CA-33 (extiende el patrón del spec
  `maintenance-access-denied-for-regular-admin`).

CA-30 (schedule con la plataforma vacía) **no se puede testear en smoke**: el propio runner
mantiene sesiones activas de varios actores, así que el conteo nunca da 0. Se cubre por
unitario (`shouldPromote`) + verificación manual antes del release. Queda dicho acá para que
nadie lo busque después.

**Manual antes de mergear**
1. Programar con gente conectada, comprobar que el semáforo baja solo y que **el mantenimiento
   se activa sin intervención** (CU-01 completo, con `idleMinutes: 1` para no esperar 5).
2. Comprobar que una sesión abierta en otro navegador sigue navegando durante la espera.
3. Cancelar y verificar que el login vuelve en el acto.
4. `notifyActiveUsers: true` y ver la franja en una sesión de alumno.

## Dependencias

- **`middleware/auth.js:59-67`** — `lastSeen` con throttle de 1 min. Es la única fuente de
  verdad de "hay alguien trabajando". Si alguien sube ese throttle, el mínimo de
  `idleMinutes` (1 min) queda inconsistente: la constante `IDLE_MIN_MIN` lleva un comentario
  que lo dice.
- **`models/User.js:135`** — índice `{lastSeen: 1}`. Sin él, cada tick del promotor y cada
  poll del panel serían un COLLSCAN sobre la colección entera.
- **`server.js:398`** — middleware de mantenimiento. Cambia su comportamiento **sin cambiar
  su código**, por la nueva semántica de `getMaintenanceState()`. El implementador debe
  agregarle solo el seteo de `res.locals.maintenancePending` (RN-12).
- **`routes/backup.js`** — `requireBackupAccess` (rol superadmin + email del dueño) protege
  todo lo nuevo sin agregar una capa propia.
- **`config/maintenance.js`** — `SYSTEM_OWNER_EMAIL`, ya consolidado acá.
- **PM2 cluster (2 workers)** — el estado en disco es lo que hace que esto funcione con más
  de un proceso, y `NODE_APP_INSTANCE` lo que evita el promotor duplicado.
- **`.nodemonignore`** — ya ignora `maintenance.json`. Sin eso, cada transición reiniciaría el
  server en dev y sería imposible probar la promoción automática.

## Riesgos de refactorización

- **🔴 El cambio de semántica de `getMaintenanceState()` es el riesgo principal.** Hoy
  devuelve el archivo si existe; pasa a devolverlo solo si `active === true`. Hay **dos**
  consumidores (`server.js:399` y `routes/backup.js:378, 441`) y los dos están en esta spec.
  El revisor debe verificar con un grep que no aparezca un tercero antes de aprobar.
- **🟠 El `finally` del `/restore` (RN-16).** Si se implementa mal, un restore borra una espera
  en curso o —peor— deja el mantenimiento activo prendido para siempre creyendo que era una
  espera. Es el punto que más merece una lectura atenta del revisor.
- **🟠 El promotor es la primera tarea periódica del proyecto.** No hay precedente de
  `setInterval` en `server.js`. Si mañana aparece otra, conviene sacar las dos a un
  `services/scheduler.js` con el guard de `NODE_APP_INSTANCE` una sola vez, en vez de repetir
  el patrón. Hoy sería sobre-ingeniería para un solo timer.
- **🟡 Empujar el promotor a un cron del sistema** (como `cleanup-rooms.js`) se descartó: un
  cron con granularidad de 1 minuto tarda hasta 60 s en promover, necesita levantar un
  proceso Node entero cada vez, y suma una pieza de infraestructura al deploy. El
  `setInterval` vive donde ya está la conexión a Mongo.
- **🟡 `views/superadmin/backup.ejs` ya tiene ~440 líneas** con el JS embebido. Esta feature
  le suma un bloque grande. No se refactoriza en esta spec (sería un diff enorme mezclado con
  la feature), pero queda anotado: si vuelve a crecer, el JS de esa pantalla merece un
  `public/js/backup-panel.js`.
- **🟢 Nada de esto cambia el flujo del alumno o del docente.** El único código que corre para
  ellos es una lectura de archivo que ya se hacía y, si está encendido, un `include` de un
  partial de 10 líneas.

## Plan de migración

**No hay migración de datos.** Cero cambios de schema, cero scripts, cero backfill.

Orden de merge (un solo PR, es una feature chica y acoplada):

1. `config/maintenance.js` — API extendida + `MAINTENANCE_FILE` overrideable. **Solo con esto
   el sistema sigue funcionando idéntico**: sin archivos `pending` en disco, la nueva
   semántica de `getMaintenanceState()` no cambia nada.
2. `services/maintenanceWindow.js` + sus unitarios.
3. `routes/auth.js` (bloqueo de ingresos) + `routes/backup.js` (endpoints y RN-16) +
   `config/audit-actions.js`.
4. `server.js` — promotor y `res.locals.maintenancePending`.
5. Vistas.
6. Smoke specs + `agente.md` (changelog + tabla de rutas).

**Rollback**: borrar `maintenance.json` restablece el comportamiento normal instantáneamente
en los dos workers, sin reiniciar nada. Si hubiera que volver atrás el código, el estado en
disco de una versión nueva (`pending: true`) leído por el código viejo **bloquearía a todos**
(el código viejo trata cualquier archivo como activo). Por eso, antes de un rollback de esta
feature: apagar el mantenimiento desde el panel o borrar el archivo a mano. Queda escrito acá
porque es el único modo en que esta feature puede sorprender a alguien.

**En producción**: `git push` → webhook `/deploy` → `pm2 reload`. Nada más. No hace falta
`npm install` (sin dependencias nuevas) ni tocar la base.
