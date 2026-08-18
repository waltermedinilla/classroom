# Actividad desde la clase en vivo + "Actividades del día" de preceptoría

> **Estado: APROBADA por el usuario el 2026-08-12** (plan aprobado antes de escribir código).
>
> Tres decisiones cerradas con el usuario ese día — no reabrirlas sin él:
>
> 1. **Cuenta cualquier actividad del día**, no solo la creada desde la sala. El botón del chat
>    es un atajo para crearla, no una categoría aparte. Una materia que subió la tarea por el
>    camino de siempre figura igual como "subió".
> 2. **Un calendario por curso** (división), con selector arriba — mismo criterio que la solapa
>    Asistencia, que también trabaja curso por curso.
> 3. **El vínculo con la clase es un aviso en el chat**, no una marca en la actividad. Sin chip
>    "creada en clase" en la tarjeta.
>
> Consecuencia directa de las tres: **no hay campo nuevo en `models/Activity.js`, ni migración,
> ni índice nuevo**. Toda la feature se apoya en `createdAt`, que ya existe.
>
> **Agregado el 2026-08-12, a pedido del usuario**: el aviso del chat lleva un botón
> **"Ver actividad"** que abre la actividad. Eso sí suma un campo —`activity` en
> `models/RoomMessage.js`, opcional, sin índice y sin backfill— y un link directo
> `/courses/:id?actividad=<id>`. Ver la sección "El botón Ver actividad" al final.
>
> Se implementa en dos partes mergeables por separado:
> **Parte 1 — el botón de la sala**. Se puede usar sola.
> **Parte 2 — la solapa del preceptor**. No depende de la 1 (lee actividades, sin importar de
> dónde salieron).

## Objetivo

Que la docente pueda **dejar la consigna mientras da la clase**, sin salir de la sala en vivo: un
botón al lado del chat, el mismo formulario de siempre, y la actividad queda en la solapa
**Actividades** de esa materia como cualquier otra.

Y que preceptoría pueda ver, **día por día en un calendario del mes**, qué materias de su curso
dejaron actividad y cuáles no — en vez de tener que entrar materia por materia.

## Responsabilidades

- Definir **desde dónde** se puede crear una actividad en la sala y **quién** puede hacerlo.
- Definir **qué queda registrado en la clase** cuando se crea una actividad desde ahí.
- Definir qué significa **"la materia subió actividad ese día"** y en qué zona horaria se decide.
- Definir el **alcance** del preceptor sobre este calendario.

## No responsabilidades

- **No** crea un tipo nuevo de actividad. Lo que se crea es un `Activity` normal: mismo modelo,
  misma solapa, mismas entregas, misma calificación, mismo borrado.
- **No** decide qué materias *deberían* haber subido actividad. El sistema no tiene horario
  escolar: no hay dato de qué materias tienen clase un martes. El panel del día lista **todas** las
  materias de la división partidas en "subieron" / "no subieron". Ponerle expectativa a eso es
  justamente lo que el usuario dejó para después ("eso se configurará después").
- **No** toca la asistencia. Que una materia no haya subido actividad no dice nada sobre si hubo
  clase, y esta pantalla no debe sugerir lo contrario.
- **No** agrega permisos de escritura al preceptor: la solapa nueva es de **solo lectura**.

## Entidades/Schemas

Ninguna colección nueva. Un solo campo nuevo, opcional (`RoomMessage.activity`).

| Archivo | Qué se usa |
|---|---|
| `models/Activity.js` | `course`, `author`, `title`, `type`, `createdAt`. **Sin campos nuevos.** |
| `models/RoomSession.js` | la sesión abierta del curso (`closedAt: null`), para saber a qué chat avisar. |
| `models/RoomMessage.js` | el aviso va como mensaje `kind: 'system'`, igual que "se abrió la sala". **Campo nuevo `activity`** (ref, opcional, default `null`, sin índice): a qué actividad apunta el aviso. Los mensajes viejos quedan en `null` y se pintan como siempre. |
| `models/Course.js` | `division`, `name`, `owner` — las materias del curso del preceptor. |

