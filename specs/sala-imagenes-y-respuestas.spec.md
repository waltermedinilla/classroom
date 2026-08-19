# Sala en vivo: imágenes de los alumnos, responder a un mensaje y contraste en modo oscuro

> **Estado: APROBADA por el usuario el 2026-08-19.**
>
> Extiende `specs/sala-en-vivo.spec.md`, que en su momento dijo *"no hay adjuntos ni imágenes
> en el chat"*. Los adjuntos llegaron después, pero **solo para quien da la clase**. Esta spec
> abre las imágenes a los alumnos, agrega la respuesta citada estilo WhatsApp y arregla el
> chat en modo oscuro.
>
> **Decisiones cerradas con el usuario el 2026-08-19 — no reabrirlas sin él:**
> el alumno sube **solo imágenes**, nunca archivos (RN-A1) · el docente tiene un
> **interruptor propio** para las fotos **y además** valen las reglas de la palabra (RN-A3) ·
> el alumno **borra lo suyo** mientras la sala esté abierta (RN-B1) · **5 imágenes cada 10
> minutos** por alumno (RN-A5).

## Objetivo

Tres cosas que la clase pide y hoy no puede hacer:

1. **Que el alumno muestre.** Hoy la única forma de que un chico enseñe el ejercicio resuelto
   o la hoja de la carpeta es describirlo por texto. La docente ya puede compartir fotos; el
   alumno no. Es la mitad de una conversación.
2. **Que se sepa a quién se le contesta.** Con 30 personas escribiendo, "sí, dale" no dice
   nada. La respuesta citada de WhatsApp es el gesto que todos ya conocen.
3. **Que el chat se lea en modo oscuro.** Los mensajes propios aparecen en un celeste claro
   fijo con el texto claro del tema encima: **1,10:1 de contraste**, es decir, invisible. Es
   el reclamo que originó esta spec.

## Responsabilidades

- Definir **quién** puede compartir una imagen en la sala y **bajo qué condiciones**.
- Definir el **interruptor** con el que la docente corta las fotos sin callar a la clase.
- Definir el **borrado propio** y su límite temporal.
- Definir la **respuesta citada**: qué se guarda, qué se muestra y qué pasa cuando el mensaje
  citado se borra después.
- Definir el **contraste mínimo** del chat en los dos temas y dejarlo bajo test.

## No responsabilidades

- **El alumno no sube archivos.** Ni PDF, ni Word, ni ZIP. Solo imágenes. Un documento de 20
  MB por alumno multiplicado por una escuela es otro problema, y abre una moderación
  (¿qué hay adentro de ese .docx?) que una foto no abre.
- **No hay respuesta privada.** Responder a alguien sigue siendo público para toda la sala: la
  sala es un espacio a la vista de todos (RN-14 de la spec madre) y esto no lo cambia.
- **No hay hilos.** La respuesta es una cita de un solo nivel, como en WhatsApp. Sin árbol,
  sin "ver conversación".
- **No se pueden responder los avisos del sistema.** "Se abrió la sala" no es de nadie.
- **No hay edición de mensajes.** Se borra y se escribe de nuevo.
- **Ni una migración.** Los campos nuevos son opcionales con default; los documentos viejos
  se leen igual que siempre. **La base de producción no se toca.**
- **No se toca la paleta global del tema.** Las correcciones de contraste viven dentro de la
  sala (`.lr-wrap`), no en `:root`.

## Entidades/Schemas

### `models/RoomMessage.js` — un agregado

```js
// La respuesta citada. Es un SNAPSHOT y no solo un ref, por el mismo motivo que authorName:
// el poll pinta hasta 100 mensajes cada 4 segundos y resolver la cita con populate agregaría
// una query al camino más caliente de la app.
reply: {
  to:       ObjectId(ref RoomMessage),  // para saltar al original
  seq:      Number,                     // la posición, que es como se lo encuentra en el DOM
  autor:    String,                     // snapshot del nombre
  extracto: String,                     // primeros 90 caracteres, o '' si era un adjunto
  kind:     String,                     // 'text' | 'image' | 'file'
  borrado:  Boolean,                    // el mensaje citado se borró DESPUÉS de la cita
}                                       // default: null (el mensaje no responde a nadie)
```

`reply.borrado` es la contraparte obligatoria del snapshot: sin él, borrar un mensaje ofensivo
lo dejaría vivo dentro de la cita de cada respuesta. Se marca en el momento del borrado
(RN-B4), que es una operación rara, y no en cada poll, que es la operación cara.

### `models/RoomSession.js` — un agregado

```js
settings: {
  studentsCanWrite:       Boolean,  // ya existía
  reactionsOn:            Boolean,  // ya existía
  studentsCanShareImages: Boolean,  // NUEVO, default true
}
```

