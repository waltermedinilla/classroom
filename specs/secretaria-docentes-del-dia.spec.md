# Secretaria — los docentes del día

> **Estado:** APROBADA por Walter el 2026-11-11. Siguiente paso: tester.
> Base de código revisada: `origin/main` v1.0.112.

## Problema

La secretaría de la escuela necesita saber, día por día, qué docentes trabajaron en la
plataforma: si entraron, si dieron clase en la sala en vivo, si publicaron trabajos o
novedades y si corrigieron. Hoy ese dato está desparramado en el registro de auditoría y en
la presencia de las salas, y solo el superadmin puede llegar a él, y no por docente ni por día.

Lo que se pidió, en palabras de Walter:

- Un rol nuevo, **Secretaria**.
- Ver la planilla de docentes de un día, **con vista tipo calendario del día**, y poder
  cambiar a esa vista cuando quiera.
- Que figure si el docente **entró a una sala**, si **subió algún trabajo**, si **inició
  sesión** y si **corrigió entregas**.
- Que la secretaria pueda **anotar** algo por docente y día.
- Que **un admin le defina qué docentes ve, según los cursos** que le asigna.

## Alcance

1. Rol `secretaria` (nombre visible **"Secretaria"**), panel propio en `/secretaria`.
2. Alcance por cursos (`Division`), asignado por un admin, con los mismos campos y la misma
   regla fail-closed que el preceptor.
3. Pantalla **"Docentes del día"** con dos vistas intercambiables: **Lista** y **Línea del día**
   (calendario de un día).
4. Ficha **"El día de un docente"** con los eventos en orden.
5. **Anotaciones** de la secretaria por docente y día.
6. Registro nuevo **"entró a la plataforma ese día"** (no existe hoy; ver D3).

### Fuera de alcance (decidido, no olvidado)

- **Horario de clases por materia.** No existe en el sistema (`models/Horario.js` es solo la
  grilla de módulos para reservar recursos, y lo dice explícitamente). Por decisión de
  Walter, **por ahora no se carga**. La pantalla no muestra "a qué hora le tocaba". Ver D6:
  el diseño deja lugar para sumarlo sin rehacer nada.
- **Juzgar si el docente cumplió.** La pantalla muestra lo que quedó registrado, nunca dice
  "faltó" ni "no trabajó" (ver D2).
- Entrar a las materias, ver contenidos, entregas o datos de alumnos.
- Exportar a Excel o imprimir (se puede pedir después).
- Que el docente vea su propia línea del día.

## Decisiones de diseño

### D1 — El alcance reutiliza `assignedDivisions` / `allDivisions`

Los dos campos ya existen en `User` y hoy solo los lee el preceptor. La secretaria los usa
igual: los docentes que ve son **los titulares y co-docentes de las materias (`Course`) cuyas
divisiones están en su alcance**.

- **Fail-closed**, igual que el preceptor: sin divisiones asignadas y sin `allDivisions`, no ve
  a nadie. No existe la convención "vacío = todas".
- El filtro por escuela se aplica siempre, también sobre `assignedDivisions`.
- `loadPreceptorScope` (`middleware/preceptor.js`) **se reutiliza tal cual**: ya resolvía el
  alcance sin mirar el rol. No se toca, así que el comportamiento del preceptor no puede cambiar
  (CA-21). *(Ajuste de implementación: la versión aprobada proponía generalizarlo.)*

### D2 — Ausencia de registro ≠ ausencia del docente

Un docente puede dar clase presencial sin tocar la plataforma. Por eso la pantalla clasifica
el día en tres estados **neutros**, nunca en "presente/ausente":

| Estado | Cuándo | Texto en pantalla |
|---|---|---|
| `actividad` | Tiene al menos una señal S2, S3 o S4 | **Con actividad** |
| `ingreso` | Solo tiene S1 | **Solo ingresó** |
| `sinRegistro` | No tiene ninguna señal | **Sin registro en la plataforma** |

La palabra "faltó" no aparece en ningún texto, título ni ayuda de la pantalla.

