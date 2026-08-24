# Pendientes que caducan solos — el alumno deja de ver tareas que ya expiraron

Estado: **aprobada** (2026-08-23) · Módulo: `activities`

## Problema

Al alumno le figuraban como "tareas para entregar" actividades que habían expirado
hacía semanas. El cartel del inicio le decía *"Tenés 15 tareas pendientes"* mezclando
lo que vence mañana con lo que el docente dejó tirado en julio, y el aviso perdía todo
su valor: si siempre dice un número grande, no avisa nada.

El filtro que había (repetido en dos lugares, `routes/courses.js` y
`routes/activities.js`) era este:

```js
if (!a.dueDate)                  return true;   // ← nunca deja de ser pendiente
if (new Date(a.dueDate) >= now)  return true;
if (a.allowLateSubmissions)      return true;   // ← nunca deja de ser pendiente
return false;
```

Las dos líneas marcadas son **dos formas distintas de quedar pendiente para siempre**.
Medido sobre el espejo local el 2026-08-23, de 674 actividades:

| caso                                             | cuántas | antigüedad máxima |
|--------------------------------------------------|---------|-------------------|
| sin fecha de entrega                              | 68      | 29 días           |
| vencidas con "entregas tardías habilitadas"       | 45      | 24 días vencidas  |

Son 113 actividades (17 % del total) que ningún alumno iba a poder sacarse nunca de
encima, porque no dependían de él: dependían de que el docente volviera a entrar a
poner una fecha o a cerrar las tardías, y eso no pasa.

## Alcance

Cada actividad **caduca sola** como pendiente. La política son dos números, elegidos
por el usuario el 2026-08-23:

1. **Sin fecha de entrega** → cuenta como pendiente **15 días desde que se publica**.
2. **Vencida con tardías abiertas** → cuenta como pendiente **14 días después del
   vencimiento** (dos semanas de gracia para el que se atrasó).
3. **Vencida sin tardías** → deja de contar en el vencimiento. Es lo que ya hacía.

Y la lista de "Mis pendientes" queda **ordenada por urgencia**: lo que vence primero arriba,
las que no tienen fecha de entrega al final. Venía al revés — ver más abajo.

**Fuera de alcance, y es importante:** esto decide qué se **cuenta** como pendiente, no
qué se puede **entregar**. Que caduque el pendiente no le cierra la puerta a nadie:

- la actividad sigue estando en la solapa **Actividades** del curso, con su chip de
  siempre (`Pendiente` / `Vencida` / `Tardía`);
- `POST /activities/:id/submit` sigue decidiendo con `allowLateSubmissions` como
  siempre — si el docente dejó las tardías abiertas, el alumno puede entregar el día 90;
- el legajo del SOE (`services/soeIndicadores.js`) **no usa** esta regla y no debe
  usarla: ahí "pendiente" significa "esto nunca lo entregó" y las vencidas tienen que
  seguir contando. Son dos preguntas distintas sobre la misma palabra.

## Regla única

Vive en `public/js/pendienteActividad.js`, hermana de `public/js/visibilidadActividad.js`
y con el mismo envoltorio (`require()` desde las rutas y desde los tests). Las dos
ventanas son las dos únicas constantes de la feature:

```
DIAS_SIN_FECHA = 15
DIAS_TARDIAS   = 14

caducaEl(act):
  sin dueDate    → (availableFrom || createdAt) + 15 días
  con tardías    → dueDate + 14 días
  sin tardías    → dueDate

sigueSiendoPendiente(act, ahora):  ahora < caducaEl(act)
```

Dos decisiones que no son obvias:

- **La cuenta de los 15 días arranca en `availableFrom`, no en `createdAt`.** El docente
  que carga el domingo una actividad programada para el martes tiene que estrenar sus 15
  días el martes. `createdAt` es solo el respaldo para documentos viejos sin el campo.
- **Un documento sin fecha de entrega NI fecha de publicación se deja pendiente.**
  `caducaEl` devuelve `null` y `sigueSiendoPendiente` devuelve `true`. Antes que hacer
  desaparecer una tarea por una fecha inventada, se prefiere el falso positivo.

