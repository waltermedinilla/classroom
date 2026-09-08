# La sala en vivo a escala: 30 salas de 30

Estado: **RN-1 IMPLEMENTADA** (2026-09-08) · RN-2, RN-3 y RN-4 siguen sin aprobar ·
Módulo: `rooms` · Rol: todos los de la sala

## Problema

Palabras del usuario:

> *"Necesito que redefinamos o reutilicemos lo necesario para que sea funcional la sala de chat
> en vivo. Porque tiene muchos problemas... deberá ser funcional para contener unas 30 salas en
> vivo, con 30 alumnos aproximadamente cada una, y dando utilidad para lo que fue creada. No le
> agregues código de más si no es necesario."*

**El objetivo de diseño**: 30 salas × 30 alumnos + su docente = **930 personas simultáneas**.
Es la mitad de la escuela adentro de una sala al mismo tiempo.

### ⭐ El objetivo NO es hipotético: ya pasó

Medido sobre las **334 sesiones** que hay en el espejo local:

| | Medido |
|---|---|
| **Pico de salas simultáneas** | **28**, el 2026-08-11 |
| **Sala más llena** | **31 personas** |
| Días más cargados | 68, 65, 60, 60 salas abiertas en la jornada |

**28 × 31 ≈ 868 personas.** El número que pidió el usuario no es una proyección optimista: es
un 7% por encima del pico que la plataforma ya atravesó. Y lo atravesó con el presupuesto de
abajo, que es justamente lo que esta spec viene a corregir — o sea que **la sala ya estuvo
funcionando en el peor punto de su curva de costo.**

⚠️ `RoomPresence` cuenta a todo el que pingueó alguna vez en esa sesión, no a los simultáneos.
El 31 es un techo, no un promedio. La proporción no cambia.

La sala no está rota de concepto: está pagando, 15 veces por minuto y por persona, el costo de
volver a averiguar cosas que no cambiaron. **Esta spec no cambia el transporte ni agrega
funcionalidad. Saca trabajo repetido del camino caliente.**

## El presupuesto de hoy, medido

Medido el 2026-09-08 contra el espejo local, sobre un curso real de **36 alumnos**
(`Ciencias Naturales`). Los tiempos son de la máquina de desarrollo, no del VPS: lo que importa
es la **proporción entre ellos**, que no cambia al mudarse.

| Qué | Medido |
|---|---|
| Queries de `cargarSala` por poll | **4** (`courses.findOne` + populate de `students`, `division`, `owner`) |
| Tiempo de `cargarSala`, en caliente | **11,4 ms** (mediana de 30; min 9,8 / máx 18,4) |
| El mismo curso sin populate, `lean()` | **2,6 ms** |
| Bloque de presencia que viaja en CADA poll | **4.981 bytes** |
| Ops de Mongo por poll (total) | **8** — 7 lecturas + **1 escritura** |

Las 8 son: `courses.findOne`, `users.find` (los 36 alumnos), `divisions.find`, `users.find`
(docente), `roomsessions.findOne`, `roompresences.updateOne` ← **escritura**,
`roommessages.find`, `roompresences.find`.

### Proyección al objetivo

⚠️ Esto es **aritmética sobre los costos unitarios de arriba**, no una prueba de carga. La
prueba de carga es el criterio de aceptación 1, y va antes de dar esto por bueno.

| | Hoy, a 930 personas |
|---|---|
| Requests | **232/s** (930 ÷ 4 s) |
| Ops de Mongo | **~1.860/s**, de las cuales **232 escrituras/s** |
| CPU solo de `cargarSala` | 232 × 11,4 ms = **~2,6 núcleos saturados** |
| Bajada solo del chat | 232 × 5 KB = **~1,16 MB/s ≈ 9,3 Mbit/s** |

**El 99% de esos bytes y de esas queries es volver a mandar una lista de alumnos que no cambió
en toda la hora.** Ahí está la spec entera.

⚠️ **Los 2,6 núcleos son el dato que decide la compra del VPS.** Sobre los 8 vCPU de hoy es un
tercio de la máquina; sobre los **4 vCPU** del plan de DonWeb dimensionado al consumo actual
(ver [[donweb-vs-contabo-costos]]) es **el 65%, solo para `cargarSala`**. Bajar este número es
lo que permite comprar la máquina chica.

## Lo que YA se arregló hoy y no entra acá

- **El congelamiento** (RN-1 corregida de `sala-poll-carrera.spec.md`): la sala se congelaba
  entera si el viaje tardaba más que el intervalo.
