# Mensajería del superadministrador: enviar mensajes a la comunidad

> **Estado: APROBADA por el usuario el 2026-08-10.** En implementación.
> Se aprobó tal cual, sin tachar ninguna de las decisiones marcadas **[TACHABLE]**: quedan
> el filtro por escuela, el asunto opcional, el cuerpo de 2000, el destinatario que no borra,
> la confirmación arriba de 50 y el toggle editable después del envío.
>
> Decisiones ya cerradas con el usuario — **no reabrirlas**:
> se envía a **toda la comunidad, por roles, o a personas sueltas** (RN-03) · **el recorte
> por curso/división queda para más adelante** (ver "No responsabilidades") · la bandeja del
> destinatario es **el sobre del header, unificado con sugerencias** (RN-12) · el toggle
> **"permitir respuestas"** se elige al redactar (RN-07) · si permite responder, la
> conversación es un **hilo privado 1 a 1 con tope de 20 mensajes** (RN-09).
>
> Decisiones que tomó esta spec y el usuario puede tachar en la revisión, marcadas
> **[TACHABLE]** donde aparecen: el filtro opcional por escuela (RN-04) · el asunto opcional
> (RN-01) · el cuerpo de 2000 caracteres (RN-01) · el destinatario no puede borrar lo que
> recibe (RN-17) · la confirmación obligatoria arriba de 50 destinatarios (RN-05) · el toggle
> de respuestas se puede cambiar después de enviado en ambos sentidos (RN-08).

## Objetivo

Que el superadministrador pueda **hablarle a la gente de la plataforma desde adentro de la
plataforma**, sin salir a buscar mails ni teléfonos.

Hoy la comunicación va en un solo sentido: cualquier usuario le manda una sugerencia al
superadmin (`models/Suggestion.js`) y el superadmin contesta. No existe el camino inverso.
Si el superadmin necesita avisar algo —"el viernes hay mantenimiento", "docentes: carguen
las notas antes del 20", "María, revisá tu usuario"— tiene que salir del sistema.

Lo que falta son tres cosas:

1. **Elegir a quién.** Toda la comunidad, un rol entero ("todos los docentes"), varios roles,
   o personas sueltas elegidas a mano. Combinables.
2. **Decidir si se puede contestar.** Hay avisos que son avisos (no se responden) y hay
   mensajes que abren una conversación. Lo elige el superadmin al redactar, con un click.
3. **Que llegue donde el usuario ya mira.** El sobre del header con el badge de no leídos
   ya existe y ya lo usan para las sugerencias. El mensaje aparece ahí, no en un lugar nuevo.

## Responsabilidades

- Definir el **modelo de datos** de un envío y del estado por destinatario, incluida la
  escala (un envío a "todos los alumnos" son cientos de personas).
- Definir **cómo se resuelve la audiencia** y en qué momento (al enviar, no al leer).
- Definir la **pantalla de redacción** con previsualización del alcance antes de enviar.
- Definir la **bandeja del destinatario**, unificada con sugerencias en el mismo sobre y el
  mismo badge, sin encarecer el middleware global que corre en cada request.
- Definir el **hilo de respuestas** 1 a 1 y su tope.
- Definir el **panel de seguimiento** del superadmin: quién leyó, quién no, quién contestó.
- Dejar todo **auditado**, con **rate limit** y con **killswitch**.

## No responsabilidades

- **No hay recorte por curso ni por división.** Decisión explícita del usuario: primero esto,
  el curso se analiza después. Es la exclusión más cara de las de esta lista y conviene
  entender por qué: `models/User.js` **no tiene** campo de división, y el único camino de una
  persona a un curso es `models/Course.js` (`division` + `students` / `owner` / `coTeachers`).
  Sumarlo obliga a una query extra a `Course` y a resolver qué pasa con los roles que no
  tienen curso (directivo, admin, jefe, soe). El modelo de esta spec lo deja preparado sin
  costo: se agrega `divisions` a `audience` y una rama al servicio de audiencia, **sin
  migración y sin tocar nada de lo demás** (RN-18).
- **No manda mails ni notificaciones push.** El mensaje vive dentro de la plataforma. Un
  correo saliente necesita servidor SMTP, plantillas, rebotes y política de bajas: es otra
  spec, y arranca por decidir qué se le puede mandar por mail a menores de edad.
- **No es un chat.** El hilo es 1 a 1, con tope, y solo lo abre el superadmin. Los usuarios
  no se escriben entre ellos. Para conversar en grupo ya está la sala en vivo
  (`specs/sala-en-vivo.spec.md`).
- **No reemplaza a las novedades del curso** (`models/Announcement.js`). Aquello es del
  docente hacia su materia y es público dentro del curso; esto es del superadmin hacia
  personas y es privado.
