# Asistencia de preceptoría (toma por curso, con autoasistencia del alumno)

> **Estado: APROBADA por el usuario el 2026-08-10. FASES A y B IMPLEMENTADAS Y VERIFICADAS
> el 2026-08-10** (154 unitarios + 269 smoke + matriz de roles, todo verde).
>
> **Tres cosas salieron distintas de lo que decía la spec**, todas por un motivo que
> apareció al implementar y que quedó documentado en el código:
>
> 1. **El cierre programado se pide en MINUTOS (`closesInMin`), no como una hora absoluta
>    (`closesAt`).** Un "08:15" tipeado en el navegador se interpreta con la zona horaria de
>    esa máquina, y las computadoras del aula tienen cualquier zona configurada: la ventana se
>    cerraría a destiempo según desde dónde se abrió. Un intervalo no depende de ninguna zona.
>    El campo `closesAt` del modelo no cambió — lo calcula el servidor.
> 2. **Se agregó `POST /toma/:id/reabrir` y la acción de auditoría `attendance.reopen`.** La
>    spec decía que una toma cerrada rechaza marcas (RN-05, CA-34) y que para corregir "hay que
>    reabrir", pero nunca definía cómo se reabría — el caso de uso 3 (el que llega 8:40) quedaba
>    sin resolver. Solo se puede reabrir la toma **de hoy**: una de ayer se vuelve a cerrar sola
>    en el request siguiente por RN-10, así que ofrecerlo sería mentir.
> 3. **La autoasistencia del alumno NO pisa una decisión que el preceptor ya tomó** (extiende
>    RN-06, que no contemplaba el orden inverso). Si él ya marcó a ese chico, el toque del
>    botón deja constancia de que dice estar presente —queda `selfMarkedAt` y la grilla lo
>    muestra— pero no cambia el estado, y la respuesta trae `respetada: false` para que el
>    cartel se lo diga con todas las letras. La alternativa era que el alumno revirtiera desde
>    el celular a quien controla la asistencia.
>
> Flujo SDD: arquitecto → **spec aprobada** → tester → implementador → revisor.
>
> Decisiones ya cerradas con el usuario el **2026-08-10** — no reabrirlas sin él:
> **una toma por día y por curso** (RN-01) · **la autoasistencia del alumno vale como
> presente y el preceptor corrige** (RN-06) · **la sala en vivo solo SUGIERE, nunca marca
> sola** (RN-09) · **cuatro estados: presente / tarde / ausente / justificado** (RN-04).
>
> **Se implementa en dos fases mergeables por separado**, en este orden:
> **Fase A — la toma**: modelos, servicio, panel del preceptor (pase de lista y ventana
> abierta), cierre, solapa, backup y auditoría. Se puede usar sola.
> **Fase B — el alumno y los reportes**: botón "Dar asistencia" en el inicio del alumno,
> sugerencias desde la sala en vivo, historial y exportación a CSV.

## Objetivo

Que el preceptor tenga, para cada uno de sus cursos, **la asistencia del día**: que pueda
pasar lista él mismo en dos minutos, o **dejar la toma abierta** para que los chicos la vayan
dando desde su pantalla mientras él hace otra cosa, y que al final **cierre y se lleve el
listado**.

Y que eso se apoye en lo que ya funciona: cuando la docente abre la sala en vivo de su
materia y los chicos entran, el preceptor **ve en su grilla quiénes ya están en clase** y los
marca de a uno o todos juntos, sin ir a preguntar aula por aula.

## Responsabilidades

- Definir el **ciclo de vida de una toma de asistencia**: abrir, estar abierta, cerrar,
  autocerrar.
- Definir los **dos modos de toma**: pase de lista activo y ventana abierta.
- Definir la **autoasistencia del alumno**: dónde la ve, qué puede y qué no puede hacer.
- Definir los **cuatro estados** y quién puede ponerlos.
- Definir el **congelado de la nómina** al abrir la toma.
- Definir la **sugerencia desde la sala en vivo**, sin que escriba nada por su cuenta.
- Definir el **historial por curso** y la **exportación a CSV** (día y mes).
- Garantizar que lo nuevo **entra al backup** y a la **auditoría**.

## No responsabilidades

- **No es el libro de asistencia oficial.** Es el registro de la plataforma. No emite
  constancias, no calcula inasistencias reglamentarias ni fracciones (1/4, 1/2), y no decide
  la condición del alumno. Si algún día hace falta, es otra spec y arranca de estos datos.
- **No notifica.** Sin mails, sin push, sin campanita — ni al alumno cuando se abre la toma,
  ni a la familia cuando falta. Coherente con el resto del proyecto
  (`specs/sala-en-vivo.spec.md:52`).
- **No marca a nadie automáticamente.** Decisión del usuario (RN-09). La sala en vivo sugiere;
  la marca la pone siempre una persona, salvo el ausente por cierre (RN-05), que es la
  consecuencia de un acto del preceptor.
- **No toca `Course.canManage()`, `canWatchLive()` ni ningún middleware de rol existente.**
- **No toca las tres colecciones de la sala en vivo.** Las lee para sugerir; no les escribe.
- **No agrega dependencias npm.**
- **No modifica datos existentes.** Dos colecciones nuevas; ni una migración.
- **No es justificación de inasistencias con documentación adjunta.** El estado "justificado"
  lleva una nota de texto, no un archivo.

## Entidades/Schemas

Dos modelos nuevos. **Ninguna colección existente se modifica.**

### `models/AttendanceSession.js` (nuevo)