### D3 — "Inició sesión" se mide como "entró a la plataforma ese día"

La sesión dura varios días (cookie JWT), así que el `POST /login` casi nunca ocurre. Un
docente que trabaja todos los días puede iniciar sesión una vez por semana. Contar logins
daría falsos "no entró".

Lo que sí sirve es el **primer y último pedido del día**. `lastSeen` ya se actualiza en
`middleware/auth.js` (como mucho una vez por minuto), pero se pisa: no queda historial.
Hace falta una colección nueva, `IngresoDiario`:

- Un documento por usuario y día (índice único `{ user, fecha }`).
- Se escribe **en el mismo lugar y con el mismo throttle** que `lastSeen`, con un upsert
  `$setOnInsert: { primeraVez }` + `$set: { ultimaVez }`. Es idempotente: si el caché del
  usuario está viejo y se repite, no duplica nada.
- **Solo para roles que no son `student`.** Los alumnos no hacen falta y no se registran.
- Fire-and-forget con `.catch()`, igual que `lastSeen`. **Nunca bloquea ni rompe el pedido.**
- **No hay historial previo**: los días anteriores al deploy muestran "sin dato de ingreso",
  no "no ingresó" (RN-07).

### D4 — Las acciones salen del registro de auditoría

`AuditLog` ya guarda quién hizo qué y cuándo, con el **actor real** (`actor.userId`). Eso
importa: `Activity.author` siempre es el titular de la materia, así que si la publica un
co-docente, contar por `author` se la atribuiría a otro.

`AuditLog` está indexado por `{ 'actor.userId', timestamp }` y no tiene vencimiento, así que
hay historial desde que existe la auditoría.

### D5 — Minutos en sala salen de `RoomPresence`

`RoomPresence` guarda por persona y sesión el tiempo acumulado (`msPresente`), y distingue
el rol (`userRole`). Es el mismo dato del CSV de asistencia de la sala.

Su único índice por usuario es `{ session, user }`. Para buscar "las presencias de este
docente este día" hace falta un **índice nuevo** `{ user: 1, firstSeenAt: -1 }` (ver
Plan de migración).

### D6 — El calendario es de un día y sin horario

La vista **Línea del día** es un eje horario de un día (de 07:00 a 23:00, extensible si hay
eventos fuera de ese rango) con una fila por docente, y en cada fila sus eventos en la hora
en que ocurrieron. La sala en vivo se dibuja como un bloque con su duración, y el resto como
puntos.

Si algún día se carga el horario de materias, la misma vista suma franjas de fondo con "le
toca 3ª hora" sin cambiar el modelo de esta spec.

## Modelo

### `User` (sin migración)

- `ROLES` suma `'secretaria'`.
- `assignedDivisions` y `allDivisions` pasan a leerse también cuando `role === 'secretaria'`.
  Se actualiza el comentario del modelo.

### `IngresoDiario` (colección nueva)

```js
{
  user:       ObjectId → User,      // required
  school:     ObjectId → School,    // snapshot, para filtrar por escuela
  fecha:      String 'YYYY-MM-DD',  // día en America/Argentina/Buenos_Aires
  primeraVez: Date,                 // $setOnInsert
  ultimaVez:  Date,                 // $set
}
index { user: 1, fecha: 1 } unique
index { school: 1, fecha: 1 }
```

`fecha` es string por el mismo motivo que `AttendanceSession.date` y `Horario`: producción
corre en UTC y un `Date` sin hora corre de día.

### `NotaDocenteDia` (colección nueva)

```js
{
  school:  ObjectId → School,
  docente: ObjectId → User,
  fecha:   String 'YYYY-MM-DD',
  texto:   String, trim, 1..500
  autor:   ObjectId → User,   // la última secretaria que la editó
  autorNombre: String,        // snapshot
  timestamps: true
}
index { school: 1, docente: 1, fecha: 1 } unique
index { school: 1, fecha: 1 }
```

Una nota por docente y día. Editarla la reemplaza; el historial de ediciones queda en
`AuditLog`.