- **No lo usa el admin ni el directivo todavía.** El modelo queda preparado (RN-18) pero la
  ruta exige `superadmin`. Habilitarlo es una decisión institucional, no técnica.
- **No toca `models/Suggestion.js` ni `services/suggestionThread.js`.** Se explica en RN-10
  por qué no se generaliza el servicio de hilo existente.
- **No agrega dependencias npm.**
- **No migra ninguna colección existente.** Todo lo nuevo son dos colecciones nuevas.

## Entidades/Schemas

### `models/Message.js` (nuevo) — el envío

Un documento por **envío**, no por destinatario. Guarda el texto una sola vez y la memoria
de a quién se apuntó.

```js
const messageSchema = new Schema({
  // Asunto opcional: es lo que se ve en el listado del panel y en el encabezado del mensaje
  // en la bandeja. Sin asunto, el listado muestra las primeras palabras del cuerpo.
  // [TACHABLE] Si el usuario lo prefiere sin asunto, se borra el campo y el listado usa
  // siempre el extracto — no cambia nada más.
  subject: { type: String, trim: true, maxlength: 120, default: '' },

  // El cuerpo. [TACHABLE] 2000 y no 1000 como una sugerencia: acá es comunicación
  // institucional (instrucciones, plazos, explicaciones), no una idea suelta.
  body: { type: String, required: true, trim: true, maxlength: 2000 },

  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },

  // ¿El destinatario puede contestar? Es el toggle del pedido original.
  // Se puede cambiar después de enviado, en los dos sentidos (RN-08).
  allowReplies: { type: Boolean, default: false },

  // MEMORIA de lo que se pidió, NO fuente de verdad de a quién le llegó.
  // Sirve para tres cosas y ninguna más: mostrar "Enviado a: Docentes — 42 personas" en el
  // panel, permitir "reenviar con los mismos filtros", y auditar el criterio. La audiencia
  // REAL son los documentos de MessageRecipient, congelados al enviar (RN-06). Nunca se
  // re-evalúa: si se re-evaluara, el alta de un docente en agosto lo metería dentro de un
  // mensaje de marzo que nunca fue para él.
  audience: {
    everyone: { type: Boolean, default: false },                      // toda la comunidad
    roles:    [{ type: String }],                                     // ['teacher', 'student']
    schools:  [{ type: Schema.Types.ObjectId, ref: 'School' }],       // [TACHABLE] ver RN-04
    userIds:  [{ type: Schema.Types.ObjectId, ref: 'User' }],         // elegidos a mano
    // `divisions` NO existe todavía a propósito. Cuando se sume el recorte por curso, entra
    // acá y en services/messageAudience.js, y nada más de esta spec cambia (RN-18).
  },

  // Denominador de "leído por X de Y". Se calcula UNA vez al enviar y no se toca: recontar
  // destinatarios en cada pintada del listado sería un countDocuments por fila.
  recipientCount: { type: Number, default: 0 },

  // Alcance institucional del envío. Hoy siempre null (el superadmin no tiene escuela y manda
  // a donde quiera). Existe desde ahora para que habilitar a admin/directivo sea una ruta
  // nueva y no una migración (RN-18).
  scopeSchool: { type: Schema.Types.ObjectId, ref: 'School', default: null },
}, { timestamps: true });

// Listado del panel: los envíos del superadmin, más recientes primero.
messageSchema.index({ sender: 1, createdAt: -1 });
```

### `models/MessageRecipient.js` (nuevo) — el estado y el hilo de UNA persona

Un documento por **(envío × destinatario)**. Es la fila que hace de bandeja, de acuse de
lectura y de conversación privada.

