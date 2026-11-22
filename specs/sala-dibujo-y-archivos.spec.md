# Sala en vivo: dibujar sobre la pantalla compartida y archivos de la clase en miniatura

Pedido del 2026-11-22, con una captura de la sala D transmitiendo:

> "cuando el docente comparte una pantalla, con el mouse que pueda ir añadiendo comentarios o
> ediciones en la 'pantalla compartida' si quiere resaltar algo que está compartiendo.
> además quiero saber si hay alguna opción donde vaya mostrando debajo o guardando los
> diferentes archivos del grupo así como imágenes etc, que se vean tipo miniatura"

---

## Parte 1 · Dibujar sobre la pantalla compartida (DB)

### DB1 · Quién y cuándo

- Solo quien emite (el docente) y solo mientras comparte pantalla.
- El botón **"Dibujar"** (icono `draw`) aparece dentro del cuadro del video, al lado de
  "Dejar de compartir".
- Funciona en los cuatro diseños: es parte de la transmisión, no de un diseño.

### DB2 · Herramientas

Al tocar "Dibujar", aparece arriba del video una barra flotante con:

| Herramienta | Qué hace |
|---|---|
| Lápiz | Trazo fino del color elegido. |
| Resaltador | Trazo grueso y translúcido, para pasar por encima de un texto. |
| Puntero láser | Trazo que se desvanece solo en poco más de un segundo, para señalar. |
| Texto | Un clic donde va el comentario, se escribe, y Enter lo deja. Escape lo cancela. |
| Colores | Rojo, amarillo, verde y azul. |
| Deshacer | Saca la última marca. También con Ctrl+Z. |
| Borrar todo | Saca todas las marcas. |
| Cerrar (✕) | Sale del modo dibujo. |

### DB3 · Qué ven los alumnos

Las marcas viajan **dentro del video**: los alumnos las ven sin hacer nada y sin
instalar nada, en cualquier diseño y en el celular.

- El navegador del docente arma, en un lienzo, la pantalla más las marcas, y lo manda en lugar
  de la pantalla sola (`replaceTrack`).
- No se agrega ningún canal nuevo, ni carga en el servidor, ni datos extra para el alumno.

### DB4 · Reglas

1. **Al salir del modo dibujo, las marcas se borran** y vuelve a viajar la pantalla sola.
2. **Si el docente se va a otra ventana** con el modo dibujo prendido, viaja la pantalla
   sola hasta que vuelve.
   - Motivo: el navegador frena casi por completo los temporizadores de una pestaña que no
     está a la vista. El lienzo se congelaría y los alumnos verían la imagen trabada.
   - Al volver, las marcas reaparecen.
3. **Las marcas se ubican respecto de la imagen, no del recuadro.** Se guardan en
   coordenadas de 0 a 1 sobre la imagen real, sin las franjas negras que deja `object-fit:
   contain`. Un trazo hecho fuera de la imagen no cuenta.
4. **El docente ve sus marcas en el acto**: se dibujan en una capa encima de su vista previa,
   sin esperar la vuelta del video. Lo que viaja es lo mismo, compuesto.
5. **Dejar de compartir** (con el botón de la app o con el del navegador) apaga el modo dibujo
   y suelta la pantalla de verdad. Esto incluye el aviso del navegador de que se está
   compartiendo.
6. **El lienzo no pasa de 1920 px de ancho** y se compone a 15 cuadros por segundo. La
   pantalla se sigue mandando con una sola capa de 400 kbps (como hasta ahora).

### DB5 · Técnica

- `public/js/transmision-dibujo.js` tiene dos partes:
  - La parte pura (coordenadas, lista de marcas, dibujo sobre un contexto 2D), que se prueba
    con `require`.
  - El control en el navegador.
- `transmision.js` publica la pantalla con `stopTracks: false`. Si no, `replaceTrack` pararía
  la captura original al cambiarla por el lienzo, y se cortaría el compartir.
- Al despublicar, se paran las dos pistas: la del productor y la captura original.
- No se agregan `id` al HTML: el botón, la capa y la barra los crea el script. Así Clásico
  sigue idéntico (CA-7 de `sala-disenos.spec.md`).

---

## Parte 2 · Archivos de la clase en miniatura (AR)

### AR1 · Qué es

Una tira horizontal, **"Archivos de la clase"**, entre la conversación y el cuadro de
escribir: en el lugar del rectángulo verde de la captura.

- Muestra en miniatura cada imagen y cada archivo compartido en la clase de hoy, del más
  nuevo al más viejo.
- Lleva el número total en el título.

### AR2 · Cada miniatura

- **Imagen:** la foto recortada en un cuadrado de 56 px. Un toque la abre en grande, con la
  misma lupa del chat.
- **Archivo:** un cuadrado con la extensión (PDF, DOCX…). Un toque lo abre en una pestaña
  nueva, igual que en el chat.
- Al pasar el mouse, se ven el nombre y quién lo compartió.

### AR3 · Reglas

1. Sale de los mensajes que ya están en el chat; no se agrega ningún pedido al servidor.
   - Límite conocido: el chat carga los últimos 100 mensajes. Un archivo más viejo que eso
     no aparece en la tira, pero sigue en "Clases anteriores".
2. Un adjunto borrado sale de la tira.
3. Sin archivos, la tira no ocupa lugar.
4. Está en los diseños Panel, Aula y Aula virtual. **Clásico queda igual** (CA-7).
5. Con el celular de costado (D5), en el chat angosto de la derecha, la tira se oculta para
   no quitarle lugar a la conversación.

---

## Criterios de aceptación

- **DB-1.** La parte pura convierte bien las coordenadas con franjas a los costados y
  arriba/abajo, y devuelve `null` fuera de la imagen.
- **DB-2.** Deshacer, borrar y el láser que vence funcionan sobre la lista de marcas.
- **DB-3.** La pantalla se publica con `stopTracks: false` y despublicar para la captura
  original.
- **DB-4.** Clásico sigue con los mismos `id` y el mismo estilo (CA-7).
- **AR-1.** La tira existe en B, C y D, con un `id` nuevo registrado en `IDS_NUEVOS`, y
  queda oculta sin archivos.
- **AR-2.** Las miniaturas se arman con `esc()`: el nombre del archivo lo escribió una
  persona.