### El orden de la lista

`porUrgencia(a, b)`, en el mismo archivo, es el comparador de "Mis pendientes":

```
con fecha los dos  → la que vence antes
solo una con fecha → la que tiene fecha, primero
ninguna con fecha  → la publicada antes (la más cerca de caducar de la lista)
```

Estaba mal y es un detalle de Mongo: `sort({ dueDate: 1 })` ordena los `null` **antes** que
cualquier fecha, así que la lista arrancaba con las tareas sin plazo y empujaba para abajo lo
que vencía mañana — exactamente al revés de para qué se abre la pantalla. El orden se decide
ahora en JS, después de filtrar; la query solo pide un orden estable para los empates.

**No se ordena por `caducaEl()`**, aunque sea tentador tener un solo criterio: una sin fecha
publicada hace 14 días caduca mañana y se treparía al primer puesto, arriba de una tarea que
vence mañana. La caducidad es tarea de la lista, no un plazo que el alumno tenga que atender.

La regla es **temporal pura**: no escribe nada. Las 113 actividades del diagnóstico
caducan al desplegar sin tocar un solo documento, y una actividad que hoy caducó vuelve
a figurar sola si el docente le pone una fecha de entrega futura.

## Criterios de aceptación

### Regla pura (`tests/unit/pendienteActividad.test.js`)

1. Sin fecha de entrega, publicada hace 14 días → sigue pendiente.
2. Sin fecha de entrega, publicada hace 16 días → ya no.
3. El corte de la sin-fecha se cuenta desde `availableFrom`, no desde `createdAt`
   (misma actividad, creada mucho antes de publicarse → los 15 días arrancan al
   publicarse).
4. Sin `availableFrom` (documento histórico) se cae a `createdAt` y caduca igual.
5. Sin fecha de entrega y sin ninguna de las dos fechas → queda pendiente (`caducaEl`
   devuelve `null`).
6. Con fecha de entrega futura → pendiente, con tardías y sin tardías.
7. Vencida sin tardías → no pendiente, aunque haya vencido hace un minuto.
8. Vencida con tardías hace 13 días → todavía pendiente.
9. Vencida con tardías hace 15 días → ya no.
10. La misma actividad, sin tocar la base, deja de ser pendiente sola al avanzar el
    reloj a través del corte.
11. Las fechas se aceptan como `Date` y como string ISO (que es como llegan por JSON).

### Servidor

12. El contador del inicio (`GET /courses`) no cuenta las actividades caducadas.
13. `GET /activities/my-pending` no las lista.
14. Las dos pantallas usan la MISMA función: un alumno con actividades caducadas ve el
    mismo número en el cartel del inicio y en la lista de "Mis pendientes".
15. La actividad caducada **sigue apareciendo** en `GET /activities/course/:id` para el
    alumno: no desaparece de la materia, solo del pendiente.
16. Con las tardías abiertas, `POST /activities/:id/submit` sigue aceptando la entrega
    de una actividad ya caducada como pendiente.
17. Las reglas previas siguen valiendo y se combinan con esta: no cuenta lo ya
    entregado, ni lo programado/oculto (`visibilidadActividad.js`), ni lo que venció
    antes de que el alumno se matriculara (`enrollmentDates`).

### Orden de la lista (`porUrgencia`)

18. Entre dos con fecha de entrega, va primero la que vence antes.
19. Las **sin fecha van al final**, nunca al principio (el bug del `null` de Mongo).
20. Una vencida con las tardías abiertas encabeza la lista: es la que está por perderse.
21. Entre las sin fecha, primero la publicada antes.
22. **No** se ordena por caducidad: una sin fecha a punto de caducar no se trepa por encima
    de una tarea con fecha de entrega más lejana.
23. `GET /activities/my-pending` devuelve el HTML en ese orden (se verifica de punta a punta
    en el smoke, comparando la posición de las dos actividades en la página).
