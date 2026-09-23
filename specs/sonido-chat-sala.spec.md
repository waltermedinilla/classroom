# Sonido de aviso en el chat de la sala en vivo

Estado: **APROBADA** (2026-09-22). El usuario cerró D1 a D6 y respondió las tres preguntas de
la primera versión (D7 a D9); las decisiones abiertas DA-1 a DA-4 quedaron con la
recomendación (D10) · Módulo: `rooms` · Roles: docente (decide), y lo escuchan todos los
presentes

Hermana de [`sala-en-vivo.spec.md`](sala-en-vivo.spec.md): **no la reemplaza, se le cuelga adentro.**
Toca la ruta más caliente de la app (el poll) y por eso hereda las restricciones de
[`sala-en-vivo-escala.spec.md`](sala-en-vivo-escala.spec.md) y de
[`sala-poll-carrera.spec.md`](sala-poll-carrera.spec.md).

> ⚠️ **Una contradicción con otra spec, escrita de entrada.** `specs/sala-en-vivo.spec.md:54-56`
> dice: *"No notifica. Sin mails, sin push, sin campanita. El alumno se entera al entrar a la
> materia."* Esta spec **enmienda esa línea, y solo esa**, por decisión del usuario del
> 2026-09-22: se agrega un sonido **dentro de la página**, que escucha **solo quien ya está
> adentro de la sala**. Sigue sin haber mails, push, `Notification` del navegador ni ningún
> aviso para quien no está en la sala. La "campanita" de esta spec es un botón de volumen, no un
> centro de notificaciones.

---

## Objetivo

Que un mensaje nuevo en el chat de la sala **se oiga**, para que quien tiene la clase abierta
pero la mirada en otro lado (el cuaderno, la pizarra, otra ventana) se entere sin tener que
estar mirando la pantalla. Hoy no existe ningún sonido de chat: el único `.play()` del
proyecto es el de la transmisión (`public/js/transmision.js:312`), y es otra cosa.

El docente decide si la clase tiene sonido y con qué mensajes suena. Cada persona puede,
en su navegador, silenciarlo o pedir que suene solo cuando no está mirando la sala.
**Sin sumar un solo request ni una sola query por vuelta del poll.**

### Decisiones ya cerradas (usuario, 2026-09-22)

| # | decisión | dónde se aplica |
|---|---|---|
| **D1** | El docente decide si el chat tiene sonido. **Si nunca eligió, está APAGADO.** | RN-01, RN-03 |
| **D2** | La elección es una **preferencia del docente para TODOS sus cursos**, y persiste: la próxima sala que abra arranca con lo último que eligió. Al abrir se copia a `RoomSession.settings`; al cambiarla durante la clase por `POST /:id/sala/config` se actualizan la sesión **y** la preferencia. | RN-04 a RN-06 |
| **D3** | El docente **elige qué mensajes suenan** (todos / solo los del docente). | RN-02, RN-12 |
| **D4** | Lo escuchan **todos los presentes**: alumnos, el propio docente (que escucha los mensajes de los alumnos), preceptoría y dirección, observando o presentada. | RN-12, RN-22 |
| **D5** | **Cada persona**, en su navegador (`localStorage`, con `try/catch`, para **todas** sus salas): puede **silenciar** (nunca prender lo que el docente apagó) y elegir entre **"siempre"** y **"solo si no estoy mirando la sala"**. | RN-19 a RN-21, RN-23 |
| **D6** | **Regla final**: suena ⇔ el docente lo tiene prendido ∧ el mensaje entra en la categoría que eligió ∧ la persona no lo silenció ∧ (modo "siempre" ∨ no está mirando). | RN-23 |
| **D7** | *(era P1)* **Con la pestaña oculta NO se toca el poll.** "Solo si no estoy mirando" funciona con la ventana sin foco y, para quien gestiona, también con la pestaña oculta u otra solapa, vía el latido que ya existe. El alumno que cambia de pestaña no escucha nada; al volver, la sala se pone al día y suena a lo sumo una vez. Cero requests nuevos. | RN-21, RN-22, RN-30 |
| **D8** | *(era P2)* **La categoría rige para la clase; quien gestiona escucha siempre a los demás.** Con el sonido prendido, quien gestiona la sala escucha todos los mensajes de otros sea cual sea la categoría; `'docente'` filtra lo que escuchan alumnos, preceptoría y dirección. | RN-12 |
| **D9** | *(era P3)* **Tiempo mínimo de 12 s entre dos sonidos**: `ENFRIAMIENTO_MS = POLL_MS × 3`. | RN-17, RN-23 |
| **D10** | *(eran DA-1 a DA-4)* Categoría por defecto `'docente'`; preferencia personal por defecto `'siempre'`; el aviso de quien transmite con micrófono se silencia cuando el módulo de transmisión se prenda (no entra en esta entrega); **el aviso de sistema "creó la actividad" NO suena**. | § Entidades, RN-11, Riesgos 8 |
| **D11** | *(2026-09-23)* **Volver con mensajes acumulados suena UNA sola vez, nunca uno por mensaje** (vuelta de la pestaña, reconexión, ráfaga). **Abrir la página de cero NO suena**: lo que llega pintado es historial y la persona ya lo tiene a la vista. Se descartó recordar "hasta dónde leí" por clase para hacerlo sonar al entrar. | RN-13, RN-14, CA-01, CA-08 |

---

## Responsabilidades

Esta spec es dueña de:

- los dos campos nuevos de `RoomSession.settings` (`sonido`, `sonidoDe`) y los dos de `User`
  (`salaSonido`, `salaSonidoDe`);
- lo que `POST /courses/:id/sala/config` y `POST /courses/:id/sala/abrir` hacen con ellos;
- el módulo de navegador **`public/js/salaSonido.js`**: la decisión pura de "¿suena?", la
  preferencia local y el reproductor WebAudio;
- el control del docente en la barra de moderación y la campana de cada participante, en
  `views/partials/live-room.ejs`;
- el desbloqueo del audio frente a la política de autoplay del navegador.

## No responsabilidades

- **No agrega endpoints.** Todo viaja por `/config`, `/abrir` y el poll que ya existen.
- **No agrega requests ni queries por vuelta del poll** (RN-08). El poll **no** lee `User`.
- **No toca el ciclo del poll, el cursor, el ritmo ni la presencia** (`public/js/salaPoll.js`
  y `live-room.ejs:1018-1164` quedan como están). En particular, **con la pestaña oculta la
  sala sigue sin pollear** (D7).
- **Alternativas evaluadas y descartadas por el usuario el 2026-09-22**, anotadas para que
  nadie las reproponga sin saber por qué quedaron afuera:
  - *Poll en segundo plano* (era la opción B de D7): seguir polleando cada 8 s con la pestaña
    oculta, sin registrar presencia. Sumaba requests a la ruta más caliente, y Chrome igual lo
    espacia a uno por minuto después de 5 minutos oculta. Si algún día los alumnos lo piden, se
    mide primero con el monitor de la sala.
  - *Categoría igual para todos* (era la opción (a) de D8): dejaba a la docente de una clase
    común sin escuchar a nadie con `'docente'`.
  - *Sin tiempo mínimo* (D9): un chat animado sonaría cada 4 s.
- **No notifica fuera de la sala**: sin push, sin mail, sin la API `Notification`, sin
  título de pestaña parpadeando, sin badge. Ver la nota de arriba sobre `sala-en-vivo.spec.md`.
- **No suena en los paneles** `/directivo/en-vivo` ni `/preceptor/en-vivo` (las tarjetas de
  `views/partials/live-cards.ejs`): ahí no hay chat.
- **No agrega dependencias npm ni archivos de audio.**
- **No es un módulo por escuela** (`config/modulos.js` no cambia). Vale para todas las
  escuelas y arranca apagado por docente (D1), que es lo mismo en la práctica sin un eje más.
- **No audita** (RN-06) ni **anuncia en el chat** el cambio (RN-06).
- **No coordina pestañas**: dos ventanas visibles de la misma sala suenan dos veces (ver
  Riesgos).

---

## Entidades/Schemas

Cero colecciones nuevas. Los campos nuevos viven en documentos que ya están en el backup
(`roomsessions`, `users`). `BACKUP_FORMAT_VERSION` no cambia.

### Una sola fuente para la lista de categorías

`public/js/salaSonido.js` exporta `SONIDO_DE = ['todos', 'docente']` y
`SONIDO_DE_DEFAULT`. Los dos modelos y `services/liveRoom.js` lo importan con `require()`
(precedente: `routes/rooms.js:36` ya importa `public/js/correccion.js` del lado del servidor).
Así el `enum` de Mongoose, la validación de `/config` y la lectura del navegador no pueden
divergir.

### `models/RoomSession.js` — dos campos dentro de `settings` (hoy `:57-73`)

```js
// Sonido de aviso del chat (specs/sonido-chat-sala.spec.md). Lo decide quien gestiona la
// sala; lo escuchan todos los presentes salvo quien lo silencie en su navegador.
//
// ⚠️ DEFAULT false, y se lee con `=== true` — AL REVÉS que sus tres hermanos, que se leen con
// `!== false` (ver puedeCompartirImagen en services/liveRoom.js:600-609 y RN-8 de
// specs/sala-reacciones.spec.md). Allá "la sesión no tiene el campo" tiene que querer decir
// PERMITIDO; acá tiene que querer decir APAGADO. Copiar el `!== false` del vecino prendería el
// sonido en todas las salas abiertas el día del deploy.
sonido:   { type: Boolean, default: false },

// Qué mensajes suenan: 'todos' | 'docente' (autor con rol en STAFF_ROLES, el mismo criterio
// de "mensaje del docente" que usan las reacciones). Separado del interruptor para que
// apagar y volver a prender no le borre la elección a la docente.
sonidoDe: { type: String, enum: SONIDO_DE, default: SONIDO_DE_DEFAULT },
```

### `models/User.js` — la preferencia, al lado de `modoCorreccion` (`:177-187`)

