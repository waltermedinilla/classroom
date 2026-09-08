# El mensaje que aparece y se borra solo

Estado: **aprobada** (2026-09-07) · Módulo: `rooms` · Rol: todos los de la sala

## Problema

Palabras del usuario:

> *"tengo problemas con la salas en vivo, muchos se quejan de que escriben y lo que
> escriben les figura y luego se borra, puede ser problemas de conección o que puede ser
> problemas de procesador"*

No es el procesador ni la conexión: es una **condición de carrera en el navegador**, que
la conexión lenta del aula dispara mucho más seguido. Nada se borra de la base — lo que se
vacía es la pantalla.

La sala no usa websockets: cada persona pregunta *"¿qué hay después del mensaje N?"* cada
4 segundos (`POLL_MS`, `services/liveRoom.js`). El cursor `N` es `seq`, y hasta hoy **nada
garantizaba que las respuestas se procesaran en el mismo orden en que salieron los
pedidos**: no había ni una guarda de concurrencia en `pollear()`.

### Causa 1 — la respuesta atrasada vacía el chat

Hay tres lugares donde salen dos pedidos casi juntos, sin cancelar el anterior:

| Dónde | Qué hacía |
|---|---|
| `enviar()` | tras el POST llamaba a `pollear()`, con el intervalo de 4 s corriendo igual |
| `visibilitychange` | `pollear()` y enseguida `arrancar()`, **que vuelve a pollear** |
| `repintarTodo()` | borrar un mensaje o reaccionar dispara otro `pollear()` |

La secuencia que reportó el usuario, con el cursor en 10:

1. El intervalo pide *"desde el 10"*. El pedido queda viajando.
2. La persona escribe. `enviar()` dispara un segundo pedido, también *"desde el 10"*.
3. El segundo vuelve primero, trae el mensaje 11 y lo pinta. **Se ve en pantalla.**
4. Vuelve el primero, más lento, con la foto vieja: `seq: 10`, sin mensajes.
5. `s.seq < seq` (10 < 11) se leía como *"la sala se reinició"* → `pintarMensajes([], true)`
   → `chat.innerHTML = ''`. **El mensaje desaparece de la pantalla.**

A los 4 segundos el poll siguiente pide desde 0 y la conversación vuelve entera. Por eso
el síntoma es *"aparece, se borra, y después vuelve"*.

### Causa 2 — el cursor salta un mensaje que todavía no existe

`postMessage()` reserva el número (`$inc` sobre `lastSeq`) y **después** inserta el
documento: entre las dos operaciones hay un `await`. Un poll que caiga en ese hueco recibe
`s.seq = 11` con el mensaje 11 todavía inexistente, y la línea

```js
if (s.seq > seq) seq = s.seq;     // ← el cursor avanzaba por lo ANUNCIADO, no por lo recibido
```

lo adoptaba igual. A partir de ahí esa pantalla pide *"desde el 11"* y **el mensaje 11 no
le llega nunca**: no vuelve a los 4 segundos, solo recargando la página.

La misma ventana produce la variante con dos mensajes: si el 12 se inserta antes que el 11
—los `$inc` son atómicos, los `create` no están ordenados entre sí— el cliente recibe el
12, avanza a 12, y el 11 queda del lado de atrás del cursor para siempre.

## Alcance

**Solo el navegador.** No se toca el servidor, ni el modelo, ni la base: no hay migración
y no hay nada que reparar en los datos.

Eso es además lo que responde el pedido del usuario de *"arreglarlo a partir del próximo
docente que inicie una sala en vivo, para no perjudicar a los que están actualmente"*:
quien esté hoy en una clase sigue corriendo el código que ya tiene cargado hasta que
recargue la página. El arreglo entra solo en las pantallas que se abran después del
despliegue, sin cortar ninguna sala viva.

La lógica del cursor sale del `<script>` inline de `views/partials/live-room.ejs` a un
módulo propio, **`public/js/salaPoll.js`**, por el mismo motivo que sus hermanas
`estadoActividad.js` y `visibilidadActividad.js`: adentro del `.ejs` no se puede probar, y
esta es justamente una regla que a ojo parecía correcta durante meses.

```js
const cursor = SalaPoll.crearCursor({ seq, sessionId });
const pedido = cursor.pedir();                  // { since, gen }
const d      = cursor.recibir(respuesta, pedido);
// d = { descartar, reinicio, mensajes, repedir }
```

### RN-1 · Solo se descarta lo que llegó tarde respecto de lo que YA SE PINTÓ

⚠️ **Corregida el 2026-09-08.** La primera redacción decía *"solo se procesa la respuesta del
último pedido"*, comparando contra el último `gen` **emitido**, y estuvo un día en producción.
Ver más abajo por qué congelaba la sala.