### `AuditLog` (acciones nuevas en `config/audit-actions.js`)

- `secretaria.nota_guardar` — creó o editó una anotación.
- `secretaria.nota_borrar` — borró una anotación.
- `user.assign_divisions` se reutiliza para el alcance de la secretaria.

## Reglas de negocio

- **RN-01** — `secretaria` **no es auto-asignable**. No entra en `allowedRoles` de
  `POST /register` ni en `allowed` de `POST /register/invite/:token`. Lo crea un admin o el
  superadmin.
- **RN-02** — ⚠️ `GET /register/invite/:token` arma la lista de roles con una **lista negra**
  (`User.getRoles().filter(r => !['superadmin','admin','preceptor'].includes(r))`). Al agregar
  `secretaria` al enum, **aparecería en el select de la invitación**. El POST la rechazaría
  (lo convierte en `student` sin avisar), así que no hay escalada, pero sí un error
  confuso. Se cambia el GET a la **misma lista blanca del POST**, en una constante compartida.
  Hoy `jefe` ya tiene este mismo problema y queda arreglado de paso.
- **RN-03** — Alcance: D1. Toda ruta con `:id` de docente valida en el servidor que el docente
  esté en el alcance (`docenteEnAlcance`). Fuera de alcance → **403**, igual con un id que no
  existe (no se distingue "no existe" de "no es tuyo").
- **RN-04** — Docentes del alcance = `owner` ∪ `coTeachers` de las `Course` con `division` en
  el alcance, sin repetir. Se listan aunque su rol no sea `teacher` (un jefe o un directivo
  que da una materia también aparece). Los usuarios deshabilitados aparecen con la marca
  "deshabilitado".
- **RN-05** — Un día es `[00:00, 24:00)` en **America/Argentina/Buenos_Aires**. Los límites
  se calculan en el servidor con el patrón del proyecto: ventana UTC holgada (`ventanaDelDia`) para
  el `$match` y recorte fino con `diaEscolar()` de `services/liveRoom.js` (`esDelDia`); está **prohibido
  `toLocale*String`** para fechas (regla del proyecto). En la vista se formatea con `Fecha`.
- **RN-06** — Las cuatro señales de un docente en un día:

  | Señal | Fuente | Qué se cuenta | Se limita a materias del alcance |
  |---|---|---|---|
  | **S1 Ingresó** | `IngresoDiario` | primera y última hora | No (es de la plataforma, no de una materia) |
  | **S2 Sala en vivo** | `RoomPresence` con `user` = docente y `firstSeenAt` en el día | sesiones y minutos (`msPresente`) por materia | Sí |
  | **S3 Publicó** | `AuditLog` `activity.create`, `announcement.create` | cantidad y títulos, por materia | Sí (target `course`) |
  | **S4 Corrigió** | `AuditLog` `submission.grade`, `submission.return` | cantidad de entregas distintas, por materia | Sí (target `course`: las dos acciones ya lo auditan) |

  Una sesión de sala que cruza la medianoche se cuenta en el día en que **empezó**.
- **RN-07** — Si la fecha consultada es anterior al primer `IngresoDiario` de la escuela, S1
  se muestra **"sin dato"** y no cuenta para el estado. El estado sale entonces solo de
  S2–S4.
- **RN-08** — Estado del día: D2.
- **RN-09** — Fechas futuras: `?fecha=` posterior a hoy redirige a hoy. Fecha mal formada →
  hoy. Sin tope hacia atrás.
- **RN-10** — **S4 nunca muestra datos de alumnos**: ni nombres ni notas, solo la cantidad de
  entregas corregidas y en qué materia. S3 muestra el título de la actividad o el comienzo de
  la novedad (60 caracteres), sin adjuntos ni enlaces.
- **RN-11** — La secretaria **no entra** a las materias por ser secretaria: no se la agrega a
  `STAFF_ROLES` (`services/liveRoom.js`), `ROLES_PERSONAL` (`public/js/salaSonido.js`) ni a
  `ROLES_QUE_CREAN_MATERIAS` (`routes/courses.js`). Si está matriculada en alguna materia, la
  ve como cualquier usuario, igual que el preceptor.