Por sesión y no por materia, mismo criterio que `studentsCanWrite`: cortar las fotos un martes
no las corta el jueves.

## Reglas de negocio

### A. Imágenes de los alumnos

- **RN-A1 — Solo imágenes.** El alumno usa `POST /courses/:id/sala/adjuntos/imagen`. El
  endpoint de archivos (`/adjuntos/archivo`) sigue siendo exclusivo de quien gestiona la
  materia. Las extensiones son las de `EXT_IMAGENES`, y toda imagen se recomprime a WebP con
  el preset `sala` antes de tocar el disco, igual que hoy.
- **RN-A2 — Preceptoría y dirección tampoco suben.** Quien entra a mirar la clase no comparte
  material en ella. El permiso es de los dos lados del mostrador: docente y alumno del curso.
- **RN-A3 — Tres condiciones, todas a la vez.** El alumno puede compartir una imagen si:
  1. la sala está **abierta**, y
  2. `settings.studentsCanShareImages` está en **true**, y
  3. **puede escribir** — es decir, `settings.studentsCanWrite` en true y él no está silenciado.

  La tercera condición es la que pidió el usuario explícitamente: silenciar a alguien lo
  silencia entero. Un chico al que se le sacó la palabra por tirar mensajes no puede seguir
  tirando fotos.
- **RN-A4 — El chequeo va ANTES de multer.** Igual que hoy para el docente: si el permiso se
  evaluara dentro del handler, el archivo de alguien sin permiso ya estaría escrito en disco
  cuando se responde 403.
- **RN-A5 — 5 cada 10 minutos, por alumno.** El docente conserva su límite de 20
  (`UPLOADS_PER_10MIN`). Por **usuario** y no por IP: la escuela entera sale por una sola IP
  NAT y un límite por IP haría que el primer curso dejara sin subir al resto.
- **RN-A6 — El botón aparece y desaparece solo.** El estado de la sala que devuelve el poll
  dice si este usuario puede compartir ahora. Cuando la docente apaga el interruptor, el botón
  de la cámara se va de la pantalla de los alumnos en el poll siguiente, sin recargar.
- **RN-A7 — Queda en auditoría.** Misma acción `room.share_file` que hoy, con el rol de quien
  subió. Compartir una foto en un chat de menores es un acto que tiene que tener autor.

### B. Borrado

- **RN-B1 — El alumno borra lo suyo, con la sala abierta.** Autor del mensaje + sesión sin
  cerrar. Cubre el caso real ("subí la foto equivocada") sin convertir el borrado en una forma
  de limpiar el rastro de una clase que ya terminó.
- **RN-B2 — El docente borra cualquier cosa, siempre.** Sin cambios. Es moderación.
- **RN-B3 — Borrar es lo mismo para todos.** Soft delete del texto, borrado real del archivo
  en disco, hueco visible en la conversación y entrada en auditoría con quién lo borró. Que el
  autor sea un alumno no cambia ninguna de esas cuatro cosas.
- **RN-B4 — Borrar apaga las citas.** Al borrar un mensaje, todas las respuestas que lo citan
  pasan a mostrar "Mensaje eliminado" en la cita, dentro de la misma sesión.

### C. Responder

- **RN-C1 — Responde quien puede escribir.** No hay un permiso nuevo: si podés mandar un
  mensaje, podés mandarlo como respuesta.
- **RN-C2 — Se responde a texto y a adjuntos, nunca al sistema.** Un aviso automático no tiene
  autor a quien contestarle.
- **RN-C3 — Solo dentro de la misma sesión.** No se cita un mensaje de la clase del martes en
  la clase del jueves: el `seq` de la cita es la posición dentro de la sesión, y la
  conversación de otra clase no está en pantalla.
- **RN-C4 — Un solo nivel.** Se puede responder a una respuesta, pero se cita solo el mensaje
  al que se apunta, sin arrastrar su cita.
- **RN-C5 — La imagen también responde.** El formulario de subida acepta el mismo `replyTo`
  que el mensaje de texto: mostrar la carpeta *contestándole* a la consigna es el caso de uso.
- **RN-C6 — Tocar la cita lleva al original.** Si el mensaje citado está en pantalla, se
  desplaza hasta él y se lo resalta un segundo. Si ya no está (quedó fuera de los últimos 100),
  la cita no lleva a ninguna parte, pero se sigue leyendo.
- **RN-C7 — Una cita inválida no rompe el envío.** Si el `replyTo` no existe, es de otra sesión
  o es un mensaje del sistema, el mensaje se manda **sin** cita. Nunca un error en la cara.

### D. Contraste

- **RN-D1 — Piso de 4,5:1 para todo texto del chat, en los dos temas.** Es el mínimo de WCAG
  AA para texto normal.