- **Los pedidos apilados** (RN-5 de esa misma spec): el `setInterval` fijo emitía **9 polls
  donde ahora salen 3**, y el servidor los atendía enteros para que el navegador tirara casi
  todos. Sin ese arreglo, todos los números de arriba se multiplican por 3 cuando la red se
  pone lenta — o sea, justo cuando peor viene.

Esta spec asume ese arreglo desplegado. **Sin él, nada de lo de acá alcanza.**

## Por qué NO son websockets (todavía)

Se evaluó y queda afuera, con los números a la vista. Un WebSocket sacaría los 232 req/s, pero:

- **No es ahí donde duele.** Duele el trabajo POR request, no la cantidad. Con RN-1 de esta
  spec, un poll pasa a costar menos que el `accept()` de la conexión que lo trae.
- **Cuesta las tres cosas que un poll no cuesta**: detectar la conexión muerta, reconectar con
  backoff y resincronizar por `seq`, contra el doble NAT de la escuela que mata conexiones
  ociosas. **El poll se cura solo; un WebSocket hay que curarlo a mano.**
- **Necesita un hub único** por los 2 workers de PM2: un mensaje que entra por el worker A no
  llega a quien está colgado del B. El patrón existe (`middleware/rtc-proxy.js`), pero es la
  mitad del trabajo.

**El umbral en el que sí conviene**: si después de esta spec el objetivo sube de ~930 a varios
miles, o si el chat pasa a necesitar latencia sub-segundo (no la necesita: es un chat de aula).
Hasta ahí, el poll con las cuatro reglas de abajo tiene margen de sobra.

## Alcance

**Se toca**: `routes/rooms.js` (el camino del poll), `services/liveRoom.js` (constantes y
resumen de presencia), `middleware/cache.js` (una entrada más), `views/partials/live-room.ejs`
(la cadencia del ciclo, que ya quedó parametrizable hoy).

**No se toca**: modelos, esquemas, índices, permisos, la UI de la sala, la transmisión, ni el
transporte. **Ninguna migración de base.**

---

## RN-1 · El curso del poll sale de un cache, no de la base

Es la regla que sostiene todas las demás: **11,4 ms → ~0**, y **4 de las 8 ops se van**.

`cargarSala` (`routes/rooms.js:122`) resuelve el curso entero con tres `populate` en cada poll.
Lo que trae —la lista de alumnos, la división, el nombre del docente— cambia cuando alguien
matricula a un chico, o sea unas pocas veces por semana. Se está resolviendo 15 veces por
minuto y por persona.

Se reutiliza `TTLCache` de `config/cache.js`, el mismo que ya sostiene `userCache` y
`schoolCache` (`middleware/cache.js`). Se agrega `courseCache`.

**TTL: 45 s**, el mismo que los otros dos y por el mismo motivo escrito ahí: el cache es
**por-worker**, así que un cambio de matrícula puede seguir sirviéndose viejo desde el OTRO
worker hasta que expire. Esa ventana ya es la que la app acepta hoy para roles y escuelas.

### ⚠️ La trampa: `Course.hydrate()` NO es la salida barata

El camino obvio —cachear el objeto plano (`lean()`, inmutable, seguro de compartir) y
reconstruir el documento con sus métodos— **no funciona, y falla en silencio**. Medido:

```
Course.hydrate(plano, undefined, { hydratedPopulatedDocs: true })
  → tieneCanManage:    true      ← los métodos vuelven
  → students:          UNDEFINED ← los populados NO
  → owner / division:  null
  → canManage(docente): FALSE    ← la docente pierde su propia sala
```

`canManage` y `canWatchLive` son **métodos del schema** (`models/Course.js:114` y `:167`) y leen
`owner`, `coTeachers` y `division`. Con los populados perdidos devuelven `false` **sin lanzar
ningún error**: el síntoma sería "a la profesora le dice Acceso denegado en su propia materia",
intermitente según qué worker atienda. Es exactamente la clase de bug que cuesta un día.

**Hay que elegir una de dos, y la spec pide que se elija explícitamente:**

- **(a) Cachear el documento hidratado tal cual.** 20 líneas, cero refactor. ⚠️ Es un objeto
  **mutable compartido** entre requests concurrentes: hoy es seguro (el único que lo toca es el
  `.sort()` de `cargarSala`, que es idempotente), pero alcanza un `req.course.algo = x` futuro
  en cualquier ruta para envenenar el cache de todos. Es la razón por la que `getCachedUser`
  usa `lean()` + copia (`middleware/auth.js:8`).