### `services/actividadesDelDia.js` (nuevo)

- `mesDeDivision(divisionId, mes)` → `{ mes, totalMaterias, porDia: { 'YYYY-MM-DD': { materias, actividades } } }`
- `diaDeDivision(divisionId, dia)` → `{ dia, totalMaterias, subieron: [...], noSubieron: [...] }`

`porDia` es un **objeto indexado por fecha**, no un array: la vista lo consulta celda por celda
al pintar la grilla, y un array la obligaría a buscar en cada una. (Esta línea decía
`dias: [{ dia, materias, actividades }]` hasta el 2026-08-17; era la spec la que había quedado
vieja, no el código.)

Las dos toman la zona horaria de `services/liveRoom.js` (`TZ`, `diaEscolar`, `hora`). **No se
instancia un segundo `Intl.DateTimeFormat` en este archivo**: la zona de la escuela tiene un solo
dueño, y un segundo formateador en otro lado es exactamente cómo volvió el bug de las tres horas
de más (ver el comentario de `TZ` en `liveRoom.js`).

> **Desde el 2026-08-17 este archivo también sirve al panel Directivo.** La solapa
> "Actividades Diarias" (`specs/directivo-actividades-diarias.spec.md`) reusa la misma regla
> RN-05 sobre un rango de fechas y toda la escuela, en vez de un mes y una división. La regla de
> qué cuenta como actividad tiene que seguir siendo **una sola** acá adentro: si alguna de las dos
> pantallas necesita una variante, va como parámetro, no como copia.

### `config/sections.js` — entrada nueva

```js
{ key: 'preceptor_actividades', panel: 'preceptor', label: 'Actividades del día',
  icon: 'calendar_month', path: '/preceptor/actividades',
  roles: ['preceptor', 'directivo', 'admin', 'superadmin'] }
```

Configurable (sin `locked`): apagarla no deja a nadie afuera del panel, porque el destino del
redirect de "/" sigue siendo `preceptor_dashboard`.

### Vistas

| Archivo | Cambio |
|---|---|
| `views/preceptor/actividades.ejs` | **nueva**: calendario del mes + panel del día al costado. |
| `views/partials/preceptor-nav.ejs` | link nuevo, con `puede('preceptor_actividades')`. |
| `views/partials/live-room.ejs` | botón "Crear actividad", botón "Ver actividad" del aviso, y `window.lrRefrescar`. |
| `views/rooms/session.ejs` | el mismo botón "Ver actividad" en la transcripción de la clase archivada. |
| `views/course.ejs` | pasa `enLaMateria` al include del partial. |
| `public/js/course.js` | `abrirActividad(id)` + el link directo `?actividad=<id>`. |

## Entradas

### Sala en vivo
- **Botón "Crear actividad"** en la barra de acciones de la sala. Abre el modal que la materia ya
  tiene (`#activityModal` de `views/course.ejs`), que estaba sin punto de entrada desde que el "+"
  flotante pasa a `/activities/new`. No hay formulario nuevo. Único faltante respecto del
  formulario de página completa: las plantillas de tareas.
- `POST /activities/create` acepta un campo más, opcional: `fromRoom` (`'1'`). El resto del body
  no cambia.

### Panel del preceptor
- `GET /preceptor/actividades?division=<id>&mes=YYYY-MM` — la pantalla. Sin `division`, la primera
  del alcance; sin `mes`, el mes en curso.
- `GET /preceptor/actividades/:divisionId/dia/:fecha` — el detalle del día, en JSON.

## Salidas

### `GET /preceptor/actividades/:divisionId/dia/:fecha`