```js
{
  division: ObjectId ref Division, required   // el CURSO (3°2°). La asistencia es del curso
  school:   ObjectId ref School,   required   // DENORMALIZADA — ver RN-15

  // Día escolar 'YYYY-MM-DD' calculado en la ZONA DE LA ESCUELA. String y no Date: ver RN-11
  date:  String, required
  // '' para la toma del día. 'Tarde', '2ª hora'... para una segunda toma (RN-01)
  label: String, trim, default '', maxlength: 30

  openedBy: ObjectId ref User, required
  openedAt: Date, default Date.now
  closedAt: Date, default null                // null = abierta. Único criterio de "en curso"
  closedBy: ObjectId ref User, default null
  autoClosed: Boolean, default false          // la cerró el autocierre del día (RN-10)

  mode: String, enum ['pase', 'ventana'], default 'pase'
  // Cierre programado opcional, solo tiene sentido en 'ventana'. null = la cierra una persona
  closesAt: Date, default null

  settings: {
    // El alumno puede marcarse solo. En 'pase' arranca en false; en 'ventana', en true
    selfCheckin: Boolean, default false
  },

  // Snapshot del total de la nómina al abrir. Se guarda para que el "N de M" de una toma de
  // hace seis meses siga diciendo lo que decía ese día, aunque el curso haya cambiado (RN-02)
  rosterSize: Number, default 0
}
// timestamps: true
```

Índices:
```js
{ division: 1, date: 1, label: 1 }  // ÚNICO — no puede haber dos tomas iguales el mismo día
{ school: 1, closedAt: 1 }          // "tomas abiertas de la escuela", la query del cartel
{ division: 1, date: -1 }           // historial del curso, de la más reciente a la más vieja
```

El índice único es lo que hace **idempotente** a `abrirToma()`: dos preceptores del mismo
curso tocando "Abrir" a la vez es un caso real (mismo criterio que `openSession` en
`services/liveRoom.js:208`).

### `models/AttendanceMark.js` (nuevo)

```js
{
  session:  ObjectId ref AttendanceSession, required
  student:  ObjectId ref User, required

  // DENORMALIZADAS: el reporte mensual filtra por curso y rango de fechas. Sin esto habría
  // que traer todas las tomas del período y hacer un $lookup por marca. `date` es inmutable
  // (el día de una toma no cambia nunca), así que no puede desincronizarse
  division: ObjectId ref Division, required
  school:   ObjectId ref School,   required
  date:     String, required

  // Snapshot, mismo criterio que RoomPresence: la asistencia de hace un año tiene que seguir
  // siendo legible aunque la cuenta ya no exista. El DNI porque es lo que pide el CSV
  studentName: String, default ''
  studentDni:  String, default ''

  // null = SIN MARCAR. Solo existe con la toma abierta: al cerrar pasa a 'ausente' (RN-05)
  status: String, enum ['presente', 'tarde', 'ausente', 'justificado', null], default: null

  // Quién puso el valor ACTUAL. 'sala' queda reservado y hoy no lo escribe nadie (RN-09)
  source: String, enum ['preceptor', 'alumno', 'sala'], default: null
  markedAt: Date, default null
  markedBy: ObjectId ref User, default null   // null cuando se marcó el alumno solo

  // Cuándo se marcó el ALUMNO. Se conserva aunque después el preceptor cambie el estado:
  // es el dato que permite ver "el chico dijo estar a las 7:42 y a las 8:10 lo pasaron a
  // ausente". Sin esto, corregir una marca borraría que el alumno la había dado (RN-06)
  selfMarkedAt: Date, default null

  note: String, trim, default '', maxlength: 200   // motivo del justificado / observación
}
// timestamps: true
```

Índices:
```js
{ session: 1, student: 1 }   // ÚNICO — una marca por alumno y toma. Es la clave del upsert
{ division: 1, date: 1 }     // grilla del día y reporte mensual del curso
{ student: 1, date: -1 }     // "asistencia de este alumno", para el legajo del preceptor
```

**No hay array de historial.** Los tres campos de arriba (`markedAt`/`markedBy`/`source` +
`selfMarkedAt`) cubren lo que se consulta de verdad, y un array que crece con cada corrección
multiplicaría por N el tamaño de la colección más grande del sistema (una marca por alumno,
por día, por año). Las correcciones sobre una marca **ya puesta** se auditan (RN-13).

### `services/attendance.js` (nuevo)

Mismo patrón que `services/liveRoom.js`: constantes con su fundamento al lado, después las
funciones **puras** (reciben `now`, no leen el reloj ni la base — son las que se testean sin
Mongo), y al final las que tocan la base y el CSV.

```js
// Constantes
ESTADOS         // ['presente', 'tarde', 'ausente', 'justificado'] + sus etiquetas en español
POLL_MS         // = liveRoom.DIRECTIVO_POLL_MS (15 s). No se inventa otra: ver RN-17

// Puras
diaEscolar(now)                      // 'YYYY-MM-DD' en la zona de la escuela (RN-11)
normalizarEstado(raw)                // uno de ESTADOS o null. Nunca confía en el body
resumen(marks)                       // { presentes, tarde, ausentes, justificados, sinMarcar, total }
shouldAutoClose(session, hoy)        // session.date !== hoy (RN-10)
puedeAutoMarcarse(session, now)      // abierta + selfCheckin + closesAt no vencido (RN-07)
esCorreccion(mark)                   // ¿la marca ya tenía estado? Decide si se audita (RN-13)

// Con base
abrirToma(division, user, opts)      // idempotente. Congela la nómina (RN-02)
cerrarToma(session, user, { auto })  // los sin marcar → ausente (RN-05)
marcar(session, studentId, status, user, note)
marcarLote(session, studentIds, status, user)
autoMarcarse(session, student)       // el alumno, solo a sí mismo, siempre 'presente' (RN-08)
tomasAbiertasDelAlumno(student, now) // para el cartel del inicio
presentesEnSalasDeDivision(divisionId, now)  // la SUGERENCIA (RN-09)

// Export
csvAsistenciaDia(marks)
csvAsistenciaMes(divisionId, desde, hasta)
```