- **(b) Cachear `lean()` y mover `canManage`/`canWatchLive` a funciones puras.** Es el patrón
  que la casa ya eligió para las reglas de la sala —*"las reglas viven en `services/liveRoom.js`
  porque se componen entre ellas y porque así se testean sin levantar Express"*— y las deja
  cubiertas por tests sin Mongo. Más trabajo, y es el único refactor que esta spec propone.

**Recomendación: (b).** No es "código de más": es la misma lógica movida, y es lo que hace que
el cache sea seguro en vez de seguro-por-ahora.

### ✅ Decidido e implementado: (b), el 2026-09-08

Las reglas viven en `services/cursoPermisos.js` como funciones puras (`esDocente`,
`puedeGestionar`, `puedeVer`, `puedeMirarEnVivo`), con todos sus comentarios. Los métodos del
schema **siguen existiendo y delegan ahí**, así que las ~60 llamadas que ya había
(`course.canManage(user)`, `course.canView(user)`, …) no se tocaron.

**Medido después del cambio, sobre el curso real de 36 alumnos:**

```
en frío:     4 queries · 102 ms
en caliente: 0 queries ·   0,011 ms     ← el mismo objeto cacheado
200 llamadas cacheadas: 0,0011 ms c/u
```

**La prueba que importa** (76.800 decisiones sobre datos reales del espejo: 120 cursos × 160
usuarios × 4 reglas, comparando el método viejo sobre el documento contra la función nueva
sobre el objeto plano):

```
diferencias: 0
y no es vacío: concedió gestionar 305, ver 315, mirar en vivo 435
```

### Invalidación — resuelta en el schema, no en las rutas

⭐ **No es una lista de puntos de entrada.** Hay ~20 lugares que modifican un curso
(`routes/admin.js`, `routes/courses.js`, `services/dbFixes.js`, `enrollment.js`,
`joinByCode.js`), y una lista así es exactamente lo que nadie actualiza cuando aparece el
lugar 21. La invalidación vive en `models/Course.js`, enganchada al schema: pasan todos los
caminos, incluidos los scripts de mantenimiento y los que se escriban mañana.

Verificado contra Mongo, los cinco caminos:

| Camino | Resultado |
|---|---|
| `updateOne` con filtro por `_id` | invalida esa entrada |
| `updateMany` | vacía el cache |
| `findOneAndUpdate` | invalida esa entrada |
| `.save()` | invalida esa entrada |
| `updateOne` con otro filtro | vacía el cache (conservador) |

Y si algún camino igual se escapara, **el peor caso son 45 s de desactualización, no un dato
incorrecto para siempre.**

---

## RN-2 · El roster no viaja en cada poll

**4.981 bytes → ~400 en régimen**, y es el 90% de la bajada del chat.

El bloque `presencia` lleva, en cada poll, los 30 alumnos con nombre, inicial, avatar, rol y
etiqueta. Esa lista **es la misma durante toda la clase**: lo único que cambia es quién está
conectado, y a veces ni eso.

El servidor calcula el resumen igual (necesita `roompresences.find` para saber quién está), le
saca una **marca de versión** y la manda. El navegador devuelve la marca que tiene en el poll
siguiente; si coincide, el servidor contesta `presencia: null` y el navegador conserva lo que ya
pintó.

