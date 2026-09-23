# El alumno que se va a hacer la actividad no está ausente

Estado: **aprobada** (2026-09-23), las tres fases, con las propuestas de P1–P4 · Módulo: `rooms` (+ `attendance` en la Fase 3) · Rol: alumnos, docente, preceptoría

> **Implementada el 2026-09-23** (las tres fases). Lo que salió distinto de lo escrito abajo:
>
> 1. **`salaConfirmada`** (`views/partials/live-room.ejs`): en la página de la materia la sala
>    arranca pintada como "cerrada" sin haberle preguntado a nadie, y el poll solo corre con la
>    solapa a la vista. Con RN-4 al pie de la letra, el alumno que recarga parado en Actividades
>    no latía nunca. Mientras el poll no contestó, se late igual y el primer 409 lo apaga.
> 2. **El 409 del latido no pasa por `fallar()`**: es la respuesta normal a esa pestaña que no
>    sabe si hay clase; por `fallar()` dejaría un `warn` por alumno que abre la materia.
> 3. **Una sesión cerrada nunca es "ahora"** en la sugerencia a preceptoría (RN-9), aunque el
>    último ping sea de hace segundos. Lo encontró el smoke.
> 4. RN-11: la columna "Se retiró" **no se agregó** — es la "Último registro" que el CSV ya tenía.
>
> Tests: `tests/unit/salaPresenciaActividad.test.js`; smoke `sala-latido-alumno` y
> `attendance-sugerencia-clase-terminada`.

## Problema

Palabras del usuario:

> *"cuando un docente inicia una clase en vivo, y comienza su clase, los alumnos se van
> conectando y luego se retiran para hacer las actividades que planteó, pero cuando eso
> ocurre, al alumno figura como desconectado […] porque estuvo presente, y no quiero que por
> eso, siempre tenga ausente."*

Es el flujo normal de una clase: la docente explica en la sala, plantea la actividad (muchas
veces con "Crear actividad" desde la misma sala) y los chicos **se van a hacerla**. En ese
momento la sala los pinta igual que a los que **nunca entraron**.

## Diagnóstico (auditado antes de escribir)

### Por qué el alumno "se desconecta" sin haberse ido

El detalle de una actividad **se abre dentro de la misma página de la materia**
(`public/js/course.js:3169`), en otra solapa. La sala es un partial de esa página
(`views/course.ejs:346`) y su poll se corta en cuanto la solapa "En vivo" no está a la vista
(`aLaVista()`, `views/partials/live-room.ejs:1235`). A los **45 s** (`ONLINE_WINDOW_MS`) el
alumno sale de `conectados` y pasa a `ausentes`.

El personal no tiene este problema desde el 13/08: tiene un **latido** de 20 s que sigue
corriendo fuera de la solapa (`live-room.ejs:1457`) y una ventana de 3 minutos. El alumno
**no lo tiene a propósito**, y el comentario lo explica: si latiera desde Novedades, el
"N de M presentes" dejaría de querer decir "está en la sala". **Esa regla se respeta en esta
spec**: la solución no es regalarle el latido del personal al alumno.

### Dónde se ve el "ausente", y dónde NO

| Lugar | ¿Qué dice hoy del que estuvo y se fue? |
|---|---|
| Círculos de la sala (`pintarPresencia`) | ❌ **Gris, con el título "sin conectarse"** — idéntico al que nunca entró. Es lo que ve la docente. |
| `presenceSummary()` | ❌ Lo pone en `ausentes`: la lista no distingue "se fue" de "no vino". |
| Sugerencia de la sala a preceptoría (`presentesEnSalasDeDivision`) | ❌ **Solo mira a los conectados AHORA** (`lastPingAt` ≥ 45 s) y **solo salas abiertas**. Si preceptoría pasa lista mientras el curso está haciendo la actividad, la sala no sugiere a nadie. Es por donde el "desconectado" termina en una **falta real** en la planilla. |
| Historial de la clase (`/sala/clases/:sid`) | ✅ Ya dice **presente** a todo el que tenga `RoomPresence` (`presente: !!p`). |
| CSV de asistencia (`csvAsistencia`) | ✅ Ya dice **Presente**. Lo que miente un poco son los *minutos*: solo cuenta el tiempo con la solapa de la sala a la vista. |

O sea: el registro de la clase ya es correcto. Lo que está mal es **la pantalla en vivo** —que
es la que mira la docente— y **la sugerencia a preceptoría**, que es la que puede convertirlo
en ausente de verdad.