- **RN-D2 — Ninguna pastilla de color fija sin variante oscura.** Todo par fondo+texto
  escrito en hex tiene que declarar su equivalente bajo `[data-theme="dark"]`. Los dos
  incumplimientos de hoy son `.lr-msg.mio .lr-burbuja` (1,10:1) y `.lr-react button.mia`
  (1,10:1); la cita nueva se escribe ya con las dos variantes.
- **RN-D3 — Los grises tenues de la sala suben, en los DOS temas.** `var(--text-hint)` no
  llega al piso en ninguno: 3,52:1 en oscuro (`#72777e` sobre la tarjeta) y **2,64:1 en
  claro** (`#9aa0a6` sobre blanco). Es lo justo para un ícono e insuficiente para los avisos
  del sistema, el pie de las cards y —el peor caso— los botones "responder" y "borrar", que
  son controles.
  **El caso claro apareció midiendo el arreglo del oscuro**: el reclamo era por el modo
  oscuro, pero en estos elementos el tema claro estaba peor y nadie lo había mirado. Se
  arreglan los dos, con **una** variable local de la sala (`--lr-tenue`) y sin tocar la paleta
  global, que la usan otras treinta vistas.
- **RN-D4 — Bajo test.** El contraste se calcula en un test unitario a partir de los colores
  declarados en el archivo. No alcanza con mirarlo una vez: la regresión de hoy entró así.

## Errores posibles

| Situación | Respuesta |
|---|---|
| Alumno sube con la sala cerrada | 409 `La sala está cerrada` |
| Alumno sube con el interruptor apagado | 403 `La o el docente desactivó las imágenes de los alumnos` |
| Alumno silenciado o sala en "solo yo escribo" | 403 `No podés compartir imágenes en esta sala` |
| Alumno pasa el límite de 5 en 10 minutos | 429 `Esperá unos minutos antes de subir más imágenes.` |
| Alumno intenta `/adjuntos/archivo` | 403 `Solo la o el docente puede hacer esto` |
| Alumno borra un mensaje ajeno | 403 `Solo podés borrar tus propios mensajes` |
| Alumno borra el suyo con la sala ya cerrada | 403 `La clase terminó: pedile a la o el docente que lo borre` |
| `replyTo` inexistente, de otra sesión o del sistema | 200, mensaje enviado **sin** cita (RN-C7) |

## Criterios de aceptación

1. Un alumno con la sala abierta ve el botón de la cámara, elige una foto de 3 MB y la clase
   entera la ve en menos de un poll, pesando ~100 KB.
2. La docente toca "Fotos: no" y el botón desaparece de la pantalla de los alumnos sin que
   nadie recargue; el suyo sigue ahí.
3. Un alumno silenciado no ve el botón, y un POST hecho a mano devuelve 403.
4. Un alumno borra su propia foto: desaparece para todos, la ruta del archivo devuelve 404 y
   queda `room.delete_message` en auditoría con su nombre.
5. Ese mismo alumno, con la sala ya cerrada, recibe 403 al intentar borrarla.
6. Responder a un mensaje muestra la cita arriba del cuadro de escribir, y el mensaje enviado
   la lleva adentro de la burbuja con el nombre del autor citado.
7. Tocar la cita desplaza el chat hasta el mensaje original y lo resalta.
8. La docente borra un mensaje citado: las respuestas que lo citaban muestran "Mensaje
   eliminado" en la cita.
9. En los dos temas, **todo** el texto del chat —mensaje propio, reacción propia, cita, avisos
   del sistema, pie de las cards, botones "responder" y "borrar"— da 4,5:1 o más, medido en el
   navegador sobre los colores realmente compuestos (no sobre los declarados).
10. Las tres suites (`test:unit`, `test:smoke`, `test:roles`) pasan.

## Tests necesarios

- **Puros, en `tests/unit/salaChat.test.js`:**
  - `puedeEscribir` y `puedeCompartirImagen` en toda la matriz: gestor / alumno / staff ×
    sala abierta-cerrada × interruptor on-off × palabra on-off × silenciado × observación.
  - `puedeBorrarMensaje`: propio con sala abierta, propio con sala cerrada, ajeno, gestor.
  - `citaDeMensaje`: recorta a 90, marca el kind, devuelve null para el sistema y para el
    mensaje ya borrado.
- **De contraste, en el mismo archivo:** calcular el ratio WCAG de cada par fondo+texto
  declarado en `live-room.ejs` y exigir ≥ 4,5:1 en los dos temas (RN-D4).
- **De marcado:** que el botón de imagen exista para el alumno y el de archivo no.

## Plan de migración

Ninguna. `reply` es `null` y `studentsCanShareImages` es `true` por default: los documentos
existentes se comportan como antes sin escribirles una sola línea. **No hay que tocar la base
de producción.**
