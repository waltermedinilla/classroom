# La tarea entregada sale de lo pendiente

Estado: **aprobada** (2026-08-24) · Módulo: `activities` · Rol: alumno

## Problema

Palabras del usuario:

> *"cuando una tarea ya se entrega tiene que salir de las que ya están pendientes, porque
> si no se juntan cosas que ya hiciste"*

Y tenía razón en dos pantallas de la materia, las dos del alumno:

1. **La tarjeta de la solapa Actividades** le decía **`Pendiente`** a algo que ya había
   entregado, y si el plazo había pasado le ponía un candado **`Vencida`** encima. El
   estado se calculaba con `myGrade` y `dueDate` y nada más: hasta que el docente no
   corregía, la tarea entregada era indistinguible de la que no se hizo.
2. **"Próximas entregas"**, la tarjeta del sidebar de Novedades, listaba las actividades
   con fecha futura sin preguntar si ya estaban entregadas. Medido sobre el espejo local
   el 2026-08-24: **24 entregas vivas** seguían figurando ahí como si faltaran.

La causa de las dos era la misma y estaba en el servidor: `GET /activities/course/:id` le
mandaba al alumno su nota (`myGrade`) pero **nada sobre su propia entrega**. El navegador
no tenía con qué contestar la pregunta, así que no la hacía.

**Lo que ya estaba bien y no se tocó:** el cartel del inicio (*"Tenés N tareas
pendientes"*) y la pantalla **Mis pendientes** descuentan las entregadas desde siempre
(`submittedSet` en `routes/courses.js` y `routes/activities.js`). El problema era solo la
pantalla de la materia.

## Alcance

`GET /activities/course/:id` le agrega a cada actividad, **solo para el alumno**:

```js
obj.mySubmission = entregadaEl ? { at: entregadaEl } : null;   // firstSubmittedAt || createdAt
```

Una sola consulta por carga de la solapa, sobre el índice único `{ activity, student }` de
`Submission`. Va **la fecha y nada más**: los archivos y el texto de la entrega siguen
saliendo por `GET /activities/:id/my-submission`, que es lo que abre el modal de detalle.

Con ese dato:

- el chip de la tarjeta pasa a **`Entregada`** (verde azulado, ícono `check_circle`);
- la fecha de la tarjeta pasa a decir **`Entregado: 19/8`** en lugar de `Venció: 20/8` en
  rojo — al que ya entregó, el plazo dejó de ser su problema;
- la actividad **sale de "Próximas entregas"**;
- todo eso pasa **en el acto al entregar**, sin recargar la página, por los dos caminos de
  entrega: el formulario de archivos y el runner de las actividades interactivas.

**Fuera de alcance:** esto decide cómo se **muestra** la actividad. No cambia quién puede
entregar (sigue mandando `allowLateSubmissions` en `POST /activities/:id/submit`), no
saca la actividad de la solapa Actividades (sigue estando, con su chip nuevo), y no toca
la regla de caducidad de `pendienteActividad.js` ni el legajo del SOE.

## Regla única

Vive en `public/js/estadoActividad.js`, hermana de `visibilidadActividad.js` y
`pendienteActividad.js`, por el mismo motivo: la misma pregunta se hace en dos lugares
(el chip y "Próximas entregas") y no puede divergir entre ellos.

**El orden ES la regla:**

```
calificada  >  entregada  >  vencida  >  tardía  >  pendiente
```

| estado         | cuándo                                                        |
|----------------|---------------------------------------------------------------|
| **calificada** | `myGrade.points != null`. Le gana a todo, incluso sin entrega: el docente puede corregir en papel y cargar la nota a mano. Una devolución escrita **sin nota** (`points: null`) NO es calificada. |
| **entregada**  | `mySubmission != null`. Le gana al plazo: si ya entregué, que la fecha haya pasado es un dato del plazo, no de mi estado. |
| **vencida**    | `dueDate` pasada y tardías cerradas.                          |
| **tardía**     | `dueDate` pasada y tardías abiertas.                          |
| **pendiente**  | todo lo demás — incluida la que no tiene fecha de entrega.     |

`esProximaEntrega(act)` = tiene `dueDate` futura **y** no está entregada. La visibilidad
(actividad programada) no se pregunta ahí: de eso se ocupa `visibilidadActividad.js`, que
`course.js` aplica antes. Una regla, un archivo.

## Criterios de aceptación

1. Entregar una actividad con plazo vencido deja el chip en `Entregada`, no en `Vencida`
   ni en `Tardía`.
2. Entregar una actividad con plazo futuro la saca de "Próximas entregas" sin recargar.
3. Una devolución escrita sin nota no la da por calificada.
4. `GET /activities/course/:id` devuelve `mySubmission` para el alumno, con `at`, y nunca
   los archivos ni el texto de la entrega.
5. `GET /activities/course/:id` **no** devuelve `mySubmission` al docente (que ya tiene su
   propio `submittedCount`).
6. El chip nuevo llega a 4,5:1 de contraste en tema claro y en oscuro.

## Trampas

1. **El chip tiene fondo fijo, así que tiene que declarar su color de texto en hex.** Es
   el bug de 1,10:1 del chat de la sala: una pastilla con `background` fijo y sin `color`
   hereda `var(--text)` y en tema oscuro queda texto claro sobre fondo claro. Los dos
   temas declaran fondo y color en hex, y `tests/unit/estadoActividad.test.js` **calcula**
   el ratio — no se mira a ojo, que es lo que ya falló una vez.
2. **`reemplazarTarjetaActividad()` llamaba siempre a la constructora del docente.** No se
   notaba porque solo lo usaban flujos de docente; desde que el alumno redibuja su tarjeta
   al entregar, respeta `window.IS_OWNER` igual que `loadActivitiesTab()`.
3. **Hay DOS caminos de entrega**, y los dos crean `Submission`: el formulario de archivos
   (`submitWork` en `course.js`) y el runner de las interactivas (`task-runner.js`). Los
   dos llaman a `window.marcarActividadEntregada()`. En la preview del superadmin el
   runner no recibe `activityId` ni `submission`, así que ahí no corre.
4. **El módulo se carga en `course.ejs` ANTES de `course.js`.** Si va después,
   `EstadoActividad` es `undefined` y la solapa Actividades no dibuja nada. Hay un test
   que compara las posiciones de los dos `<script>`.

## Tests

- `tests/unit/estadoActividad.test.js` — la matriz de estados, "Próximas entregas", el
  cableado (que el servidor mande el campo y que la vista cargue el módulo en orden) y el
  contraste del chip en los dos temas.
- `tests/smoke/specs.js` → `entrega-sale-de-pendientes` — de punta a punta contra el
  servidor: `mySubmission` en null, entregar, `mySubmission` con fecha, y la actividad
  fuera de "Mis pendientes".