```js
// Un mensaje del hilo posterior al envío original.
// A diferencia de models/Suggestion.js, acá el hilo arranca limpio: el mensaje inicial vive
// en Message.body (uno solo, compartido) y TODO lo que viene después vive acá adentro, sin
// campos especiales para el primero. Ver RN-10: es la razón por la que este modelo es nuevo
// en vez de una generalización del de sugerencias.
const threadMessageSchema = new Schema({
  from:     { type: String, enum: ['user', 'staff'], required: true },
  author:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text:     { type: String, required: true, trim: true, maxlength: 2000 },
  at:       { type: Date, default: Date.now },
  editedAt: { type: Date, default: null },
});

const messageRecipientSchema = new Schema({
  message: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
  user:    { type: Schema.Types.ObjectId, ref: 'User',    required: true },

  // Congelados al enviar. Se guardan A PROPÓSITO aunque se puedan sacar del User: el panel de
  // seguimiento tiene que poder decir "se lo mandaste a Juan como Docente" aunque hoy Juan
  // sea Preceptor. Es el rol que TENÍA cuando se le mandó. Sin esto, un cambio de rol
  // reescribe la historia del envío.
  roleAtSend:   { type: String, default: null },
  schoolAtSend: { type: Schema.Types.ObjectId, ref: 'School', default: null },

  // null = no leído. Es lo que cuenta el badge del sobre.
  readAt: { type: Date, default: null },

  // La conversación 1 a 1. Vacío en los mensajes que nadie contestó, que van a ser la mayoría.
  thread: { type: [threadMessageSchema], default: [] },

  // ¿Hay algo en el hilo que el DESTINATARIO todavía no vio? Se prende cuando el superadmin
  // contesta y se apaga cuando el destinatario abre la bandeja. Va aparte de readAt porque
  // readAt es del mensaje original: sin este campo, una respuesta del superadmin sobre un
  // mensaje ya leído no encendería el badge nunca.
  unreadForUser: { type: Boolean, default: false },

  // Espejo del anterior, del lado del panel: ¿el destinatario escribió algo que el superadmin
  // todavía no vio? Evita recorrer todos los hilos para pintar "3 respuestas nuevas".
  unreadForStaff: { type: Boolean, default: false },
}, { timestamps: true });

// ÍNDICE CRÍTICO: lo usa el contador del badge, que corre en CADA request (RN-13).
messageRecipientSchema.index({ user: 1, readAt: 1 });
messageRecipientSchema.index({ user: 1, unreadForUser: 1 });
// Bandeja del usuario, ordenada por actividad reciente.
messageRecipientSchema.index({ user: 1, updatedAt: -1 });
// Panel de seguimiento: los destinatarios de UN envío, y su borrado en cascada.
messageRecipientSchema.index({ message: 1, readAt: 1 });
// Una persona no puede tener dos filas del mismo envío. Es lo que hace idempotente al alta
// masiva: si el insertMany se corta por la mitad y se reintenta, no duplica.
messageRecipientSchema.index({ message: 1, user: 1 }, { unique: true });
```

### `services/messageAudience.js` (nuevo) — resolver a quién le llega

Lógica pura de armado del conjunto de destinatarios. Se aísla acá por dos motivos: es lo
único de esta feature que conviene testear sin HTTP, y es donde va a entrar el recorte por
curso cuando se decida sumarlo (RN-18).

```js
// resolverAudiencia({ everyone, roles, schools, userIds }, remitente) → [ObjectId]
//
// Los filtros de GRUPO se INTERSECTAN entre sí: rol ∩ escuela.
//   "docentes" + "Escuela San José" = los docentes de San José.
// Los usuarios elegidos A MANO se SUMAN (unión) al grupo resultante:
//   ...más María, aunque María sea alumna.
// Es el comportamiento que espera cualquiera que haya usado un filtro y una lista de
// invitados: el filtro acota, la lista agrega.
//
// `everyone: true` ignora `roles` (es "sin filtro de rol", no un rol más).
// Siempre se excluyen: el remitente y los usuarios con active: false (RN-11).
// El resultado nunca tiene ids repetidos, aunque una persona entre por dos caminos.
```

Es una sola query a `User` (`{ role: { $in }, school: { $in }, active: true }`) más los ids
sueltos. Sin `Course`, sin `Division`, sin agregaciones.

### `services/messageThread.js` (nuevo) — el hilo

Misma **forma de API** que `services/suggestionThread.js` para que las vistas se lean igual,
pero sin arrastrar su caso especial (ver RN-10):

```js
MAX_MENSAJES = 20
hilo(message, recipient)          → [{ from, text, at, editedAt, autor, indice }]  // body + thread[]
esperaAlDestinatario(rec)         → bool     // el último lo escribió el staff
puedeResponderElUsuario(msg, rec) → bool     // msg.allowReplies && no llegó al tope
cuantosMensajes(msg, rec)         → number
```

### `config/sections.js` — una solapa nueva

```js
{ key: 'superadmin_messages', panel: 'superadmin', label: 'Mensajes', icon: 'forum',
  path: '/superadmin/messages', roles: ['superadmin'], locked: true },
```

`locked: true` como todas las del panel de superadministración, por la decisión ya
documentada en el encabezado de ese archivo: el superadmin no se restringe nunca. Va después
de `superadmin_suggestions` (son vecinas conceptuales: una es el correo que entra, la otra el
que sale).

Al sumar la solapa 13, el corte de dos filas de `views/partials/superadmin-nav.ejs`
(`.admin-nav-break`) queda en 8 arriba y 5 abajo. Revisar si conviene moverlo un ítem.

### `config/audit-actions.js` — cinco acciones y una categoría nuevas

```js
'message.send':           { label: 'envió un mensaje',                    icon: 'send',      color: '#1a73e8', category: 'message' },
'message.reply':          { label: 'respondió un mensaje',                icon: 'reply',     color: '#137333', category: 'message' },
'message.staff_reply':    { label: 'siguió el hilo de un mensaje',        icon: 'forum',     color: '#1a73e8', category: 'message' },
'message.toggle_replies': { label: 'cambió las respuestas de un mensaje', icon: 'lock_open', color: '#ea8600', category: 'message' },
'message.delete':         { label: 'eliminó un mensaje enviado',          icon: 'delete',    color: '#ea4335', category: 'message' },
// CATEGORIES
message: 'Mensajes',
```