`models/RoomPresence.js` ya lo dice en su encabezado: *"un documento con lastPingAt viejo
significa 'estuvo y ya no está', que NO es lo mismo"*. La base lo sabe; la pantalla no lo usa.

## Decisiones propuestas

- **D1 — Haber entrado a la clase es haber estado.** Un `RoomPresence` de la sesión basta para
  que el alumno no vuelva a figurar como "no entró" en esa clase, se quede 2 minutos o 80.
  La permanencia se informa (minutos), pero no decide el estado. Sin umbral mínimo: el juicio
  de "estuvo poco" es de la docente, no del sistema (ver P1).
- **D2 — Tres estados en la sala, no dos:**
  | Estado | Cuándo | Cómo se pinta |
  |---|---|---|
  | **En la sala** | ping del poll dentro de 45 s (como hoy) | anillo verde (como hoy) |
  | **En la actividad** | fuera de la sala, pero con la materia abierta (Fase 2) | anillo ámbar, título "trabajando en la materia" |
  | **Estuvo** | tiene presencia en la sesión, ninguna de las dos anteriores | contorno punteado, título "estuvo · se retiró a las HH:MM" |
  | **No entró** | sin `RoomPresence` en la sesión | gris (como hoy), título "no entró a la clase" |
- **D3 — El "N de M presentes" NO cambia de significado.** Sigue contando solo "en la sala
  ahora". Se le agrega al lado un segundo número: **"18 en la sala · 24 de 25 asistieron"**.
  Dos preguntas distintas, dos números; ninguno se infla con el otro.
- **D4 — El latido del alumno es OTRO dato, no el ping de la sala.** Escribe campos propios
  (`enMateriaAt`, `msEnMateria`) y **nunca** toca `lastPingAt` ni `msPresente`. Así el conteo
  en vivo, la ventana de 45 s y el cálculo de permanencia en la sala quedan exactamente como
  están (RN-3 de `sala-en-vivo-escala.spec.md` incluido).
- **D5 — El latido del alumno no mantiene viva la sala.** No toca `lastActivityAt`. El
  autocierre sigue midiendo "sala vacía" con la docente adentro o afuera; si la docente se fue
  30 minutos, la clase terminó, aunque los chicos sigan trabajando. Evita resucitar las salas
  fantasma de `salas_fantasma_autocierre`.
- **D6 — La sala sigue sugiriendo, nunca marca.** Decisión cerrada del 10/08
  (`asistencia-preceptoria.spec.md`). Esta spec amplía **a quién** se sugiere, no el
  mecanismo: la marca la sigue poniendo el preceptor con un click.

## Reglas de negocio

- **RN-1** — `presenceSummary()` devuelve, además de `conectados` y `ausentes`, una lista
  `estuvieron: [{ id, nombre, inicial, avatar, seRetiro, enActividad }]` con los alumnos del
  roster que tienen presencia en la sesión y no están en la ventana de 45 s. `ausentes` pasa a
  ser **solo** los que no tienen `RoomPresence`. `presentes` no cambia. Se agrega
  `asistieron = presentes + estuvieron.length`.
- **RN-2** — `seRetiro` es el `lastPingAt` (la última vez que tuvo la sala a la vista), ya
  formateado con `fmt` en la zona de la escuela (ver `zona_horaria_fmt`).
- **RN-3** — La huella de presencia (`huellaDePresencia`, RN-2 de escala) incluye `estuvieron`
  y `enActividad`: si no, el cambio "se fue a la actividad" no se repintaría nunca.
  ⚠️ Pero la huella **no** puede incluir `seRetiro` en minutos relativos ("hace 3 min"), o
  cambiaría en cada vuelta y RN-2 de escala dejaría de ahorrar. Viaja la hora absoluta.
- **RN-4 (Fase 2)** — Mientras la sesión esté abierta y el alumno tenga **la página de esa
  materia** abierta con la solapa de la sala **no** a la vista, el partial manda un latido
  cada **60 s** a `POST /courses/:id/sala/latido`. Con la sala a la vista no late (ya pollea).
  Con la pestaña del navegador oculta **tampoco late**: "tiene la materia abierta en una
  pestaña de fondo" no es "está trabajando" (ver P2).