```json
{
  "dia": "2026-08-12",
  "totalMaterias": 9,
  "subieron": [
    { "materia": "Matemática", "docente": "PÉREZ, Ana",
      "actividades": [{ "titulo": "TP de fracciones", "tipo": "tp", "hora": "10:24", "autor": "PÉREZ, Ana" }] }
  ],
  "noSubieron": [ { "materia": "Historia", "docente": "GÓMEZ, Luis" } ]
}
```

## Reglas de negocio

- **RN-01 — Lo que se crea es una actividad normal.** Mismo `POST /activities/create`, mismo
  modelo, misma validación de permiso (`course.canManage`). Si mañana se saca el botón de la sala,
  las actividades que salieron de ahí siguen siendo indistinguibles del resto, y eso está bien.
- **RN-02 — El botón es solo para quien gestiona la materia**, y solo donde el modal existe. El
  partial de la sala lo usan dos contenedores: la solapa de la materia (`views/course.ejs`, que
  tiene el modal) y la página suelta (`views/rooms/standalone.ejs`, por donde entran dirección y
  preceptoría, que no lo tiene). Sin el flag `enLaMateria`, el botón abriría la nada.
  El permiso real lo sigue chequeando el servidor: esconder un botón no es un permiso.
- **RN-03 — El aviso en el chat lo decide el servidor, no el cliente.** El id de la sesión **no**
  se toma del body: se resuelve con la sesión abierta de ese curso. Si no hay sala abierta, no hay
  aviso y la actividad se crea igual — crear una actividad no exige estar en clase.
- **RN-04 — El aviso nunca voltea la creación.** Va después del `Activity.create` y con su propio
  try/catch: si falla escribir en el chat, la actividad ya existe y la respuesta es 201 igual.
  Quedarse sin la actividad porque no se pudo avisar sería el peor canje posible.
- **RN-05 — "Subió actividad ese día" = tiene al menos un `Activity` con `createdAt` en ese día
  escolar.** No importa `availableFrom` ni `dueDate`: la pregunta del preceptor es "¿el docente
  dejó trabajo?", que es un hecho del día en que lo cargó.
- **RN-06 — El día se decide en la zona horaria de la escuela**, con `live.diaEscolar`. Producción
  corre en UTC: una actividad cargada 21:30 de Buenos Aires es del día siguiente en UTC, y
  aparecería en la celda equivocada. Es el mismo criterio con el que se archiva la asistencia.
- **RN-07 — El alcance del preceptor manda en cada request.** Toda ruta con `:divisionId` valida
  `inScope(req, ...)`. Que un curso no esté en el selector no impide escribir el id en la URL.
- **RN-08 — La solapa es de solo lectura.** Ni un POST. El preceptor mira producción docente; no
  crea, edita ni borra actividades de nadie.
- **RN-09 — Los días futuros no se pueden abrir.** No hay nada que responder sobre mañana, y un
  panel vacío se lee como "no subieron".

## Casos de uso

1. **La consigna en el momento.** La docente está en la sala, explica el trabajo y lo deja cargado
   ahí mismo: botón → modal → crear. La clase ve el aviso en el chat y la actividad en su solapa.
2. **El preceptor a fin de semana.** Abre el calendario de 3°2°, ve que el martes solo 2 de 9
   materias dejaron actividad, toca el día y ve cuáles fueron.
3. **El preceptor busca un día puntual.** Un padre pregunta qué se dio el 6 de agosto: toca ese día
   y tiene las materias con el título de cada actividad y la hora.

## Criterios de aceptación

### Parte 1 — la sala
- **CA-01** Con la sala abierta y siendo docente de la materia, la barra de la sala muestra
  "Crear actividad".
- **CA-02** Un alumno en la misma sala no ve el botón.
- **CA-03** En `/courses/:id/sala` (página suelta, dirección/preceptoría) el botón no se renderiza.
- **CA-04** El botón abre el modal de creación ya existente, con sus adjuntos y links.
- **CA-05** Creada la actividad, aparece en la solapa **Actividades** de esa materia sin recargar.
- **CA-06** Con la sala abierta y `fromRoom`, el chat recibe un mensaje `kind: 'system'` con el
  título de la actividad, y se ve sin esperar el poll siguiente.