### `middleware/rate-limits.js` — dos limiters nuevos

```js
// Envío: 20 por hora POR USUARIO. Un envío puede crear cientos de documentos; 20/hora es
// holgado para el uso real (nadie manda 20 comunicados en una hora) y acota el daño de un
// script suelto o de un doble click sostenido. Por usuario y no por IP, mismo motivo que
// roomMessageLimiter: la escuela entera sale por una sola IP NAT.
messageSendLimiter   → windowMs: 60*60*1000, max: 20,  keyGenerator: req.userId || ipKeyGenerator(req.ip)

// Respuesta del destinatario: 10 por minuto POR USUARIO, calcado de roomMessageLimiter.
messageReplyLimiter  → windowMs: 60*1000,    max: 10,  keyGenerator: idem
```

### Vistas

| Archivo | Qué es |
|---|---|
| `views/superadmin/messages.ejs` (nuevo) | Redacción + listado de enviados |
| `views/superadmin/message-detail.ejs` (nuevo) | Un envío: destinatarios, quién leyó, hilos |
| `views/partials/superadmin-nav.ejs` | Solapa "Mensajes" |
| `views/partials/header.ejs` | El badge pasa a sumar sugerencias + mensajes |
| `views/partials/footer.ejs` | El modal del sobre pasa a mostrar las dos cosas |

## Entradas

### `GET /superadmin/messages`
Pantalla de redacción + listado de envíos propios, paginado (20 por página, reusando
`views/partials/pagination.ejs`).

### `GET /superadmin/messages/preview?everyone=&roles=&schools=&userIds=`
Devuelve el alcance **sin enviar nada**: `{ total, porRol: { teacher: 14, student: 129 }, muestra: [...10 usuarios...] }`.
La usa la previsualización en vivo de la pantalla de redacción (RN-05).

### `GET /superadmin/messages/users?q=&role=&school=`
Buscador de usuarios sueltos: por nombre, **DNI** o email. Devuelve como máximo 20 resultados
con `{ _id, dni, name, email, role, school }`.

### `POST /superadmin/messages`
Cuerpo: `{ subject?, body, allowReplies, everyone, roles[], schools[], userIds[] }`.
Crea el `Message`, resuelve la audiencia, inserta los `MessageRecipient` y audita.

### `POST /superadmin/messages/:id/reply`
Cuerpo: `{ recipientId, text }`. El superadmin sigue el hilo de UN destinatario.

### `PATCH /superadmin/messages/:id/replies`
Cuerpo: `{ allowReplies: bool }`. Prende o apaga el toggle después de enviado (RN-08).

### `DELETE /superadmin/messages/:id`
Borra el envío y todos sus destinatarios en cascada.

### `GET /messages/mine`
Bandeja del destinatario. Los mensajes que recibió, con el hilo ya armado, más recientes
primero, tope 50 (igual que `/suggestions/mine`).

### `POST /messages/mine/:recipientId/reply`
El destinatario contesta. Solo si `allowReplies` y no se llegó al tope.

### `POST /messages/mine/:recipientId/read`
Marca leído. Se dispara al abrir el modal, fire-and-forget, como ya hace sugerencias.

## Salidas

### `GET /messages/mine` → `200`

```jsonc
{ "messages": [{
  "recipientId": "...",
  "subject": "Carga de notas del segundo trimestre",
  "body": "Docentes: recuerden que...",
  "sender": { "name": "Walter Medinilla" },
  "sentAt": "2026-08-10T12:00:00.000Z",
  "readAt": null,
  "allowReplies": true,
  "hilo": [{ "from": "staff", "text": "...", "at": "...", "editedAt": null }],
  "puedeResponder": true,
  "esperaAlDestinatario": true
}]}
```

### `POST /superadmin/messages` → `201`

```jsonc
{ "ok": true, "id": "...", "destinatarios": 143 }
```

Errores: `400` cuerpo vacío / cuerpo > 2000 / **audiencia vacía** (`"El mensaje no tiene
destinatarios"`) · `429` límite de envíos · `503` mantenimiento.

### `POST /messages/mine/:recipientId/reply` → `200`

`{ ok: true }`. Errores: `400` texto vacío o > 2000 · `403` `"Este mensaje no admite
respuestas"` · `400` `"Esta conversación llegó a los 20 mensajes."` · `404` si el
`recipientId` no es del usuario logueado.

## Reglas de negocio

**RN-01 — Un mensaje es cuerpo obligatorio y asunto opcional.** **[TACHABLE]** El cuerpo va
de 1 a 2000 caracteres; el asunto, de 0 a 120.

