# Visibilidad de actividades — actividad programada + botón de ojo

Estado: **aprobada** (2026-08-18) · Módulo: `activities`

## Problema

El docente prepara con anticipación la actividad de una clase futura. Hoy la carga
queda publicada de inmediato: el alumno la ve apenas se guarda, aunque sea para el
martes que viene.

El campo `Activity.availableFrom` ("Disponible desde") ya existía y **el backend ya
filtraba** las actividades futuras para el alumno, pero:

- el **docente no veía en ninguna parte** que la actividad estuviera programada — en su
  lista se ve igual que una publicada, así que la feature era invisible y nadie la usaba;
- no había forma de **adelantar o retirar** una publicación sin editar la fecha a mano.

## Alcance

1. La actividad cuya "Disponible desde" es futura le figura al docente como
   **deshabilitada**, y se publica sola cuando llega esa fecha.
2. Un **botón de ojo** en la tarjeta le permite al docente forzar el estado contrario:
   mostrarla ya, u ocultar una que ya estaba visible.

Fuera de alcance: notificaciones al alumno al publicarse, programar el cierre, y
programar por fecha las novedades (`Announcement`).

## Modelo

`Activity.visibleOverride: Boolean, default: null` — override manual del docente:

| valor              | significado                                                    |
|--------------------|----------------------------------------------------------------|
| `null` / ausente   | **automático**: visible cuando `availableFrom <= ahora`         |
| `true`             | visible ya, aunque `availableFrom` sea futura                   |
| `false`            | oculta, aunque `availableFrom` ya haya pasado                   |

`null` es el default y es también lo que leen los documentos históricos (que no tienen
el campo): **el comportamiento de todo lo que ya está cargado no cambia.**

## Regla única

Vive en `public/js/visibilidadActividad.js` (se carga como `<script>` en `course.ejs`,
se `require()` desde las rutas y desde los tests). Una sola fuente de verdad: el mismo
archivo decide qué ve el alumno en el servidor y qué chip dibuja el navegador.

```
estadoVisibilidad(act, ahora):
  visibleOverride === true   → 'visible'
  visibleOverride === false  → 'oculta'
  availableFrom > ahora      → 'programada'
  si no                      → 'visible'
```

El ojo **no cicla entre tres estados**: invierte el estado efectivo, y si con eso alcanza
volver al automático, borra el override (`null`) en vez de fijarlo. Así el docente ve un
interruptor de dos posiciones y **la fecha programada nunca se pierde**.

## Criterios de aceptación

### Regla pura (`tests/unit/visibilidadActividad.test.js`)

1. `availableFrom` futura y sin override → `'programada'`; no la ve el alumno.
2. `availableFrom` pasada y sin override → `'visible'`.
3. Documento histórico sin el campo `visibleOverride` → se lee como automático.
4. `visibleOverride: true` con `availableFrom` futura → `'visible'` (el ojo gana).
5. `visibleOverride: false` con `availableFrom` pasada → `'oculta'` (el ojo gana).
6. Llegada la fecha, la programada pasa sola a `'visible'` sin tocar la base.
7. El ojo sobre una programada devuelve `true`; el segundo click devuelve `null`
   (vuelve al automático, conservando la fecha), no `false`.
8. El ojo sobre una visible por fecha devuelve `false`; el segundo click, `null`.
9. El filtro de Mongo acepta exactamente los mismos documentos que la función pura
   (se verifica con documentos de prueba evaluados contra las dos implementaciones).

### Servidor

10. `GET /activities/course/:id` como alumno no devuelve las programadas ni las ocultas.
11. Ese filtro **convive** con el de `enrollmentDates` (las dos condiciones se combinan
    con `$and`; antes las dos peleaban por la misma clave `$or`).
12. `GET /activities/my-pending` y el resumen de pendientes del dashboard aplican la
    misma regla.
13. `POST /activities/:id/submit` rechaza con 403 la entrega a una actividad que el
    alumno no debería estar viendo (defensa por si llega por link directo).
14. `PATCH /activities/:id/toggle-visibility` solo lo puede llamar quien administra el
    curso (403 en otro caso) y queda auditado como `activity.toggle_visibility`.
15. El docente sigue viendo **todas** sus actividades, programadas y ocultas incluidas.

### Interfaz del docente

16. La tarjeta de una actividad no visible se muestra atenuada, con chip
    "Programada · <fecha>" o "Oculta".
17. El botón de ojo aparece **solo** en la vista del docente, y su ícono refleja el
    estado (`visibility` cuando se ve, `visibility_off` cuando no).
18. Al crear o editar, elegir una "Disponible desde" futura avisa en el formulario que
    la actividad va a quedar programada.