- **RN-12** — Anotaciones: cualquier secretaria **con ese docente en su alcance** puede crear,
  editar o borrar la nota de ese día. Texto vacío = borrar. Máximo 500 caracteres. Se puede
  anotar en días pasados y en hoy, no en días futuros.
- **RN-13** — Quién **lee** las anotaciones: la secretaria (con alcance), el directivo y el
  admin de la escuela. **El docente no las ve.** (Pendiente de confirmar: pregunta abierta 1.)
- **RN-14** — Un admin que suplanta a un docente deja auditoría a nombre del docente
  (`logAudit` toma `res.locals.user`). Esas acciones cuentan como del docente. Es una
  limitación conocida; no se cambia `logAudit`. **El ingreso (S1) sí se protege:** mientras hay
  suplantación no se registra `IngresoDiario` para el docente suplantado.
- **RN-15** — Si la auditoría está apagada (`AUDIT_ENABLED=false`), S3 y S4 no tienen datos:
  la pantalla muestra un aviso arriba en vez de mostrar a todos "sin registro".

## Pantallas

Panel `secretaria`, con su nav propio (`views/partials/secretaria-nav.ejs`). `GET /` redirige
a la secretaria a `/secretaria`, como hace con el preceptor y el SOE.

### `GET /secretaria?fecha=YYYY-MM-DD&curso=<divisionId>&vista=lista|linea`

(`/secretaria/dia` queda como alias. Se sirve en `/secretaria` sin redirect porque es el path
de la solapa y `test:roles` espera un 200 ahí.)

- **Encabezado:** la fecha larga ("miércoles, 11 de noviembre de 2026"), flechas ◀ ▶, botón
  **Hoy** y selector de fecha. Sábados y domingos se muestran igual, con el encabezado gris.
- **Filtro:** por curso del alcance (por defecto, todos).
- **Resumen:** tres contadores: *Con actividad · Solo ingresó · Sin registro*.
- **Vista Lista** (por defecto): una fila por docente, ordenada por apellido.

  | Docente | Materias (del alcance) | Ingresó | Sala | Publicó | Corrigió | Nota |
  |---|---|---|---|---|---|---|
  | con el estado como etiqueta de color | | 07:42 – 12:15 | 2 sesiones · 85 min | 3 | 14 | ✎ |

- **Vista Línea del día:** el calendario del día (D6). Al pasar el mouse por un evento se ve
  su detalle; al tocarlo se abre la ficha del docente.
- El cambio de vista es un parámetro de URL. El navegador recuerda la última elegida
  (`localStorage`, envuelto en `try/catch`).
- **Sin alcance:** pantalla "Todavía no tenés cursos asignados. Pedíselo a un administrador",
  igual que el preceptor.

### `GET /secretaria/docentes/:id?fecha=YYYY-MM-DD`

Ficha del día de un docente: sus materias del alcance, los eventos en orden cronológico
(hora · qué hizo · materia) y la anotación del día con su campo para editar. Flechas para
moverse de día sin salir de la ficha.

### `POST /secretaria/docentes/:id/nota`

Body `{ fecha, texto }`. Crea, reemplaza o (con texto vacío) borra. Responde JSON. Valida
RN-03, RN-09 y RN-12.

### Panel admin

- **Alta de usuario:** al elegir "Secretaria" aparece el mismo selector de cursos que para el
  preceptor ("Todos los cursos" + lista). ⚠️ El alta está **duplicada**: el modal de
  `views/admin/users.ejs` y la página `views/admin/user-form.ejs`. Hay que tocar las dos.
- **Perfil del usuario** (`/admin/users/:id`): el bloque "Cursos a cargo" y su aviso ámbar
  "sin cursos" se muestran también para la secretaria.
- `POST /admin/users/:id/divisions` acepta `secretaria` además de `preceptor` y llama a
  `invalidateUser` (el alcance se lee del usuario cacheado 45 s).

### Catálogo de solapas (`config/sections.js`)