⚠️ **Se preserva la propiedad de "una sola forma"** que la sala defiende hoy (*"es la ÚNICA
forma de la sala: la usan el render inicial y el poll, para que no puedan divergir"*): el render
inicial manda **siempre** el bloque completo. `null` solo puede aparecer en un poll, y significa
"lo que ya tenés". Un navegador que llegue sin marca recibe el bloque entero.

---

## RN-3 · La presencia se escribe con ventana, no en cada poll

**232 escrituras/s → ~62/s.**

`touchPresence` hace un `updateOne` por persona **por poll**: cada 4 segundos. Lo único que ese
dato tiene que sostener es la ventana de "conectado ahora", que son **45 s para alumnos** y
**3 minutos para el personal** (`ONLINE_WINDOW_MS` y `STAFF_ONLINE_WINDOW_MS`). Se está
escribiendo 11 veces más seguido de lo que hace falta.

La escritura pasa a hacerse solo si el `lastPingAt` que hay tiene más de **15 s**. Son 3 pings
de margen dentro de la ventana de 45 s — el mismo criterio de "~3 ciclos" con el que esa
constante ya está justificada.

⚠️ **`lastActivityAt` de la sesión va junto y no se puede separar sin pensarlo**: es lo que
alimenta el autocierre por inactividad (`AUTO_CLOSE_MS`, 30 min). Refrescarlo cada 15 s en vez
de cada 4 s no lo afecta —30 minutos son 120 ventanas de 15 s—, pero tiene que quedar escrito
que se movieron los dos.

---

## RN-4 · La cadencia se afloja cuando no pasa nada

**232 req/s → ~120/s en reposo**, sin que nadie note nada.

Una clase de 40 minutos tiene mensajes en ráfagas y silencio en el medio. Hoy se pregunta cada
4 segundos igual, esté pasando algo o no.

El ciclo encadenado que quedó hoy en `live-room.ejs` ya recibe el intervalo por parámetro
(`programar(ms)`), así que **esto no agrega estructura, solo decide el número**:

- Sale **4 s** mientras haya actividad (un mensaje propio o ajeno en la última vuelta).
- Tras **N vueltas sin nada**, se afloja a **8 s**.
- Vuelve a 4 s en el acto ante cualquier actividad: mensaje propio, cambio de presencia, o
  cualquier acción de la persona.

⚠️ **El techo del aflojado no puede pasar los 15 s de RN-3 ni acercarse a los 45 s de la
ventana de presencia**: si el poll se espacia más que la ventana, la gente empieza a parpadear
dentro y fuera de la lista de conectados. 8 s deja margen de sobra; **subirlo obliga a revisar
las dos constantes**.

---

## Lo que esto da, sumado

Proyección sobre los costos unitarios medidos, a 930 personas. **Números a verificar con la
prueba de carga, no a creer:**

| | Hoy | Con las 4 reglas |
|---|---|---|
| Requests | 232/s | **~120/s** |
| Ops de Mongo | ~1.860/s | **~480/s** |
| Escrituras | 232/s | **~62/s** |
| CPU de `cargarSala` | ~2,6 núcleos | **~0,02** |
| Bajada del chat | ~1,16 MB/s | **~0,05 MB/s** |

## Criterios de aceptación

1. ⭐ **Prueba de carga antes de dar nada por bueno**: 30 salas × 30 pollers simulados contra
   una instancia local, midiendo CPU, ops/s de Mongo y percentil 95 de latencia. Se corre
   **antes y después**, y el "antes" tiene que reproducir los ~2,6 núcleos de `cargarSala`. Sin
   ese "antes", el "después" no prueba nada.
2. El poll de una sala en régimen hace **4 ops de Mongo o menos** (hoy: 8).
3. Un poll sin novedades, con la presencia sin cambios, devuelve **menos de 600 bytes**.
4. El cache del curso se invalida al matricular y al dar de baja un alumno: el poll siguiente
   ve el cambio, sin esperar el TTL.
5. ⭐ **La docente entra a su propia sala y `canManage` da `true`** en los dos workers, con el
   curso viniendo del cache. Es el criterio que ataja la trampa de `hydrate`.
6. Un alumno que cierra la pestaña desaparece de la lista de conectados dentro de la ventana de
   45 s, con RN-3 y RN-4 activas a la vez (es el cruce que puede romper las dos).
7. La cadencia vuelve a 4 s en la vuelta siguiente a un mensaje, desde el aflojado de 8 s.
8. `test:smoke` y `test:roles` sin regresiones, y los 29 casos de `salaPoll.test.js` intactos.

## Lo que NO entra

- **Websockets.** Ver la sección de arriba, con el umbral en el que habría que reabrirlo.
- **Cambiar el modelo de datos, los índices o los permisos.** Cero migraciones: si esta spec
  pide una, algo se planificó mal.
- **UI optimista** (pintar el mensaje propio antes de que el servidor conteste). Ya estaba
  descartado en `sala-poll-carrera.spec.md` y sigue: agrega un segundo estado de verdad en la
  pantalla justo donde se sacó uno.
- **Cache compartido entre workers** (Redis o similar). Sería otra pieza de infraestructura para
  ganar 45 s de frescura que la app ya acepta perder en usuarios y escuelas.
- **Tocar la transmisión en vivo.** Es otro proceso y otro problema.

## Riesgos y decisiones abiertas

1. ⭐ **Elegir (a) o (b) en RN-1.** Es la única decisión de diseño real de esta spec.
2. ~~**Los 930 no están medidos, están supuestos.**~~ **Medido el 2026-09-08**: pico de **28
   salas simultáneas** y **31 personas** en la más llena. El objetivo es correcto y ya se
   alcanzó una vez. Lo que queda abierto es si la escuela va a crecer por encima de eso: si el
   uso se duplica, esta spec sigue alcanzando (deja ~10x de margen); si se multiplica por diez,
   se reabre lo de websockets.
3. **La prueba de carga corre en la máquina de desarrollo**, con Mongo local y sin latencia.
   Mide CPU y ops, **no** mide lo que sufre el aula. Para eso está la medición de red aparte.
