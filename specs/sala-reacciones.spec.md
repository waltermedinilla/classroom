# Reaccionar sin escribir, en la sala en vivo

Estado: **aprobada** (2026-09-17) · Módulo: `rooms` · Rol: alumnos (y el personal de la sala)

## Problema

Palabras del usuario:

> *"quiero que los alumnos puedan ser capaces de 'reaccionar' enviando emojis solo al texto
> que sube el docente, porque si el docente deshabilita la sala solo para que él comente
> algo, quiero que los alumnos puedan ser capaces de generar esa reacción, pero sin texto"*
>
> *"si el docente vuelve a habilitar la sala, que se comporte como venía trabajando, que
> estaba todo bien"*

El modo **"Solo yo escribo"** (`settings.studentsCanWrite = false`) deja a la clase muda:
se le esconde el cuadro de escribir y aparece el cartel *"La docente puso la sala en modo
solo docente"*. La docente explica algo y **no tiene ninguna señal de vuelta** — ni un
"entendido", ni un "no se entiende". La sala pasa de conversación a altavoz.

### Lo que ya existía (y nunca se pudo usar)

Auditado antes de escribir una línea. La mitad de la feature estaba hecha desde
`specs/sala-en-vivo.spec.md` (CU-04) y **estaba muerta**:

| Pieza | Estado |
|---|---|
| `RoomMessage.reactions[{ emoji, users }]` | ✅ existe |
| `RoomSession.settings.reactionsOn` | ✅ existe, **sin ningún interruptor que lo apague** |
| `POST /courses/:id/sala/mensajes/:mid/reaccion`, con toggle | ✅ existe y funciona |
| Pastillas de reacción bajo la burbuja | ✅ se pintan |
| **Un control para crear la PRIMERA reacción de un mensaje** | ❌ **no existe** |
| **Que la reacción de otro llegue a mi pantalla** | ❌ **no llega** |

Las pastillas son botones que **suman** a una reacción ya existente. Como no había forma de
crear la primera, nunca existía ninguna. Y aunque se pudiera crear, el poll pregunta *"¿qué
hay después del mensaje N?"* — una reacción sobre un mensaje **viejo** no cambia ningún `seq`
y por lo tanto **no viaja**. El que reaccionaba lo veía (su propio POST devuelve el mensaje);
los otros 29, no, hasta recargar.

O sea: no alcanzaba con "mostrar el botón". Faltaban las dos mitades.

## Decisiones

- **D1 — El alumno reacciona SOLO a los mensajes del personal.** Es el pedido textual
  ("solo al texto que sube el docente"). Se decide por `authorRole` contra `STAFF_ROLES`, así
  que incluye a preceptoría y dirección **presentadas** en la sala. No a los mensajes de otros
  alumnos, no a los propios, no a los avisos del sistema.
- **D2 — Los adjuntos del docente también.** La foto del pizarrón o el PDF de la guía son
  "lo que sube el docente" igual que su texto, y son justo lo que una clase quiere marcar
  como visto. Los avisos del sistema no: no son de nadie (mismo criterio que
  `puedeBorrarMensaje`).
- **D3 — El botón está siempre que la sala esté abierta**, con la palabra habilitada o no.
  Con la palabra habilitada **no se saca ni se cambia nada** de lo que ya había: el cuadro de
  escribir, responder, las fotos y el resto siguen exactamente igual. Reaccionar es una vía
  más, no un reemplazo del chat.
- **D4 — Al silenciado se le apagan también las reacciones.** Es el precedente de las fotos
  (2026-08-19, `specs/sala-imagenes-y-respuestas.spec.md`): *silenciar a alguien lo silencia
  entero*. Un emoji repetido treinta veces es exactamente la conducta por la que se silencia.
- **D5 — La docente gana el interruptor que le faltaba.** `reactionsOn` existía en la base y
  en el POST desde el día uno, sin botón: mientras nadie podía reaccionar daba igual, ahora
  no. Es el mismo par que "Sin fotos de alumnos": si los emojis se van de tema, se cortan sin
  callar a la clase. **La docente y el personal siguen pudiendo reaccionar a cualquier
  mensaje** (como venía).
- **D6 — La paleta es la que ya está**: los 12 de `live.EMOJIS`. Cerrada, por lo mismo de
  siempre: valida la entrada sin razonar sobre unicode arbitrario y entra en un celular.

## Reglas de negocio

- **RN-1** — `puedeReaccionar(session, msg, ctx)` es **pura** y vive en `services/liveRoom.js`
  junto a sus tres hermanas (`puedeEscribir`, `puedeCompartirImagen`, `puedeBorrarMensaje`),
  porque se compone con ellas. La usan el POST **y** el serializador: un solo cálculo decide
  si el botón se pinta y si el POST se acepta, así que el botón no puede quedar ofreciendo
  algo que el servidor va a rechazar (es RN-A6 de la spec de la transmisión, otra vez).
- **RN-2** — Sala cerrada → nadie reacciona (ya era así: 409).
- **RN-3** — Modo observación → no reacciona. Mirar sin aparecer implica no dejar rastro.
- **RN-4** — Un mensaje **borrado** no recibe reacciones. El hueco dice "Mensaje eliminado":
  colgarle emojis sería devolver por la ventana parte de lo que la moderación sacó.
