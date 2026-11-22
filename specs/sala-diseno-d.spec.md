# Sala en vivo: diseño D (parte de B "Panel lateral" y suma cosas de C)

> Pedido del usuario, 2026-11-22: *"el botón que permanezca al lado donde dice la sala no está
> abierta. Cuando la misma se abra, ahí recién que aparezca la opción de Transmitir. Generalo como
> la opción D. Ahí te voy a ir cargando las nuevas especificaciones, porque voy a ir compilando
> entre las opciones B y C."*

Estado: **en construcción con el usuario** ("Hazlo y lo voy corrigiendo en el camino",
2026-11-22). D1 a D7 implementados; se sigue ajustando.

Se monta sobre lo que ya existe en `specs/sala-disenos.spec.md` (mismo selector, misma mudanza de
botones, mismo freno de mano, mismas reglas). D se agrega como un diseño más en
`config/salaDisenos.js` (`id: 'mixto'`, rótulo **"Aula virtual"**, clase `lr-diseno-d`). B y C siguen como están.

## Base

**D arranca igual que B "Panel lateral"** (`specs/maquetas-sala/B-panel-lateral-*.png`): chat
grande a la izquierda y el panel fijo a la derecha con Controles de la clase, Manos levantadas y
Quién está; en el celular, solapas. Todo lo que no se cambie acá es igual a B.

## Cambios sobre B

### D1 — Un solo botón Abrir / Cerrar sala, en la cabecera

> Aclaración del usuario, 2026-11-22: *"Abrir Sala y Cerrar Sala, es el mismo botón"*.

El botón vive en la **cabecera**, a la derecha del estado, y cambia según cómo esté la sala:

| Sala | Cabecera | Botón |
|---|---|---|
| Cerrada | `CERRADA · La sala no está abierta` | **Abrir sala** (azul, relleno) |
| Abierta | `EN VIVO · Clase de hoy · desde las HH:MM` | **Cerrar sala** (rojo, con borde) |

Ya **no** aparece en el panel de Controles de la clase.

Por dentro son los dos botones de siempre (`#lrAbrir` y `#lrCerrar`), mudados juntos al mismo
lugar de la cabecera: el script ya muestra uno u otro según el estado de la sala, así que en
pantalla se ven como un único botón que cambia. No hay lógica nueva, y cerrar la sala sigue
pidiendo la confirmación de siempre.

### D2 — La transmisión aparece recién con la sala abierta

Con la sala **cerrada**, la tarjeta de la transmisión ("La clase no se está transmitiendo" con
**Hablar** y **Transmitir**) **no se muestra**. Hoy, en B, se ve aunque la sala esté cerrada.

Cuando el docente abre la sala, la tarjeta aparece (en el poll siguiente o en el acto, el mismo
repintado que hoy muestra los controles al abrir).

Es solo de presentación: la ruta de la transmisión ya exige sala abierta y no cambia.

### D3 — La barra de botones de abajo, como en C "Modo aula"

> Pedido del usuario, 2026-11-22: *"quiero los botones de la opción C, en la parte de abajo"*.
> Al preguntarle qué hacer con los controles que ya están en el panel: *"en el panel, la barra
> solo transmisión"*.

Una barra fija al pie de la sala, con los **botones redondos con el rótulo debajo** de C
(`specs/maquetas-sala/C-modo-aula-docente.png`), en dos grupos separados por una línea:

**Docente**

| Grupo | Botones |
|---|---|
| Transmisión | **Micrófono · Pantalla · Cámara · Terminar** (aparecen mientras transmite, igual que hoy) |
| La clase | **Crear actividad** |

- **Alumnos escriben, Fotos de los alumnos y Sonido para la clase se quedan en el panel** de
  Controles de la clase, como en B. No van a la barra.
- **Crear actividad** sale del panel y pasa a la barra.
- **Abrir / Cerrar sala** no está en la barra: es el botón de la cabecera (D1).
- **Hablar** y **Transmitir** siguen en la tarjeta de la transmisión, que se ve con la sala
  abierta (D2). Cuando el docente arranca a transmitir, sus botones aparecen en la barra.
- Con la sala cerrada no hay nada que apretar ahí: la barra no se muestra.

**Alumno**: **Levantar la mano** (y **Dejar de ver**, si se confirma D-D1). No hay "Ver la
clase": en D el alumno entra viendo (D4).

