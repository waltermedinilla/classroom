# SOE — Servicio de Orientación Escolar

Estado: **aprobada** (2026-08-18) · Módulo: `soe`

## Problema

El rol `soe` **ya existe y está vacío**. Está en el enum de `models/User.js:9`, se puede
asignar desde `/admin/users` y `/superadmin/users`, tiene nombre (`SOE`), color e ícono
(`psychology`), entra a las salas en vivo como staff (`services/liveRoom.js:107`) y hasta
tiene una nota en `views/superadmin/roles.ejs:189` que dice que todavía no tiene panel.
Hoy quien lo tiene aterriza en `/courses` con las solapas generales, exactamente igual que
un docente sin materias.

Lo que falta no es el rol: es **su trabajo**. El gabinete necesita registrar, por alumno:

- **cómo está** — el pulso a lo largo del tiempo, no una foto;
- **qué le pasa** — motivo de intervención, dificultades;
- **con qué cuenta** — fortalezas, intereses, a qué quiere dedicarse;
- **cómo se lo contiene** — estrategias acordadas con los docentes, qué funcionó y qué no;
- **si se lo derivó** a un servicio externo, y **qué dijo ese lugar** cuando lo atendió.

Hoy todo eso vive en un cuaderno o en un Word suelto. Y el dato más caro de conseguir —cómo
viene con la asistencia, las notas y las entregas— ya está en la base de la plataforma, pero
el SOE no tiene ninguna pantalla que se lo muestre junto.

`agente.md:1217` ya lo había marcado: *"el rol `soe` existe en el sistema pero está vacío"*, y
`futureGoal` es justamente el campo pensado para Orientación.

## Alcance

1. **Panel propio** en `/soe`, con su nav, igual que Preceptoría o Jefatura.
2. **Legajo por alumno**: situación, fortalezas, dificultades y estrategias de contención.
3. **Seguimiento cronológico**: entrevistas, observaciones, contactos con la familia,
   acuerdos con docentes — cada uno con fecha, autor y **cómo se lo vio**.
4. **Derivaciones externas**: a dónde, por qué, en qué estado está, y las **devoluciones**
   que ese lugar va dando.
5. **Panel "Cómo viene"**: asistencia, rendimiento, entregas y perfil del alumno, de solo
   lectura, armado con datos que la plataforma **ya tiene**.
6. **Confidencialidad configurable por escuela**, con el default cerrado.

### Fuera de alcance (decidido, no olvidado)

- **Adjuntos** (informes escaneados, certificados). Motivo técnico, no de producto: los
  adjuntos de hoy (`routes/activities.js:103`) van a disco con `diskStorage` y se sirven por
  una URL adivinable. Un informe psicológico de un menor **no puede vivir ahí**. Necesita una
  ruta propia con guarda de lectura, y eso es una spec aparte.
- **Pedido de intervención del docente/preceptor** ("Derivar al SOE" desde la ficha del
  alumno). Decisión del usuario: en la v1 el legajo lo abre solo el SOE.
- **Alertas automáticas** de alumnos en riesgo sin legajo abierto.
- **Exportar el legajo a PDF** y mensajería con la familia.

## Decisiones de diseño

### D1 — La confidencialidad NO se resuelve con `config/sections.js`

El sistema de solapas por rol es **restrictivo y fail-open**: solo puede QUITAR lo que los
middlewares ya conceden, y todo lo que no está explícitamente denegado pasa. Es la elección
correcta para una solapa de "Materias", y la equivocada para una historia clínica: acá el
default tiene que ser **cerrado**, y la configuración tiene que **agregar** acceso, no quitarlo.

Por eso el acceso al contenido del legajo vive en un campo nuevo y explícito de la escuela:

```js
// models/School.js
soeAccess: {
  directivo: { type: String, enum: ['none','resumen','completo'], default: 'none' },
  admin:     { type: String, enum: ['none','resumen','completo'], default: 'none' },
  preceptor: { type: String, enum: ['none','resumen'],            default: 'none' },
  teacher:   { type: String, enum: ['none','resumen'],            default: 'none' },
}
```