`diaEscolar()` se agrega en **`services/liveRoom.js`**, junto a los otros formateadores, y
`attendance.js` lo importa de ahí. Es la única modificación a un archivo existente fuera del
cableado, y es a propósito: la zona horaria de la escuela ya tiene un dueño único
(`liveRoom.js:62`) y agregar un segundo `Intl.DateTimeFormat` en otro archivo es exactamente
cómo vuelve el bug de las tres horas de más (`agente.md:451`).

### `routes/attendance.js` (nuevo)

Dos routers exportados desde el mismo archivo, porque comparten todo el servicio y las
validaciones de estado:

- `panelRouter` — se monta en `/preceptor/asistencia`, con la misma cadena que
  `routes/preceptor.js:40`: `requireAuth, requirePreceptor, sectionGuard('preceptor'),
  loadPreceptorScope`.
- `alumnoRouter` — se monta en `/asistencia`, con `requireAuth` y nada más. Son dos endpoints
  y los dos validan que quien llama sea alumno de esa división.

En `server.js`, `/preceptor/asistencia` se monta **antes** que `/preceptor`. Es el mismo
patrón que `routes/rooms.js` con `/courses` (`routes/rooms.js:4`): sin ese orden, el request
atraviesa igual la cadena de `preceptorRouter` —incluido `loadPreceptorScope`, que consulta
divisiones— antes de caer en el router correcto, y paga la query dos veces.

### Vistas

| Archivo | Qué es |
|---|---|
| `views/preceptor/asistencia.ejs` | Una tarjeta por curso del alcance con el estado de HOY: sin tomar / abierta (N de M) / cerrada. Botones "Pasar lista" y "Abrir ventana" |
| `views/preceptor/asistencia-toma.ejs` | La grilla: nómina, cuatro botones por alumno, resumen arriba, sugerencias de la sala, cerrar |
| `views/preceptor/asistencia-historial.ejs` | Días anteriores del curso + resumen del mes + los dos botones de exportación |
| `views/partials/asistencia-banner.ejs` | El cartel del alumno con el botón "Dar asistencia". Se incluye en `views/dashboard.ejs` |

Ninguna vista formatea horas por su cuenta: reciben `fmt` (`services/liveRoom.js:91`), igual
que las de la sala.

### `config/sections.js` — entrada nueva

```js
{ key: 'preceptor_asistencia', panel: 'preceptor', label: 'Asistencia', icon: 'fact_check',
  path: '/preceptor/asistencia',
  roles: ['preceptor', 'directivo', 'admin', 'superadmin'] },
```

Configurable (sin `locked`): apagarla no deja a nadie afuera del panel, porque el destino del
redirect de `/` sigue siendo `preceptor_dashboard`, que sigue bloqueado
(`config/sections.js:40`). Va **después** de `preceptor_envivo` en el array, que es el orden
en que las pinta el nav.

### `config/audit-actions.js` — acciones nuevas

```js
'attendance.open':   { label: 'abrió la toma de asistencia',   icon: 'fact_check',  color: '#137333', category: 'division' },
'attendance.close':  { label: 'cerró la toma de asistencia',   icon: 'task_alt',    color: '#ea8600', category: 'division' },
'attendance.change': { label: 'corrigió una asistencia',       icon: 'edit_note',   color: '#9334e6', category: 'division' },
```

Categoría `division` porque la asistencia es del curso, no de una materia.

`attendance.change` se registra **solo cuando se pisa una marca que ya tenía estado** (RN-13).
El pase de lista normal no audita: son 30 eventos por curso y por día, la auditoría quedaría
inservible, y el dato de quién marcó y cuándo ya vive en la marca misma.

### `routes/backup.js` — las dos colecciones al array `COLLECTIONS` (`:103`)

```js
{ name: 'attendancesessions', model: AttendanceSession, optional: true },
{ name: 'attendancemarks',    model: AttendanceMark,    optional: true },
```

Van juntas y no se separan: una marca sin su toma no se puede fechar ni atribuir a un curso.
`optional: true` para que un backup viejo (sin estas colecciones) siga restaurándose, que es
el comportamiento que ya tiene `routes/backup.js:305`.

## Entradas

### Panel del preceptor (Fase A)

| Método | Ruta | Body / query | Quién |
|---|---|---|---|
| GET | `/preceptor/asistencia` | — | Preceptor (su alcance) |
| POST | `/preceptor/asistencia/:divisionId/abrir` | `{ mode, selfCheckin, label, closesAt }` | Preceptor |
| GET | `/preceptor/asistencia/:divisionId` | — | Preceptor |
| GET | `/preceptor/asistencia/toma/:id/poll` | — | Preceptor |
| POST | `/preceptor/asistencia/toma/:id/marcar` | `{ studentId, status, note }` | Preceptor |
| POST | `/preceptor/asistencia/toma/:id/marcar-lote` | `{ studentIds: [], status }` | Preceptor |
| POST | `/preceptor/asistencia/toma/:id/cerrar` | — | Preceptor |

### Alumno y reportes (Fase B)

| Método | Ruta | Body / query | Quién |
|---|---|---|---|
| GET | `/asistencia/abierta` | — | Alumno |
| POST | `/asistencia/:id/presente` | — | Alumno |
| GET | `/preceptor/asistencia/:divisionId/historial` | `?desde=&hasta=` | Preceptor |
| GET | `/preceptor/asistencia/:divisionId/export` | `?tipo=dia\|mes&fecha=\|desde=&hasta=` | Preceptor |