**RN-02 — Solo el superadministrador envía.** El router entero va detrás de
`requireAuth, requireSuperAdmin` (`middleware/superadmin.js`), montado igual que
`routes/superadmin.js:35`. No hay excepción por email como en Backup: mandar un mensaje no
escribe en masa sobre la base ni se deshace mal.

**RN-03 — Tres formas de elegir destinatarios, combinables.** Toda la comunidad (`everyone`)
· por rol (uno o varios) · personas sueltas por buscador. Los roles se **intersectan** con el
filtro de escuela si lo hay; las personas sueltas se **suman** (unión) al grupo resultante.
`everyone: true` ignora `roles`: es "sin filtro de rol", no un rol más. Dejar todo sin tildar
**no** es "todos" — es audiencia vacía y se rechaza con `400`. Que "todos" haya que elegirlo
a propósito es la diferencia entre mandarle a la escuela entera queriendo y sin querer.

**RN-04 — [TACHABLE] Filtro opcional por escuela.** No estaba en el pedido; lo agrego porque
sin él "todos los docentes" significa los de **todas** las escuelas, y la plataforma soporta
varias (el panel `/superadmin/audit` ya tiene su propio filtro por escuela, por lo mismo).
Es un campo más en el `$match`, sin queries extra ni casos especiales. Si hoy hay una sola
escuela, es dead weight y se saca sin tocar nada más.

**RN-05 — No se envía a ciegas.** La pantalla muestra el alcance **antes** de enviar
("143 personas: 14 docentes, 129 alumnos") y una muestra de 10 nombres. **[TACHABLE]** Arriba
de 50 destinatarios el botón pide una confirmación explícita con el número escrito. Es la
única protección real contra el "quise mandarle a los docentes y le mandé a la escuela".

**RN-06 — La audiencia se congela al enviar (snapshot), no se evalúa al leer.** Enviar
materializa un `MessageRecipient` por persona. Tres razones, en orden de peso:

1. **Un mensaje tiene fecha.** El aviso del 3 de marzo dirigido a "todos los docentes" no es
   para la docente que entró en agosto. Es correo, no un tablón: quien no estaba, no lo
   recibió. Re-evaluar el filtro al leer haría aparecer mensajes viejos en bandejas nuevas.
2. **El badge corre en cada request.** Con snapshot es un `countDocuments` por índice sobre
   `{ user, readAt: null }`. Sin snapshot habría que re-resolver la audiencia en **todas** las
   páginas que abre **todo** el mundo.
3. **"Leído por 87 de 143" necesita un denominador.** Sin la fila por persona, no hay 143.

El costo aceptado: el que llega después no lo recibe. Si el superadmin lo quiere, reenvía
—por eso `Message.audience` guarda los filtros originales.

**RN-07 — El toggle de respuestas es del mensaje, no del destinatario.** `allowReplies` vale
para todo el envío. Si está apagado, la bandeja muestra el mensaje sin caja de texto y el POST
de respuesta devuelve `403` aunque se lo llame a mano.

**RN-08 — [TACHABLE] El toggle se puede cambiar después de enviado, en los dos sentidos.**
Prenderlo habilita a contestar a quien no podía. Apagarlo cierra la caja de texto pero **no
borra nada**: lo que alguien ya escribió se conserva y se sigue viendo, del lado del
destinatario y del panel. Cualquier otra cosa sería perder mensajes de gente. El cambio se
audita (`message.toggle_replies`).

**RN-09 — El hilo es privado, 1 a 1, y tiene tope de 20.** Cada destinatario conversa solo con
el superadmin. Nadie ve las respuestas de los demás — ni un alumno las de otro alumno, ni un
docente las de sus colegas. El tope es el mismo criterio ya tomado para sugerencias
(`services/suggestionThread.js`): pasados 20 mensajes casi siempre ya es otro tema. Alcanzado
el tope, la bandeja lo dice y no ofrece caja de texto.

**RN-10 — Modelo nuevo, no generalización del de sugerencias.** `Suggestion` arrastra una
deuda concreta y documentada: sus dos primeros mensajes viven en `text` y `response`, fuera de
`messages[]`, porque migrarlos habría exigido tocar datos que ya están en producción (ver el
comentario de `models/Suggestion.js`). `services/suggestionThread.js` existe justamente para
tapar eso. Un modelo nuevo no tiene esa deuda y no hay razón para heredarla: `Message.body` es
el mensaje inicial y `MessageRecipient.thread[]` es todo lo demás, sin casos especiales. Lo
que sí se copia es la **forma de la API** (`hilo`, `puedeResponder`, `esperaAl...`), para que
las vistas y los tests se lean igual. Si alguna vez se migra `Suggestion` a un hilo limpio,
ese es el momento de unificar los dos servicios — y recién ahí.

