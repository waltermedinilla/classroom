# Sala en vivo: tres diseños nuevos (A "Ordenada", B "Panel lateral", C "Modo aula") que elige el docente

> Pedido del usuario, 2026-11-22: *"generarme la spec de cada una de ellas […] me interesa la b y
> c de docente y alumno, además, quiero que le figure al docente si quiere el panel b o c o seguir
> con el que tiene"*, y enseguida: *"la A también incluila"*.

Estado: **aprobada el 2026-11-22** ("Comienza"), con las seis decisiones en su recomendación.
**B y C en uso. A "Ordenada" se retiró el 2026-11-22** a pedido del usuario ("no me gusta"): ya
no se ofrece, no se puede elegir y quien lo tenga guardado ve Clásico. Su id sigue en los enums de
los modelos (sacarlo haría fallar el guardado de quien lo hubiera elegido) y en
`config/salaDisenos.js` con `listo: false`; su CSS y sus mudanzas se borraron. Lo que sigue de S5
queda como registro.

**Las maquetas son parte de esta spec** y están al lado, en `specs/maquetas-sala/`:

| Archivo | Qué muestra |
|---|---|
| `A-ordenada-docente.png` | A, docente, computadora |
| `A-ordenada-alumno-celular.png` | A, alumno, celular |
| `B-panel-lateral-docente.png` | B, docente, computadora |
| `B-panel-lateral-alumno-celular.png` | B, alumno, celular |
| `C-modo-aula-docente.png` | C, docente, computadora |
| `C-modo-aula-alumno-celular.png` | C, alumno, celular |