## Salidas

### `GET /preceptor/asistencia/toma/:id/poll`

```jsonc
{
  "estado": "abierta",              // "abierta" | "cerrada"
  "modo": "ventana",
  "autoasistencia": true,
  "cierraA": "08:15",               // ya formateada por el servidor, o null
  "resumen": { "presentes": 18, "tarde": 2, "ausentes": 0, "justificados": 1,
               "sinMarcar": 4, "total": 25 },
  "marcas": [
    { "studentId": "…", "nombre": "PEREZ, Ana", "estado": "presente",
      "origen": "alumno", "hora": "07:42", "seMarcoSolo": true, "nota": "" },
    { "studentId": "…", "nombre": "GOMEZ, Luis", "estado": null,
      "origen": null, "hora": "", "seMarcoSolo": false, "nota": "" }
  ],
  // SUGERENCIA, no marca. Alumnos sin marcar que están conectados AHORA a una sala en vivo
  // de alguna materia de este curso (RN-09)
  "enClase": [
    { "studentId": "…", "nombre": "GOMEZ, Luis", "materia": "Matemática" }
  ]
}
```

### `GET /asistencia/abierta`

```jsonc
{
  "tomas": [
    { "id": "…", "curso": "3°2°", "abiertaDesde": "07:30", "cierraA": "08:15",
      "yaDi": false }
  ]
}
```

Array y no un objeto suelto: un alumno puede cursar en más de una división (repitentes con
materias de dos años). En la práctica trae una sola.

## Reglas de negocio

- **RN-01 — La asistencia es del CURSO y del DÍA.** Una toma por `{division, date, label}`,
  con índice único. La toma normal lleva `label: ''`; una segunda toma el mismo día (turno
  tarde, contraturno) necesita etiqueta. Decisión del usuario: la toma diaria es el caso
  normal y la segunda es la excepción, no al revés.

- **RN-02 — La nómina se congela al abrir.** `abrirToma()` crea una `AttendanceMark` con
  `status: null` por cada alumno del curso **en ese momento**, con nombre y DNI copiados. Un
  alumno que se matricula a las 10 de la mañana no aparece en la toma de las 7:30, y uno que
  se va de la escuela sigue figurando en las tomas de cuando estaba. La nómina es la unión de
  los `students` de todas las materias de la división — el mismo criterio del `$setUnion` de
  `routes/preceptor.js:73`, porque un alumno cursa varias materias del mismo curso y sumarlas
  lo contaría repetido.

- **RN-03 — Fail-closed por alcance, en cada request.** Toda ruta con `:divisionId` pasa por
  `inScope()` (`middleware/preceptor.js:66`). Toda ruta con `:id` de toma carga la toma **y
  verifica que su `division` esté en el alcance** — validar solo el id de la toma dejaría leer
  la asistencia del curso de al lado escribiendo el número en la barra de direcciones. Alcance
  vacío significa "ningún curso", jamás "todos" (`models/User.js`, `middleware/preceptor.js:9`).

- **RN-04 — Cuatro estados y nada más**: `presente`, `tarde`, `ausente`, `justificado`. El
  `null` (sin marcar) no es un estado: es la ausencia de decisión y solo existe mientras la
  toma está abierta. `justificado` admite una nota de hasta 200 caracteres; el resto también
  la admite pero no la pide.

- **RN-05 — Al cerrar, lo que quedó sin marcar pasa a `ausente`,** con `source: 'preceptor'`,
  `markedBy` = quien cerró y `markedAt` = la hora del cierre. Es la única escritura de estado
  que no viene de un click alumno por alumno, y sigue siendo consecuencia de un acto explícito
  de una persona. Una toma cerrada **no tiene ningún `null`**.

- **RN-06 — La autoasistencia cuenta como presente al instante.** Decisión del usuario. Se
  guarda con `source: 'alumno'`, `markedBy: null` y `selfMarkedAt`. El preceptor puede
  cambiarla en cualquier momento; el cambio pisa `status`/`source`/`markedBy`/`markedAt` pero
  **conserva `selfMarkedAt`**, y la grilla sigue mostrando el ícono de "se marcó solo". Sin
  eso, corregir una marca borraría que el alumno la había dado, que es justo el dato que se
  discute cuando alguien reclama.

- **RN-07 — La autoasistencia solo existe con la toma abierta y `selfCheckin` prendido.**
  Fuera de eso el POST del alumno responde 409, aunque conozca el id de la toma. Si hay
  `closesAt` y ya pasó, también 409: la ventana se cierra sola para el alumno aunque el
  preceptor todavía no haya apretado "Cerrar".

- **RN-08 — El alumno solo puede marcarse a SÍ MISMO, y solo `presente`.** El body del POST no
  lleva ni `studentId` ni `status`: el alumno sale de la sesión y el estado es constante. Si
  llegó tarde, lo corrige el preceptor — decidir la propia tardanza no es del alumno. Y la
  toma tiene que ser de una división donde el alumno **curse** (misma verificación que
  `alumnoEnAlcance`, pero del lado del alumno): sin eso, conocer un id alcanzaría para
  aparecer presente en un curso ajeno.

- **RN-09 — La sala en vivo SUGIERE, nunca marca.** Decisión explícita del usuario. El poll
  del preceptor devuelve `enClase`: los alumnos **sin marcar** que en este momento están
  conectados a una sala abierta de alguna materia de este curso, con el nombre de la materia.
  El preceptor los marca de a uno o con "Marcar presentes a los N". No se escribe nada sin que
  él lo toque, y `services/liveRoom.js` no se modifica: esta feature lo lee y nada más.