**RN-11 — Quién queda afuera del snapshot.** Al enviar se excluyen: el propio remitente (nadie
se manda mensajes a sí mismo) y los usuarios con `active: false` (no pueden loguearse; su fila
solo inflaría el denominador de "leído por X de Y" con gente que no puede leer). Si un usuario
se deshabilita **después** del envío, su fila **se conserva** —consistente con la regla del
proyecto de no destruir historial— y el panel lo muestra marcado como "cuenta deshabilitada"
en la columna de no leídos, para que el número se entienda. Lo mismo con el alumno que se
transfiere de escuela: el mensaje era suyo y sigue siéndolo.

**RN-12 — La bandeja es el sobre del header, unificada.** El mismo botón `#inboxBtn`, el mismo
modal y el mismo badge muestran las sugerencias propias **y** los mensajes recibidos,
ordenados juntos por actividad reciente. Cada ítem lleva una píldora que dice qué es
("Mi sugerencia" / "Mensaje del equipo") y un borde de color distinto. El título del modal deja
de ser "Mis sugerencias" y pasa a **"Mensajes"**; el `title` del botón, también.

**RN-13 — El badge suma dos fuentes sin encarecer el middleware.** El middleware global de
`server.js:461-481` pasa a hacer las dos cuentas en un `Promise.all` (no en serie), cada una
por su índice, bajo su propio killswitch:

```js
res.locals.unreadSuggestionCount  // se mantiene tal cual — hay vistas y tests que lo usan
res.locals.unreadMessageCount     // nuevo: MessageRecipient { user, $or: [readAt: null, unreadForUser: true] }
res.locals.unreadInboxCount       // la suma; es lo que pinta el header
```

Se conserva `unreadSuggestionCount` en vez de renombrarlo: es un `res.locals` que ya consumen
vistas y suites de humo, y romperlo no compra nada. El mismo patrón defensivo de hoy:
`try/catch` que nunca puede tumbar una request, y en caso de error el contador queda en 0
(el sobre no muestra badge, la página nunca se rompe).

**RN-14 — Marcar leído es del destinatario y no reordena nada.** Abrir el modal dispara
`POST /messages/mine/:recipientId/read` en fire-and-forget para los no leídos, igual que hoy
con sugerencias. La escritura va con `{ timestamps: false }`: leer no es actividad de la
conversación y no tiene que subir el mensaje en el orden de nadie.

**RN-15 — El panel de seguimiento muestra lo que el superadmin necesita saber.** Por envío:
fecha, asunto o extracto, criterio de audiencia en español, "leído por 87 de 143" y cuántas
respuestas sin leer hay. En el detalle, la tabla de destinatarios con **DNI primero**, nombre,
rol **en español** (`roleNames[...]`), escuela, estado de lectura y el hilo si contestó.
Filtro rápido: todos / leídos / no leídos / respondieron.

**RN-16 — El envío es atómico "a lo Mongo" e idempotente.** Los `MessageRecipient` se insertan
con `insertMany(..., { ordered: false })` en lotes de 500. El índice único `{ message, user }`
hace que un reintento no duplique. Si el insert falla entero, el `Message` se borra y se
responde `500`: no queda un envío fantasma sin destinatarios. `recipientCount` se escribe
**después**, con la cantidad realmente insertada.

**RN-17 — [TACHABLE] El destinatario no puede borrar lo que recibe.** Es comunicación
institucional: si el destinatario pudiera borrar, "leído por X de Y" y el registro dejan de
significar algo. Sí puede el superadmin, y borra el envío **completo** (el `Message` y todos
sus `MessageRecipient`, en cascada), con confirmación y auditoría. No hay borrado parcial por
persona.

**RN-18 — Lo que queda preparado sin implementarse.** Dos puertas abiertas y cerradas con
llave, ambas sin migración el día que se decidan:

- **Recorte por curso/división.** Se suma `divisions` a `Message.audience` y una rama a
  `services/messageAudience.js` que resuelve los ids vía `Course` (`students` para alumnos,
  `owner` + `coTeachers` para docentes, `assignedDivisions` para preceptores) y decide qué
  hacer con los roles que no tienen curso. Nada más de esta spec cambia.
- **Que envíen admin y directivo.** `Message.sender` y `Message.scopeSchool` ya lo soportan.
  Sería una ruta nueva más un guardia que fuerce `scopeSchool = user.school` y filtre la
  audiencia por ahí.

**RN-19 — Killswitch.** `MESSAGES_ENABLED !== 'false'`, mismo patrón que
`SUGGESTIONS_INBOX_ENABLED` (`server.js:468`). Apagado: el contador queda en 0, el modal no
pide `/messages/mine`, la solapa no se pinta y las rutas devuelven `404`. Sin redeploy.

## Casos de uso

1. **Aviso a todos los docentes, sin respuesta.** El superadmin tilda rol Docente, escribe,
   deja el toggle apagado, ve "42 personas", confirma. Los 42 ven el badge en su próxima carga
   de página y el mensaje en el sobre, sin caja de texto.
