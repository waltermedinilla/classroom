# Transmisión: arranca con la cámara, y la pantalla se comparte desde el cuadro del video

> Pedido del usuario, 2026-11-22, después de la primera prueba real en producción (1.0.115):
> *"si el profesor quiere transmitir, por defecto que se vea la cámara, no la pantalla, luego
> cuando esté transmitiendo, que al profesor le figure la opción de compartir pantalla, pero con
> un botón chico dentro del recuadro de la webcam"*.
>
> Decisión al preguntarle qué ven los alumnos al compartir: **"Pantalla grande, cámara chica"**,
> como en Meet.

Estado: **aprobada el 2026-11-22.** Modifica D6 de `specs/transmision-en-vivo.spec.md`.

---

## Problema

Hoy "Transmitir" abre el selector de pantalla del navegador y la cámara queda apagada (D6). En
la prueba real el docente esperaba verse él, como en Meet, y no le quedó claro qué estaba
mandando. Además:

1. **El docente no se ve a sí mismo.** Su propio video no se muestra en ningún lado: no sabe si
   la cámara anda ni qué ven los alumnos.
2. **Cámara y pantalla juntas no se ven bien.** El alumno tiene UN `<video>` y las dos pistas
   van al mismo `MediaStream`: el navegador muestra una sola, y no siempre la misma.
3. **Al alumno que entra tarde no le llega qué es cada pista.** El mensaje `bienvenido` del
   proceso de medios manda los productores sin su `fuente` (`productorNuevo` sí la manda).

## Alcance

- Por defecto, "Transmitir" prende **micrófono + cámara**. La pantalla queda apagada.
- El docente ve **su propia cámara** en el cuadro de la transmisión (vista previa local, en
  espejo, sin sonido).
- **Mientras transmite**, dentro de ese cuadro aparece un **botón chico** "Compartir pantalla"
  (ícono `screen_share`, esquina inferior derecha; la cámara chica va a la izquierda para no taparse). Al compartir, el mismo botón pasa a
  "Dejar de compartir" (`stop_screen_share`).
- **Al compartir**, el alumno ve **la pantalla grande y la cámara chica** en una esquina. Al
  dejar de compartir, vuelve a ver la cámara grande.
- Los tres botones de abajo (Micrófono, Pantalla, Cámara) **se quedan**: siguen sirviendo para
  apagar la cámara o el micrófono. El botón chico es un atajo, no un reemplazo.

### Fuera de alcance

- Grabación, fondos virtuales, elegir qué cámara usar (eso sigue siendo del navegador).
- Que el alumno pueda agrandar la cámara chica o cambiarla de esquina.
- Cambiar el diálogo del alumno, "Ver la clase" (D12) y la mano levantada (D7): no se tocan.

## Decisiones de diseño

### C1 — La cámara es lo primero. Reemplaza la primera mitad de D6

D6 eligió pantalla por ancho de banda: una pantalla quieta cuesta menos que una cámara a 360p.
El argumento es correcto, pero la prueba mostró que no es lo que el docente espera: abrir una
transmisión y ver el selector de pantalla confunde, y una clase sin cara se siente vacía.

El costo ya está cubierto: la cámara publica dos capas (125 y 400 kbps, simulcast) y el
gobernador de aforo (D5) baja a los alumnos a la capa chica, o a solo audio, cuando la escuela
se acerca al presupuesto. Ese mecanismo no cambia.

En la práctica: el botón "Transmitir" pasa `{ micro: true, pantalla: false, camara: true }`
en vez de `{ micro: true, pantalla: true, camara: false }`.

**Si el navegador no da la cámara** (no hay, o el docente niega el permiso), la transmisión
**no se cae**: sigue con micrófono solo y avisa "No se pudo prender la cámara. Seguís
transmitiendo con el micrófono." El docente puede compartir pantalla igual.

### C2 — Pantalla grande, cámara chica: dos `<video>`, no uno

El cuadro pasa a tener dos elementos:

- `#txVideo` (el grande): muestra la **pantalla** si hay, si no la **cámara**.
- `#txVideoChico` (el chico, esquina inferior izquierda, ~25 % del ancho, borde redondeado):
  muestra la **cámara** solo cuando también hay pantalla.

Cada pista de video se monta según su `fuente` (`'camara'` o `'pantalla'`), nunca por orden
de llegada. Eso resuelve el problema 2.

Para el problema 3, `bienvenido` manda `{ id, kind, fuente }` por cada productor, igual que
`productorNuevo`. Es un cambio de una línea en `media/servidor.js`, compatible: un cliente viejo
ignora el campo.

### C3 — La cámara chica viaja en la capa baja

Mientras hay pantalla, el alumno pide la capa **baja** de la cámara (125 kbps,
`setPreferredLayers` del consumidor). En una esquina chica no se nota la diferencia, y así
compartir pantalla cuesta por alumno ~0,56 Mbit/s (pantalla 400 + cámara chica 125 + audio 32)
en vez de ~0,83.

**El gobernador lo tiene que saber.** Hoy cuenta una sola capa de video por espectador. Con
pantalla + cámara suma la cámara chica (`CAMARA_CHICA_MBPS = 0.125` en `config/transmision.js`,
con su fundamento al lado). Si el gobernador ya bajó la sala a 180p o a solo audio, la cámara
chica **no se manda**: se ve solo la pantalla (o nada, en solo audio).