- **RN-5 — La reacción viaja por una VENTANA DE TIEMPO, no por el cursor de mensajes.**
  El cursor es `seq` y una reacción no crea ningún `seq`. El mensaje toca `reactAt`, la
  sesión toca `lastReactAt`, y el poll manda el bloque `reacciones` **solo si**
  `lastReactAt` cae dentro de `VENTANA_REACCIONES_MS`.
  - `lastReactAt` ya viene en el documento de sesión que el poll carga igual: **con la sala
    en silencio la puerta se cierra sin una sola query extra**. La query solo ocurre cuando
    alguien reaccionó recién.
  - Se manda el **estado completo** de cada mensaje tocado (los contadores, no un delta):
    es idempotente, así que una respuesta repetida o fuera de orden no descuadra nada. Es lo
    contrario del cursor, que no perdona un salto (ver `specs/sala-poll-carrera.spec.md`).
  - ⚠️ **La ventana se DERIVA de `POLL_MS` (×4) y tiene un test guarda** que la compara con
    la cadencia lenta (`POLL_MS × 2`, RN-4 de `sala-en-vivo-escala`): si la ventana quedara
    por debajo del intervalo real, una reacción caería en el hueco entre dos polls y no la
    vería nadie. Mismo patrón que el techo lento contra `ONLINE_WINDOW_MS`.
  - ⚠️ **No se usa un contador incremental tipo `lastSeq`.** Sería la copia obvia y trae su
    carrera: el `$inc` se reserva antes de que el documento esté guardado (nota 14 de "Issues
    Conocidos" de `agente.md`), y con dos toggles casi juntos el cursor pasaría por encima
    del que se guardó más lento y esa reacción no se vería nunca más. La ventana no tiene
    hueco posible: cubre todo lo tocado en los últimos 16 segundos, guardado en el orden que
    sea.
- **RN-6 — Reaccionar NO repinta la conversación.** Hasta hoy cada pulsada llamaba a
  `repintarTodo()`, que pide los **100 últimos mensajes**. Con 30 alumnos marcando un emoji
  eso son 30 descargas completas del chat por cada mensaje de la docente — justo lo que
  RN-2 de `sala-en-vivo-escala` bajó de 4.076 B a 570. La respuesta del POST ya trae el
  mensaje serializado: se repintan **sus** pastillas y nada más.
- **RN-7 — Límite propio, por usuario**: `roomReactionLimiter`, 30 por minuto. Por usuario y
  no por IP, como todos los de este proyecto: la escuela sale por una sola IP pública NAT y
  un límite por IP haría que 2°3° deje sin reaccionar a 5°1°.
- **RN-8 — `!== false` al leer `reactionsOn`**, nunca `=== true`. Una sesión abierta antes
  del despliegue no tiene el campo. Es la trampa 4 de la spec de imágenes, ya cobrada una vez.

## Modelo

```
RoomSession
  lastReactAt: Date, default null    // ← la puerta de RN-5: evita la query cuando no pasó nada

RoomMessage
  reactAt: Date, default null        // ← última vez que se tocó alguna reacción de este mensaje
  índice { session: 1, reactAt: 1 }  // ← la query de la ventana
```

`reactions[{ emoji, users }]` no cambia.

## Contrato

| Ruta | Método | Cambia |
|---|---|---|
| `/courses/:id/sala/mensajes/:mid/reaccion` | POST | ahora pasa por `roomReactionLimiter` y por `puedeReaccionar` (403 con motivo legible) |
| `/courses/:id/sala/config` | POST | `reactionsOn` ya se aceptaba; ahora hay un botón que lo manda |
| `/courses/:id/sala/poll` | GET | suma `reacciones: [{ id, reacciones: [{emoji,n,mia}] }]` y `puedoReaccionar` por mensaje |

El bloque `reacciones` es `[]` el 95% del tiempo (sala en silencio) y no se manda con
`since=0`: en el arranque cada mensaje ya trae las suyas.

## Criterios de aceptación

- **CA-1** — Con `studentsCanWrite: false`, un alumno reacciona a un mensaje del docente → 200.
- **CA-2** — Con `studentsCanWrite: false`, ese mismo alumno **no** puede mandar un mensaje → 403.
- **CA-3** — Un alumno reacciona a un mensaje **de otro alumno** → 403.
- **CA-4** — Un alumno reacciona a un mensaje **propio** → 403.
- **CA-5** — Un alumno reacciona a un aviso del **sistema** → 403.
- **CA-6** — La docente reacciona a un mensaje de un alumno → 200 (no cambió nada para ella).
- **CA-7** — Silenciado → 403, aunque la palabra esté habilitada para el resto.
- **CA-8** — `reactionsOn: false` → 403 para todos, y el botón no se pinta.
- **CA-9** — Sesión **sin el campo** `reactionsOn` → se comporta como prendida.
- **CA-10** — Emoji fuera de `EMOJIS` → 400. Toggle: la segunda pulsada del mismo emoji la quita.
- **CA-11** — Mensaje borrado → 403.
- **CA-12** — Tras reaccionar, **otro** cliente con el cursor al día (`since = lastSeq`) recibe
  `reacciones` con el mensaje tocado y los contadores al día, sin recibir ningún mensaje.
- **CA-13** — Sin reacciones recientes, el poll devuelve `reacciones: []` (y no hace la query).
- **CA-14** — `VENTANA_REACCIONES_MS` > la cadencia lenta del poll (test guarda).
- **CA-15** — Modo observación → 403.
- **CA-16** — Con la palabra habilitada, todo lo anterior de la sala sigue igual: el cuadro de
  escribir, responder, fotos y borrado no cambian de comportamiento.