- Escuela sin el campo (todas las de hoy) → **todos en `none`**: solo el SOE. Sin migración.
- `preceptor` y `teacher` no pueden llegar a `completo` ni configurándolo: el enum no lo
  admite. Es un techo duro, no una decisión de pantalla.
- Va **fuera** de `settings` por el mismo motivo que `rolePermissions` (ver el comentario en
  `models/School.js:64`): `settings` lo edita el admin de la escuela desde `/admin/tasks`, y
  el admin no puede ser quien se habilita a sí mismo a leer legajos.
- Igual que `settings` y `rolePermissions`: **hay que sumarlo al `.select()` de `server.js`**
  que arma `res.locals.school`, o el campo nunca llega y la guarda queda muda.

Lo configura el **superadmin** desde `/superadmin/roles`, en una tarjeta nueva "Orientación
Escolar (SOE)" — el mismo lugar donde hoy hay una nota diciendo que el rol no tiene panel.

### D2 — Los tres niveles

| nivel | qué ve | quién |
|-------|--------|-------|
| `none` | ni la solapa. El panel `/soe` responde 403. | default de todos |
| `resumen` | que el alumno **tiene legajo abierto**, su estado, la prioridad, las **fortalezas** y las **estrategias de aula**. Y que hay una derivación en curso — sin destino. | configurable |
| `completo` | todo, en modo lectura. | configurable, solo `directivo`/`admin` |