### C4 — El botón chico vive en el cuadro del docente, y solo ahí

El botón se pinta solo si `esGestor` y la pestaña **está emitiendo con video permitido**
(`puedoAbrirVideo`). No aparece en el cuadro del alumno, ni en "Hablar" (sala de solo voz,
que ya oculta pantalla y cámara).

Llama a las mismas funciones que el botón "Pantalla" de abajo (`publicarPantalla` y
`despublicar('pantalla')`), así que no hay un segundo camino que pueda desincronizarse. Si el
docente corta desde la barra del navegador ("Dejar de compartir"), el evento `ended` que ya
existe vuelve a pintar el botón chico.

### C5 — La vista previa del docente es local

El docente se ve con la pista de **su propia cámara**, sin pasar por el servidor (cero ancho
de banda, cero retraso). Va en espejo, como en Meet, y siempre `muted`. Cuando comparte
pantalla ve lo mismo que el alumno: su pantalla grande y su cámara chica.

### C6 — Apagar la pantalla o la cámara le avisa al servidor (encontrado al implementar)

`despublicar()` cerraba el productor solo en el navegador. mediasoup-client no avisa al SFU, así
que el productor seguía "vivo" allá: el alumno se quedaba con el último cuadro congelado y,
con este cambio, la cámara nunca volvería a ser la grande. Ahora el navegador manda
`{ t: 'cerrarProductor', producerId }` antes de cerrar; el proceso de medios cierra el productor
(solo si es del mismo usuario del ticket), avisa `productorSeFue` y recalcula capas y aforo.

Mismo arreglo de paso: `reanudar` aplicaba siempre la capa más alta aunque la sala estuviera
degradada; ahora reanuda cada video con la capa que le corresponde (`planDeVideo`).

## Archivos que se tocan

| Archivo | Cambio |
|---|---|
| `views/partials/live-room.ejs` | El botón "Transmitir" abre con cámara en vez de pantalla (C1). |
| `views/partials/transmision.ejs` | `#txVideoChico` y el botón chico dentro de `#txCuadro`, con sus estilos (C2, C4). |
| `public/js/transmision.js` | Montar pistas por `fuente`, vista previa local, capa baja para la cámara chica, cámara que falla sin tirar la transmisión (C1–C5). |
| `media/servidor.js` | `bienvenido` manda `fuente` (C2). |
| `config/transmision.js` | `CAMARA_CHICA_MBPS` (C3). |
| `media/aforo.js` | Suma la cámara chica cuando hay pantalla (C3). |
| `specs/transmision-en-vivo.spec.md` | Nota en D6: "reemplazada por C1 de transmision-camara-primero". |

## Criterios de aceptación

### Lógica pura (se testea sin navegador)

- **CA-1** Una función pura `ubicarPistas(pistas)` recibe `[{ fuente, kind }]` y devuelve qué
  va al cuadro grande y qué al chico:
  - solo cámara → grande: cámara, chico: nada
  - solo pantalla → grande: pantalla, chico: nada
  - cámara + pantalla → grande: pantalla, chico: cámara
  - ninguna → grande: nada, chico: nada (se ve "Estás escuchando la clase")
  - una pista sin `fuente` (cliente viejo) → va al cuadro grande, nunca se pierde.
- **CA-2** El gobernador: con pantalla + cámara, el costo por espectador en 360p es
  `0.432 + CAMARA_CHICA_MBPS`; en 180p o solo audio no se suma la cámara chica.
- **CA-3** `bienvenido` incluye `fuente` en cada productor (test sobre el armado del mensaje).

### Vistas (render de EJS en un test unitario)

- **CA-4** Con `esGestor: true`, `#txCuadro` contiene `#txVideoChico` y el botón chico
  `#txPantallaChico`; con `esGestor: false`, el botón chico no está.
- **CA-5** El botón "Transmitir" de `live-room.ejs` pide `camara: true` y `pantalla: false`.

### Prueba manual en producción (con Docente Prueba y Alumno Prueba)

- **CA-6** El docente toca Transmitir: el navegador pide micrófono y cámara (no pantalla), y
  el docente se ve en el cuadro, en espejo.
- **CA-7** El alumno toca "Ver la clase" y ve la cámara del docente grande.
- **CA-8** El docente toca el botón chico: elige pantalla. El alumno ve la pantalla grande y la
  cámara chica en la esquina. El docente ve lo mismo.
- **CA-9** El docente toca "Dejar de compartir" (en el botón chico o en la barra del
  navegador): el alumno vuelve a ver la cámara grande.
- **CA-10** El docente niega el permiso de cámara: la transmisión sigue con micrófono y aparece
  el aviso de C1.

## Nota sobre "se cortaba o tardaba"

En la prueba de 1.0.115 la imagen tuvo cortes y demora. Sin cambios de código, hay dos causas
esperables: la pantalla se manda a 5 cuadros por segundo a propósito (D6, texto quieto) y se ve
"a saltos" si hay movimiento, y la red del celular. Con la cámara (24 cuadros por segundo) debería
verse más fluido. Si después de este cambio los cortes siguen, se mira aparte: RTC_ANNOUNCED_IP,
si el video viaja por UDP o cae a TCP, y la capa que asigna el gobernador.