- **RN-10 — Autocierre por cambio de día.** Una toma cuyo `date` ya no es el día escolar de
  hoy se cierra sola (con `autoClosed: true`) en el primer request que la toque, aplicando
  RN-05. Se evalúa de forma **perezosa** y no con un `setInterval`, por el mismo motivo que el
  autocierre de la sala (`routes/rooms.js:130`): PM2 corre dos workers y un timer se ejecutaría
  dos veces. Una toma de asistencia no puede cruzar la medianoche: no hay caso de uso legítimo
  y una ventana olvidada durante el fin de semana dejaría a todo el curso presente el lunes.

- **RN-11 — El día escolar lo calcula SIEMPRE el servidor, en la zona de la escuela.** `date`
  es un string `'YYYY-MM-DD'` producido por `diaEscolar()`, nunca un `Date` a medianoche ni
  algo derivado del reloj del navegador. Producción corre en UTC: con un `Date` local, una
  toma abierta a las 21:30 de Buenos Aires quedaría fechada al día siguiente, y el índice único
  de RN-01 dejaría abrir una segunda toma "del mismo día". El string además hace el índice
  único trivial y las comparaciones de rango del reporte mensual, exactas.

- **RN-12 — La asistencia no se purga nunca.** Sin `cleanup`. Es exactamente el dato que se
  consulta meses después, igual que `RoomPresence` (`services/liveRoom.js:37`).

- **RN-13 — Se audita el marco, no cada marca.** `attendance.open` y `attendance.close`
  siempre. `attendance.change` **solo cuando se pisa una marca que ya tenía estado**, con el
  estado anterior y el nuevo en `meta`. El pase de lista de un curso son 30 marcas: auditarlas
  todas ahogaría `/admin/audit` y no agregaría nada, porque la marca ya guarda quién y cuándo.

- **RN-14 — Sin notificaciones.** Ni al abrir la toma, ni al alumno que no la dio, ni a la
  familia. El alumno ve el cartel cuando entra a la plataforma y nada más.

- **RN-15 — `school` denormalizada en las dos colecciones.** Mismo motivo que en `RoomSession`
  (`models/RoomSession.js:19`): todo `$match` del proyecto arranca por la escuela del usuario,
  y sin el campo habría que traer las tomas de todas las escuelas y filtrarlas en memoria por
  la división populada.

- **RN-16 — La solapa se puede apagar por escuela** desde `/superadmin/roles`, como
  `preceptor_envivo`. El sistema sigue siendo restrictivo puro: `sectionGuard` solo puede
  quitar lo que `requirePreceptor` ya concedió (`config/sections.js:8`).

- **RN-17 — Costo.** El poll del panel es de **15 s** y lo corre solo el preceptor mientras
  mira la grilla: uno o dos usuarios por curso, no 25 como en la sala. Por eso reusa
  `DIRECTIVO_POLL_MS` en vez de definir otra constante. El POST del alumno es de **una vez por
  día por alumno**, pero llega concentrado a la hora de entrada: va con su propio limitador
  (`attendanceCheckinLimiter`, 10 por 5 minutos por usuario, en `middleware/rate-limits.js`),
  suficiente para tolerar el doble click y el F5 sin habilitar un martilleo. Estas rutas **no**
  se sacan del `generalLimiter`: no tienen nada que ver con el volumen de la sala.

- **RN-18 — El POST del alumno es idempotente.** Doble click, F5 o dos pestañas producen una
  sola marca (upsert sobre el índice único `{session, student}`) y la segunda llamada devuelve
  200 con `yaDi: true`, no un error. Un alumno que toca dos veces no puede ver un mensaje rojo
  cuando su asistencia está bien dada.

- **RN-19 — Directivo, admin y superadmin ven el panel completo.** Ya entran por
  `ROLES_CON_ACCESO` de `middleware/preceptor.js:16` y `loadPreceptorScope` les da todas las
  divisiones de su escuela (`ROLES_SIN_LIMITE`). Pueden abrir, marcar y cerrar: es el mismo
  criterio que ya rige en todo el panel de preceptoría, donde un directivo puede dar de alta un
  alumno. El docente **no** entra: 403.

- **RN-20 — Nada de esto aparece en la sala en vivo.** El chat de la clase no muestra la
  asistencia ni avisa que se abrió una toma. Son dos cosas distintas y mezclarlas haría que un
  alumno crea que entrar a la sala ya es dar la asistencia — que, por RN-09, no lo es.

## Casos de uso

1. **Pase de lista de la mañana.** El preceptor entra a `/preceptor/asistencia`, ve sus cuatro
   cursos con "Sin tomar", toca "Pasar lista" en 3°2°. Se abre la grilla con los 25 nombres.
   Va tocando "Presente" y en los tres que faltan, "Ausente". Cierra. Total: dos minutos.

2. **Ventana abierta.** A las 7:20 abre la ventana de 1°1° con cierre a las 8:15 y se va a
   recibir a los chicos. Los alumnos entran a la plataforma, ven el cartel y tocan "Dar
   asistencia". A las 8:10 vuelve, mira la grilla: 21 se marcaron solos, 4 sin marcar. De esos
   4, la grilla le dice que 2 están conectados a la sala de Matemática — los marca presentes
   con un click. Los otros 2 los deja: cierra y quedan ausentes.

3. **El que llega tarde.** Llegó 8:40, ya con la toma cerrada. El preceptor abre la toma del
   día desde el historial, le cambia el estado a "Tarde" y listo. Queda auditado como
   corrección (RN-13).