Panel nuevo `secretaria`, sección `secretaria_dia` (`/secretaria`), roles
`['secretaria', 'directivo', 'admin', 'superadmin']`, **locked** (es el destino del redirect de
"/"). El directivo y el admin entran viendo toda su escuela y leen las notas (RN-13), pero no
anotan (RN-12). Además, `secretaria` se suma a `app_courses` y
`app_profile`, como el preceptor.

## Lugares a tocar por el rol nuevo

Lista sacada con `grep` sobre v1.0.112. Es la checklist del implementador y del revisor:
**ninguno puede quedar afuera**, porque un rol que falta en una lista se ve como un rol roto.

| Archivo | Qué |
|---|---|
| `models/User.js` | `ROLES`; comentario de `assignedDivisions` |
| `routes/superadmin.js:159` | lista `ROLES` |
| `routes/auth.js` | RN-01 y RN-02 (lista blanca compartida) |
| `server.js` | redirect de `GET /` (junto a preceptor/jefe/soe); `res.locals.roleNames` |
| `config/sections.js` | panel y sección nuevos; `app_courses`, `app_profile` |
| `config/audit-actions.js` | dos acciones nuevas |
| `middleware/preceptor.js` | **no se toca**: `loadPreceptorScope` se reutiliza (D1) |
| `middleware/auth.js` | escritura de `IngresoDiario` (D3) |
| `routes/admin.js` | alta y `/:id/divisions` aceptan secretaria |
| `routes/backup.js` | **las dos colecciones nuevas en el backup** (`optional: true`) |
| `views/admin/users.ejs`, `user-form.ejs`, `user-profile.ejs` | opción del rol, selector de cursos, color del avatar |
| `views/superadmin/users.ejs` (3 lugares), `school-profile.ejs` (5), `import.ejs`, `monitor.ejs` | listas y nombres de roles |
| `views/profile.ejs` | color del avatar |
| `views/dashboard.ejs:62` | condición por rol |
| `views/partials/header.ejs:327` | revisar si corresponde |
| `tests/roles/check-roles.js` | `ROLES`, `LANDING`, configurar alcance en el paso 1 |

Archivos nuevos: `routes/secretaria.js`, `middleware/secretaria.js`,
`services/secretariaDia.js`, `models/IngresoDiario.js`, `models/NotaDocenteDia.js`,
`views/secretaria/dia.ejs`, `views/secretaria/docente.ejs`,
`views/partials/secretaria-nav.ejs`, `views/secretaria/_linea.ejs`, `views/secretaria/_estilos.ejs`,
`views/secretaria/no-scope.ejs`, `services/ingresoDiario.js`.

## Contrato de `services/secretariaDia.js`

Funciones puras: sin Mongo, sin `req`, sin `Date.now()` adentro (el "ahora" entra por
parámetro). Los ids se comparan con `String()`.

```js
const {
  limitesDelDia,      // ('YYYY-MM-DD') -> { desde: Date, hasta: Date }  (RN-05)
  fechaDe,            // (Date) -> 'YYYY-MM-DD' en America/Argentina/Buenos_Aires
  fechaValida,        // (string, ahora: Date) -> 'YYYY-MM-DD'  (RN-09)
  docentesDelAlcance, // (courses, scopeDivisionIds) -> [{ docenteId, materias: [courseId] }]  (RN-04)
  señalesDelDocente,  // ({ ingreso, presencias, auditorias, actividadACurso, cursosAlcance }) -> Señales  (RN-06)
  estadoDelDia,       // (Señales, { hayDatoIngreso }) -> 'actividad' | 'ingreso' | 'sinRegistro'  (D2, RN-07)
  eventosDeLaLinea,   // (Señales) -> [{ desde, hasta|null, tipo, materia, texto }] ordenados
} = require('./services/secretariaDia');
```

## Criterios de aceptación

### Reglas puras (`tests/unit/secretariaDia.test.js`)

- **CA-01** La ventana de `ventanaDelDia('2026-11-11')` contiene las 00:00 y las 23:59 de
  Argentina del 11, y `esDelDia` deja afuera el 10 y el 12.