2. **Aviso a toda la comunidad.** Elige "Toda la comunidad", ve "1.240 personas", confirma con
   el número escrito (RN-05).
3. **Mensaje a una persona.** Busca "Medinilla" en el buscador, la elige, escribe, envía a 1.
4. **Pedido a dos roles, con respuesta.** Tilda Docente + Preceptor, prende el toggle. Doce
   contestan; el panel le muestra "12 respuestas nuevas" y cada hilo aparte.
5. **Recordatorio a los que no leyeron.** Abre el detalle, filtra "no leídos", los selecciona
   y usa "reenviar a los no leídos" — que es el caso 3 con la lista precargada.
6. **Se dio cuenta tarde de que necesita respuestas.** Abre el envío, prende el toggle (RN-08).
   Los 42 destinatarios ven aparecer la caja de texto.
7. **Se equivocó de audiencia.** Borra el envío (RN-17). Desaparece de las 42 bandejas.

## Criterios de aceptación

### Resolución de audiencia (`services/messageAudience.js`, lógica pura)

1. Un rol → devuelve exactamente los usuarios `active: true` de ese rol.
2. Dos roles → devuelve la unión de ambos, sin repetidos.
3. Rol + escuela → devuelve la intersección; ningún usuario de otra escuela.
4. `everyone: true` → devuelve todos los usuarios activos menos el remitente, **ignorando**
   `roles` aunque venga cargado.
5. Usuarios sueltos + filtro de rol → el resultado es la **unión**: los sueltos entran aunque
   no cumplan el filtro.
6. El remitente nunca está en el resultado, ni siquiera si se eligió a sí mismo a mano.
7. Ningún usuario `active: false` está en el resultado.
8. Sin ningún filtro y sin `everyone` → devuelve vacío (y el POST responde `400`).
9. El resultado nunca tiene ids repetidos, aunque una persona entre por dos caminos.

### Hilo (`services/messageThread.js`, lógica pura)

10. `hilo()` de un mensaje sin respuestas devuelve **un** ítem, `from: 'staff'`, con `body`.
11. `hilo()` devuelve `body` primero y `thread[]` después, en orden cronológico.
12. `puedeResponder` es `false` si `allowReplies` es `false`, aunque el hilo esté vacío.
13. `puedeResponder` es `false` al llegar a 20 mensajes, con `allowReplies: true`.
14. `esperaAlDestinatario` es `true` cuando el último lo escribió el staff.

### Envío (con base de datos)

15. `POST /superadmin/messages` válido → `201`, crea 1 `Message` y N `MessageRecipient`.
16. `Message.recipientCount` coincide con la cantidad de `MessageRecipient` creados.
17. Cada `MessageRecipient` guarda `roleAtSend` y `schoolAtSend` con los valores del momento.
18. Reejecutar el mismo `insertMany` no duplica filas (índice único `{ message, user }`).
19. Cuerpo vacío → `400`. Cuerpo de 2001 caracteres → `400`.
20. Audiencia vacía → `400` con `"El mensaje no tiene destinatarios"`, y **no** crea el `Message`.
21. Un usuario no superadmin que llama al POST → `403`.
22. El envío queda auditado como `message.send`, con la cantidad de destinatarios en el meta.
23. El envío 21 dentro de la misma hora → `429`.

### Bandeja del destinatario

24. `GET /messages/mine` devuelve solo los mensajes del usuario logueado, nunca los de otro.
25. Devuelve el hilo ya armado; el cliente no reconstruye nada.
26. Un mensaje con `allowReplies: false` llega con `puedeResponder: false`.
27. `POST /messages/mine/:id/read` pone `readAt` y **no** modifica `updatedAt`.
28. `POST .../read` sobre un `recipientId` de otro usuario → `404`.
29. `POST .../reply` con `allowReplies: false` → `403`, aunque se lo llame directo por HTTP.
30. `POST .../reply` válido → agrega al hilo, pone `unreadForStaff: true` y `unreadForUser: false`.
31. `POST .../reply` en el mensaje 21 → `400` con el texto del tope.

### Badge y bandeja unificada

32. Con 2 sugerencias sin leer y 3 mensajes sin leer, el badge del header muestra **5**.
33. Abrir el modal muestra las 5 cosas juntas, ordenadas por actividad reciente, cada una con
    su píldora de origen.
34. Al cerrar y recargar, el badge muestra **0**.
35. Una respuesta del superadmin sobre un mensaje **ya leído** vuelve a encender el badge
    (`unreadForUser`), que es justamente lo que `readAt` solo no cubre.
36. Con `MESSAGES_ENABLED=false`: el badge cuenta solo sugerencias, la solapa no aparece y
    `/messages/mine` devuelve `404`.