- **CA-07** Sin sala abierta, `fromRoom` no rompe nada: se crea la actividad y no hay aviso.
- **CA-08** Sin `fromRoom` (el camino de siempre, desde el FAB) no se escribe nada en ningún chat.
- **CA-09** El aviso queda en la transcripción de la clase (`/courses/:id/sala/clases/:sid`).

### Parte 2 — la solapa
- **CA-10** El preceptor ve "Actividades del día" en su nav, entre "En vivo" y el resto.
- **CA-11** La pantalla abre en el mes en curso y en el primer curso del alcance.
- **CA-12** Cada día con actividad muestra `n/total materias`; los días sin actividad, nada.
- **CA-13** Al tocar un día, el panel lateral lista "Subieron" (materia, docente, título, hora) y
  "No subieron" (materia, docente).
- **CA-14** El total de "subieron" + "no subieron" es igual a la cantidad de materias del curso.
- **CA-15** Cuenta igual una actividad creada desde la sala que una creada desde el FAB.
- **CA-16** Una división fuera del alcance devuelve 403, tanto en la pantalla como en el JSON.
- **CA-17** Un preceptor sin cursos a cargo cae en `preceptor/no-scope`.
- **CA-18** Denegar `preceptor_actividades` desde `/superadmin/roles` la saca del nav **y**
  devuelve 403 en `/preceptor/actividades`. Reponerla la devuelve.
- **CA-19** Un día futuro no es clickeable.
- **CA-20** Una actividad cargada 21:30 hora de Buenos Aires cae en el día en que se cargó, no en
  el siguiente.

## Errores posibles

| Situación | Respuesta |
|---|---|
| `fromRoom` sin sala abierta | 201, actividad creada, sin aviso (RN-03) |
| Falla el aviso al chat | 201, actividad creada, se registra el error (RN-04) |
| `:divisionId` fuera del alcance | 403 `Acceso denegado` (HTML o JSON según el `Accept`) |
| `:fecha` mal escrita | 400 `Fecha inválida` |
| `mes` mal escrito | se ignora y se usa el mes en curso |
| Preceptor sin escuela o sin cursos | `preceptor/no-scope`, como el resto del panel |

## Tests necesarios

- **Smoke** (`tests/smoke/specs.js`): crear con `fromRoom` con la sala abierta deja el mensaje de
  sistema y la actividad listada en `GET /activities/course/:id`; el preceptor ve el detalle del
  día de su curso y recibe 403 en una división ajena.
- **Matriz de roles** (`tests/roles/check-roles.js`): la sección nueva sale del catálogo, así que
  entra sola en el recorrido de los 8 roles. Sumarla a la lista de toggles del paso 6.

## Dependencias

- `services/liveRoom.js` — `TZ`, `diaEscolar`, `hora`, `systemMessage`.
- `middleware/preceptor.js` — `loadPreceptorScope`, `inScope`.
- `middleware/sections.js` — `sectionGuard('preceptor')`, que ya está montado en el router.

## Riesgos de refactorización

- **`routes/activities.js` pasa a conocer la sala.** Es un `require` nuevo de `services/liveRoom` y
  `models/RoomSession` en un router que hoy no sabe nada de salas. Se acota a un bloque con su
  propio try/catch dentro de `POST /create` (RN-04): si mañana se saca el botón, se borra ese
  bloque y no queda nada colgado.
- **Rendimiento del mes.** El `$match` es `course: { $in: [...] }` + rango de `createdAt`, y una
  división tiene ~10 materias: el índice `{ course: 1, availableFrom: 1 }` que ya existe cubre el
  prefijo. **No se agrega índice**. Si con el uso real se nota, `{ course: 1, createdAt: -1 }` es
  el candidato, y hay que avisar antes de pushearlo porque construye en producción.