```js
// Sonido del chat de la sala en vivo (specs/sonido-chat-sala.spec.md, D2). Es la última
// elección de ESTA persona como gestora de una sala, para todos sus cursos: la sala que abra
// arranca con esto. Mismo criterio que `modoCorreccion`: vive en User y no en localStorage
// porque `users` está en el backup y la docente cambia de máquina.
//
// Nadie la escribe salvo POST /courses/:id/sala/config con un campo de sonido en el cuerpo.
salaSonido:   { type: Boolean, default: false },
salaSonidoDe: { type: String, enum: SONIDO_DE, default: SONIDO_DE_DEFAULT },
```

> `SONIDO_DE_DEFAULT` = `'docente'` (D10): es la categoría que queda elegida la primera vez
> que alguien prende el sonido. Menos ruido para treinta alumnos, y con D8 quien gestiona
> escucha a todos igual.

### `localStorage` — la preferencia de cada persona (D5)

```
clave: 'salaSonido'            ← UNA sola, sin id de curso: vale para todas las salas
valor: 'siempre' | 'si_no_miro' | 'silencio'
ausente, inválido o storage que tira  →  'siempre'
```

`'siempre'` es el valor por defecto porque es el que deja actuar a la decisión del docente
(D1): con `'silencio'` por defecto, prender el sonido no le haría nada a nadie hasta que cada
alumno entrara a un menú. La redacción de D5 lo confirma (*"además de 'siempre'"*), y el
usuario lo confirmó (D10).

### `public/js/salaSonido.js` — módulo nuevo (UMD, igual que `public/js/salaPoll.js:25-29`)

Lo carga la sala con `<script>` y lo carga `node --test` con `require()`. **La parte de
decisión no toca el DOM ni el reloj**: recibe todo por parámetro.

```js
// Constantes
SONIDO_DE            = ['todos', 'docente']
SONIDO_DE_DEFAULT    = 'docente'                          // D10
PREFERENCIAS         = ['siempre', 'si_no_miro', 'silencio']
PREFERENCIA_DEFAULT  = 'siempre'                          // D10
CLAVE_LOCAL          = 'salaSonido'
ROLES_PERSONAL       = [...]      // copia de STAFF_ROLES (services/liveRoom.js:177), con test guarda
ENFRIAMIENTO_MS      = 12000      // D9: POLL_MS × 3 (services/liveRoom.js:22), con test guarda
DURACION_MS          = ...        // ≤ 300
GANANCIA_MAX         = ...        // ≤ 0.2

// Puras
politica(settings)               → { activo: boolean, de: 'todos' | 'docente' }
preferencia(valorCrudo)          → uno de PREFERENCIAS (inválido → PREFERENCIA_DEFAULT)
crearEstado(sessionId, mensajes) → { sessionId, marca, ultimoSonido: null }
evaluar(estado, entrada)         → { sonar: boolean, estado: <nuevo estado> }
leerPreferencia(storage)         → nunca tira
guardarPreferencia(storage, v)   → true | false, nunca tira
soportaAudio(win)                → boolean

// Solo navegador (no se testea con node)
reproducir()                     → toca el aviso una vez; nunca tira
```

`entrada` de `evaluar`:

```js
{
  origen:      'poll' | 'latido',                 // RN-22
  sessionId:   string | null,                     // el de la respuesta
  mensajes:    [{ seq, kind, esMio, borrado, rol }],  // la forma que YA serializa routes/rooms.js:449-500
  politica:    { activo, de },                    // salida de politica(s.settings)
  preferencia: 'siempre' | 'si_no_miro' | 'silencio',
  mirando:     boolean,                           // RN-20
  esGestor:    boolean,                           // RN-12 / D8: req.esGestor, lo pone el partial (GESTOR)
  ahora:       number,                            // ms; lo pasa quien llama
}
```

`evaluar` **no muta** el `estado` que recibe: devuelve uno nuevo. Su algoritmo completo, en
el orden en que se aplica (cada paso cita la regla que lo explica):

```
evaluar(estado, e):
  // 1. El latido nunca decide que la sesión cambió                           (RN-22)
  si e.origen === 'latido' y e.sessionId !== estado.sessionId:
      devolver { sonar: false, estado }                       ← el MISMO estado, sin tocar

  // 2. Cambio de sesión o sala cerrada: se olvida la marca                    (RN-14)
  s = copia de estado
  si e.sessionId !== s.sessionId:  s.sessionId = e.sessionId;  s.marca = null

  maxSeq = mayor seq de e.mensajes, o null si viene vacía

  // 3. Sin marca, la tanda es historial: fija la marca y no suena             (RN-14)
  si s.marca === null:  s.marca = maxSeq;  devolver { sonar: false, estado: s }

  // 4. Candidatos                                                             (RN-10, RN-11)
  candidatos = e.mensajes con  seq > s.marca
                           ∧  kind !== 'system'
                           ∧  esMio === false
                           ∧  borrado === false

  // 5. Categoría: rige para la clase, NO para quien gestiona                  (RN-12, D8)
  si e.politica.de === 'docente' y e.esGestor === false:
      candidatos = candidatos con rol ∈ ROLES_PERSONAL

  // 6. La marca avanza SIEMPRE, suene o no                                    (RN-18)
  si maxSeq !== null:  s.marca = max(s.marca, maxSeq)

  // 7. La regla final                                                         (RN-23, D6, D9)
  sonar =  candidatos.length > 0
        ∧  e.politica.activo === true
        ∧  e.preferencia !== 'silencio'
        ∧  (e.preferencia === 'siempre' ∨ e.mirando === false)
        ∧  (s.ultimoSonido === null ∨ e.ahora − s.ultimoSonido ≥ ENFRIAMIENTO_MS)

  si sonar:  s.ultimoSonido = e.ahora
  devolver { sonar, estado: s }
```

Dos consecuencias que no se ven a simple vista:

- `ultimoSonido` **sobrevive al cambio de sesión** (paso 2 solo borra la marca): cerrar y
  reabrir la sala no resetea el tiempo mínimo.
- Una tanda que cae **dentro** del tiempo mínimo no suena y **no se guarda para después**: la
  marca ya pasó por encima de esos mensajes (paso 6). El próximo aviso lo dispara el próximo
  mensaje nuevo que llegue con el tiempo mínimo cumplido.

### `services/liveRoom.js` — dos funciones puras nuevas y una con el modelo inyectado

```js
// Lee el cuerpo de /config. No toca la base.
configDeSonido(body) → { cambios: { sonido?, sonidoDe? }, error: null | 'INVALID_SOUND_OPTION' }

// Lo que hereda una sesión NUEVA de la preferencia de quien la abre. `pref` puede ser null.
sonidoInicial(pref)  → { sonido: pref?.salaSonido === true, sonidoDe: <válido o SONIDO_DE_DEFAULT> }

// La lectura de RN-05, con el modelo por parámetro para poder testear que falle (CA-46,
// 2026-09-23). Devuelve sonidoInicial(pref); ante CUALQUIER error del modelo —que rechace o
// que tire antes de devolver la promesa— devuelve el sonido apagado y no propaga.
async leerPreferenciaSonido(UserModel, userId) → { sonido, sonidoDe }
```

`openSession(course, user, title)` (`services/liveRoom.js:708-722`) suma un cuarto parámetro
opcional `settings` que va al `RoomSession.create()`. **Sigue sin consultar `User`**: la ruta
le pasa la preferencia ya resuelta (RN-05).

---

## Entradas

| de dónde | qué |
|---|---|
| Docente (pantalla) | el control "Sonido de la clase": interruptor + categoría |
| Cualquier participante (pantalla) | la campana: siempre / solo si no tengo la sala al frente / silenciar; el botón "Activar sonido" |
| `POST /courses/:id/sala/config` | `sonido?: boolean \| 'true' \| 'false'`, `sonidoDe?: 'todos' \| 'docente'` (junto a los campos que ya acepta) |
| `POST /courses/:id/sala/abrir` | sin cambios en el cuerpo; lee la preferencia de quien abre |
| `GET /courses/:id/sala/poll` | sin cambios en la entrada |
| `users` (base) | `salaSonido`, `salaSonidoDe` de quien abre, leídos **una vez por apertura** |
| `localStorage['salaSonido']` | la preferencia de la persona |
| El navegador | `document.visibilityState`, `document.hasFocus()`, `aLaVista()` (`live-room.ejs:985-988`), el estado del `AudioContext` y el primer gesto del usuario |

## Salidas

| a dónde | qué |
|---|---|
| `roomsessions.settings` | `sonido`, `sonidoDe` |
| `users` | `salaSonido`, `salaSonidoDe` de quien cambió `/config` |
| Respuesta del poll | `settings` ya viaja entero (`routes/rooms.js:362`): lleva los dos campos. Con la sala cerrada, `sonido: false` (RN-09) |
| Respuesta de `/config` | `{ ok, settings }` como hoy (`routes/rooms.js:1213`), con los dos campos |
| Parlante | un aviso corto generado con WebAudio, **una vez por tanda** |
| Pantalla | el control del docente, la campana, el botón "Activar sonido" |
| Chat | **nada**: el cambio no se anuncia (RN-06) |
| Auditoría | **nada** (RN-06) |
| Logs | solo si falla guardar la preferencia en `User` (RN-06) |

---

## Reglas de negocio

### A. La política del docente

- **RN-01 — El sonido es de la SESIÓN y lo decide quien gestiona.** "Quien gestiona" es
  `req.esGestor` (`routes/rooms.js:175`, `services/cursoPermisos.js:61-71`): docente titular,
  co-docente, admin de la escuela o superadmin. Nadie más cambia la política.

- **RN-02 — Dos campos y no uno.** `sonido` es el interruptor; `sonidoDe` es la categoría.
  Separados para que apagar el sonido no le borre a la docente la categoría que había elegido:
  al prenderlo otra vez vuelve con la misma. `sonidoDe` se guarda aunque `sonido` sea `false`.

  | `sonidoDe` | qué suena para alumnos, preceptoría y dirección (quien gestiona escucha todo, RN-12) |
  |---|---|
  | `'todos'` | todo mensaje nuevo de otra persona |
  | `'docente'` | solo los mensajes cuyo autor tiene rol en `STAFF_ROLES` (`services/liveRoom.js:177`): docentes, preceptoría, dirección, admin, jefe, SOE. **Es el mismo criterio de "mensaje del docente" que ya usan las reacciones** (D1 de `sala-reacciones.spec.md`) |