Son del 24/09/2026 (los originales, con sus `.html`, siguen en `proyectos\maquetas-sala-en-vivo\`).
**Donde esta spec y una maqueta no coincidan, manda la maqueta.** Las combinaciones que no tienen
maqueta (docente en celular, alumno en computadora) se describen acá derivadas de las que sí, y
están marcadas *(sin maqueta)*.

---

## Problema

La sala de hoy (de acá en adelante, **"Clásico"**) es una columna de tarjetas apiladas: aviso →
presencia y fila de botones → transmisión → chat → cuadro de escribir. Funciona y nadie quiere
romperla, pero:

1. **Con la transmisión activa, el chat queda fuera de la pantalla.** El video ocupa 16:9 de todo
   el ancho; en una notebook de 1366×768 el chat empieza debajo del pliegue. El docente que
   transmite no ve las preguntas.
2. **Los controles del docente son una fila de 7 a 9 botones iguales** (Abrir/Cerrar sala, modo,
   fotos, sonido, crear actividad, campana, clases anteriores) que se parten en renglones y no
   dicen en qué estado están: "Solo yo escribo" ¿es lo que pasa o lo que va a pasar?

Cada maqueta lo resuelve distinto, y sirven para clases distintas: **A** es Clásico ordenado,
**B** pone el chat al frente para clases de charla y **C** pone el video al frente para exponer.
Por eso **elige el docente**, y Clásico sigue siendo una opción y el valor por defecto.

## Alcance

- Tres diseños nuevos, **A**, **B** y **C**, cada uno en su versión para quien **gestiona**
  (docente) y para quien **mira** (alumno), en computadora y en celular.
- Un **selector de diseño** para el docente, dentro de la sala: Clásico, A, B o C.
- La elección se recuerda para las clases siguientes del mismo docente.
- **Clásico no cambia**: mismo HTML, mismo CSS, mismo comportamiento que hoy.

### Fuera de alcance

- Cambiar qué hace cualquier botón, permiso o regla. **Esto es disposición visual**: ninguna ruta,
  permiso ni poll de la sala cambia de comportamiento (salvo la ruta nueva del selector).
- **El interruptor "Reacciones"** que dibujan las tres maquetas. Hoy no existe: es de
  `specs/sala-reacciones.spec.md` (aprobada el 17/09, sin desplegar). Los tres diseños le dejan
  el lugar; aparece cuando esa spec se implemente. Ver D-6.
- Los paneles de supervisión (`/directivo/en-vivo`, `/preceptor/en-vivo`), la página de clases
  anteriores, el modal de "Crear actividad", el lightbox y los menús de sonido (se reusan tal cual).

## Decisiones de diseño

### S1 — Un solo HTML, cuatro hojas de estilo. La lógica no se toca

Es lo que hace que esto no pueda romper la sala ("ni se te ocurra cambiar nada, porque es lo que
funciona", 24/09).

- El HTML de la sala sigue siendo **uno solo**, con **los mismos `id`** de hoy (`lrChat`,
  `lrTexto`, `lrAbrir`, `lrModo`, `lrFotos`, `txCuadro`, …). El JavaScript de `live-room.ejs` y de
  `public/js/transmision.js` busca por `id`: si los `id` no cambian, no se entera de que la sala
  se ve distinta.
- El diseño se elige con **una clase en el contenedor** `.lr-wrap`: sin clase extra (Clásico),
  `lr-diseno-a`, `lr-diseno-b`, `lr-diseno-c`.
- Los diseños reacomodan las tarjetas con **CSS Grid y `grid-template-areas`**. Cada bloque recibe
  una clase de área (`lr-area-cabecera`, `lr-area-controles`, `lr-area-presencia`, `lr-area-tx`,
  `lr-area-manos`, `lr-area-chat`, `lr-area-barra`). En Clásico esas clases no tienen reglas.
- Todas las reglas nuevas van **prefijadas** con `.lr-diseno-a`, `-b` o `-c` (CA-14 lo controla).
- **Donde un diseño necesita un control en otro lugar o con otra forma** (un interruptor en vez de
  un botón, un botón redondo en la barra de C), se agrega un elemento nuevo que **delega el clic
  en el original** (`original.click()`) y **lee su estado del original** (su rótulo o su
  `aria-pressed`, que ya escribe `pintarEstado()`). Mismo patrón que el botón chico de compartir
  pantalla (`specs/transmision-camara-primero.spec.md`, C4). **Nunca dos caminos con lógica
  propia.** Los originales quedan en el DOM, ocultos en ese diseño.

### S2 — Lo elige el docente y la clase lo sigue

- La elección vive en `RoomSession.settings.diseno` y viaja en el poll de siempre (cada 4 s). Un
  cambio a mitad de clase les llega a los alumnos en el poll siguiente **sin recargar**: el
  JavaScript cambia la clase del contenedor y nada más.
- El último diseño elegido se guarda en `User.salaDiseno`. La próxima sala que abra el docente
  arranca con ése. Mismo criterio que `User.modoCorreccion`.
- ⚠️ Ver D-1 (¿o cada uno elige el suyo?).

### S3 — El selector

Un botón con ícono `dashboard_customize` y texto **"Diseño"** que abre un menú de cuatro
opciones, cada una con su línea:

- **Clásico** — "Como siempre."
- **Ordenada** — "Lo mismo, con los controles agrupados y con su estado a la vista."
- **Panel lateral** — "Chat grande y los controles a un costado. Para clases de charla."
- **Modo aula** — "Oscuro, el video grande y los botones abajo. Para exponer o transmitir."

Mismo patrón que el menú de "Sonido: …" que ya existe (`.lr-menu`, `role="menu"`,
`menuitemradio`, `aria-checked`). Solo para quien gestiona. Dónde va en cada diseño: Clásico, al
final de la fila de botones; A, en la cabecera al lado de "Clases anteriores"; B, al pie del panel
de controles; C, en la barra de arriba, al lado de "Clases anteriores". Se aplica **en el acto**
en la pantalla del docente y se manda al servidor.

### S4 — Lo común a A, B y C (sale de las tres maquetas)

Todo esto se ve igual en los tres diseños, y se arma con datos que la sala **ya tiene**:

- **Cabecera nueva**: pastilla roja **EN VIVO**, título de la clase ("Clase del jueves 24/09" o
  "Clase de hoy · desde las 08:02") y la línea "15 en la sala · 20 de 25 se conectaron".
  Reemplaza la línea de estado de hoy (`#lrEstadoTexto`), que queda oculta y sigue siendo la
  fuente del texto.
- **El aviso de supervisión** (RN-15 de `sala-en-vivo.spec.md`) dentro de la cabecera, más chico.
  Sigue visible siempre.
- **"Dar presente"** arriba de todo en el celular del alumno (es el `asistencia-banner` de hoy).
- **Presencia con contadores**: chips "● 15 en la sala · ● 3 en la actividad · 2 estuvieron ·
  5 ausentes" sobre los círculos con apellido; el que está en la actividad lleva un distintivo
  naranja, el que estuvo tiene borde punteado, el ausente va apagado. Todo sale de
  `presencia.conectados / estuvieron / ausentes` del poll.
- **En el chat**: los mensajes propios a la derecha con burbuja de color ("Vos"); los del docente
  con la etiqueta **DOCENTE**; el aviso de actividad nueva como tarjeta con "Ver actividad"; y
  arriba del chat, el estado de la palabra ("🔒 Todos pueden escribir" / "Solo el docente").
- **Turnos para hablar** (si hay transmisión): quién tiene la palabra, con **Cortar** para el
  docente, y la cola con **Darle la palabra**. Para el alumno, **Levantar la mano**.

### S5 — A "Ordenada"

Ver `A-ordenada-docente.png` y `A-ordenada-alumno-celular.png`. Es Clásico, con el mismo orden de
arriba hacia abajo, pero agrupado.

**Docente, computadora:**
1. **Cabecera** (S4) con la campana y "Clases anteriores" a la derecha.
2. Tarjeta **LA CLASE**: interruptores con su estado — *Alumnos escriben* (es `#lrModo`), *Fotos
   de alumnos* (`#lrFotos`), *Reacciones* (D-6) — y el desplegable **Sonido: todos ▾**
   (`#lrSonidoClase`). Abajo, **Crear actividad** (azul, relleno) y **Cerrar sala** (rojo, borde).
3. **Presencia** (S4).
4. **Transmisión**: pastilla **TRANSMITIENDO** + "Tu pantalla y tu voz"; a la derecha
   **Micrófono**, **Pantalla**, **Cámara** (verde los prendidos) y **Terminar** (rojo). El video a
   la izquierda y, al lado, la columna **TURNOS PARA HABLAR**.
5. **Conversación** con el cuadro de escribir y los emojis abajo.

**Alumno, celular:** "Dar presente" → cabecera con campana y "Clases anteriores" → presencia →
transmisión ("Estás viendo la clase", **Dejar de ver**, el video, y debajo los turnos y
**Levantar la mano**) → conversación.

*(sin maqueta)* Docente en celular: el mismo orden; los interruptores de LA CLASE en lista de a
uno por renglón. Alumno en computadora: como el docente, sin la tarjeta LA CLASE y sin los
botones de transmisión.

### S6 — B "Panel lateral"

Ver `B-panel-lateral-docente.png` y `B-panel-lateral-alumno-celular.png`.

**Docente, computadora (≥ 900 px):** cabecera de ancho completo (EN VIVO, título, contadores y el
aviso a la derecha) y debajo dos columnas:

| Izquierda (≈ 70 %) | Derecha (≈ 30 %, fija al hacer scroll) |
|---|---|
| **Transmisión**: "Estás transmitiendo tu pantalla y tu voz", el video con la pastilla flotante "Tomás Ruiz tiene la palabra · **Cortar**" abajo a la izquierda, y debajo **botones redondos** con rótulo: Micrófono, Pantalla, Cámara, Terminar | **CONTROLES DE LA CLASE**: lista de interruptores con explicación — *Los alumnos pueden escribir* ("Si lo apagás, solo escribís vos"), *Fotos de los alumnos*, *Reacciones con emoji* (D-6), *Sonido para la clase* [Todos ▾]. Abajo **Crear actividad** (azul, ancho completo) y **Cerrar sala** (rojo, borde) |
| **Conversación**: en la cabecera, la campana ▾ y "Clases anteriores". Acciones *responder · borrar* debajo de cada burbuja. Cuadro de escribir con botón **Enviar** con texto, y los emojis debajo | **MANOS LEVANTADAS** ("2 en espera") con **Darle la palabra** |
| | **QUIÉN ESTÁ** ("20 de 25") agrupado: *En la sala · 15 (+ docente)* en círculos; *Haciendo la actividad · 3* en lista con "hace 6 min"; *Estuvieron · 2* con su horario ("08:05–08:14"); *No entraron · 5*, apagados |

- El chat tiene alto fijo y scroll propio: **el cuadro de escribir no se va de la pantalla**
  (arregla el problema 1).
- *Haciendo la actividad · hace N min* y *Estuvieron 08:05–08:14* salen del poll
  (`enActividad`, y la hora de entrada y salida que ya trae `estuvieron`). Si algún dato no
  viene en el poll, se muestra sin él: no se agrega nada al poll por esto.

**Alumno, celular:** "Dar presente" → cabecera (EN VIVO, "Clase de hoy · desde las 08:02",
contadores, aviso) → **solapas**: **Chat** (al frente por defecto), **Presentes 15**, **Manos**
(con contador rojo) → la transmisión ("Estás viendo la clase", con la pastilla de quién tiene la
palabra sobre el video) y debajo **Levantar la mano** y **Dejar de ver** → la conversación (campana
▾ y "Clases anteriores" en su cabecera, burbujas con DOCENTE, tarjeta de actividad grande, cuadro
con **Enviar** y emojis debajo).

- Las solapas son botones con `role="tab"`. Cambiar de solapa es mostrar u ocultar, sin pedir
  nada al servidor. Un mensaje nuevo con otra solapa al frente pone un punto en **Chat**.

*(sin maqueta)* Docente en celular: las mismas solapas más una cuarta, **Controles**, con la
lista de interruptores, Crear actividad y Cerrar sala. Alumno en computadora: las dos columnas;
el panel derecho sin CONTROLES DE LA CLASE.

### S7 — C "Modo aula"

Ver `C-modo-aula-docente.png` y `C-modo-aula-alumno-celular.png`. Estilo Meet. La maqueta es
oscura, pero **C sigue el botón de tema claro/oscuro del sitio**, como el resto de la plataforma
(pedido del usuario, 2026-11-22: *"que se acople a la situación"*): en claro se ve claro y en
oscuro, como la maqueta. Respeta los contrastes ya medidos para los dos temas (≥ 4,5:1 en texto,
CA-20).

**Docente, computadora:**
- **Barra de arriba**: flecha para volver, "Matemática · 3.° 2.ª / Clase en vivo", **EN VIVO**,
  "desde 08:02 · **00:24:13**" (cronómetro de la clase, calculado en el navegador desde la hora de
  apertura), y a la derecha la pastilla "👥 15 en la sala · 20/25", la campana y "Clases
  anteriores".
- **Franja del aviso** de supervisión, ancho completo, debajo de la barra.
- **Escenario** (izquierda, grande): el video con la etiqueta "Pantalla de Laura Gómez" arriba a la
  derecha; **flotando abajo a la derecha, MANOS LEVANTADAS** con Darle la palabra; **abajo a la
  izquierda, la pastilla verde** "Tomás Ruiz tiene la palabra · Cortar". Debajo del escenario, la
  tarjeta **Quién está** (contadores y círculos). Sin transmisión, el escenario muestra la presencia
  en grande.
- **Conversación** en una columna fija a la derecha, con *responder · borrar* arriba a la derecha
  de cada mensaje y el cuadro de escribir abajo.
- **Barra de abajo**, fija y centrada, con botones redondos y rótulo debajo, en tres grupos
  separados por una línea: **Micrófono · Pantalla · Cámara · Terminar transmisión** | **Alumnos
  escriben · Fotos de alumnos · Reacciones (D-6) · Sonido: todos ▾** | **Crear actividad** (azul
  claro, grande) · **Cerrar sala** (rojo, ícono de colgar).

**Alumno, celular:** barra de arriba (volver, título, EN VIVO, cronómetro, "15 en la sala ·
20/25", campana, "Clases anteriores") → franja del aviso → escenario con la etiqueta de la pantalla
y, debajo dentro del mismo bloque, MANOS LEVANTADAS → barra verde "Tomás Ruiz tiene la palabra" →
Quién está → Conversación con cuadro de escribir y emojis → **barra fija abajo: Dar presente**
(verde) · **Levantar la mano** · **Dejar de ver**. El cuadro de escribir queda **encima** de la
barra, nunca tapado, también con el teclado abierto.

*(sin maqueta)* Docente en celular: los once botones no entran en 360 px; la barra muestra
Micrófono, Pantalla, Cámara, Terminar y un botón **Más** (`more_horiz`) que abre el resto en una
hoja desde abajo. Alumno en computadora: como el docente, con la barra del alumno.

### S8 — Lo que no cambia en ningún diseño

- El aviso de supervisión y "Dar presente" se ven siempre.
- El modo observación (dirección y preceptoría mirando sin aparecer) muestra su cartel y
  "Presentarme" en los cuatro diseños.
- Cuadro de escribir, adjuntos, emojis, respuestas, reacciones, lightbox y menús de sonido son los
  mismos elementos y funcionan igual.
- La página suelta (`views/rooms/standalone.ejs`) ve el diseño de la clase en su versión de alumno,
  sin el selector (D-3).

### Decisiones pendientes (con recomendación)

- **D-1 · ¿La clase sigue al docente o cada uno elige?** *Recomendado: la sigue (S2).* Si cada uno
  elige, el docente pierde la referencia de qué ve el alumno.
- **D-2 · ¿El alumno puede volver a Clásico por su cuenta?** *Recomendado: no por ahora.*
- **D-3 · Dirección y preceptoría en la página suelta: ¿diseño de la clase o Clásico?**
  *Recomendado: el de la clase*, para supervisar viendo lo mismo que los alumnos.
- **D-4 · ¿Se puede cambiar de diseño con la transmisión al aire?** *Recomendado: sí.* Los
  `<video>` son los mismos elementos; solo cambian de lugar (CA-12).
- **D-5 · Freno de mano.** *Recomendado: sí*, una constante `DISENOS_SALA_VISIBLES` en
  `config/salaDisenos.js`, en `true`. En `false` el selector desaparece y todas las salas se ven en
  Clásico, sin perder lo elegido. Mismo criterio que `BOTON_SUGERENCIAS_VISIBLE`.
- **D-6 · El interruptor "Reacciones".** Las tres maquetas lo dibujan y hoy no existe
  (`settings.reactionsOn` no tiene interruptor). *Recomendado: dejarlo fuera de esta spec* y que
  aparezca solo cuando se implemente `sala-reacciones.spec.md`; hasta entonces los diseños no lo
  muestran. La alternativa es implementarlo acá, lo que sí cambia comportamiento (y la spec de
  reacciones tiene sus propias reglas para el modo "solo yo escribo").

## Entidades / Schemas

### `models/User.js` — al lado de `modoCorreccion`

```js
// Diseño de la sala en vivo que eligió por última vez COMO DOCENTE (specs/sala-disenos).
// La próxima sala que abra arranca con éste. Default 'clasico': nadie ve un cambio que no pidió.
salaDiseno: { type: String, enum: ['clasico', 'ordenada', 'panel', 'aula'], default: 'clasico' },
```

### `models/RoomSession.js` — dentro de `settings`

```js
// El diseño de ESTA clase. Lo pone quien gestiona y lo ven todos (S2). Se copia de
// User.salaDiseno al abrir. Las sesiones viejas leen undefined → 'clasico'.
diseno: { type: String, enum: ['clasico', 'ordenada', 'panel', 'aula'], default: 'clasico' },
```

Sin índices nuevos. Sin migración.

### `config/salaDisenos.js` (nuevo)

`DISENOS` (la lista con id, rótulo, línea de ayuda e ícono, única fuente para el menú y la
validación) y `DISENOS_SALA_VISIBLES`.

### `services/liveRoom.js` — una función pura

```js
// Qué diseño se pinta. Valor desconocido o freno de mano puesto → 'clasico'.
disenoEfectivo({ guardado, visibles }) → 'clasico' | 'ordenada' | 'panel' | 'aula'
```

## Entradas y salidas

### `POST /courses/:id/sala/diseno` (nueva)

- Cuerpo `{ diseno }`, uno de los cuatro ids.
- Detrás de `cargarSala`. Solo quien gestiona; el resto, 403 por `fallar()`.
- Fuera de la lista → 400 `'Diseño no válido'`.
- Guarda `settings.diseno` de la sesión (si hay una abierta) **y** `User.salaDiseno`. **Con la
  sala cerrada también se puede elegir**: queda como preferencia y la próxima clase abre así.
  Con la sala cerrada, el poll del docente trae su preferencia como `settings.diseno` (para que
  vea el diseño elegido antes de abrir); el resto ve Clásico. *(Cambio del 2026-11-22: con 409 el
  docente veía "No se pudo cambiar el diseño" sin entender por qué.)* Auditoría: acción nueva
  `room.diseno` en `config/audit-actions.js`. Sin mensaje de sistema en el chat.

### `GET /courses/:id/sala/poll`

`settings.diseno` (ya pasado por `disenoEfectivo`), dentro del objeto `settings` que ya viaja.

### Render inicial

`routes/rooms.js` pasa el diseño efectivo y `live-room.ejs` pone la clase del contenedor desde el
servidor: la sala no parpadea de Clásico al diseño elegido en el primer poll.

## Reglas de negocio

- **RN-1** Sin elección, todos ven Clásico.
- **RN-2** Solo quien gestiona la materia cambia el diseño de la clase.
- **RN-3** El diseño es solo visual: si un control existe en Clásico para un rol, existe en A, B y
  C para ese rol, y ninguno de ellos tiene controles que Clásico no tenga (CA-13). Única excepción
  futura: "Reacciones", cuando se implemente su spec (D-6), que va a aparecer en los cuatro.
- **RN-4** Abrir la sala copia `User.salaDiseno` a la sesión. Cerrarla no lo borra del usuario.
- **RN-5** Con `DISENOS_SALA_VISIBLES = false`, todo se ve en Clásico y no hay selector.

## Criterios de aceptación

### Lógica pura (`node --test`)

- **CA-1** `disenoEfectivo`: `'ordenada'`, `'panel'` y `'aula'` pasan; `undefined`, `''`, `'A'`,
  `'otro'` → `'clasico'`; con `visibles: false`, siempre `'clasico'`.

### Servidor (smoke, con Mongo)

- **CA-2** El docente elige `'panel'`: queda en la sesión y en su usuario; el poll del alumno trae
  `settings.diseno: 'panel'`.
- **CA-3** Alumno, preceptoría, dirección o secretaría que piden `POST /sala/diseno` → 403, sin
  cambios.
- **CA-4** Valor inválido → 400. Sala cerrada → 200, y solo se guarda la preferencia.
- **CA-5** El docente abre una sala nueva: arranca con su último diseño.
- **CA-6** Sesión vieja sin el campo → Clásico.

### Vista (render de EJS en unit)

- **CA-7** Con `'clasico'`, el HTML de la sala es **idéntico al de hoy** salvo las clases de área
  y los elementos inertes nuevos (instantánea tomada antes del cambio).
- **CA-8** Con `'ordenada'`, `'panel'` o `'aula'`, el contenedor sale del servidor con
  `lr-diseno-a`, `-b` o `-c`.
- **CA-9** **Todos los `id` de hoy existen en los cuatro diseños** (barrido del render Clásico
  contra los otros tres). Es lo que asegura que el JavaScript encuentra todo.
- **CA-10** El selector aparece para quien gestiona y no para el alumno; con el freno de mano
  puesto, para nadie.
- **CA-11** Cada control nuevo de S1 (interruptor, botón redondo) tiene un `data-delega` que
  apunta a un `id` existente, y no tiene manejador propio con lógica.

### En el navegador (Docente Prueba y Alumno Prueba, curso "Prueba Transmisión")

- **CA-12** Con la transmisión al aire, el docente pasa de Clásico a A, B, C y vuelta: el video
  del alumno no se corta ni se congela.
- **CA-13** En cada diseño y cada rol, cada control de Clásico está y hace lo mismo (lista de
  control: 4 diseños × 2 roles × 2 tamaños).
- **CA-14** Ninguna regla CSS nueva sin prefijo `.lr-diseno-a/-b/-c`.
- **CA-15** Cada diseño, en computadora y en celular, se ve como su maqueta (comparación lado a
  lado con las PNG de `specs/maquetas-sala/`).
- **CA-16** B en 1366×768 con transmisión: el chat y el cuadro de escribir se ven completos sin
  scroll de la página.
- **CA-17** B en celular (360 px): las solapas funcionan y un mensaje nuevo pone el punto en Chat.
- **CA-18** C en celular: el cuadro de escribir nunca queda tapado por la barra, ni con el teclado
  abierto.
- **CA-19** El alumno ve el cambio de diseño en 4 segundos como mucho, sin recargar.
- **CA-20** Contraste del texto en C ≥ 4,5:1 en claro y en oscuro, medido en el navegador.

## Tests necesarios

- **Unit** (`tests/unit/salaDisenos.test.js`): CA-1, CA-7 a CA-11, CA-14.
- **Smoke** (`tests/smoke/specs.js`): CA-2 a CA-6; se corren en la PC de Walter.
- **Roles** (`tests/roles/check-roles.js`): la ruta nueva, 200 para docente y 403 para el resto.
- **Íconos**: `npm run iconos:actualizar` por los nuevos (`dashboard_customize`, `more_horiz`,
  `call_end`, `tune`, …); lo controla `tests/unit/iconos.test.js`.
- **Navegador**: CA-12, CA-13 y CA-15 a CA-20.

## Dependencias y riesgos

- **El riesgo principal es romper Clásico.** Lo cubren S1, CA-7, CA-9 y el freno de mano (D-5).
- **Grid sobre el DOM de hoy**: si un bloque no es hijo directo del contenedor, hace falta
  `display: contents` en el intermedio. Se revisa al implementar y se deja escrito en el código.
- **Los controles que cambian de forma** (interruptores de A y B, botones redondos de C) van por
  delegación (S1). El estado lo leen del original; si el original cambia de rótulo, el nuevo se
  entera en el mismo repintado.
- **Es trabajo grande.** Se puede implementar por partes, **un diseño por deploy** (A, después B,
  después C), cada uno con su CA-15. El selector muestra solo los diseños ya implementados (la
  lista de `config/salaDisenos.js` manda).

## Plan de migración

1. Deploy con el freno de mano en `true` y default `'clasico'`: nadie ve nada distinto hasta que un
   docente elija.
2. Probar con Docente Prueba y Alumno Prueba (CA-12 a CA-20).
3. Si algo falla en una clase real: `DISENOS_SALA_VISIBLES = false` y deploy. Todas las salas
   vuelven a Clásico en el poll siguiente, sin perder lo que eligió cada docente.

## Notas de implementación (2026-11-22)

- **La mudanza (ajuste a S1).** Mover los botones solo con CSS Grid no alcanzaba: los controles
  del docente viven todos juntos en `.lr-acciones` y A los reparte en dos tarjetas. Se resolvió
  **mudando los nodos** con JavaScript (`acomodarDiseno()` en `live-room.ejs`): el botón de
  siempre, con su `id` y sus manejadores, se lleva al lugar del diseño, y un comentario marca su
  lugar de Clásico para devolverlo exacto. La garantía de S1 se mantiene: los mismos elementos,
  ningún botón duplicado, ninguna lógica nueva. La lista está en `MUDANZAS`.
- **CA-7** se implementó comparando la lista de `id`, en orden, contra la sala de antes
  (`tests/fixtures/sala-clasico-antes.json`, generada del commit previo a los diseños) y el hash
  del `<style>` propio de la sala, que no cambió.
- **La solapa "En vivo" de la materia** se pinta vacía en el servidor a propósito (no consulta la
  sala, ver `views/course.ejs`), así que ahí el diseño se aplica con el primer poll, que corre
  recién cuando la solapa se hace visible. La sala suelta (`/courses/:id/sala`) sí lo trae del
  render.
- La línea "15 en la sala · 20 de 25 se conectaron" la arma `SalaPresencia.lineaCabecera()`, por
  la regla de `sala-presencia-en-actividad`: los textos de la presencia no van sueltos en el
  partial.
- El poll suma `apertura: { dia, desde, hoy }` para el título de la cabecera.
- "Reacciones" no aparece (D-6).

### B y C

- **B**: el panel de la derecha recibe por mudanza la tarjeta de controles (`#lrAClase`), las
  manos (`#txManos`) y la presencia (`#lrPresencia`). En el celular las solapas son **Chat ·
  Presentes · Manos** (+ **Controles** para el docente) y la transmisión queda siempre a la vista
  arriba del contenido de la solapa.
- **B, "Quién está"**: los que estuvieron muestran "se retiró a las 08:14" y no el rango
  "08:05–08:14", y "Haciendo la actividad" no muestra "hace N min": la presencia manda la hora de
  salida y no tiempos relativos a propósito (RN-3 de `sala-en-vivo-escala`, para no mover la
  huella de presencia en cada poll). Los rótulos de los grupos vienen de `SalaPresencia.GRUPOS`.
- **B, quién tiene la palabra**: va como pastilla oscura debajo del video, no flotando encima.
- **C sigue el tema del sitio** (claro u oscuro, con el botón de siempre): todo va con las
  variables del sitio y cada color fijo tiene su par en el bloque `[data-theme="dark"]`. Lo único
  oscuro en los dos temas es el cuadro de las manos cuando flota sobre el video, porque va encima
  de una imagen.
- **C, manos y palabra**: flotan sobre el video solo cuando hay video (`:has()`); sin video van
  en su lugar de siempre, dentro de la tarjeta.
- **C, celular del alumno**: "Dar presente" sigue siendo la banda verde de arriba (es el aviso de
  asistencia, que se ve igual en todos los diseños, S8), no un botón de la barra.
- **C, celular del docente** *(sin maqueta)*: la barra se desliza de costado en vez de un botón
  "Más": cero lógica nueva.
- Los iconos que C dibuja solo desde CSS (`play_arrow`, `call_end`, `campaign`) están listados
  en el comentario de `sala-disenos-estilos.ejs` para que el barrido de la fuente los incluya.
- La cuenta "15 en la sala · 20/25" y el "20 de 25" de B los arma `SalaPresencia`
  (`cuentaCorta`, `deTotal`), por la misma regla que la cabecera.

---

## Diseño fijo: D "Aula virtual" para todos (2026-11-22)

> "quiero quedarme con esa versión, así que cada vez que un docente haga click en 'en vivo'
> quiero que le aparezca la versión D, quiero que elimines el botón de diseño, que ya no nos
> hace falta."

- `config/salaDisenos.js` tiene `DISENO_FIJO = 'mixto'`. Con un valor ahí:
  - **Todas las salas se ven en D**, abiertas o cerradas, para el docente y para el alumno,
    sin importar lo que cada uno tenga guardado (`disenoEfectivo` devuelve el fijo).
  - **El botón "Diseño" no se dibuja**: `paraVista()` trae solo el diseño fijo, y con uno
    solo la vista no muestra el selector.
  - `disenoValido` solo acepta el fijo, así que la ruta del selector no puede elegir otro.
- **Es reversible**: lo guardado en `User.salaDiseno` y en `settings.diseno` no se borra. Con
  `DISENO_FIJO = null` vuelve el selector y cada uno queda como estaba.
- **El freno de mano sigue mandando**: con `DISENOS_SALA_VISIBLES = false`, todo vuelve a
  Clásico aunque haya un diseño fijo.
- **Dos arreglos que salieron al fijarlo**, porque antes el alumno casi nunca veía D:
  - **La cabecera del alumno.** El aviso de asistencia (`#asBanda`) va antes en el HTML, y aun
    vacío se quedaba con la fila 1 de la grilla, así que la cabecera caía debajo del panel o
    del video. Ahora `#lrACab` tiene `grid-row: 1`.
  - **La tarjeta vacía del docente.** Con la sala cerrada, la tarjeta de controles quedaba
    vacía (antes solo mostraba el botón "Diseño"). Ahora no se muestra.

### Sin salto al entrar a "En vivo" (2026-11-22)

> "porque al entrar, me figura como si fuera la primera vez que ingreso, y luego carga por
> defecto el diseño elegido"

**Causa.** La página de la materia no consulta la sala, para no hacer más lenta la ruta más
visitada. Por eso la solapa salía con un estado de relleno: Clásico y la sala "cerrada". Al
contestar el primer poll saltaba a D y al estado real.

**Arreglo.**
- **El primer render ya sale en D.** `views/course.ejs` pasa el diseño: el fijo si lo hay; si
  no, la preferencia del docente.
- **Mientras no contesta el poll, la cabecera dice "Cargando la sala…"** y el resto no se ve
  (`data-cargando` en `.lr-wrap`). El primer poll válido lo saca.
- Si el poll no contesta nunca (sin conexión), a los 8 segundos se muestra lo que hay, que
  es lo mismo que se veía antes.
- La sala en ventana aparte no usa este estado: esa ya sale con el estado real.