4. **El reclamo.** "Yo di la asistencia y me pusieron ausente". El preceptor abre la toma, ve
   el ícono de "se marcó solo" con la hora, y decide (RN-06).

5. **Fin de mes.** Entra al historial de 3°2°, elige el mes y baja el CSV: una fila por alumno,
   una columna por día, y el total de presentes/tardes/ausentes/justificados.

## Criterios de aceptación

### Lógica pura (`services/attendance.js`, se testea sin base de datos)

- **CA-01** — `diaEscolar()` con una fecha UTC del 11/08 a las 01:30 devuelve `'2026-08-10'`
  (zona de la escuela, tres horas menos), y con las 02:30 UTC del 11/08 devuelve
  `'2026-08-10'` también. *Es el test que impide que vuelva el bug de las tres horas.*
- **CA-02** — `normalizarEstado()` devuelve el estado para los cuatro válidos, y `null` para
  `'PRESENTE'`, `''`, `undefined`, `'presente; DROP'`, un número y un objeto.
- **CA-03** — `resumen()` sobre una nómina de 25 con 18 presentes, 2 tarde, 1 justificado y 4
  sin marcar devuelve exactamente esos números y `total: 25`.
- **CA-04** — `resumen()` de una nómina vacía devuelve todo en 0 y `total: 0`, sin `NaN`.
- **CA-05** — `shouldAutoClose()` es `true` para una toma con `date` de ayer, `false` para una
  de hoy, y `false` para una ya cerrada (sin importar la fecha).
- **CA-06** — `puedeAutoMarcarse()` es `false` con la toma cerrada, `false` con
  `selfCheckin: false`, `false` con `closesAt` vencido, y `true` con la toma abierta,
  `selfCheckin: true` y `closesAt` futuro o `null`.
- **CA-07** — `esCorreccion()` es `false` para una marca con `status: null` y `true` para una
  que ya tenía cualquiera de los cuatro estados.

### Abrir la toma

- **CA-08** — Dado un curso de 25 alumnos, cuando el preceptor abre la toma, entonces se crea
  **una** `AttendanceSession` con el `date` de hoy y **25** `AttendanceMark` con `status: null`,
  cada una con el nombre y el DNI copiados, y `rosterSize: 25` (RN-02).
- **CA-09** — Dado un alumno que cursa **tres materias** del mismo curso, entonces tiene **una
  sola** marca, no tres (RN-02).
- **CA-10** — Dados dos preceptores abriendo la misma toma a la vez, entonces queda **una**
  sesión y el segundo recibe la misma, sin error y sin marcas duplicadas (RN-01).
- **CA-11** — Dado un curso con la toma de hoy ya **cerrada**, cuando se intenta abrir otra sin
  etiqueta, entonces 409; con `label: 'Tarde'`, se abre (RN-01).
- **CA-12** — Dado `mode: 'ventana'`, entonces `settings.selfCheckin` queda en `true` por
  defecto; dado `mode: 'pase'`, en `false`.
- **CA-13** — Dado un curso **fuera del alcance** del preceptor, entonces 403 al abrir, aunque
  escriba el id a mano (RN-03).
- **CA-14** — Dado un preceptor **sin divisiones asignadas**, entonces `/preceptor/asistencia`
  responde 200 con la pantalla vacía y cero tarjetas, y abrir cualquier toma da 403 (RN-03).
- **CA-15** — Se registra un `AuditLog` con `action: 'attendance.open'`, el actor correcto y
  `meta` con el curso y el modo (RN-13).

### Marcar

- **CA-16** — Dado el preceptor marcando `presente`, entonces la marca queda con
  `source: 'preceptor'`, `markedBy` = él, `markedAt` seteado, y el resumen del poll refleja el
  cambio en la siguiente llamada.
- **CA-17** — Dado un `status` inválido en el body, entonces 400 y la marca **no cambia**.
- **CA-18** — Dado `marcar-lote` con 12 alumnos y `presente`, entonces las 12 marcas quedan
  presentes en **una** operación y el resto de la nómina no se toca.
- **CA-19** — Dado `marcar-lote` con un `studentId` que **no pertenece a esa toma**, entonces
  ese id se ignora y los demás se marcan (no 500, no se crea una marca huérfana).
- **CA-20** — Dado que el preceptor cambia una marca que **ya tenía** estado, entonces se
  registra `attendance.change` con el estado anterior y el nuevo en `meta`; dado que marca una
  que estaba en `null`, entonces **no** se audita (RN-13).
- **CA-21** — Dado un `justificado` con nota de 300 caracteres, entonces se guarda recortada a
  200 y no falla.
- **CA-22** — Dado un docente (`teacher`) llamando a cualquier ruta del panel, entonces 403
  (RN-19); dado un `directivo`, 200.

### Autoasistencia del alumno

- **CA-23** — Dada una toma abierta con `selfCheckin`, cuando el alumno toca "Dar asistencia",
  entonces su marca queda `presente`, `source: 'alumno'`, `markedBy: null` y `selfMarkedAt`
  seteado (RN-06).
- **CA-24** — Dado ese mismo alumno tocando el botón **dos veces**, entonces hay **una** marca,
  la respuesta es 200 con `yaDi: true` y `selfMarkedAt` **no se pisa** con la segunda hora
  (RN-18).
- **CA-25** — Dado que después el preceptor lo pasa a `ausente`, entonces `status`, `source`,
  `markedBy` y `markedAt` cambian y **`selfMarkedAt` se conserva**; el poll sigue devolviendo
  `seMarcoSolo: true` (RN-06).
- **CA-26** — Dada una toma con `selfCheckin: false`, entonces el POST del alumno responde 409
  aunque conozca el id (RN-07).