- **CA-02** `fechaDe` de las 23:30 hora argentina del 11 devuelve `'2026-11-11'` (en UTC ya es el 12).
- **CA-03** `fechaValida`: futura → hoy; basura → hoy; válida → igual.
- **CA-04** `docentesDelAlcance` une titular y co-docentes sin repetir, y deja afuera las
  materias de divisiones fuera del alcance.
- **CA-05** Alcance vacío → ningún docente.
- **CA-06** Un `activity.create` de una materia fuera del alcance **no cuenta**.
- **CA-07** `submission.grade` y `submission.return` de la misma entrega cuentan **una** entrega.
- **CA-08** Sesión de sala que empieza 23:50 y termina 00:20 cuenta en el día en que empezó.
- **CA-09** Solo S1 → `ingreso`. S1 + cualquier S2–S4 → `actividad`. Nada → `sinRegistro`.
- **CA-10** Sin dato de ingreso (RN-07) y con S3 → `actividad`. Sin dato y sin S2–S4 → `sinRegistro`.
- **CA-11** `eventosDeLaLinea` sale ordenada y la sala tiene `hasta`.

### Servidor (smoke)

- **CA-12** `GET /secretaria` con `teacher`, `student`, `preceptor`, `jefe`, `soe` → bloqueado.
- **CA-13** Secretaria sin alcance → pantalla "todavía no tenés cursos asignados".
- **CA-14** `GET /secretaria/docentes/:id` de un docente fuera del alcance → 403; id inexistente → 403.
- **CA-15** Docente con una actividad publicada hoy en una materia del alcance aparece
  "Con actividad" con Publicó = 1.
- **CA-16** Nota: crear, editar, borrar con texto vacío. 501 caracteres → 400. Fecha futura → 400.
  Docente fuera del alcance → 403.
- **CA-17/18** Las dos puertas de registro están **cerradas** desde el 2026-08-23
  (`services/registroPublico.js`), así que no hay smoke posible. Se cubre en
  `tests/unit/registroPublico.test.js`: la lista blanca compartida `ROLES_AUTOREGISTRO` no
  incluye `secretaria` (ni `jefe`, `preceptor`, `admin`, `superadmin`) y está congelada.
- **CA-19** La secretaria no puede `POST /courses/create`, ni entrar a `/preceptor`, `/admin`,
  `/directivo` ni `/soe`.
- **CA-20** Un pedido autenticado de un docente crea su `IngresoDiario` de hoy; un segundo
  pedido no crea otro. Un alumno no genera ninguno.

### Regresión

- **CA-21** Los 16 smoke del preceptor siguen pasando sin tocarlos (D1 no cambia su alcance).
- **CA-22** El backup incluye `ingresodiarios` y `notadocentedias`, y restaurar un backup
  viejo sin esas colecciones no falla.

### Matriz de roles

- **CA-23** `npm run test:roles` con `secretaria` en `ROLES`: aterriza en `/secretaria`, ve
  solo su solapa más *Mis clases* y *Mi perfil*, y el header dice "Secretaria".

## Errores posibles

| Caso | Respuesta |
|---|---|
| Docente fuera del alcance o inexistente | 403 |
| Fecha futura en la nota | 400 "No se puede anotar un día que todavía no pasó" |
| Texto de más de 500 caracteres | 400 |
| Usuario con rol cambiado a secretaria desde el listado (sin alcance) | Ve "sin cursos asignados"; el admin ve el aviso ámbar |
| Falla la escritura de `IngresoDiario` | Se loguea y el pedido sigue normal |
| Auditoría apagada | Aviso arriba de la pantalla (RN-15) |

## Tests necesarios

- `tests/unit/secretariaDia.test.js` — CA-01 a CA-11.
- `tests/unit/registroPublico.test.js` — sumar RN-01/RN-02.
- Unit del alcance generalizado — que el preceptor resuelva exactamente lo mismo que antes.
- `tests/smoke/specs.js` — CA-12 a CA-22, con su prefijo `secretaria-` para poder correrlos con `--only`.
- `tests/roles/check-roles.js` — CA-23.
- Las tres suites completas en verde antes del push, más `verificar:arbol` sobre el árbol commiteado.