Como en C: los botones son los de siempre mudados a la barra (sin lógica nueva), la barra queda
fija al pie de la ventana mientras se ve la sala, los menús que cuelgan de ella se abren hacia
arriba, en el celular se desliza de costado si no entra, y sigue el tema claro/oscuro del sitio.

### D4 — El alumno entra viendo la transmisión, sin tocar nada

> Pedido del usuario, 2026-11-22: *"El alumno directamente entra viendo la transmisión, no se le
> pregunta. Ve al docente directamente transmitiendo, ya sea su cámara web o pantalla y cámara,
> lo ve como la mitad de la pantalla del celular, y la parte de abajo ve el chat del grupo."*

**Cómo se ve en el celular del alumno**

- **Mitad de arriba**: el video del docente — su cámara, o su pantalla grande con la cámara chica
  en la esquina si comparte pantalla (lo que ya hace la transmisión desde 1.0.116). Queda fijo
  arriba mientras el alumno se mueve por el chat.
- **Mitad de abajo**: el chat del grupo, con el cuadro de escribir siempre visible abajo.
- Si el docente transmite **solo la voz** (Hablar), no hay video: arriba queda una franja chica
  con "Estás escuchando la clase" y el chat ocupa el resto.
- Si **no hay transmisión**, el chat ocupa toda la pantalla, como hoy.
- En la computadora *(sin indicación todavía)*: el video arriba de la columna izquierda y el chat
  debajo, con el panel de la derecha de B.

**Cómo arranca**

- Al entrar a la sala con la transmisión activa —o cuando el docente empieza a transmitir con el
  alumno ya adentro— el navegador del alumno **se conecta solo** (lo mismo que hoy hace el botón
  "Ver la clase", sin el botón).
- **El sonido**: los navegadores no dejan reproducir audio en una página hasta que la persona la
  toca. Si el alumno llegó a la sala tocando la solapa "En vivo" de la materia, eso ya cuenta y
  el sonido arranca solo. Si no (por ejemplo, entró por un enlace directo), el video arranca
  **sin sonido** y aparece sobre el video **"🔇 Tocá para escuchar"**: un toque y listo. Esto no
  se puede saltear: lo impone el navegador, no la plataforma.

### D5 — El celular de costado: pantalla completa, con el chat a la derecha

> Pedido del usuario, 2026-11-22: *"si el alumno o el docente están en celular y lo coloca en
> horizontal, puede ver la transmisión en pantalla completa, o transmitir, en modo completo, y
> abajo le puede aparecer botones sobre la transmisión para que pueda desactivar los mensajes del
> chat o activarlos, porque quiero que del lado derecho le figure una pequeña sala […] poder
> escribir en el chat, ver los mensajes, reaccionar."*

Con el celular **de costado** y video en pantalla (el alumno mirando, o el docente transmitiendo
y viéndose en su vista previa):

- El video ocupa **toda la pantalla** a la izquierda.
- A la **derecha**, una franja (≈ 38 % del ancho) con **la sala chica**: los mensajes, el cuadro
  para escribir y las reacciones — es el mismo chat de siempre, no una copia.
- **Abajo, flotando sobre el video**, la barra de D3 en versión translúcida, con un botón más al
  principio: **Ocultar chat / Mostrar chat**. Oculto, el video ocupa todo el ancho.
- Quién tiene la palabra queda arriba a la izquierda, sobre el video.
- Al volver a poner el celular parado, todo vuelve a como estaba.

Es "pantalla completa" dentro de la página: la barra del navegador puede seguir visible (la
pantalla completa real del navegador pide un toque y se puede sumar después si hace falta).

### D6 — El estado de la transmisión y "Transmitir", en el medio de la cabecera

> Pedido del usuario, 2026-11-22 (con captura): *"Quiero mover ese rectángulo al centro […]
> Acórtalo para que solo quede el botón Transmitir, y la descripción de 'la clase no se está
> transmitiendo' o si…"* (el mensaje llegó cortado; se entendió "o si se está transmitiendo").

- El rectángulo de la transmisión (el punto, el texto y el botón) pasa a una **pastilla en el
  medio de la cabecera**, entre el título de la clase y el botón Abrir/Cerrar sala.
- Dice **"La clase no se está transmitiendo"** con el botón **Transmitir**, o **"Laura Gómez está
  transmitiendo · 9 mirando"** mientras transmite (los botones de la transmisión están en la
  barra de abajo, D3).