- **CA-27** — Dada una toma **cerrada**, o con `closesAt` ya vencido, entonces 409 (RN-07).
- **CA-28** — Dado un alumno que **no cursa** en esa división, entonces 403 y no se crea
  ninguna marca (RN-08).
- **CA-29** — Dado un POST del alumno con `{ studentId: <otro>, status: 'justificado' }` en el
  body, entonces el body **se ignora por completo**: se marca a sí mismo como `presente`
  (RN-08). *Es el test que cierra la puerta a marcar a un compañero.*
- **CA-30** — Dado un alumno **sin** toma abierta, entonces `GET /asistencia/abierta` devuelve
  `{ tomas: [] }` y el inicio **no** muestra el cartel.
- **CA-31** — Dado un alumno que cursa en dos divisiones con toma abierta, entonces
  `/asistencia/abierta` devuelve las dos y el cartel muestra las dos, cada una con su botón.
- **CA-32** — Dado el mismo alumno haciendo 11 POST en 5 minutos, entonces el 11° recibe 429 y
  su asistencia sigue dada (RN-17).

### Cerrar y autocerrar

- **CA-33** — Dado el cierre con 4 alumnos sin marcar, entonces los 4 quedan `ausente` con
  `source: 'preceptor'` y `markedBy` = quien cerró, y la toma **no tiene ningún `null`**
  (RN-05).
- **CA-34** — Dada una toma cerrada, entonces el POST del alumno da 409 y el del preceptor
  también: para corregir hay que reabrir desde el historial (caso de uso 3).
- **CA-35** — Dada una toma abierta con `date` de **ayer**, cuando el preceptor entra a
  `/preceptor/asistencia`, entonces esa toma aparece **cerrada** con `autoClosed: true`, los
  sin marcar quedaron ausentes, y hoy se puede abrir una nueva (RN-10).
- **CA-36** — Se registra `attendance.close` con el resumen final en `meta` (RN-13).

### Sugerencia desde la sala en vivo

- **CA-37** — Dada una sala abierta de Matemática de 3°2° con 12 alumnos conectados, cuando el
  preceptor pollea la toma de 3°2°, entonces `enClase` trae esos 12 con el nombre de la materia
  y **ninguna marca cambió** (RN-09).
- **CA-38** — Dado que 5 de esos 12 **ya estaban marcados**, entonces `enClase` trae solo los
  otros 7: sugerir lo que ya está resuelto es ruido.
- **CA-39** — Dado un alumno cuyo último ping fue hace 2 minutos (fuera de la ventana de 45 s
  de `liveRoom.ONLINE_WINDOW_MS`), entonces **no** aparece en `enClase`.
- **CA-40** — Dada una sala abierta de una materia de **otra** división, entonces sus alumnos
  no aparecen en `enClase` de esta toma.
- **CA-41** — Dado el preceptor tocando "Marcar presentes a los N", entonces esos N quedan
  `presente` con `source: 'preceptor'` (**no** `'sala'`): la marca la puso él (RN-09).
- **CA-42** — Dado que no hay ninguna sala abierta, entonces `enClase` es `[]` y la grilla no
  muestra el bloque de sugerencias (no un bloque vacío).

### Historial y exportación

- **CA-43** — Dado el historial de un curso, entonces lista los días con su resumen, del más
  reciente al más viejo, y una toma **abierta** aparece marcada como tal.
- **CA-44** — Dado el export `?tipo=dia`, entonces devuelve un CSV con una fila por alumno:
  nombre, DNI, estado, hora de la marca, quién la puso y la nota.
- **CA-45** — Dado el export `?tipo=mes`, entonces devuelve una fila por alumno con una columna
  por día del rango y los totales por estado al final.
- **CA-46** — Dados los dos CSV, entonces empiezan con BOM, usan `;` como separador y las horas
  están en la zona de la escuela (RN-11), igual que `csvAsistencia` de la sala.
- **CA-47** — Dado un rango de fechas invertido o malformado, entonces 400 y no una consulta
  sin límites.

### Solapa, backup y regresión

- **CA-48** — Dado que el superadmin apagó `preceptor_asistencia` para el rol `preceptor`,
  entonces `/preceptor/asistencia` responde 403 **y** la solapa desaparece del nav (RN-16).
- **CA-49** — Dado un backup con asistencia cargada, entonces el manifiesto incluye
  `attendancesessions` y `attendancemarks` con sus conteos y el `.tar.gz` los contiene.
- **CA-50** — Dado un backup **viejo** (sin las dos colecciones), entonces la pantalla de
  restauración las lista como faltantes y no se rompe.
- **CA-51** — Dado el HTML de las tres pantallas, entonces no contiene `NaN`, `Infinity` ni
  `undefined`, aunque el curso no tenga alumnos.
- **CA-52** — Dado `npm run test:smoke` y `npm run test:roles`, entonces siguen verdes.
- **CA-53** — Dadas las tres colecciones de la sala en vivo, entonces **ninguna cambió** después
  de una jornada completa de asistencia: esta feature solo las lee (RN-09, RN-20).

## Errores posibles