- **RN-03 — Se lee con `=== true`. La ausencia es APAGADO.** Una sesión abierta antes del
  despliegue no tiene el campo; un usuario que nunca eligió tampoco. Los dos leen apagado.
  `politica(settings)` es la **única** lectura de la política, en el servidor y en el
  navegador, y un test fija que no hay otra. Es la inversión deliberada de RN-8 de
  `sala-reacciones.spec.md` (`!== false`): allá la ausencia es permiso; acá, silencio.

- **RN-04 — La preferencia vive en `User` y vale para todos sus cursos (D2).** Solo la
  escribe `POST /sala/config` cuando el cuerpo trae `sonido` o `sonidoDe`. Un `/config` que
  solo cambia la palabra, las fotos o las reacciones **no toca la preferencia de sonido**. No
  hay endpoint aparte ni pantalla de perfil para esto: se elige en clase, que es donde se usa.

- **RN-05 — Herencia al ABRIR, leyendo la base.**
  - `POST /sala/abrir` lee `salaSonido` y `salaSonidoDe` de **quien abre** con una query
    propia (`User.findById(req.userId).select('salaSonido salaSonidoDe').lean()`), los pasa por
    `sonidoInicial()` y se los da a `openSession` para el `create`. La query y el paso por
    `sonidoInicial()` viven en `live.leerPreferenciaSonido(User, req.userId)`, que es lo único
    que llama la ruta.
  - **No se lee de `res.locals.user`**, y el motivo es concreto: sale de `userCache`, que es
    **por worker** con TTL de 45 s (`middleware/cache.js:3-12`, `middleware/auth.js:8-14`).
    `invalidateUser` solo limpia el worker que atendió el `/config`. La docente que cambia el
    sonido, cierra y vuelve a abrir en menos de 45 s —y le toca el otro worker— heredaría el
    valor viejo. Una query por apertura de clase no pesa nada; el poll sí, y ahí no se toca.
  - **Solo si la sesión se CREA.** `openSession` es idempotente (`services/liveRoom.js:709-710`):
    si ya había una abierta, sus `settings` no cambian aunque quien toca "Abrir" tenga otra
    preferencia.
  - **Hereda quien abre**, no el dueño de la materia: con co-docentes, la preferencia del que
    tocó "Abrir" primero.
  - **Si la lectura falla, la sala se abre igual, con el sonido apagado.** Abrir la clase no
    puede depender de una preferencia de volumen.