- **"Hablar" (solo la voz) no se ofrece en D.**
- La tarjeta de la transmisión (el video, quién tiene la palabra, "Solo yo hablo / Todos pueden
  hablar") aparece recién **mientras se transmite**; sin transmisión no queda un recuadro vacío.
- En el celular, la pastilla baja a su propio renglón dentro de la cabecera.

### D7 — Al transmitir, la sala se reacomoda: video a la izquierda, chat a la derecha

> Pedido del usuario, 2026-11-22 (con captura): *"al darle click en el botón de transmitir, se
> auto acomode la sala, abriendo del lado izquierdo como está la pantalla a transmitir (ya sea web
> o pantalla o las dos) y del lado derecho pase el chat, acomodando los botones de configuración,
> como un botón arriba más o menos a la derecha a la misma altura que diga más opciones, y
> despliegue opciones y luego se oculten los chats, para poder transicionar de uno a otro."*

En la computadora, **mientras hay transmisión** (para el que transmite y para el que mira):

- **Izquierda**: la transmisión — la cámara, la pantalla o las dos (pantalla grande y cámara chica).
- **Derecha**: el **chat**, en lugar del panel de B.
- Arriba de la columna derecha, un botón **"Más opciones"** (con el número de manos levantadas en
  rojo si hay). Al tocarlo, la columna derecha muestra **las opciones** — Controles de la clase,
  Manos levantadas y Quién está — y el chat se oculta; el botón pasa a **"Volver al chat"**.
- Al terminar la transmisión, la sala vuelve a como estaba (chat a la izquierda, panel a la
  derecha).
- *Ajuste del 2026-11-22 (con captura): "bajes ese botón que quede un poco más dentro de esas
  opciones" y "extiendas el chat […] un poco más ancho".* El botón va **adentro** de lo que se
  está mirando: en la cabecera del chat ("Más opciones"), o en el título de la primera tarjeta de
  las opciones ("Volver al chat"). Mientras se transmite, la columna derecha pasa de 340 a
  **440 px** de ancho.

En el celular no cambia: parado siguen las solapas, de costado la pantalla completa (D5).

### Decisiones

- **D-D1 · Resuelta (2026-11-22): automático solo en D, con "Dejar de ver" a mano.** El usuario
  aceptó la recomendación (b)+(c). Clásico, B y C siguen con el botón "Ver la clase". Si el alumno
  toca "Dejar de ver", no se lo vuelve a conectar solo hasta que esa transmisión termine.

Lo que se había planteado:

- **Choca con D12 de la transmisión.** Hoy el alumno tiene que tocar "Ver la clase" a
  propósito, por tres razones escritas en `transmision-en-vivo.spec.md` (D12):
  1. **Clases presenciales**: si los 30 alumnos están en el aula con el docente y la sala abierta,
     con conexión automática bajarían el video 30 veces por la internet de la escuela para ver lo
     que está proyectado en la pared.
  2. **Datos del celular**: un alumno con datos móviles gasta sin elegirlo: entre 80 MB (lo medido el
     22/11, imagen quieta) y 190 MB (el tope a calidad media) por hora de clase.
  3. **El servidor**: todos los que están en la sala pasan a contar para el ancho de banda.

  Opciones: (a) automático siempre, como pidió el usuario; (b) automático, pero con un botón
  **Dejar de ver** a mano para el que quiera cortar; (c) automático solo en el diseño D, que el
  docente elige para sus clases virtuales, y Clásico/B/C siguen con el botón. *Recomendado: (b)
  y (c) juntas* — el docente que pone D sabe que es una clase a distancia, y el alumno conserva
  la forma de cortar.

## Notas de implementación

- D reusa las reglas de B (todas las de `.lr-diseno-b` pasaron a valer también para D) y las de la
  barra de C; lo propio de D está en su bloque de `sala-disenos-estilos.ejs`.
- D2 y la barra se apagan con la sala cerrada mirando `data-estado` del contenedor, que pone
  `pintarDiseno()` en cada poll.
- La conexión automática (`mirarSolo()`) llama a lo mismo que el botón "Ver la clase"; si el
  navegador no deja sonar, aparece "Tocá para escuchar" (`#txSonido`).
- D5 es CSS: `(orientation: landscape) and (max-height: 520px)` con video a la vista.

## Pendiente

- Las próximas correcciones del usuario.
- Criterios de aceptación definitivos y prueba en celulares reales (parado y de costado).