37. Si la query de mensajes falla, la página se pinta igual y el badge cuenta solo sugerencias
    (nunca un error 500 por el sobre).

### Panel de seguimiento

38. El listado muestra "leído por X de Y" con X = `MessageRecipient` con `readAt != null`.
39. El detalle lista los destinatarios con **DNI en la primera columna**.
40. Los roles se muestran **en español** en toda la pantalla (listado, detalle, filtros).
41. El filtro "no leídos" devuelve exactamente los de `readAt: null`.
42. Un destinatario dado de baja después del envío sigue apareciendo, marcado como
    "cuenta deshabilitada".
43. `PATCH .../replies` con `false` cierra la caja de texto pero **conserva** todo lo escrito.
44. `DELETE /superadmin/messages/:id` borra el `Message` y **todos** sus `MessageRecipient`, y
    el mensaje desaparece de las bandejas.
45. Borrar queda auditado como `message.delete`.

### Regresión (lo que no se puede romper)

46. `/suggestions/mine`, `/suggestions/mine/:id/reply` y `/:id/read` siguen funcionando igual.
47. `res.locals.unreadSuggestionCount` sigue existiendo y valiendo lo mismo que antes.
48. La suite de humo completa sigue pasando (`npm run test:smoke`).
49. La matriz de roles × solapas sigue pasando (`npm run test:roles`), con la solapa nueva
    visible **solo** para superadmin.

## Errores posibles

| Situación | Respuesta |
|---|---|
| Cuerpo vacío o > 2000 | `400` `"El mensaje no puede estar vacío"` / `"...no puede superar los 2000 caracteres"` |
| Audiencia vacía | `400` `"El mensaje no tiene destinatarios"` |
| No es superadmin | `403` |
| `recipientId` ajeno | `404` (no `403`: no se confirma que exista) |
| Responder un mensaje sin respuestas | `403` `"Este mensaje no admite respuestas"` |
| Hilo en el tope | `400` `"Esta conversación llegó a los 20 mensajes."` |
| Más de 20 envíos/hora | `429` |
| Falla el `insertMany` | `500`, y el `Message` se borra (RN-16) |
| Falla el contador del badge | Silencioso, badge en 0 (RN-13) |

## Tests necesarios

- **Unitarios** (`tests/unit/messageAudience.test.js`): criterios 1-9.
- **Unitarios** (`tests/unit/messageThread.test.js`): criterios 10-14.
- **Humo** (`tests/smoke/specs.js`): criterios 15-45, con el servidor real y las credenciales
  de superadmin ya guardadas.
- **Roles** (`tests/roles/check-roles.js`): criterio 49.

## Dependencias

- `models/User.js` (`ROLES`, `active`, `school`) — única colección que consulta la audiencia
- `models/School.js` (solo si queda el filtro por escuela, RN-04)
- `middleware/superadmin.js` (`requireSuperAdmin`), `middleware/auth.js`, `middleware/audit.js`
- `config/sections.js`, `config/audit-actions.js`, `middleware/rate-limits.js`
- `server.js:461-481` (middleware del badge), `views/partials/header.ejs:233-240`,
  `views/partials/footer.ejs:111-301` (modal del sobre)

## Riesgos de refactorización

1. **El middleware del badge corre en cada request.** Es el único cambio de esta feature que
   toca el camino caliente. Va con `Promise.all` (no en serie), por índice, y con killswitch
   propio. Si algo se degrada en producción, se apaga con una env var y un reload.
2. **El modal del sobre es JS a mano en un `.ejs` de 400 líneas.** Fusionar dos fuentes ahí
   adentro es donde más fácil se rompe algo que hoy funciona. Los criterios 46-47 existen por eso.
3. **El envío masivo escribe cientos de documentos en una request.** Lotes de 500,
   `ordered: false`, índice único que hace idempotente el reintento.
4. **`NODE_ENV=production` en el `.env` local cachea las vistas EJS**: los cambios en los
   `.ejs` no se ven hasta reiniciar el servidor. Vale para toda la verificación en el navegador.

## Plan de migración

Ninguna migración de datos: dos colecciones nuevas, vacías. Los índices los crea Mongoose al
levantar.

**Antes de pushear a producción hay que avisarle al usuario**: aunque no cambia datos
existentes, la primera arrancada crea índices nuevos y suma un `countDocuments` por request.

Orden sugerido de implementación, en PRs chicos:

1. Modelos + `services/messageAudience.js` + `services/messageThread.js` + sus tests unitarios.
2. `routes/messages.js` (superadmin) + `views/superadmin/messages.ejs` + solapa en
   `config/sections.js` y en el nav.
3. Bandeja del destinatario: `GET/POST /messages/mine` + fusión en el modal del sobre + badge
   unificado.
4. Panel de detalle y seguimiento.
5. Auditoría, rate limits y killswitch — verificados de punta a punta.