- **RN-06 — `POST /sala/config` con campos de sonido.**
  1. **Primero quién**: si no es gestor, 403 como hoy (`routes/rooms.js:1178`), **antes** de
     mirar el cuerpo. Un alumno que manda `sonidoDe: 'x'` recibe 403, no 400 (el orden
     QUIÉN → QUÉ que ya usan el DELETE y la reacción, `routes/rooms.js:735-745`).
  2. Sala cerrada → 409 como hoy (`:1180`).
  3. **Se valida antes de mutar nada.** `configDeSonido(body)` corre antes de tocar
     `studentsCanWrite` y compañía: con `sonidoDe` inválido, **ningún** campo del mismo pedido
     se aplica y la respuesta es 400 `INVALID_SOUND_OPTION`.
  4. `sonido` se interpreta con el mismo `bandera()` de sus vecinos (`:1183`): `true` o
     `'true'` prende, cualquier otra cosa apaga. `sonidoDe` tiene que estar en `SONIDO_DE`.
  5. Se escribe en `session.settings` y se guarda con el `session.save()` que ya existe
     (`:1210`).
  6. Después, `User.updateOne({ _id: req.userId }, { $set: <solo los campos que vinieron> })`
     + `invalidateUser(req.userId)` (precedente: `routes/courses.js:572-573`).
     **Falla abierto**: si esa escritura tira, se loguea y la respuesta sigue siendo 200 — la
     clase ya tiene el sonido cambiado, que es lo que la docente está mirando (precedente:
     RN-03 de `correccion-de-entregas.spec.md`).
  7. **No se anuncia en el chat.** A diferencia de la palabra y las fotos (`:1189-1208`), no
     desaparece ningún botón de la pantalla del alumno ni se le prohíbe nada: no hay nada que
     explicarle. Y un aviso de sistema por cada vez que la docente prueba el volumen ensucia la
     transcripción.
  8. **No se audita.** `/config` no audita ninguno de sus interruptores hoy, y las
     preferencias de pantalla tampoco (`routes/courses.js:575-576`: *"alto volumen y cero valor
     forense"*). No se agrega nada a `config/audit-actions.js`.

- **RN-07 — Con la sala cerrada no se puede elegir.** La preferencia se cambia desde la clase;
  fuera de clase `/config` sigue dando 409. Es consistente con D2 ("al cambiarla durante la
  clase").

### B. Cómo llega a cada navegador

- **RN-08 — Adentro del poll que ya existe, sin costo por vuelta.** `estadoDeSala` ya manda
  `settings: session.settings` entero (`routes/rooms.js:362`) y el documento de sesión ya se
  carga en cada poll (`sesionAbierta`, `:225-233`): los dos campos nuevos viajan solos.
  - **Cero queries nuevas por vuelta. Cero requests nuevos. El poll no lee `User`.** La
    preferencia se copia a la sesión al abrir justamente para que el poll no la necesite.
  - Costo honesto: `,"sonido":false,"sonidoDe":"docente"` son **~35 bytes sin comprimir** por
    respuesta, contra los ~570 B de promedio medidos en RN-2 de `sala-en-vivo-escala`. Es la
    única cosa que esta feature agrega al camino caliente.
  - Contexto de la restricción: el 2026-09-18 se revirtieron las reacciones tras un incidente
    de tráfico (después se vio que no eran la causa: cayó el tráfico de todo el sitio). Esta
    feature no puede ser la próxima sospechosa.

- **RN-09 — Una forma sola, también con la sala cerrada.** Los dos objetos `settings` escritos
  a mano —`routes/rooms.js:300` (sala cerrada) y `views/course.ejs:347` (estado inicial de la
  solapa)— suman `sonido: false` y `sonidoDe: SONIDO_DE_DEFAULT`.

### C. Qué dispara el sonido

- **RN-10 — "Nuevo" se decide con una MARCA, no con el tipo de respuesta.** El estado de
  sonido guarda `marca`: el `seq` más alto que esta pantalla ya evaluó para sonar.
  - Un mensaje es **nuevo** si su `seq` es mayor que la marca.
  - Después de cada evaluación, la marca pasa a ser el mayor `seq` de la tanda, **suene o no
    suene** (RN-18).
  - No alcanza con mirar `since === 0` o `reinicio`: el repintado de `repintarTodo()`
    (`live-room.ejs:570`) pide desde cero y puede traer, mezclado con los 100 viejos, un
    mensaje que llegó recién. La marca separa los dos sin preguntarle nada al cursor.

- **RN-11 — Qué cuenta como candidato.** Un mensaje de la tanda con `seq > marca` que además:
  - **no es del sistema** (`kind !== 'system'`): aperturas, cierres, ingresos y **también el
    aviso "creó la actividad X"** (D10, decidido el 2026-09-22: no suena aunque lleve
    `actividad`) — no son de nadie;
  - **no es propio** (`esMio === false`, que ya calcula el servidor en `routes/rooms.js:459`);
  - **no está borrado** (`borrado === false`): uno que llega ya borrado es un hueco, no un
    mensaje.
  - **Las imágenes y los archivos sí cuentan**: son mensajes de alguien, igual que el texto
    (mismo criterio que D2 de `sala-reacciones.spec.md`).
  - **Las reacciones no cuentan nunca**, y no por un filtro: viajan en `s.reacciones`, no en
    `s.mensajes` (`routes/rooms.js:365`), y `evaluar` solo recibe mensajes.

- **RN-12 — La categoría rige para la clase, no para quien gestiona (D8).**
  - **Para quien NO gestiona** (alumnos, preceptoría, dirección presentada u observando): con
    `politica.de === 'todos'` todo candidato sirve; con `'docente'`, solo los candidatos con
    `rol` en `ROLES_PERSONAL`.
  - **Para quien gestiona** (`esGestor === true`): la categoría **no filtra**. Con el sonido
    prendido escucha todos los mensajes de otros —alumnos, co-docentes, preceptoría—, sea
    `'todos'` o `'docente'`. Si no los quiere, se ajusta con su propia campana (RN-19).
  - Por qué: es lo único que cumple D3 y D4 a la vez. Con la categoría aplicada igual para
    todos, la docente de una clase común (única gestora) no escucharía nada con `'docente'`:
    sus mensajes no suenan por propios y los de los alumnos quedarían filtrados.
  - `esGestor` es el mismo booleano que ya recibe la vista (`GESTOR`, `live-room.ejs:488`), que
    sale de `req.esGestor` en la sala suelta y de `course.canManage(user)` en la materia
    (`views/course.ejs:351`). **No es el rol del usuario**: un admin que mira la sala de una
    materia que gestiona es gestor; una preceptora nunca lo es.

- **RN-13 — Una tanda suena UNA vez.** `evaluar` devuelve un solo booleano por tanda, y quien
  la llama reproduce a lo sumo una vez por llamada. Cinco mensajes en la misma vuelta son un
  solo aviso.

- **RN-14 — El historial no suena nunca.**
  - `marca === null` significa "esta pantalla todavía no tiene nada": **la primera tanda es
    historial**. No suena y fija la marca.
  - Al cargar la página, la marca arranca en el mayor `seq` de `SALA.mensajes` (los que vinieron
    pintados del servidor), o en `null` si no hay ninguno. Es el mismo principio que
    `anotarActividades(SALA.mensajes)` en `live-room.ejs:1757-1759`: *"lo que ya vino pintado
    no es novedad"*.
  - **Cambio de sesión** (el `sessionId` de la respuesta no es el del estado): la marca vuelve a
    `null`. Encaja con el cursor, que ante otra sesión devuelve la tanda vacía y repide desde 0
    (`public/js/salaPoll.js:144-164`): esa segunda respuesta es el historial de la sala nueva y
    fija la marca sin sonar.
  - Sala cerrada (`sessionId: null`): estado `{ sessionId: null, marca: null }`.

- **RN-15 — Reconexión: lo acumulado suena UNA vez.** Tras un corte de red (polls fallando con
  la pestaña a la vista), la primera tanda que llega trae todo lo acumulado; es novedad
  (`seq > marca`) y suena **una sola vez**, sujeta al resto de la regla. Lo mismo al volver a
  una pestaña que estuvo oculta. No hay regla aparte para "llegó de golpe": RN-13 ya lo cubre.

- **RN-16 — Se evalúa lo que el cursor dio por bueno, nada más.**
  - Si `cursor.recibir()` devuelve `descartar` (`live-room.ejs:1039`), **no se evalúa**: es una
    respuesta vieja.
  - Se evalúa `d.mensajes` —lo que se va a pintar— y **nunca** `s.mensajes`. Así un mensaje que
    el cursor retiene por un hueco (`salaPoll.js:197-228`) suena cuando se pinta, no antes.

- **RN-17 — Tiempo mínimo de 12 s entre dos avisos (D9).** Con la sala activa el poll corre
  cada 4 s (`services/liveRoom.js:22`): sin tiempo mínimo, un chat animado con `'todos'`
  sonaría cada 4 s toda la clase, y eso es lo que lleva a silenciarlo para siempre.
  - `ENFRIAMIENTO_MS = 12000` = `POLL_MS × 3`. Vive en `public/js/salaSonido.js` como número
    (el navegador no tiene `POLL_MS` a mano) y **un test guarda fija que sea igual a
    `live.POLL_MS * 3`**: si alguien toca la cadencia del poll, el test obliga a mirar esto.
    Mismo patrón que `VENTANA_REACCIONES_MS` (`services/liveRoom.js:32-38`).
  - Se mide desde el **último aviso que la función decidió** (`ultimoSonido`), no desde el
    último mensaje. `ahora − ultimoSonido ≥ ENFRIAMIENTO_MS` habilita: a los 12 000 ms justos
    ya puede sonar.
  - Lo que cae dentro del tiempo mínimo **no se guarda para después** (ver el algoritmo en
    § Entidades): no hay un aviso diferido que suene solo a los 12 s. Suena el próximo mensaje
    nuevo que llegue con el tiempo cumplido.
  - Es **por página**, no por sala ni por persona: vive en el estado de sonido de esa pestaña.
    Sobrevive al cambio de sesión; se reinicia al recargar.
  - Se aplica igual al poll y al latido de quien gestiona (RN-22): comparten el estado.

- **RN-18 — La marca avanza SIEMPRE.** También con la política apagada, con la persona en
  silencio o mirando. Prender el sonido a mitad de clase no hace sonar lo que ya pasó.

### D. La decisión de cada persona

- **RN-19 — La preferencia local.** `localStorage['salaSonido']`, una sola clave para todas
  las salas. `leerPreferencia` y `guardarPreferencia` envuelven el acceso en `try/catch`
  (Safari en modo privado y algunas netbooks con el almacenamiento bloqueado tiran al escribir):
  si falla, se usa el valor en memoria mientras dure la página y el default al recargar.
  **Silenciar es lo único que la persona puede hacer contra la política**: ningún valor local
  prende un sonido que el docente apagó (`politica.activo === false` gana siempre).

- **RN-20 — Qué es "estar mirando".**
  `mirando = document.visibilityState === 'visible' && document.hasFocus() && aLaVista()`.
  El tercer término cubre la sala embebida en la materia (`live-room.ejs:985-988`): quien está
  en Novedades de la misma página no está mirando la sala.

- **RN-21 — La pestaña oculta: el poll NO se toca (D7).**
  **Lo que hace el código, y sigue haciendo**: con la pestaña oculta **el poll se detiene**
  (`live-room.ejs:1159-1164`: *"Con la pestaña oculta no se pollea"*), y fuera de la solapa "En
  vivo" tampoco pollea (`pollear()` sale en `:1019` si `!aLaVista()`). Sin poll no llega ningún
  mensaje, así que no hay nada que haga sonar. Por lo tanto el modo "solo si no estoy mirando"
  suena en exactamente estos casos:
  - **cualquiera**, con la sala a la vista pero la **ventana sin foco** (otra ventana adelante,
    pantalla partida);
  - **quien gestiona**, además, con la **pestaña oculta** o en **otra solapa** de la materia,
    por el latido (RN-22).
  El alumno que cambia de pestaña **no** escucha nada mientras está afuera; al volver, la sala
  se pone al día y la tanda acumulada suena a lo sumo una vez (RN-15), si su modo es "siempre".
  En celulares, con la pantalla apagada o el navegador en segundo plano, el sistema suspende la
  página: ahí no suena para nadie, y ninguna opción lo habría resuelto.
  El texto de la opción no promete lo que no hace (RN-30).

- **RN-22 — El latido de quien gestiona hace sonar sin sumar requests (D7).**
  Quien gestiona ya manda un poll cada 20 s con la pestaña oculta o en otra solapa
  (`live-room.ejs:1191-1208`) y **tira la respuesta**. Esa respuesta trae los mensajes
  posteriores a `cursor.seq`. Se la pasa a `evaluar` con `origen: 'latido'`:
  - **no se pinta nada y no se toca el cursor**: el latido sigue sin llamar a `cursor.pedir()`
    ni a `cursor.recibir()` (el motivo está en `:1199-1201`);
  - la marca evita el doble aviso: el latido siguiente trae los mismos mensajes (el cursor no
    avanzó) y ya están bajo la marca; al volver a la sala, el poll los pinta sin sonar;
  - **una respuesta de latido con otro `sessionId` se ignora entera** y no cambia el estado: el
    latido nunca decide que la sesión cambió, eso es del poll;
  - con la pestaña oculta más de 5 minutos Chrome espacia los timers a uno por minuto, así que
    el aviso puede llegar hasta ~1 minuto tarde. Es el mismo throttling que ya documenta
    `services/liveRoom.js:54-60`.
  - el latido lleva `esGestor: true` por definición (solo late quien gestiona,
    `live-room.ejs:1193`), así que la categoría no lo filtra (RN-12).
  Es lo que hace que D4 ("el docente escucha a los alumnos") sirva justo cuando la docente no
  está mirando la sala, que es cuando más le sirve, a costo cero.

- **RN-23 — La regla final (D6), exacta.** Para una tanda ya filtrada por RN-10 a RN-12:

  ```
  sonar =  hayCandidatos
        ∧  politica.activo === true
        ∧  preferencia !== 'silencio'
        ∧  (preferencia === 'siempre' ∨ ¬mirando)
        ∧  (ultimoSonido === null ∨ ahora − ultimoSonido ≥ ENFRIAMIENTO_MS)     ← D9, 12 s
  ```

  Si `sonar`, `ultimoSonido = ahora`. `sonar` dice que **corresponde** sonar; si el audio no está
  desbloqueado (RN-26), no suena y no se guarda nada para después — pero `ultimoSonido` se
  actualiza igual: el tiempo mínimo corre desde la decisión, no desde el parlante. El orden
  exacto de los pasos es el del algoritmo de `evaluar` en § Entidades.

- **RN-24 — Todo lo anterior es UNA función pura.** `evaluar` vive en `public/js/salaSonido.js`
  por el mismo motivo que el cursor vive en `salaPoll.js` (`:15-19`): adentro del `.ejs` no se
  puede probar, y una regla de cinco condiciones con una marca es exactamente lo que "a ojo
  parece correcto".

### E. El audio

- **RN-25 — WebAudio generado, sin archivo.** Un aviso de dos tonos senoidales, con envolvente
  de ataque corto y caída exponencial. Límites fijos, exportados como constantes y con test:
  **duración total ≤ 300 ms, ganancia pico ≤ 0,2** (volumen moderado: el volumen real lo pone el
  sistema). Frecuencias y forma exactas: a criterio del implementador, dentro de esos límites.
  Por qué no un archivo: cero bytes de red, cero requests (ni el primero), nada que agregar a
  `public/`, al backup ni a la lista de estáticos cacheados. Un `.mp3` chico no pesaría mucho,
  pero sería un request y un asset a cambio de nada que WebAudio no haga.
  `window.AudioContext || window.webkitAudioContext` (Safari viejo).

- **RN-26 — Autoplay: sin gesto no suena, y se dice.**
  - El `AudioContext` se crea **recién cuando hace falta**: política prendida ∧ preferencia
    distinta de `'silencio'`. Con el sonido apagado (el default) la página no crea ninguno.
  - Mientras haga falta sonido y el contexto no esté `'running'`, cada gesto de la página
    (`pointerdown` / `keydown`, en captura) intenta crearlo o reanudarlo (`resume()`) adentro
    del propio manejador del gesto. Chrome y Firefox recuerdan que la página ya tuvo un gesto
    (activación persistente), así que en la solapa de la materia —donde el clic en "En vivo" ya
    fue uno— el contexto suele arrancar solo aunque se cree después. Safari exige que sea
    **dentro** del gesto, y en la sala suelta (`views/rooms/standalone.ejs`, preceptoría y
    dirección) puede no haber habido ninguno: ahí aparece el botón de abajo.
  - Si corresponde sonar y el contexto no está `'running'`, la campana se convierte en el botón
    **"Activar sonido"**. Tocarlo reanuda el contexto, **suena una vez** (la persona escucha
    cómo va a sonar y confirma que anda) y el botón vuelve a ser la campana. Ese aviso de
    confirmación **no pasa por `evaluar`** y no cuenta para el tiempo mínimo: es la respuesta a
    un toque, no un mensaje. Precedente del cartel: `public/js/transmision.js:312-317` (*"Tocá
    el video para que empiece a sonar"*).
  - **No se encolan avisos**: lo que no sonó por falta de desbloqueo no suena después.

- **RN-27 — Navegador sin WebAudio**: `soportaAudio(window) === false` → la campana muestra
  *"Tu navegador no puede reproducir sonidos"* y ningún código de sonido corre. Nada tira.

- **RN-28 — Un sonido nunca rompe el chat.** `reproducir()` atrapa todo. Un error de audio no
  puede cortar `pollear()`, que es lo que mantiene viva la sala (`live-room.ejs:1131-1142`).

### F. La interfaz

- **RN-29 — El control del docente**, en la barra de moderación (`.lr-acciones`,
  `live-room.ejs:348-380`), solo si `esGestor`, visible solo con la sala abierta (mismo
  criterio que sus vecinos en `pintarEstado`, `:908-934`).
  - Un botón `id="lrSonidoClase"` con el **estado actual**: *"Sonido: apagado"*, *"Sonido:
    todos"*, *"Sonido: solo docente"*. Se aparta a propósito del patrón de sus vecinos (*"el
    rótulo dice lo que va a pasar"*, `:916`): con tres estados, "lo que va a pasar" no entra en
    un botón.
  - Al tocarlo abre un menú con un **interruptor** *"Sonido del chat para toda la clase"* y dos
    opciones *"Todos los mensajes"* / *"Solo los mensajes del docente"* (deshabilitadas con el
    interruptor apagado), y una línea de ayuda: *"Cada persona puede silenciarlo en su
    dispositivo."*
  - Elegir manda **un solo** `POST /config` con los campos que cambiaron y después `pollear()`,
    como sus vecinos (`:1537-1559`). El rótulo lo repinta `pintarEstado()` con lo que dice el
    servidor, no con lo que se tocó.

- **RN-30 — La campana de cada participante.** Un botón `id="lrCampana"` en `.lr-acciones`,
  antes de *"Clases anteriores"*, **para todos los roles** con la sala abierta (alumno,
  docente, preceptoría, dirección presentada u observando).
  - Menú: *"Siempre"*, *"Solo si no tengo la sala al frente"*, *"Silenciar"*. Guarda con
    `guardarPreferencia` y no manda nada al servidor.
  - El texto de la segunda opción **no promete la pestaña oculta** a quien no la va a tener
    (D7). Debajo, una línea de ayuda que depende de `GESTOR`:
    - quien no gestiona: *"Suena si la sala está abierta detrás de otra ventana. Si cambiás de
      pestaña, la sala se pausa y te ponés al día al volver."*
    - quien gestiona: *"También suena si estás en otra solapa de la materia o con la pestaña
      oculta (puede demorar hasta un minuto)."*
  - Con la política apagada, la campana se ve como apagada y el menú dice arriba *"El sonido
    está apagado en esta clase"*; las opciones **se pueden elegir igual**, porque la
    preferencia es para todas las salas.
  - Para quien gestiona conviven los dos controles y dicen cosas distintas: *"Sonido de la
    clase"* (lo que escuchan todos) y la campana (lo que escucho yo).
  - Accesibilidad: `aria-label` y `title` con el estado, `aria-haspopup="menu"`,
    `aria-expanded`, opciones con `role="menuitemradio"` + `aria-checked`, Esc y clic afuera
    cierran.

- **RN-31 — Iconos: se escriben en el EJS, no se eligen en JavaScript.** Los tres estados de la
  campana son tres `<span class="material-symbols-outlined">` literales en el partial
  (`notifications_active`, `notifications_paused`, `notifications_off`), y el JS solo cambia una
  clase o un `data-` del botón que decide cuál se ve. Motivo: el barrido que arma la lista de
  iconos no ve los nombres elegidos en JS, y un icono fuera de la lista se muestra como su
  nombre en inglés al lado del control, sin error en ningún log (causa 3 del 2026-09-16).
  Hoy la lista tiene `notifications_active` y `notifications_off` pero **no**
  `notifications_paused` (`views/partials/head-iconos.ejs:32`): se regenera con
  `npm run iconos:actualizar`.

- **RN-32 — Móvil y temas.**
  - Colores en clases con su variante `[data-theme="dark"]`, **nunca** en `style=` (patrón 8
    de la revisión móvil: no deja dónde colgar la variante oscura).
  - Si un fondo va en hex (el botón "Activar sonido", por ejemplo), su color de texto también va
    en hex, en los dos temas (regla de `sala-imagenes-y-respuestas`). Texto gris con
    `--lr-tenue` (`live-room.ejs:41-42`), que ya llega a AA en los dos temas.
  - Por debajo de 600 px (el corte propio del partial) los dos menús se abren **en el flujo**,
    a lo ancho, debajo de la fila de botones — no como un flotante absoluto que se salga de los
    360 px. Sin `flex-shrink: 0` en la fila; blancos táctiles de **44 px** (2026-09-23, pedido
    del usuario tras verlo en el celular: los ~38 px del selector de reacciones quedaban cortos
    para el dedo). Lo fija CA-59b.

- **RN-33 — Dónde se carga el módulo.** `<script src="/js/salaSonido.js"></script>` va **arriba
  de todo del partial, junto a `salaPoll.js`** (`live-room.ejs:12-23`), nunca pegado al
  `<script>` en línea: ese script se ubica con `document.currentScript.previousElementSibling`,
  que tiene que seguir siendo el `<div class="lr-wrap">`. Si no, la sala pierde su propio
  contenedor y `aLaVista()` empieza a contar presente a quien tiene la materia abierta en otra
  solapa.

### G. Lo que no cambia

- **RN-34 — La sala sigue igual con el sonido apagado.** Con la política apagada —que es como
  arrancan todas— no se crea `AudioContext`, no aparece "Activar sonido", no hay un request más,
  y `pollear()`, `ciclo()`, `latir()` y el cursor se comportan exactamente como hoy.
  `public/js/salaSonido.js` no contiene ningún `fetch`.

---

## Casos de uso

Acciones en el vocabulario `<entidad>.<verbo>` de `config/audit-actions.js`, aunque ninguna se
audita (RN-06). No se agrega ninguna entrada al catálogo.

| CU | quién | qué | acción | auditable |
|---|---|---|---|---|
| **CU-01** | gestor | Prende el sonido de la clase y elige la categoría | `room.config` | — |
| **CU-02** | gestor | Lo apaga (la categoría queda guardada) | `room.config` | — |
| **CU-03** | gestor | Abre una clase nueva y hereda su última elección | `room.open` | ya existe (`room.open`, `config/audit-actions.js:58`) |
| **CU-04** | alumno | Escucha un aviso cuando escribe el docente | — | — |
| **CU-05** | gestor | Escucha un aviso cuando escribe un alumno, **también con la categoría `'docente'`** (D8) | — | — |
| **CU-06** | preceptoría / dirección | Escucha los avisos, presentada u observando | — | — |
| **CU-07** | cualquiera | Silencia el sonido en su navegador, para todas sus salas | — | — |
| **CU-08** | cualquiera | Elige "solo si no tengo la sala al frente" (con la pestaña oculta, solo le sirve a quien gestiona: D7) | — | — |
| **CU-12** | cualquiera | En un chat animado, escucha como mucho un aviso cada 12 s (D9) | — | — |
| **CU-09** | cualquiera | Desbloquea el audio con "Activar sonido" | — | — |
| **CU-10** | gestor | Está en otra solapa o con la pestaña oculta y escucha a un alumno (RN-22) | — | — |
| **CU-11** | alumno / preceptoría / dirección | Intenta cambiar la política y recibe 403 | `room.config` | — |

---

## Criterios de aceptación

### La decisión pura (`public/js/salaSonido.js`, con `node --test`, sin DOM ni base)

Salvo que el criterio diga otra cosa, la entrada base es: `politica = { activo: true, de:
'todos' }`, `preferencia = 'siempre'`, `mirando = true`, `esGestor = false`, `origen = 'poll'`,
`ahora = 1_000_000`, estado `{ sessionId: 'S', marca: 10, ultimoSonido: null }`, y un mensaje
"de otro" es `{ seq: 11, kind: 'text', esMio: false, borrado: false, rol: 'student' }`.

⚠️ **Por el tiempo mínimo de 12 s (D9), todo criterio que encadena dos evaluaciones y espera
`true` en la segunda la hace con `ahora` al menos 12 000 ms después del último `true`**, salvo
que el criterio sea justamente sobre el tiempo mínimo. Si no, el test estaría probando el tiempo
mínimo sin querer.

- **CA-01** *(RN-14)* — Dado un estado con `marca: null`, cuando se evalúa una tanda de 100
  mensajes de otros, entonces `sonar === false` y la marca queda en el mayor `seq` de la tanda.
- **CA-02** *(RN-10, RN-11)* — Dado el estado base, cuando llega un mensaje de otro con `seq 11`,
  entonces `sonar === true` y la marca queda en 11.
- **CA-03** *(RN-11)* — Cuando el único mensaje nuevo tiene `esMio: true`, `sonar === false`.
- **CA-04** *(RN-11)* — Cuando el único mensaje nuevo tiene `kind: 'system'`, `sonar === false`.
- **CA-04b** *(RN-11, D10)* — Cuando el único mensaje nuevo es el aviso de actividad
  (`kind: 'system'` con `actividad: { id, url }`, la forma de `routes/rooms.js:486-488`),
  `sonar === false`, también con `esGestor: true` y con `de: 'todos'`.
- **CA-05** *(RN-11)* — Cuando el único mensaje nuevo tiene `borrado: true`, `sonar === false`.
- **CA-06** *(RN-11)* — Cuando el único mensaje nuevo es `kind: 'image'` o `kind: 'file'` de
  otro, `sonar === true`.
- **CA-07** *(RN-11)* — Cuando `mensajes` es `[]`, `sonar === false` cualquiera sea el resto de
  la entrada (es lo que ve una vuelta que solo trajo reacciones).
- **CA-08** *(RN-13)* — Cuando la tanda trae 5 mensajes nuevos de otros, `evaluar` devuelve **un**
  booleano `true` y la marca queda en el mayor de los 5.
- **CA-09** *(RN-10)* — Dada `marca: 50`, cuando la tanda es un repintado con los `seq` 1 a 50,
  `sonar === false`; cuando es 1 a 51 con el 51 de otro, `sonar === true`.
- **CA-10** *(RN-14)* — Dado el estado en la sesión `'A'` con `marca: 30`, cuando llega una tanda
  con `sessionId: 'B'` y mensajes de otros, entonces `sonar === false`; y una evaluación
  siguiente en `'B'` con un `seq` mayor al máximo de esa primera tanda da `sonar === true`.
- **CA-11** *(RN-14)* — Cuando `sessionId` es `null`, `sonar === false` y el estado queda
  `{ sessionId: null, marca: null }`.
- **CA-12** *(RN-18)* — Con `politica.activo === false` y un mensaje nuevo de otro,
  `sonar === false` **y la marca avanza**; al prender la política, una evaluación con los mismos
  mensajes da `sonar === false`.
- **CA-13** *(RN-03)* — `politica(undefined)`, `politica({})`, `politica({ sonido: 'true' })`,
  `politica({ sonido: 1 })` y `politica({ studentsCanWrite: true, reactionsOn: true })` dan
  `activo === false`. Solo `politica({ sonido: true })` da `activo === true`.
- **CA-14** *(RN-03)* — `politica({ sonido: true, sonidoDe: 'cualquiera' })` da
  `de === SONIDO_DE_DEFAULT`.
- **CA-15** *(RN-12)* — Con `de: 'docente'` y `esGestor: false`: un mensaje nuevo con
  `rol: 'student'` da `false`; con `rol: 'teacher'` da `true`; con `rol: 'preceptor'` da `true`.
- **CA-16** *(RN-12, D8)* — Con `de: 'docente'`, `esGestor: true` y un mensaje nuevo con
  `rol: 'student'`, `sonar === true`: la categoría no filtra a quien gestiona.
- **CA-16b** *(RN-12, D8)* — Con `de: 'docente'` y `esGestor: true`, la regla del gestor **no
  saltea los otros filtros**: un mensaje propio (`esMio: true`) da `false`, uno del sistema da
  `false`, uno borrado da `false`.
- **CA-16c** *(RN-12, RN-23, D8)* — Con `esGestor: true` y un mensaje nuevo de un alumno:
  `politica.activo === false` da `false` (quien gestiona tampoco escucha con el sonido de la
  clase apagado) y `preferencia: 'silencio'` da `false` (su campana manda).
- **CA-16d** *(RN-12, D8)* — Con `de: 'docente'`, la misma tanda —un mensaje de un alumno y uno
  de la docente, los dos nuevos— da `true` para `esGestor: true` **y también** para
  `esGestor: false` (por el de la docente); y una tanda con **solo** el del alumno da `true` para
  `esGestor: true` y `false` para `esGestor: false`.
- **CA-17** *(RN-23)* — Con `preferencia: 'silencio'`, `sonar === false` para cualquier
  combinación de lo demás.
- **CA-18** *(RN-23)* — Con `preferencia: 'si_no_miro'`: `mirando: true` → `false`;
  `mirando: false` → `true`.
- **CA-19** *(RN-23)* — Con `preferencia: 'siempre'` y `mirando: true`, `sonar === true`.
- **CA-20** *(RN-19)* — `preferencia(undefined)`, `preferencia('')` y `preferencia('fuerte')`
  dan `'siempre'`.
- **CA-21** *(RN-19)* — `leerPreferencia` con un storage cuyo `getItem` tira devuelve
  `'siempre'` sin tirar; `guardarPreferencia` con un `setItem` que tira devuelve `false` sin
  tirar; con un storage sano, guardar `'silencio'` y leer devuelve `'silencio'`, bajo la clave
  `CLAVE_LOCAL`, que no contiene ningún id de curso.
- **CA-22** *(RN-17, D9)* — `ENFRIAMIENTO_MS === 12000` **y** `ENFRIAMIENTO_MS ===
  require('services/liveRoom').POLL_MS * 3` (test guarda: si cambia la cadencia del poll, este
  test obliga a revisar el tiempo mínimo).
- **CA-22b** *(RN-17, D9)* — Sonó en `t` (mensaje `seq 11`). Un mensaje nuevo de otro (`seq 12`)
  evaluado en `t + 11 999` da `false`; otro nuevo (`seq 13`) evaluado en `t + 12 000` da `true`
  (el borde es inclusivo).
- **CA-22c** *(RN-17, D9)* — **Lo que cae adentro no se difiere.** Sonó en `t`; el `seq 12` en
  `t + 5 000` da `false`; una evaluación en `t + 13 000` **sin mensajes nuevos** (`mensajes: []`,
  o solo `seq ≤ 12`) da `false`: no hay un aviso guardado que suene solo al cumplirse el tiempo.
- **CA-22d** *(RN-17, D9)* — **Se mide desde el último aviso, no desde el último mensaje.** Sonó
  en `t`; mensajes nuevos en `t + 5 000` y en `t + 10 000` dan `false` los dos; uno nuevo en
  `t + 12 000` da `true`. Las evaluaciones que no sonaron no corren la ventana (`ultimoSonido`
  sigue siendo `t` después de ellas).
- **CA-22e** *(RN-17, D9)* — **Sobrevive al cambio de sesión.** Sonó en `t` en la sesión `'A'`;
  en `t + 1 000` llega la primera tanda de `'B'` (historial: `false`); un mensaje nuevo en `'B'`
  en `t + 5 000` da `false`; otro en `t + 12 000` da `true`.
- **CA-22f** *(RN-17, RN-22, D9)* — **El latido y el poll comparten el tiempo mínimo.** Un latido
  con un mensaje nuevo suena en `t`; un poll con **otro** mensaje nuevo en `t + 4 000` da `false`.
- **CA-22g** *(RN-23, D9)* — Con `politica.activo === false` o `preferencia: 'silencio'`, una
  evaluación con mensajes nuevos **no** actualiza `ultimoSonido`: al prender el sonido, el primer
  mensaje nuevo suena sin esperar 12 s.
- **CA-23** *(RN-22)* — Con `origen: 'latido'` y un `sessionId` distinto del estado,
  `sonar === false` y el estado devuelto es igual al recibido.
- **CA-24** *(RN-22)* — Con `esGestor: true`: un latido en `t` con un mensaje nuevo de otro da
  `true`; un segundo latido en `t + 20 000` con **los mismos** mensajes da `false`; y un poll en
  `t + 40 000` que trae esos mismos mensajes da `false`. (Los tiempos superan los 12 s a
  propósito: lo que se prueba es la marca, no el tiempo mínimo.)
- **CA-25** *(RN-24)* — `evaluar` no muta el objeto `estado` que recibe (se congela con
  `Object.freeze` en el test y no tira).
- **CA-26** *(RN-12)* — `ROLES_PERSONAL` es igual, elemento por elemento, a
  `require('services/liveRoom').STAFF_ROLES`. Si alguien suma un rol de personal en el
  servidor, este test falla.
- **CA-27** *(RN-25)* — `DURACION_MS <= 300` y `GANANCIA_MAX <= 0.2`.
- **CA-28** *(RN-27)* — `soportaAudio({})` es `false`; `soportaAudio({ AudioContext: function(){} })`
  y `soportaAudio({ webkitAudioContext: function(){} })` son `true`.

### El servidor (`services/liveRoom.js` y los modelos, con `node --test`)

- **CA-29** *(RN-02, RN-03)* — `RoomSession.schema.path('settings.sonido').defaultValue === false`
  y `User.schema.path('salaSonido').defaultValue === false`. El `enum` de `settings.sonidoDe` y
  de `salaSonidoDe` es `SONIDO_DE`, el mismo objeto que exporta `public/js/salaSonido.js`.
- **CA-30** *(RN-03)* — Un `RoomSession` hidratado desde un objeto **sin** `sonido` ni
  `sonidoDe` en `settings` da `politica(doc.settings).activo === false`.
- **CA-31** *(RN-06)* — `configDeSonido({})` → `{ cambios: {}, error: null }`;
  `({ sonido: 'true' })` → `cambios.sonido === true`; `({ sonido: 'x' })` →
  `cambios.sonido === false`; `({ sonidoDe: 'todos' })` → `cambios.sonidoDe === 'todos'`;
  `({ sonidoDe: 'nadie' })`, `({ sonidoDe: '' })` y `({ sonidoDe: null })` →
  `error === 'INVALID_SOUND_OPTION'`.
- **CA-32** *(RN-05)* — `sonidoInicial(null)` y `sonidoInicial({})` dan
  `{ sonido: false, sonidoDe: SONIDO_DE_DEFAULT }`;
  `sonidoInicial({ salaSonido: true, salaSonidoDe: 'todos' })` da `{ sonido: true, sonidoDe: 'todos' }`.

### La ruta, de punta a punta (`tests/smoke/specs.js`)

- **CA-33** *(RN-08, RN-09)* — Dada una sala abierta por un docente que nunca eligió, cuando el
  alumno pollea, entonces `settings.sonido === false` y `settings.sonidoDe` existe. Con la sala
  cerrada, el poll también trae `settings.sonido === false`.
- **CA-34** *(RN-06, RN-08)* — Cuando el docente manda `POST /config { sonido: true,
  sonidoDe: 'todos' }`, entonces responde 200 con esos valores en `settings`, y **el poll
  siguiente del alumno** trae `settings.sonido === true` y `settings.sonidoDe === 'todos'`.
- **CA-35** *(RN-04, RN-06)* — Después de CA-34, el documento del docente en `users` tiene
  `salaSonido: true` y `salaSonidoDe: 'todos'`.
- **CA-36** *(RN-04)* — Cuando después el docente manda `POST /config { studentsCanWrite: false }`,
  su `salaSonido` sigue en `true`; cuando manda `{ sonido: false }`, pasa a `false` y
  `salaSonidoDe` sigue en `'todos'`.
- **CA-37** *(RN-06)* — `POST /config { sonidoDe: 'nadie', studentsCanWrite: false }` responde
  **400** *«Esa opción de sonido no existe.»*, y ni `studentsCanWrite` ni el sonido de la sesión
  ni la preferencia del docente cambian.
- **CA-38** *(RN-01, RN-06)* — `POST /config { sonido: true }` hecho por el alumno, por
  preceptoría y por dirección responde **403** *«Solo la o el docente puede hacer esto»*; la
  sesión no cambia y ninguno de esos tres usuarios tiene `salaSonido: true` en `users` (ojo: los
  usuarios que el smoke crea después del deploy ya traen `salaSonido: false` guardado por el
  default de Mongoose; lo que se verifica es que no sea `true`). Con `{ sonidoDe: 'nadie' }`
  también es 403, no 400.
- **CA-39** *(RN-06)* — Tomando `since = seq` antes de CA-34, el poll posterior no trae **ningún**
  mensaje: el cambio de sonido no escribe en el chat.
- **CA-40** *(RN-06)* — La cantidad de entradas de auditoría del docente es la misma antes y
  después de CA-34.
- **CA-41** *(RN-07)* — Con la sala cerrada, `POST /config { sonido: true }` del docente
  responde **409**.
- **CA-42** *(RN-05)* — Dado un docente con `salaSonido: true, salaSonidoDe: 'todos'`, cuando
  abre una sala nueva, entonces `/abrir` responde `creada: true` y el primer poll trae
  `settings.sonido === true` y `settings.sonidoDe === 'todos'`.
- **CA-43** *(RN-05)* — Un docente que nunca eligió —se arma con un `$unset` de `salaSonido` y
  `salaSonidoDe` en su documento— abre una sala nueva → `settings.sonido === false` y
  `settings.sonidoDe === SONIDO_DE_DEFAULT`.
- **CA-44** *(RN-05)* — Con una sala ya abierta con `sonido: false`, cambiar en la base
  `salaSonido` del docente a `true` y volver a tocar `/abrir` responde `creada: false`, y el poll
  sigue trayendo `settings.sonido === false`.
- **CA-45** *(RN-05)* — **La herencia lee la base y no el cache.** Con la sala cerrada, el
  docente con `salaSonido: false` y un request suyo recién hecho (así su usuario queda en
  `userCache` con `false`), se escribe `salaSonido: true` **directo en la base**, sin pasar por
  `/config`, y dentro de los 45 s siguientes se abre una sala nueva: la sesión nace con
  `sonido === true`. Leyendo `res.locals.user` nacería con `false`.
- **CA-46** *(RN-05)* — Con la lectura de la preferencia fallando (en unit, inyectando un modelo
  que tira), la apertura devuelve la sesión con `sonido: false` y no propaga el error.
- **CA-47** *(RN-08)* — El manejador de `GET /sala/poll` y `estadoDeSala` no referencian `User`
  (barrido del código), y el bloque `settings` serializado pesa **a lo sumo 40 bytes más** que
  sin los dos campos.

### La pantalla (`views/partials/live-room.ejs`; barrido del archivo en unit + verificación en el navegador)

- **CA-48** *(RN-33)* — `<script src="/js/salaSonido.js">` aparece en el partial **antes** del
  `<style>` inicial, junto a `salaPoll.js`, y el hermano anterior del `<script>` en línea sigue
  siendo `<div class="lr-wrap">`.
- **CA-49** *(RN-25)* — Ni `public/js/salaSonido.js` ni el partial contienen `new Audio(`, ni
  nombran un `.mp3`, `.wav` u `.ogg`; `public/` no tiene archivos de audio nuevos.
- **CA-50** *(RN-34)* — `public/js/salaSonido.js` no contiene `fetch(` ni `XMLHttpRequest`.
- **CA-51** *(RN-31)* — Los tres iconos de la campana están escritos como `<span
  class="material-symbols-outlined">…</span>` literales en el partial; `tests/unit/iconos.test.js`
  pasa (incluido `notifications_paused` en `head-iconos.ejs`); y ningún nombre de icono de la
  campana se asigna desde JS.
- **CA-52** *(RN-29)* — La página de la materia del **alumno** no contiene `id="lrSonidoClase"`;
  la del **docente** sí. La sala suelta de **preceptoría** no lo contiene.
- **CA-53** *(RN-30)* — La campana `id="lrCampana"` está en la página del alumno, del docente,
  de preceptoría y de dirección en modo observación.
- **CA-54** *(RN-16)* — En `pollear()`, la evaluación del sonido ocurre **después** del
  `if (d.descartar) return;` y recibe `d.mensajes`.
- **CA-54b** *(RN-12, RN-22, D8)* — En `pollear()`, `evaluar` recibe `esGestor: GESTOR`; en
  `latir()`, `esGestor: true` y `origen: 'latido'`. Ninguna de las dos llamadas deriva
  `esGestor` del rol del usuario (el barrido verifica que no nombran `role` ni `rol` del
  usuario), y las dos usan **el mismo** objeto de estado de sonido.
- **CA-55** *(RN-26, navegador)* — Con la política prendida, preferencia `'siempre'` y la sala
  suelta recién cargada sin tocar nada: aparece "Activar sonido"; al tocarlo suena una vez, el
  `AudioContext` queda `'running'` y vuelve la campana. Un mensaje de otro que llega **2 s
  después** del toque suena igual: el aviso de confirmación no cuenta para el tiempo mínimo.
- **CA-56** *(RN-34, navegador)* — Con la política apagada (default): la pestaña de red muestra la
  misma cadencia de `/poll` que antes del cambio, no aparece "Activar sonido" y no se crea
  ningún `AudioContext`.
- **CA-57** *(RN-22, D8, navegador)* — Con el sonido de la clase en **"solo docente"**, la
  docente pasa a Novedades de la misma materia; un alumno escribe; en el latido siguiente
  (≤ 20 s) a la docente le suena **una** vez; al volver a "En vivo" el mensaje aparece y no
  suena otra vez.
- **CA-57b** *(RN-12, D8, navegador)* — Con el sonido de la clase en **"solo docente"** y dos
  alumnos en la sala, un alumno escribe: al otro alumno **no** le suena y a la docente **sí**.
  Después (pasados 12 s) escribe la docente: al alumno **sí** le suena.
- **CA-57c** *(RN-17, D9, navegador)* — Con el sonido en "todos", tres mensajes de otros con 4 s
  de separación: suena el primero, no suena el segundo (a los 4 s), no suena el tercero (a los
  8 s); un cuarto a los 13 s del primero suena.
- **CA-58** *(RN-21, D7)* — **El poll no se toca con la pestaña oculta.** El manejador de
  `visibilitychange` del partial sigue llamando a `detener()` cuando `document.hidden` (barrido
  del archivo), y en el navegador, con la pestaña del alumno oculta, la pestaña de red no muestra
  ningún `/poll` (igual que hoy).
- **CA-58b** *(RN-30, D7)* — La segunda opción de la campana dice *"Solo si no tengo la sala al
  frente"* (no nombra la pestaña), y su línea de ayuda es la de quien no gestiona en la página del
  alumno y la de quien gestiona en la del docente.
- **CA-59** *(RN-32, navegador)* — A 360 px de ancho, con la sala abierta y la docente logueada,
  los dos menús se abren sin scroll horizontal, se leen enteros y se cierran con Esc y con
  clic afuera. En tema oscuro, todo texto de los menús y de "Activar sonido" llega a 4,5:1.
- **CA-59b** *(RN-32, 2026-09-23)* — La regla `.lr-menu button` de `live-room.ejs` tiene
  `min-height` de al menos 44 px: las opciones de los dos menús se tocan con el dedo.
- **CA-60** *(RN-27, navegador)* — Sin `AudioContext` (se lo borra de `window` antes de cargar la
  sala), la sala funciona entera y la campana dice *"Tu navegador no puede reproducir sonidos"*.

---

## Errores posibles

| CÓDIGO | HTTP | mensaje en español | cuándo |
|---|---|---|---|
| `NOT_A_TEACHER` | 403 | «Solo la o el docente puede hacer esto» | `/config` de quien no gestiona. Ya existe (`routes/rooms.js:1178`) |
| `ROOM_CLOSED` | 409 | «La sala está cerrada» | `/config` sin sala abierta. Ya existe (`:1180`) |
| `INVALID_SOUND_OPTION` | 400 | «Esa opción de sonido no existe.» | `sonidoDe` presente y fuera de `SONIDO_DE` |
| `COURSE_NOT_FOUND` / `ACCESS_DENIED` | 404 / 403 | «Curso no encontrado» / «Acceso denegado» | los de `cargarSala`, sin cambios |
| `SOUND_PREF_NOT_SAVED` | — (200) | — (no se muestra) | falló el `updateOne` de `User` en `/config`: se loguea y se sigue (RN-06.6) |
| `AUDIO_LOCKED` | — | «Activar sonido» (botón) | el navegador no dejó arrancar el audio sin un gesto (RN-26) |
| `AUDIO_UNSUPPORTED` | — | «Tu navegador no puede reproducir sonidos» | no hay WebAudio (RN-27) |

Como en `sala-en-vivo.spec.md:809-811`, los códigos son el contrato para tests y logs; la
respuesta HTTP sigue la forma de `fallar()` (`routes/rooms.js:94-104`): `{ error }` en JSON o
texto plano según `req.accepts`.

---

## Tests necesarios

### Unit (`npm run test:unit`)

- **`tests/unit/salaSonido.test.js`** (nuevo) — CA-01 a CA-28 con sus variantes (CA-04b,
  CA-16b a CA-16d, CA-22b a CA-22g): la matriz entera de `evaluar`, `politica`, `preferencia`,
  `leerPreferencia`/`guardarPreferencia` con storages falsos (uno sano, uno que tira en
  `getItem`, uno que tira en `setItem`), las dos guardas contra el servidor (`ROLES_PERSONAL`
  contra `STAFF_ROLES`, `ENFRIAMIENTO_MS` contra `POLL_MS × 3`), las constantes del audio y
  `soportaAudio`. El tiempo se inyecta por `ahora`: **ningún test usa `Date.now()` ni espera
  12 s de verdad**. Y los barridos de la pantalla: CA-48 a CA-51, CA-54, CA-54b, CA-58 (parte
  del barrido) y CA-58b, leyendo `views/partials/live-room.ejs` como texto, igual que hace
  `tests/unit/salaReacciones.test.js:22-23`.
- **`tests/unit/salaSonidoServidor.test.js`** (nuevo) — CA-29 a CA-32, CA-46 y el barrido de
  CA-47. Sin base: los modelos se hidratan con `Model.hydrate()`, `configDeSonido` /
  `sonidoInicial` son puras, y CA-46 le pasa a `leerPreferenciaSonido` un modelo falso que
  rechaza y otro que tira antes de devolver la promesa.
- **Guarda de la inversión** (en cualquiera de los dos): ningún archivo lee `settings.sonido`
  con `!== false`; la única lectura es `politica()`. Es el test que caza a quien "arregle" la
  lectura copiando la del vecino.

### Adecuar lo que ya existe

- **`tests/unit/iconos.test.js`** — no se toca: tiene que pasar después de
  `npm run iconos:actualizar` (CA-51).
- **`tests/unit/salaChat.test.js`** y **`salaReacciones.test.js`** — sus `sesion()` de prueba
  no traen los campos nuevos y **tienen que seguir pasando sin cambios**: es la prueba de que
  la ausencia no rompe las reglas existentes.
- **`tests/smoke/specs.js` → `'sala-acceso'`** (`:9316-9322`) — el bucle de preceptoría y
  dirección suma `POST /config { sonido: true }` → 403 (CA-38).

### Smoke (`npm run test:smoke`)

- **`'sala-sonido'`** (nuevo), **después de `'sala-reacciones'`** (`:8899`), con la sala del
  smoke abierta: CA-33 (parte abierta), CA-34 a CA-40, y el alumno haciendo CA-38. Todo dentro de
  un `try/finally` que deja la sesión **y la preferencia del docente** en `sonido: false`,
  `sonidoDe: SONIDO_DE_DEFAULT` — el precedente es `'sala-reacciones'` (`:8914-8984`), que aprendió
  que un assert cortado a la mitad se lleva puestos los specs siguientes. CA-35 a CA-37 leen
  `users` con `MONGODB_URI`, como ya hacen `'sala-purga'` y
  `'sala-transcripcion-cartel-purgada-por-ciclo'`.
- **`'sala-sonido-herencia'`** (nuevo), **después de `'sala-crear-actividad-sin-sala'`**
  (`:9650`), que es el único momento del smoke con la sala cerrada: CA-41 y CA-33 (parte
  cerrada); CA-43 (abre, verifica, deja abierta); prende el sonido (`/config`), cierra, reabre y
  verifica CA-42; después CA-44 y CA-45. CA-43, CA-44 y CA-45 escriben directo en `users` con
  `MONGODB_URI`. En el `finally`: preferencia en `false` y **la sala cerrada**
  (una sala que el smoke deja abierta aparece "en vivo" en los paneles). El tester verifica que
  los dos specs que vienen detrás (`'sala-transcripcion-cartel-purgada-por-ciclo'` y
  `'sala-purga'`) no dependan de cuántas sesiones tiene la materia: hoy toman una cualquiera
  (`:9692`) o la de `state.salaSessionId` (`:9770`), así que no deberían.
- CA-52 y CA-53 con los GET de la página de la materia (docente y alumno) y de la sala suelta
  (preceptoría, dirección con `?modo=observacion`), buscando los `id` en el HTML.

### Roles (`npm run test:roles`)

**No cambia.** No hay solapa nueva en `config/sections.js`: la matriz de solapas × roles es la
misma. Lo que cambia por rol —quién ve el control del docente, quién recibe 403 en `/config`—
se fija en smoke (CA-38, CA-52, CA-53), que es donde ya vive la matriz de la sala.

### Verificación en el navegador (no automatizable, con pasos escritos)

CA-55 a CA-60 (incluidos CA-57b, CA-57c y la parte de red de CA-58), más el caso de iOS/Safari
(desbloqueo con un toque) y el del tema oscuro. CA-57b necesita dos alumnos en la misma sala:
dos navegadores o una ventana privada. Con el
servidor de verificación en otro puerto por la cache de vistas EJS con
`NODE_ENV=production` en el `.env` local.

### Contra el arreglo

Cada test nuevo de la ruta se corre **una vez contra el código sin la feature** y tiene que
fallar (CA-34, CA-35, CA-42, CA-45 son los que importan): un test que pasa igual sin el cambio
no prueba nada.

---

## Dependencias

- **Código que se modifica**: `models/RoomSession.js` (settings), `models/User.js`,
  `services/liveRoom.js` (`openSession`, `configDeSonido`, `sonidoInicial`),
  `routes/rooms.js` (`/config` `:1176-1215`, `/abrir` `:666-678`, el `settings` de la sala
  cerrada `:300`), `views/partials/live-room.ejs` (control, campana, carga del módulo, llamadas a
  `evaluar` en `pollear()` y en `latir()`), `views/course.ejs:347`,
  `views/partials/head-iconos.ejs` (por `npm run iconos:actualizar`).
- **Código nuevo**: `public/js/salaSonido.js`.
- **Código que NO se toca**: `public/js/salaPoll.js`, el ciclo del poll, `touchPresence`,
  `config/audit-actions.js`, `config/sections.js`, `config/modulos.js`, `routes/backup.js`.
- **Sin dependencias npm.** WebAudio: Chrome, Edge, Firefox y Safari ≥ 14.1 sin prefijo; Safari
  viejo con `webkitAudioContext`.
- **Specs**:
  - `sala-en-vivo.spec.md` — **se enmienda** su "No notifica" (`:54-56`), ver la nota de arriba.
  - `sala-reacciones.spec.md` — las reacciones **no** suenan; RN-03 invierte su RN-8 a propósito.
  - `sala-en-vivo-escala.spec.md` — RN-08 respeta sus cuatro RN: ni una query por vuelta.
  - `sala-poll-carrera.spec.md` — el cursor no se toca; RN-16 evalúa solo lo que el cursor
    aceptó.
  - `transmision-en-vivo.spec.md` — posible eco del aviso en el micrófono del docente (D10:
    se resuelve cuando el módulo se prenda, no en esta entrega).
  - `correccion-de-entregas.spec.md` — precedente de preferencia en `User` y de "falla abierto".
- ⚠️ **El árbol sobre el que se escribió**: el local, `HEAD 382ab3d` (v1.0.104, **con**
  reacciones). Según la memoria del proyecto, en `origin/main` las reacciones están revertidas
  (`29ba72b`, incidente del 18/09). **La feature no depende de las reacciones**, pero las líneas
  citadas de `routes/rooms.js` y `live-room.ejs` sí: verificar en qué árbol se implementa antes
  de empezar.

---

## Riesgos de refactorización

1. **La lectura invertida.** Los tres interruptores vecinos se leen con `!== false`; copiar ese
   patrón para `sonido` prende el sonido en todas las sesiones viejas el día del deploy. Lo
   frenan RN-03, CA-13, CA-30 y el test guarda de la inversión.
2. **Leer la preferencia en el poll.** La tentación es "ya que estamos, leo `User` en el poll
   para que el cambio se vea al instante en todas las salas del docente". Es una query por vuelta
   y por persona, justo lo que RN-1 de `sala-en-vivo-escala` sacó. CA-47 lo caza.
3. **`res.locals.user` en `/abrir`.** Funciona en local con un solo proceso y falla en
   producción con dos workers, a veces. CA-45 es el test que lo distingue.
4. **El `<script>` pegado al script en línea** rompe `aLaVista()` sin ningún error (RN-33,
   CA-48).
5. **El latido.** Si al evaluar su respuesta alguien "aprovecha" y la pinta, o llama a
   `cursor.pedir()`, la sala se congela cada 20 s para la docente (`live-room.ejs:1199-1201`).
   RN-22 dice qué se puede hacer con esa respuesta: evaluarla, nada más.
6. **Evaluar `s.mensajes` en vez de `d.mensajes`**: suena por respuestas descartadas y por
   mensajes retenidos por un hueco (CA-54).
7. **Iconos elegidos en JS**: la campana saldría con su nombre en inglés (RN-31, CA-51).
8. **Eco en la transmisión.** Si la docente transmite con micrófono y sus parlantes tocan el
   aviso, el micrófono puede levantarlo y mandárselo a toda la clase. La cancelación de eco del
   navegador puede o no sacarlo. Decidido (D10): cuando el módulo de transmisión se prenda en
   alguna escuela, el aviso de quien transmite con micrófono se silencia. **No entra en esta
   entrega** porque hoy el módulo está apagado; queda como condición para prenderlo.
9. **iOS**: el interruptor de silencio del iPhone apaga WebAudio y la página no se entera. No
   tiene arreglo desde la web; se documenta.
10. **Dos pestañas visibles** de la misma sala suenan dos veces. Coordinar pestañas
    (`BroadcastChannel`) queda afuera a propósito.
11. **Suplantación**: un admin que suplanta a una docente y toca el sonido cambia la preferencia
    de ella (`req.userId` es el de la suplantada). Es lo mismo que ya pasa con `modoCorreccion`.
12. **Estado del smoke**: el docente del smoke queda con la preferencia que le dejó el último
    spec. Los dos specs nuevos la restauran en su `finally`.
13. **El tiempo mínimo en los tests.** Con 12 s entre avisos, un test que encadene dos
    evaluaciones sin mover `ahora` prueba el tiempo mínimo sin querer y da un falso rojo (o un
    falso verde). La nota al principio de los CA lo dice; `evaluar` recibe `ahora` justamente
    para que ningún test dependa del reloj.

---

## Plan de migración

1. **Sin migración de datos.** Los cuatro campos tienen default y solo se escriben cuando
   alguien toca el control. Ninguna escritura masiva.
2. **Sesiones abiertas en el momento del deploy**: leen apagado (RN-03). **Usuarios
   existentes**: apagado. **Backup viejo restaurado**: vuelve sin los campos y lee apagado.
3. **Un solo commit** con modelos, rutas, partial y `public/js/salaSonido.js`: el navegador
   ignora los campos que no conoce y el servidor no necesita al navegador nuevo.
4. `npm run iconos:actualizar` dentro del mismo commit (CA-51).
5. **Páginas abiertas durante el deploy**: siguen con el JS viejo y sin sonido hasta recargar.
   En producción las vistas EJS están cacheadas (`NODE_ENV=production`): el reload de PM2 es
   parte del deploy normal.
6. **Vuelta atrás**: revertir el commit. Los campos que hayan quedado en `roomsessions` y
   `users` son inertes para el código viejo (el schema no los declara y nadie los lee).
7. Antes de pushear: **avisarle al usuario** (toca el schema de `users` y `roomsessions` en
   producción, aunque sin escribir nada), verificar el árbol commiteado con `git archive HEAD`,
   las tres suites en verde, y `agente.md` al día.