`pedir()` numera cada pedido (`gen`); `recibir()` recuerda el número del último que dio por
bueno (`genAceptado`). Se **descarta entera** toda respuesta con `pedido.gen <= genAceptado`:
no pinta, no vacía y no mueve el cursor.

Descartarla es correcto y no pierde nada: la respuesta que la pasó salió con el mismo `since`
o uno mayor, así que **ya trajo** todo lo que traía la atrasada.

Se descarta la respuesta **completa**, no solo sus mensajes: la presencia, el estado de la
transmisión y `puedoEscribir` de una respuesta vieja son igual de viejos, y pintarlos hacía
parpadear la fila de conectados.

**Por qué el sujeto es "lo pintado" y no "lo pedido".** Con `pedido.gen !== gen`, el criterio
dependía de un pedido que todavía podía no haber vuelto. El razonamiento *"el que la dejó atrás
trae lo mismo"* es cierto **solo si ese llega**, y el poll salía cada 4 s pasara lo que pasara:
si el viaje tardaba más que el intervalo, cada respuesta encontraba un pedido más nuevo ya
emitido y se tiraba. Para siempre.

No es una degradación gradual, es un **acantilado en los 4000 ms exactos**: por debajo la sala
anda perfecto; por arriba no pinta nada, nunca. Se reportó como las dos mitades del mismo
síntoma — *"entra pero la sala no carga"* y *"escribe pero no le llega al alumno"*. Medido en el
navegador con la respuesta a 9 s: **0 repintados del DOM en 40 segundos**.

Una respuesta lenta que todavía no pisó nadie es la mejor información que hay: es la única que
llegó.

### RN-5 · El ciclo se encadena, no sale por intervalo

La otra mitad del mismo problema. `setInterval(pollear, POLL)` emitía un pedido cada 4 s pasara
lo que pasara: en una red lenta se **apilan sin límite**, y son requests que el servidor atiende
enteras —7 queries cada una— para que el navegador tire casi todas.

La vuelta siguiente se programa cuando la anterior **terminó** (`programar()` / `ciclo()` en el
partial). Así hay como mucho un pedido del ciclo en vuelo, y el ritmo se afloja solo cuando la
red aprieta. Medido: con la respuesta a 9 s, 3 polls en 40 s contra los 9 del intervalo fijo.

⚠️ **Con el ciclo encadenado, un pedido que no vuelve nunca dejaría la sala muda para siempre**
— peor que el bug que esto cierra. Por eso el `fetch` del poll lleva un `AbortController` con
plazo (`PLAZO_MS`, 15 s). Es holgado a propósito: con 350 ms de RTT y 5% de pérdida un poll
lento tarda segundos, y abortarlo antes sería tirar la respuesta que estaba por llegar. Ese
plazo no marca el ritmo del chat —ése es `POLL`—, es la red de contención.

Los pedidos **fuera de ciclo** (enviar, borrar, reaccionar, el repedido de RN-2) siguen saliendo
aparte y a propósito: son la respuesta inmediata a algo que la persona acaba de hacer, y con
RN-1 corregida el cursor ya sabe ordenarlos.

### RN-2 · El único indicador de "otra sesión" es el `sessionId`

`s.seq < seq` deja de ser señal de reinicio: con el mismo `sessionId`, el `lastSeq` del
servidor **nunca** significa que haya que vaciar la pantalla.

- `sessionId` distinto y no nulo (sala abierta o reabierta) → vaciar, cursor a 0 y
  **repedir en el acto**, sin esperar los 4 segundos. Antes, el reinicio pintaba la tanda
  que había pedido con el cursor viejo —parcial por definición— y la conversación quedaba
  truncada hasta el poll siguiente.
- `sessionId` nulo (la sala se cerró) → vaciar y quedarse ahí, como hasta ahora.

### RN-3 · El cursor avanza solo con mensajes recibidos, y no saltea un hueco

Se elimina `if (s.seq > seq) seq = s.seq`. El cursor pasa a ser el mayor `seq` **recibido**.

Y con un pedido `since > 0`, si la tanda no arranca en `since + 1`, hay un hueco: el
mensaje del medio existe (su número está reservado) pero todavía no se insertó. En ese caso
el cursor avanza **solo hasta el último número consecutivo**, y los mensajes que quedan del
otro lado del hueco **no se pintan todavía**: el poll siguiente los trae completos y en
orden. Cuatro segundos de demora valen más que leer la conversación desordenada.

**Con salvaguarda de tiempo (`HUECO_MS`, 10 s):** un número reservado cuyo documento nunca
llegue a existir —un `create` que falló— dejaría el cursor clavado para siempre, y la sala
muda. Pasados 10 segundos el hueco se da por perdido, el cursor salta y la conversación
sigue. Sin ese límite, el arreglo sería peor que el problema.