| CODIGO | HTTP | Mensaje en español | Cuándo |
|---|---|---|---|
| `DIVISION_NOT_FOUND` | 404 | «Curso no encontrado» | `:divisionId` malformado o inexistente |
| `SESSION_NOT_FOUND` | 404 | «Toma de asistencia no encontrada» | `:id` inexistente |
| `ACCESS_DENIED` | 403 | «Acceso denegado» | División fuera del alcance (RN-03), alumno que no cursa ahí (RN-08), o sección denegada |
| `ALREADY_OPEN` | 409 | «Ya hay una toma de asistencia de hoy para este curso» | Segunda toma sin etiqueta (RN-01) |
| `SESSION_CLOSED` | 409 | «La toma de asistencia está cerrada» | Marcar o autoasistirse en una toma con `closedAt` |
| `CHECKIN_OFF` | 409 | «Este curso no tiene la asistencia abierta para alumnos» | `selfCheckin: false` o `closesAt` vencido (RN-07) |
| `INVALID_STATUS` | 400 | «Estado de asistencia no válido» | `status` fuera de `ESTADOS` |
| `INVALID_RANGE` | 400 | «El rango de fechas no es válido» | `desde` > `hasta`, o formato distinto de `YYYY-MM-DD` |
| `RATE_LIMITED` | 429 | «Esperá un momento antes de volver a intentar» | Más de 10 check-ins en 5 minutos (RN-17) |
| `SERVER_ERROR` | 500 | «Error del servidor» | Excepción no prevista |

Los códigos `SCREAMING_SNAKE` son el contrato para los tests; las respuestas siguen enviando
texto plano o JSON según `req.accepts`, mismo criterio que `routes/rooms.js:42`.

## Tests necesarios

**Unitarios** — `tests/unit/attendance.test.js` con `node --test` (el runner que ya usa el
proyecto, `package.json:17`). Cubren **CA-01 a CA-07**. Toda la lógica de días, estados y
ventanas de tiempo se testea acá, sin Mongo: son funciones puras que reciben `now`.

**Smoke** — nuevos casos en `tests/smoke/specs.js` siguiendo el patrón del archivo:
- Flujo completo del pase de lista (CA-08, CA-16, CA-33, CA-43).
- Flujo completo de la ventana con autoasistencia (CA-12, CA-23, CA-24, CA-33).
- Las cinco guardas de seguridad, que son las que más caro salen si fallan: **CA-13, CA-14,
  CA-28, CA-29, CA-22**.
- Los dos export (CA-44, CA-45).

**Roles** — `tests/roles/check-roles.js`: la solapa nueva entra en la matriz de roles ×
solapas, con los 8 roles (CA-48).

**Manual, en el navegador** — la grilla con 25 alumnos en un celular (es donde el preceptor la
va a usar de verdad), y el cartel del alumno en el inicio.

## Dependencias

- `middleware/preceptor.js` — `requirePreceptor`, `loadPreceptorScope`, `inScope`. Sin cambios.
- `middleware/sections.js` + `config/sections.js` — la solapa nueva.
- `middleware/audit.js` + `config/audit-actions.js` — las tres acciones nuevas.
- `middleware/rate-limits.js` — un limitador nuevo (RN-17).
- `services/liveRoom.js` — se **agrega** `diaEscolar()` junto a los formateadores y se
  **leen** `fmt`, `ONLINE_WINDOW_MS`, `STAFF_ROLES` y `DIRECTIVO_POLL_MS`. No se modifica
  ninguna función existente.
- `models/RoomSession.js` / `models/RoomPresence.js` — **solo lectura**, para la sugerencia.
- `routes/backup.js` — las dos colecciones nuevas.
- `views/dashboard.ejs` — una línea: el `include` del cartel.
- `server.js` — dos `app.use` nuevos, `/preceptor/asistencia` **antes** de `/preceptor`.

## Riesgos de refactorización

- **El orden del montaje en `server.js`.** Si `/preceptor/asistencia` queda después de
  `/preceptor`, todo sigue funcionando pero cada request paga `loadPreceptorScope` dos veces.
  Silencioso, y por eso vale la pena dejarlo escrito acá.
- **`diaEscolar()` duplicado.** Si alguien, con apuro, arma otro `Intl.DateTimeFormat` en
  `attendance.js` en vez de importar el de `liveRoom.js`, la feature funciona hasta que las dos
  zonas horarias discrepen — y va a discrepar en producción, que corre en UTC. CA-01 es la red.
- **El congelado de la nómina (RN-02) tienta a "arreglarse".** Alguien va a notar que una toma
  vieja no muestra a un alumno nuevo y va a querer recalcular la nómina al vuelo. Eso rompe el
  registro histórico: la asistencia de un día es la de los que estaban ese día.
- **La tentación de marcar desde la sala.** RN-09 es una decisión del usuario, no una limitación
  técnica: el enganche automático son cuatro líneas en `touchPresence`. Si alguna vez se
  reabre, la conversación es con él, y el lugar correcto sigue siendo el `creada` de
  `touchPresence` (una vez por alumno y sesión) y **nunca** el poll, que corre cada 4 segundos
  por cada alumno conectado.
- **El índice único `{division, date, label}`** vive sobre un campo (`label`) que el usuario
  escribe. Dos etiquetas que difieren en un espacio son dos tomas distintas. Se normaliza con
  `trim()` en el modelo; no se normaliza acentos ni mayúsculas a propósito, porque "Tarde" y
  "tarde" siendo la misma toma es más sorpresa que ayuda.

## Plan de migración

**Ninguna.** Dos colecciones nuevas que Mongo crea al primer uso, cero cambios a colecciones
existentes, cero backfill. Un despliegue sin asistencia cargada se comporta exactamente igual
que hoy: las pantallas muestran su estado vacío.

**Rollback**: quitar la entrada de `config/sections.js` esconde la solapa y `sectionGuard`
bloquea las rutas. Las dos colecciones quedan en la base sin molestar a nada.

**Orden de merge**: Fase A completa y verificada en producción antes de empezar la B. La A ya
le sirve al preceptor (pase de lista + cierre + grilla); la B agrega el botón del alumno, las
sugerencias y los reportes.