- **RN-5 (Fase 2)** — El latido actualiza `RoomPresence.enMateriaAt` y acumula
  `msEnMateria` con la misma regla pura que `decidirPing` (tramos topeados, nunca
  `último − primero`), en una función hermana `decidirLatido` con reloj inyectable. Escribe
  como máximo una vez por minuto por alumno.
- **RN-6 (Fase 2)** — El latido **solo actualiza** un `RoomPresence` que ya existe: no hace
  upsert. Un alumno que nunca entró a la sala y tiene la materia abierta **no** pasa a
  "estuvo" por latir. Estar en la clase empieza por entrar a la clase.
- **RN-7 (Fase 2)** — "En la actividad" = `enMateriaAt` dentro de **3 minutos** (la ventana
  del personal, `STAFF_ONLINE_WINDOW_MS`, por el mismo motivo: tolerar un latido perdido).
- **RN-8 (Fase 2)** — El endpoint verifica lo mismo que el poll: alumno matriculado, sesión
  abierta de esa materia. Responde `204` sin cuerpo. Tiene su propio limiter (no comparte cupo
  con el poll: ver `monitor_ratelimit`, el techo real es 2× por los dos workers).
- **RN-9 (Fase 3)** — La sugerencia a preceptoría se amplía a **"asistió hoy a una clase en
  vivo de este curso"**: sesiones de la división con `openedAt` en el `diaEscolar()` de hoy,
  abiertas o cerradas, con `RoomPresence` del alumno. Se distingue en la grilla:
  - *"Está ahora en Matemática"* (conectado, como hoy)
  - *"Estuvo en Matemática, 8:05 – 8:40"* (nuevo)
- **RN-10 (Fase 3)** — La query de RN-9 arranca por `{ school, … }` para usar un índice
  existente; si hace falta `{ school, division, openedAt }` se agrega y se justifica en el
  modelo. Se consulta en el poll de la grilla (cada 15 s por preceptor): no puede ser un scan.
- **RN-11** — El historial de la clase y el CSV suman la columna **"Minutos en la materia
  (fuera de la sala)"** con `msEnMateria`, y **"Se retiró"** con `lastPingAt`. El estado sigue
  siendo *Presente* / *Ausente* como hoy. Documentos anteriores sin `msEnMateria` → vacío, no
  0: no se inventa un dato que no se midió (mismo criterio que `msPresente`).

## Criterios de aceptación

### Fase 1 — La sala deja de mentir (cero pedidos nuevos)

- **CA-1** — Dado un alumno que polleó y dejó de pollear hace 60 s, entonces aparece en
  `estuvieron` y **no** en `ausentes`; `presentes` no lo cuenta y `asistieron` sí.
- **CA-2** — Dado un alumno del roster sin `RoomPresence`, entonces aparece en `ausentes` y en
  ninguna otra lista.
- **CA-3** — Dado un alumno conectado ahora, entonces está en `conectados` y no en
  `estuvieron` (no se cuenta dos veces en `asistieron`).
- **CA-4** — Dada una docente o preceptora con presencia vieja, entonces no aparece en
  `estuvieron` (el personal no es asistencia, igual que hoy).
- **CA-5** — Dado que un alumno pasa de conectado a "estuvo", entonces la huella de presencia
  cambia; dados dos polls seguidos sin cambios de estado, la huella es la misma (RN-3).
- **CA-6** — En la pantalla, el círculo de un alumno que "estuvo" no tiene la clase `lr-off`
  ni el título "sin conectarse"; lleva "estuvo · se retiró a las HH:MM".
- **CA-7** — El cartel muestra los dos números ("N en la sala · M de T asistieron") en la
  sala del docente. Test de string: los textos viven en el módulo, no sueltos en el partial
  (lección del 11/09 en `asistencia_preceptoria`).

### Fase 2 — "En la actividad"

- **CA-8** — Dado un alumno con presencia en la sesión que late con la solapa fuera de vista,
  entonces `enMateriaAt` se actualiza y `lastPingAt` **no cambia**; `msPresente` tampoco.
- **CA-9** — Dado un alumno **sin** `RoomPresence` que late, entonces no se crea ningún
  documento (RN-6) y responde `204` igual (no se le da señal de nada).
- **CA-10** — Dados dos latidos a 20 s, entonces se escribe uno solo (RN-5).
- **CA-11** — Dado un hueco de 10 minutos entre latidos, entonces `msEnMateria` acredita como
  máximo la ventana, no los 10 minutos (misma regla que CA de `decidirPing`).