Con `since = 0` no se evalúa nada de esto: ahí el servidor manda los últimos 100 mensajes,
que no tienen por qué empezar en 1.

### RN-4 · El latido de la docente no consume generación

`latir()` manda el mismo GET y **tira la respuesta** (mantiene viva su presencia mientras
mira otra solapa). Lee `cursor.seq` directo y no llama a `pedir()`: si numerara un pedido,
invalidaría el poll real que estuviera en vuelo y la sala se congelaría cada 20 segundos
para quien gestiona.

## Criterios de aceptación

1. La secuencia de la Causa 1, paso a paso, **no vacía el chat** y deja el cursor en 11.
2. Con el mismo `sessionId`, una respuesta con `seq` menor que el cursor no reinicia nada.
3. `sessionId` nuevo → `reinicio` con `mensajes: []` y `repedir: true`; sala cerrada →
   `reinicio` sin `repedir`.
4. El cursor no se mueve por `resp.seq`: una respuesta que anuncia el 11 sin traerlo lo
   deja en 10, y cuando el 11 aparece, llega.
5. Un hueco (llega el 12, falta el 11) no pinta el 12 ni mueve el cursor; al poll siguiente
   se pintan 11 y 12 en orden.
6. Un hueco de más de 10 segundos se da por perdido y el cursor avanza igual.
7. `desdeCero` (borrar / reaccionar) se aplica **al recibir** y no al pedir: si esa
   respuesta se pierde, el cursor no queda en 0.
8. El cableado: las dos vistas cargan `/js/salaPoll.js` antes del partial, y el `.ejs` ya no
   contiene `s.seq < seq` ni `seq = s.seq`.

### Agregados el 2026-09-08 (RN-1 corregida y RN-5)

9. Con dos pedidos emitidos y **ninguna respuesta pintada todavía**, la respuesta del primero
   **se pinta** y mueve el cursor: es la única que llegó.
10. El orden se sigue respetando en la otra dirección: si `b` (posterior) volvió primero y se
    pintó, la respuesta de `a` se descarta igual.
11. Con el viaje **más largo que el intervalo** (4200, 6000 y 9000 ms), 60 s de clase pintan los
    mismos mensajes que con la red buena y el cursor termina donde el servidor. Con la regla
    vieja: 0 mensajes y el cursor clavado donde arrancó.
12. El cableado del ciclo: el partial ya no contiene `setInterval(pollear` ni `setInterval(ciclo`
    (leído **sin los comentarios**, que nombran el viejo para explicar por qué se fue), y la
    vuelta siguiente se programa con `setTimeout(ciclo`.
13. El `fetch` del poll lleva `AbortController` y le pasa el `signal`: sin plazo, un pedido
    colgado frena el ciclo encadenado para siempre.

## Lo que NO entra

- **Websockets.** Cambiar el transporte es otra discusión: con las respuestas ordenadas, el
  poll de 4 s hace lo que tiene que hacer.

  **Repropuesto por el usuario el 2026-09-08** ("serviría para descongestionar el uso del
  servidor"), y vuelve a quedar afuera, ahora con números. **No hay congestión que descongestionar**:
  ese día producción llevaba 24,6 h de uptime sin un reciclado, la app respondía en 7 ms y el poll
  de la sala ya está **exento del `generalLimiter`** (`LIVE_ROOM_PATHS` en `server.js`), así que no
  puede agotarle el cupo al login de nadie. Lo que sí había era este bug, y RN-5 se lleva de paso
  los polls apilados, que eran el gasto real.

  Lo que un WebSocket **no** arregla es la causa de fondo, que es la red: 5% de pérdida y 261-350 ms
  hasta Alemania (ver [[latencia-linea-base]]). Y trae el mismo problema con otra cara —una conexión
  muerta hay que detectarla, reconectarla y resincronizar por `seq`, contra el doble NAT de la
  escuela que mata conexiones ociosas—, más el **hub único** que exigen los 2 workers de PM2: un
  mensaje que entra por el worker A no llega a quien está colgado del B. El patrón para eso ya
  existe (`middleware/rtc-proxy.js` tuneliza el WS de la transmisión a un proceso único), pero es
  la mitad del trabajo, no un detalle. **Si alguna vez se hace, va con spec propia.**
- **Cerrar el hueco del `$inc` en el servidor.** Se podría insertar el mensaje y numerarlo
  en una sola operación, pero eso toca la ruta más caliente de la app y `RN-3` ya deja el
  síntoma sin efecto desde el navegador.
- **UI optimista** (pintar el mensaje propio antes de que el servidor conteste). Tentador,
  pero agrega un segundo estado de verdad en la pantalla justo donde acabamos de sacar uno.