`resumen` es exactamente lo que un docente necesita para dar clase mejor ("este chico
funciona con consignas cortas y se le pide que las lea en voz alta") **sin** enterarse del
diagnóstico ni de lo que pasa en la casa. Es la línea que separa acompañar de chusmear.

**Escribir lo escribe siempre y solo el SOE.** Nadie más, ni el superadmin. Un legajo firmado
por el dueño técnico de la plataforma no significa nada y ensucia la responsabilidad
profesional de lo que quedó escrito.

### D3 — El superadmin ve, pero deja rastro

`superadmin` entra siempre (mismo criterio que `config/sections.js`: no se auto-bloquea, y
además tiene la base entera con `mongosh`). La compensación es que **toda lectura de un
legajo por alguien que no es el SOE queda auditada** con `soe.view_case`. No es una
restricción, es un registro — que es lo único honesto que se puede ofrecer acá.

### D4 — Alcance de alumnos: fail-**open** deliberado

`middleware/soe.js` invierte la regla de `preceptor.js` y `jefatura.js`:

```
soe sin assignedDivisions   → TODA su escuela
soe con assignedDivisions   → solo esas divisiones
directivo/admin/superadmin  → toda la escuela (si soeAccess se lo permite)
usuario sin escuela         → nada
```

Los otros dos paneles son fail-closed porque el rol se asigna por caminos que no preguntan
por divisiones (cambio de rol en lote), y "vacío = todas" les entregaría la escuela por
omisión. Acá **eso es justamente lo que se quiere**: el gabinete es uno solo por escuela y
mira a todos. La opción de acotar existe para las escuelas con dos gabinetes por turno.

El riesgo es acotado y hay que dejarlo dicho: lo que gana un `soe` sin configurar es el
**listado de alumnos de su propia escuela** — no los legajos ajenos, porque los legajos los
escribe él mismo.

⚠️ Un alumno **no tiene división propia**: se deduce de `Course.division` de las materias
donde está en `Course.students` (ver `services/attendance.js:184`). Por lo tanto:

- `alumnoEnScope()` resuelve las divisiones **actuales** del alumno con una query, nunca
  contra el snapshot guardado en el legajo;
- `SoeCase.division` es un **snapshot** para poder listar y filtrar sin joins, y se refresca
  al abrir o editar el legajo. Nunca es la fuente de verdad de la autorización.

## Modelo

Una sola colección nueva: `models/SoeCase.js`. Las entradas y las derivaciones van
**embebidas**, no en colecciones aparte, porque:

1. un legajo se lee siempre entero — es una historia, no una tabla que se pagina;
2. el volumen es de decenas de entradas por alumno, no miles (lejos del límite de 16 MB);
3. y sobre todo: con un solo documento, la regla de confidencialidad es **una sola guarda**.
   Con tres colecciones habría tres lugares donde olvidarse de aplicarla.

```js
SoeCase {
  student:   ObjectId → User    // required, único
  school:    ObjectId → School  // required
  division:  ObjectId → Division | null   // SNAPSHOT (ver D4)

  estado:    'abierto' | 'seguimiento' | 'cerrado'   // default 'abierto'
  prioridad: 'baja' | 'media' | 'alta'               // default 'media'

  motivo:       String  // por qué se abrió           max 500
  fortalezas:   String  // con qué cuenta             max 1000
  dificultades: String  // qué le cuesta              max 1000
  estrategias:  String  // cómo contenerlo en el aula max 2000

  entries:   [SoeEntry]
  referrals: [SoeReferral]

  openedBy:  ObjectId → User    openedAt: Date
  closedBy:  ObjectId → User    closedAt: Date | null   cierreMotivo: String
  lastEntryAt: Date | null      // denormalizado, para ordenar la lista sin abrir cada legajo
}

SoeEntry {                                   // el seguimiento
  fecha:  Date                               // la del hecho, NO la de carga
  tipo:   'entrevista' | 'observacion' | 'familia' | 'acuerdo_docente' | 'seguimiento' | 'nota'
  animo:  'bien' | 'altibajos' | 'preocupante' | null    // "cómo se encuentra"
  texto:  String  max 4000
  autor:  ObjectId → User
  createdAt / editedAt
}

SoeReferral {                                // la derivación externa
  destino:  String  max 200                  // "Hospital Zonal — Salud Mental"
  tipo:     'salud_mental' | 'fonoaudiologia' | 'psicopedagogia' | 'neurologia'
          | 'servicio_social' | 'equipo_orientacion' | 'otro'
  motivo:   String  max 1000
  fecha:    Date                             // cuándo se derivó
  contacto: String  max 200                  // referente del lugar
  estado:   'derivado' | 'con_turno' | 'en_tratamiento' | 'sin_respuesta'
          | 'no_asistio' | 'alta' | 'cerrado'
  proximoSeguimiento: Date | null            // cuándo volver a preguntar
  devoluciones: [{ fecha, texto (max 2000), registradoPor → User, createdAt }]
}
```

**Índices**: `{ student: 1 }` único (un legajo por alumno, para siempre — se reabre, no se
duplica), `{ school: 1, estado: 1, prioridad: 1 }` para el resumen, `{ division: 1 }` para
el alcance acotado, y `{ 'referrals.proximoSeguimiento': 1 }` para la solapa Derivaciones.

**Cambio en la base de producción**: colección nueva + campo nuevo en `School`. Los dos son
**aditivos**: ninguna escuela ni ningún usuario existente necesita migración, y el
comportamiento de todo lo que ya está cargado no cambia. Igual va avisado antes de pushear.

## Pantallas

Router `routes/soe.js` montado en `/soe`, con
`router.use(requireAuth, requireSoe, sectionGuard('soe'), loadSoeScope)`.

| ruta | qué es |
|------|--------|
| `GET /soe` | **Resumen**. Contadores (legajos abiertos, en seguimiento, derivaciones sin devolución, seguimientos vencidos) y la lista de legajos ordenada por prioridad y última novedad. |
| `GET /soe/alumnos` | **Alumnos**. Buscador por nombre y DNI, filtro por división, chip "tiene legajo". Es la puerta para abrir uno nuevo. |
| `GET /soe/legajo/:studentId` | **La ficha**. Cuatro solapas: Situación · Seguimiento · Derivaciones · Cómo viene. |
| `GET /soe/derivaciones` | **Derivaciones** de toda la escuela con su estado, resaltando las que están sin respuesta o con el seguimiento vencido. Es la pantalla que evita que un chico derivado se pierda. |

Escrituras (todas solo para `soe`): `POST /soe/legajo/:studentId` (abrir),
`PATCH /soe/legajo/:id/situacion`, `POST /soe/legajo/:id/entrada`,
`PATCH|DELETE /soe/legajo/:id/entrada/:entryId`, `POST /soe/legajo/:id/derivacion`,
`PATCH /soe/legajo/:id/derivacion/:refId`, `POST /soe/legajo/:id/derivacion/:refId/devolucion`,
`POST /soe/legajo/:id/cerrar` y `/reabrir`.

### Solapa "Cómo viene" — todo dato que ya existe

| bloque | de dónde sale |
|--------|---------------|
| Asistencia últimos 30 días y del ciclo | `AttendanceMark`, índice `{ student: 1, date: -1 }` que ya existe |
| Promedio por materia | `Submission.grades[].points` — **filtrando `points != null`**, que es la devolución sin nota |
| Entregas pendientes y fuera de término | `Activity` + `Submission`, misma regla que `/activities/my-pending` |
| Última conexión | `User.lastSeen` |
| Intereses, presentación y a qué quiere dedicarse | `User.interests`, `User.bio`, `User.futureGoal` |

No inventa ni calcula un "índice de riesgo": muestra los números y deja el juicio donde
corresponde.

### Catálogo de solapas (`config/sections.js`)

```js
{ key: 'soe_dashboard',    panel: 'soe', label: 'Resumen',      icon: 'psychology', path: '/soe',              roles: ['soe','directivo','admin','superadmin'], locked: true },
{ key: 'soe_alumnos',      panel: 'soe', label: 'Alumnos',      icon: 'group',      path: '/soe/alumnos',      roles: ['soe','directivo','admin','superadmin'] },
{ key: 'soe_derivaciones', panel: 'soe', label: 'Derivaciones', icon: 'share',      path: '/soe/derivaciones', roles: ['soe','directivo','admin','superadmin'] },
```

`soe_dashboard` va `locked` por la INVARIANTE de `config/sections.js`: es el destino del
redirect de `/` para el rol. Y `server.js:614` suma
`if (user.role === 'soe') return res.redirect('/soe');`.

Que `directivo`/`admin` figuren en `roles` **no les da acceso**: `sectionGuard` solo puede
quitar. Quien decide si entran es `requireSoe` leyendo `School.soeAccess` (D1). Están en la
lista para que la pantalla de `/superadmin/roles` pueda pintarles la celda.

## Criterios de aceptación

### Reglas puras (`tests/unit/soeAcceso.test.js`)

1. Escuela **sin** `soeAccess` → `nivelAcceso(school, 'directivo')` devuelve `'none'`; ídem
   `admin`, `preceptor` y `teacher`.
2. `nivelAcceso(school, 'soe')` devuelve `'completo'` siempre, aunque la escuela no tenga el
   campo.
3. `nivelAcceso(null, 'soe')` (usuario sin escuela) devuelve `'none'`.
4. `soeAccess.preceptor = 'completo'` guardado a mano en la base se lee como `'resumen'`: el
   techo del rol no depende de que la pantalla haya validado bien.
5. `puedeEscribir(role)` es `true` **solo** para `'soe'` — incluido `superadmin` en `false`.
6. `camposVisibles(nivel)` con `'resumen'` devuelve `estado`, `prioridad`, `fortalezas`,
   `estrategias` y el booleano `tieneDerivacionActiva`, y **no** devuelve `motivo`,
   `dificultades`, `entries` ni el detalle de `referrals`.
7. El sanitizado de `'resumen'` se verifica sobre un legajo con entradas y derivaciones
   cargadas: el objeto resultante no contiene ninguno de esos textos en ninguna profundidad.

### Alcance (`tests/unit/soeScope.test.js`)

8. `soe` sin `assignedDivisions` → alcance = todas las divisiones de su escuela.
9. `soe` con `assignedDivisions` → solo esas; un alumno de otra división da `false` en
   `alumnoEnScope()`.
10. Las divisiones asignadas se filtran **siempre** por escuela: una división que quedó
    pegada de la escuela anterior no entra al alcance.
11. `alumnoEnScope()` resuelve las divisiones **actuales** del alumno: si al alumno lo
    cambiaron de división después de abrirle el legajo, manda la nueva, no el snapshot.
12. Un alumno de **otra escuela** da `false` aunque su id se pase a mano en la URL.
13. `directivo` con `soeAccess.directivo != 'none'` → alcance = toda la escuela, sin importar
    `assignedDivisions`.

### Servidor

14. `GET /soe` con rol `soe` → 200. Con `student`, `teacher`, `jefe` y `preceptor` (escuela
    en default) → **403**.
15. `GET /soe` con `directivo` y escuela en default → **403**. Con
    `soeAccess.directivo = 'resumen'` → 200.
16. `GET /soe/legajo/:studentId` con `directivo` en `'resumen'` devuelve la ficha **sin**
    `motivo`, `dificultades`, entradas ni derivaciones: se verifica sobre el HTML, no solo
    sobre el objeto.
17. Todo `POST`/`PATCH`/`DELETE` de `/soe/*` con un rol que no es `soe` → **403**, incluido
    `superadmin` y incluido `directivo` en nivel `'completo'`.
18. `POST /soe/legajo/:studentId` sobre un alumno fuera del alcance → 403, y **no** crea el
    documento.
19. Abrir un legajo que ya existe **no duplica**: devuelve el existente (el índice único es
    la última red, pero la ruta no debe llegar a chocarlo).
20. Cerrar y reabrir conserva entradas y derivaciones; cerrar exige motivo.
21. Un alumno **nunca** ve nada: no hay ruta de `/soe` accesible con rol `student`, y el
    legajo no aparece en `/courses/profile` ni en el perfil que ven docentes y preceptores.
22. Cada apertura de legajo por un rol distinto de `soe` queda auditada como `soe.view_case`
    con el id del alumno. La del propio SOE **no** se audita: es su trabajo diario y llenaría
    la auditoría de ruido.
23. Quedan auditadas `soe.case_open`, `soe.case_close`, `soe.entry_add`, `soe.referral_add`
    y `soe.referral_update`, todas registradas en `config/audit-actions.js`.

### Interfaz

24. El nav del panel (`views/partials/soe-nav.ejs`) pinta las tres solapas según `can()`,
    igual que los demás paneles.
25. En nivel `'resumen'` la ficha no dibuja los formularios de escritura ni las solapas
    Seguimiento y Derivaciones — no alcanza con que el POST responda 403.
26. **Todas** las fechas se imprimen con `fmt` en el servidor y con `Fecha` en el navegador.
    Ni un `toLocaleDateString` suelto (regla de zona horaria del proyecto).
27. La línea de tiempo del seguimiento ordena por `fecha` (la del hecho), no por `createdAt`:
    una entrevista del martes cargada el viernes va en su lugar.
28. Una derivación `sin_respuesta` o con `proximoSeguimiento` vencido se resalta en la ficha
    y en `/soe/derivaciones`.
29. La pantalla se ve bien en teléfono: sin scroll horizontal, tablas con
    `overflow-x: auto`, y los 8 patrones de la revisión móvil respetados.

### Matriz de roles

30. `tests/roles/check-roles.js` pasa a esperar `soe → '/soe'` con panel `'soe'`
    (hoy espera `/courses` con panel `'app'`), y `soe` sigue **sin** entrar a `/admin`,
    `/directivo`, `/preceptor`, `/jefatura` ni `/superadmin`.
31. Las tres suites en verde: `npm run test:smoke`, `npm run test:roles` y los unitarios.

### Fecha de repaso del legajo (agregado el 2026-08-26)

Hasta acá, la única fecha que hacía sonar una alarma era `referrals[].proximoSeguimiento`: es
lo que alimenta el panel *"necesitan que alguien pregunte"*. Un chico al que el gabinete
acompaña **sin derivarlo a ningún lado** no tenía ninguna fecha, así que se enfriaba sin que
nada avisara — el legajo quedaba abierto y en silencio. `SoeCase.proximoRepaso` cierra ese
hueco reusando la misma regla y el mismo panel.

32. **`SoeCase.proximoRepaso`** (`Date`, default `null`): cuándo volver a mirar este legajo.
    Un documento sin el campo es un legajo sin repaso pedido — **no hay migración**, los
    legajos que ya existen siguen comportándose igual que antes.
33. **`legajoNecesitaRepaso(legajo, ahora)`** vive en `services/soeAcceso.js` y es pura: `true`
    solo si el legajo **no** está cerrado y `proximoRepaso <= ahora`. Sin fecha, `false`.
    Es la hermana de `derivacionNecesitaAtencion` y compara igual que ella (una fecha de hoy
    ya cuenta como vencida: un `<input type="date">` llega como medianoche).
34. El campo es de nivel **`completo`**: `sanitizarLegajo` no lo expone en `'resumen'`. La
    agenda interna del gabinete no es lo que un docente necesita para dar clase, y el
    criterio 7 (nada clínico en el HTML del nivel resumen) se mide sobre el objeto
    serializado.
35. Se carga desde **dos formularios, con reglas distintas y a propósito**:
    - **Situación** es el editor completo del legajo: el campo vacío **borra** la fecha, igual
      que el resto de los campos de ese formulario;
    - **una entrada del seguimiento** solo la **pisa si viene con fecha**. Ahí vacío significa
      "no cambies nada": es el campo que más se va a dejar en blanco, porque se anota una
      entrevista sin querer tocar la agenda. Que anotar una observación borre la fecha de
      repaso sería una pérdida de dato silenciosa.
36. El resumen (`GET /soe`) lista los legajos con el repaso vencido **en el mismo panel** que
    las derivaciones, en su propia tabla, y suma la tarjeta *"Para volver a ver"*. Las dos
    cosas **solo en nivel `completo`**, por el criterio 34.
37. La ficha muestra la fecha como chip en la cabecera: en aviso si todavía falta, en alerta
    si ya venció. En el formulario de Situación se edita con un `<input type="date">`.
38. **Cerrar un legajo no borra la fecha**, pero un legajo cerrado nunca aparece en el panel
    (criterio 33). Si se reabre con la fecha ya vencida, vuelve a la lista — que es
    exactamente lo que se quiere: alguien tiene que mirarlo.

## Archivos

**Nuevos**: `models/SoeCase.js` · `middleware/soe.js` · `routes/soe.js` ·
`services/soeAcceso.js` (las reglas puras de D1/D2, compartidas por rutas y vistas) ·
`services/soeIndicadores.js` (el "Cómo viene") · `views/soe/{index,alumnos,legajo,derivaciones}.ejs` ·
`views/partials/soe-nav.ejs` · los tres archivos de test.

**Tocados**: `models/School.js` (`soeAccess`) · `server.js` (mount, `.select()` de la escuela,
redirect de `/`) · `config/sections.js` (3 secciones + panel) · `config/audit-actions.js`
(6 acciones) · `views/superadmin/roles.ejs` (tarjeta nueva, reemplaza la nota del `:189`) ·
`tests/roles/check-roles.js` · `agente.md`.

## Preguntas abiertas

Ninguna bloqueante. Dos que se pueden responder al implementar:

- ¿La solapa Alumnos lista **todos** los alumnos de la escuela o solo los que tienen legajo,
  con el resto detrás del buscador? Con 800 alumnos la primera opción es una pantalla
  inservible. Propuesta: **buscador primero**, y debajo los legajos abiertos.
- ¿`prioridad` se muestra como color o como texto? Propuesta: chip de color con el texto al
  lado — un legajo no es un semáforo y el color solo no se lee bien en impresión.