- **CA-12** — Dado un alumno de **otra** materia o una sesión cerrada, entonces `403` / `409`
  y ninguna escritura.
- **CA-13** — Con `enMateriaAt` hace 2 min el alumno figura "en la actividad"; hace 4 min,
  "estuvo".
- **CA-14** — Dado un latido, entonces `RoomSession.lastActivityAt` **no cambia** (D5).
- **CA-15** — Smoke: la matriz de roles confirma que docente, preceptoría y dirección **no**
  laten por este camino (ellos ya tienen el suyo).

### Fase 3 — Preceptoría

- **CA-16** — Dada una toma abierta y un alumno que estuvo en una sala del curso hoy, ya
  cerrada, marcado ausente, entonces aparece en la sugerencia con "Estuvo en <materia>,
  HH:MM – HH:MM".
- **CA-17** — Dada una sala de **ayer**, entonces no sugiere nada (el día sale de
  `diaEscolar()`, nunca de un `Date` local — trampa conocida de producción en UTC).
- **CA-18** — Aceptar la sugerencia deja la marca con `source: 'preceptor'`, como hoy.
- **CA-19** — El historial y el CSV traen las columnas nuevas; un documento sin `msEnMateria`
  deja la celda vacía (RN-11).

## Costo (lo que la sala se pasó cuatro RN cuidando)

- **Fase 1: cero.** Los datos ya vienen en el `find` de presencias del poll; solo cambia cómo
  se reparten en `presenceSummary`. La huella sigue ahorrando mientras nadie cambie de estado.
- **Fase 2: un pedido por minuto por alumno fuera de la sala**, contra 7,5–15 por minuto que
  hace cada uno dentro. Peor caso (toda la escuela afuera a la vez, 900 alumnos): 15 pedidos/s
  y 15 escrituras/s — un 3% del tráfico que la sala ya sostuvo el 14/09. Sin writes a
  `RoomSession`.
- **Fase 3:** una query más en el poll de la grilla del preceptor, acotada por índice.

## Fuera de alcance

- Que la sala **marque** asistencia sola (D6, decisión cerrada).
- Que la docente marque a mano "presente en mi clase": sería una segunda planilla de
  asistencia por materia, y la escuela ya tiene una sola oficial por curso y día.
- Medir actividad real (teclas, scroll): "tiene la materia abierta al frente" es lo más que se
  puede afirmar honestamente, y es lo que se afirma.
- Salas anteriores al deploy: ya tienen `RoomPresence`, así que la Fase 1 les aplica sola al
  mirarlas; la Fase 2 no tiene datos para ellas y no se inventan.

## Decisiones del usuario (2026-09-23)

*"aprobada, hacé las 3 fases con tus propuestas"*. Quedan cerradas así:

- **P1 → sin umbral.** Entrar a la clase cuenta; los minutos quedan a la vista (D1).
- **P2 → la pestaña del navegador oculta NO late** (RN-4). El que trabaja con la pestaña de
  fondo figura "estuvo", que tampoco es ausente.
- **P3 → las tres fases.**
- **P4 → alcanza con la sugerencia de la grilla.** Las tarjetas del panel de salas en vivo de
  preceptoría y dirección (`getOpenSessions`) no cambian: responden "¿qué pasa ahora en cada
  aula?", no "¿quién vino hoy?", y son la query más caliente de los dos paneles.

## Archivos que toca (estimado)

| Fase | Archivos |
|---|---|
| 1 | `services/liveRoom.js` (`presenceSummary`, huella), `routes/rooms.js` (payload del poll), `views/partials/live-room.ejs` (`pintarPresencia`, cartel), `public/css/style.css` (anillo "estuvo"), tests unitarios de `presenceSummary` y huella |
| 2 | `models/RoomPresence.js` (`enMateriaAt`, `msEnMateria`), `services/liveRoom.js` (`decidirLatido`, `touchLatidoAlumno`), `routes/rooms.js` (`POST /sala/latido` + limiter), `live-room.ejs` (latido del alumno), smoke |
| 3 | `services/attendance.js` (`presentesEnSalasDeDivision` → presentes de hoy), `routes/attendance.js` (`estadoDeToma`), vista de la grilla, `routes/rooms.js` + `csvAsistencia` (columnas) |

Sin cambios de esquema destructivos: los campos nuevos tienen default y los documentos viejos
se leen igual. No toca la base de producción más allá de los campos nuevos que empiezan a
escribirse.