## Dependencias y riesgos

- **Escritura en el camino caliente (`middleware/auth.js`).** Todo pedido autenticado pasa por
  ahí. Se mitiga con D3: solo dentro del throttle de `lastSeen` (como mucho 1 por minuto por
  usuario), solo personal (no alumnos), sin `await`, y con upsert idempotente. Costo
  esperado: un puñado de escrituras por docente por día.
- **Índice nuevo en `RoomPresence`** sobre la base de producción (ver plan de migración).
- **Suplantación** (RN-14): limitación conocida.
- **Los datos de S3/S4 dependen de que cada ruta audite.** Las rutas que publican o corrigen
  sin `logAudit` no cuentan. El tester tiene que listar los caminos que crean actividades
  (crear, desde plantilla, desde la sala en vivo, carga masiva) y verificar que todos
  auditen; el que no lo haga es un arreglo aparte, se anota y no se resuelve dentro de esta spec.
- **Carpeta local con cambios sin commitear.** La implementación se hace en un worktree sobre
  `origin/main`, como el cambio del 11/11.

## Plan de migración

Cambio **aditivo**:

- Dos colecciones nuevas, que se crean solas con el primer documento.
- Campos de `User` existentes: no se tocan documentos.
- ⚠️ **Toca la base de producción:** el índice `{ user: 1, firstSeenAt: -1 }` en
  `roompresences` lo crea Mongoose al arrancar. Antes del deploy hay que ver el tamaño de la
  colección (`db.roompresences.countDocuments()`); si es grande, crear el índice a mano fuera
  del horario escolar. **Se avisa antes del deploy**, como dice la regla del proyecto.

## Preguntas abiertas — resueltas al aprobar (2026-11-11)

Walter aprobó la spec con las propuestas del arquitecto:

1. **Anotaciones:** las leen la secretaria, el directivo y el admin. **El docente no** (RN-13).
2. **Aviso a los docentes:** decisión de la escuela, fuera del código. El texto de ayuda de la
   pantalla es neutral: explica de dónde sale cada dato y que "sin registro" no significa ausencia.
3. **"Inició sesión"** = "entró a la plataforma ese día", con primera y última hora (D3).
4. **Varias secretarias por escuela**, cada una con su alcance.

## Ajustes durante la implementación (2026-11-11)

Cambios respecto de la versión aprobada, todos para reducir riesgo:

- **D1:** no se generalizó `loadPreceptorScope`; se reutiliza sin tocarlo.
- **Contrato:** `limitesDelDia` pasó a `ventanaDelDia` + `esDelDia` (el patrón de
  `services/actividadesDelDia.js`). Se sumaron `esFecha`, `esFutura`, `diaAnterior`,
  `diaSiguiente`, `resumen` y `textoDeNota`. `señalesDelDocente` se escribe `senalesDelDocente`
  (sin ñ en el identificador) y ya no necesita `actividadACurso`.
- **RN-02:** también `GET /register` armaba la lista con `User.getRoles()` menos `admin`. Las
  cuatro (dos GET y dos POST) usan ahora `ROLES_AUTOREGISTRO`.
- **RN-14:** el ingreso no se registra durante una suplantación (`services/ingresoDiario.js`).
- **Lugares tocados de más:** `views/partials/header.ejs` (entrada "Docentes del día" en el menú
  lateral y "Inicio" en vez de "Clases"), `views/dashboard.ejs` (sin botón "Crear clase"),
  `tests/unit/jefaturaAcceso.test.js` (la tabla de 9 roles), `models/User.js`
  (`ROLES_CON_CURSOS_A_CARGO`, para no repetir `['preceptor', 'secretaria']` en el admin).
- **No se creó** `public/js/secretariaLinea.js`: la línea del día se dibuja del lado del servidor
  (`views/secretaria/_linea.ejs`) y no necesita JavaScript.