## El botón "Ver actividad" (agregado 2026-08-12)

El aviso del chat trae un botón chico que lleva a la actividad. Es lo que convierte al aviso en
algo accionable: hasta ahora el alumno leía "se creó la actividad X" y tenía que ir a buscarla.

- **RN-10 — El id viaja como dato, no dentro del texto.** `RoomMessage.activity` es una ref. La
  alternativa —meter la URL en el texto del mensaje— obligaría a parsear el mensaje para pintar
  el botón, y cualquier cambio de rutas rompería los avisos ya guardados. El texto es lo que se
  lee (y lo que queda en la transcripción y en el CSV); el link es otra cosa.
- **RN-11 — La URL la arma el servidor** (`serializarMensaje` en `routes/rooms.js`), igual que la
  hora: el formato de las rutas de la app lo decide un solo lugar.
- **RN-12 — El botón solo se pinta para quien puede abrir la materia.** El link va a
  `/courses/:id`, que es exactamente lo que dirección y preceptoría no pueden abrir. Un botón que
  lleva a un 403 es peor que no tenerlo; el aviso se sigue leyendo igual, sin botón. El criterio
  se resuelve distinto en cada pantalla porque el dato disponible es distinto:
  - **sala en vivo** → `locals.enLaMateria`: la sala embebida en `views/course.ejs` la ven solo
    docentes y alumnos del curso; la página suelta (`views/rooms/standalone.ejs`) es la de
    dirección y preceptoría.
  - **transcripción archivada** (`views/rooms/session.ejs`) → `puedeAbrirMateria`, que el
    servidor calcula como `esGestor || esAlumno`. Ahí las dos audiencias comparten la MISMA
    vista, así que el contenedor no alcanza como criterio.
- **RN-13 — Un mensaje borrado no lleva botón.** El hueco en la conversación se lee como hueco.
- **RN-14 — Con JS, el botón NO recarga**: la solapa "En vivo" y la de Actividades son la misma
  página, así que abre el detalle ahí mismo y no saca a nadie de la clase. Es un `<a href>` de
  verdad igual —teclado, botón derecho, "abrir en pestaña nueva"—, con el mismo patrón que la
  lupa de las imágenes: el link es el respaldo y el handler es el comportamiento normal.
- **RN-15 — El link directo `/courses/:id?actividad=<id>`** abre la solapa Actividades y el
  detalle al cargar la página. Sirve al botón cuando el JS no llegó a interceptarlo, y es
  compartible.
- **RN-16 — Si la actividad no está, se dice.** Borrada, o programada con "disponible desde" a
  futuro (el listado del alumno la filtra): se avisa "Esa actividad ya no está disponible" en vez
  de abrir un modal vacío.

**Criterios de aceptación**
- **CA-21** El aviso de una actividad trae el botón; el de "se abrió la sala", no.
- **CA-22** El alumno toca el botón y se abre el detalle de esa actividad, sin recargar y sin
  salir de la página.
- **CA-23** El mismo botón funciona para la docente (abre su vista del detalle).
- **CA-24** En `/courses/:id/sala` (página suelta) el aviso se lee sin botón.
- **CA-24b** En la transcripción de una clase archivada el aviso lleva el botón para el docente y
  para el alumno, y NO lo lleva para preceptoría ni dirección.
- **CA-25** Un título con `<b>` se muestra literal: el aviso pasa a `innerHTML` para poder llevar
  el botón, así que el texto va escapado sí o sí.
- **CA-26** Entrar directo a `/courses/:id?actividad=<id>` abre esa actividad.
- **CA-27** Un id que no existe avisa y no abre nada.

## Plan de migración

Ninguno. `RoomMessage.activity` es opcional y sin índice: los mensajes que ya están en la base
quedan en `null` y se pintan exactamente como antes. Sin backfill, sin colecciones nuevas y sin
tocar `Activity`. Se despliega y funciona sobre los datos que ya están.
