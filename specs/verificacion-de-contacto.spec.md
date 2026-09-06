# Verificación de contacto — correo electrónico y celular

Estado: **implementada** (2026-08-31) · Módulo opcional: `verificacion` · Canales: `email`, `celular`

> **Cómo llegó**: el correo queda **completo y funcionando**; el celular queda **preparado** —
> mismo modelo, mismas rutas, adaptadores de WhatsApp y Twilio escritos— pero con el proveedor
> en `off`, que es el default. Con el celular en `off` la verificación del celular igual funciona
> por la vía **asistida** (D6). Falta encender un proveedor de correo (`VERIF_EMAIL_PROVEEDOR`)
> y prender el módulo por escuela desde `/superadmin/schools`.
>
> **Tres cosas salieron distintas de lo planeado y están corregidas más abajo**: los lugares que
> escriben `email`/`phone` eran **4 y no 6** (y uno no estaba en la lista: la fusión de DNI
> duplicados), el alcance del preceptor no se resuelve como suponía la spec, y apareció una
> trampa nueva —los `.select()` que no traen los campos nuevos— que no estaba anticipada.

> Plan pedido por el usuario: *"un validador de correo electrónico y de celular, típico que te
> envían un correo y hacés click a un enlace o te envían un código, que sea opcional, y lo mismo
> para el celular… que funcione y también marque a los usuarios si está validada o no."*

---

## Problema

Hoy la plataforma **cree** todo lo que le escriben en los dos campos por los que se contacta a una
persona de verdad:

| Campo | Dónde se carga | Quién lo escribe | Qué lo valida hoy |
|---|---|---|---|
| `User.email` | alta de admin, `/courses/profile/change-email`, importación de Excel | admin, preceptor, el propio usuario | un regex de 4 caracteres (`routes/courses.js:450`) + índice único |
| `User.phone` | `/courses/profile/contact`, `/preceptor/students/:id` | el propio usuario, el preceptor | `sanitizePhone()` (`routes/courses.js:304`): 7 a 20 caracteres de `[0-9+\-\s()]` |

Las dos validaciones responden *"¿tiene forma de correo / de teléfono?"*. Ninguna responde la
pregunta que importa: **¿esa casilla y ese teléfono son de esta persona, y los lee?**

Las consecuencias ya son visibles en el sistema tal como está:

1. **El correo es la llave de entrada.** Se inicia sesión con `email` (`routes/auth.js`) y
   `GET /register/lookup` le dice a alguien con un DNI **con qué correo entra**. Un correo mal
   tipeado en la importación de Excel es una cuenta que su dueño no puede usar, y un correo de
   otro es una cuenta que abre la persona equivocada.
2. **No hay recuperación de contraseña**, y no puede haberla: recuperar por correo sin correo
   verificado es regalar cuentas. Hoy la única salida es que un admin resetee a mano
   (`user.reset_password` en `config/audit-actions.js:111`).
3. **El celular ya se publica como enlace.** `views/partials/contact-info.ejs` arma
   `tel:` y `https://wa.me/<número>` con lo que haya guardado. Un dígito de más manda al
   directivo a escribirle por WhatsApp a un desconocido.
4. **Nadie sabe qué porcentaje de la escuela es contactable.** Antes de mandar el primer
   comunicado por correo hay que poder responder "¿a cuántos les va a llegar?".

Y falta la pieza previa a cualquier notificación futura: **la plataforma hoy no sabe mandar nada
hacia afuera**. No hay `nodemailer`, no hay SMTP, no hay proveedor de SMS ni de WhatsApp en
`package.json`. Esta feature es también la que instala ese caño.

---

## Alcance

1. **Verificación de correo**, iniciada por el propio usuario desde su perfil: se manda un mail
   con **un enlace de un click** y, en el mismo mail, **un código de 6 dígitos** de respaldo.
2. **Verificación de celular**, iniciada por el propio usuario: **código de 6 dígitos** por
   WhatsApp o SMS, según el proveedor que la escuela tenga configurado.
3. **Verificación asistida**: un admin o preceptor marca un contacto como verificado porque lo
   confirmó en persona o por teléfono. Es el camino de costo cero y el único posible para el
   alumno que no tiene casilla propia (ver D6).
4. **Estado visible**: chip verde / gris en las 9 pantallas donde ya se muestra un correo o un
   celular, columna y **filtro** "sin verificar" en los listados de usuarios, y contador de
   cobertura en los paneles de admin y directivo.
5. **Opcional en dos ejes**: por escuela (módulo del superadmin) y por persona (nunca bloquea
   nada). Ver D1.
6. **Infraestructura de envío** enchufable (`services/canales/`) con adaptadores SMTP, WhatsApp
   Cloud API, Twilio y `log` para desarrollo.

### Fuera de alcance (decidido, no olvidado)

- **Recuperación de contraseña por correo.** Es la razón de ser económica de todo esto, pero es
  una feature con su propia superficie de ataque (tokens, enumeración de cuentas, sesiones
  invalidadas). Se hace después, *encima* de esto, y ahí sí exigiendo `emailVerifiedAt`.
- **Notificaciones por correo o WhatsApp** (nueva actividad, nota publicada, citación del SOE).
  Esta spec deja el caño instalado y probado; qué se manda por él es otra decisión, y una que
  tiene consecuencias de costo y de fastidio.
- **Login por enlace mágico** (sin contraseña).
- **Verificar el correo de un tercero** (padre/madre/tutor). Hoy el modelo `User` no tiene
  tutores; agregarlos es otra feature.
- **Cambiar el celular a un campo estructurado.** `User.phone` sigue siendo el texto libre que ya
  es y que ya se muestra. Al lado se guarda su forma normalizada, ver D7.
- **Verificación obligatoria para operar.** Explícitamente pedido como opcional. Ver D1.

---

## Decisiones de diseño

### D1 — "Opcional" son dos ejes distintos, y los dos tienen que ser ciertos

El pedido dice "que sea opcional". Eso se cumple en dos lugares que no se pueden confundir:

**Eje escuela — el módulo.** `verificacion` entra en `config/modulos.js` como segundo módulo
opcional, al lado de `recursos`. Una escuela que no lo prendió no ve los chips, no tiene los
botones y las rutas le contestan 403 (`requireModulo('verificacion')`, fail-closed, tal como está
documentado en `middleware/modulos.js`). No es solo estética: sin proveedor configurado el botón
"Verificar" no puede hacer nada, y un botón que no hace nada es peor que no tener el botón.

**Eje persona — nunca es una puerta.** El estado de verificación **no bloquea absolutamente
nada**: ni el login, ni entregar una actividad, ni entrar a la sala. Es un **atributo del dato**,
no un permiso del usuario. Concretamente, y esto es una prohibición explícita para el
implementador:

> Ningún middleware nuevo. Ninguna guarda que consulte `emailVerifiedAt` para dejar pasar o no.
> Si alguna vez hay que exigirlo (recuperación de contraseña), la exigencia vive **en esa ruta**,
> no en una capa transversal.

El motivo es concreto: los usuarios son adolescentes de una escuela pública argentina, muchos con
correo de fantasía creado para el trámite y sin celular propio. Una plataforma que se les cierra
por eso es una plataforma que dejan de usar. La verificación acá sirve para que **el que manda**
sepa si va a llegar, no para castigar al que no verificó.

### D2 — Un modelo para los dos canales, no dos modelos gemelos

Correo y celular comparten todo lo que es difícil: generar un secreto, hashearlo, no permitir 40
intentos, expirar, no dejar reenviar cada 2 segundos, auditar, limpiar lo viejo. Lo único que
cambia es **por dónde sale el mensaje** y **qué se le muestra al usuario**.

Entonces: **un solo `models/ContactVerification.js` con un campo `canal: 'email' | 'celular'`**, y
la diferencia empujada al borde (`services/canales/`). Dos modelos gemelos garantizan que el
arreglo de mañana se aplique a uno solo — el proyecto ya tiene esa cicatriz con las **dos listas
de `TIPOS_ENTRADA`** del SOE y con los **9 lugares** de los formatos de archivo.

### D3 — El correo lleva enlace **y** código, en el mismo mail

No es redundancia por las dudas, es que **cada uno falla en un lugar distinto**:

- El **enlace** es un click y es lo que la gente espera. Pero el correo se abre casi siempre en el
  celular y la sesión está abierta en la netbook del aula; el click abre una pestaña **sin sesión**,
  y ahí el enlace tiene que funcionar igual (ver D4).
- El **código** funciona cuando el enlace no: webmails que reescriben URLs, clientes que las cortan
  a los 78 caracteres, antivirus corporativos que las "pre-visitan" (y consumirían el enlace de un
  solo uso antes de que el usuario lo toque), y el caso más común de todos — el usuario mira el
  mail en el teléfono y quiere terminar en la pantalla donde ya está.

El celular lleva **solo código**. Un enlace en un SMS o en un WhatsApp es exactamente lo que se le
enseña a la gente a no tocar, y además obligaría a que el enlace sobreviva al copiado manual.

### D4 — El enlace del correo funciona sin sesión, y por eso el token es el único secreto

`GET /verificacion/email/:token` **no lleva `requireAuth`**. Es la única ruta de la feature que no
lo lleva, y es a propósito: el escenario normal es abrir el mail en un dispositivo distinto.

Consecuencias que el implementador no puede saltear:

1. El token es de **48 bytes** (`crypto.randomBytes(48).toString('base64url')`), no de 6 dígitos.
   Un código de 6 dígitos sin sesión es adivinable a fuerza bruta; con sesión, no (ya sabés quién
   sos y hay tope de intentos).
2. En la base se guarda **solo el SHA-256 del token**, nunca el token. Mismo criterio que una
   contraseña: quien lea un dump de Mongo no puede verificar correos ajenos. El código de 6
   dígitos se guarda igual, hasheado.
3. La ruta **no cambia nada por GET desde un `<img>`**: el escaneo automático de antivirus de
   correo hace GET a todo lo que ve. Por eso el GET **muestra una página de confirmación con un
   botón**, y el `POST` es el que verifica. Es la única forma honesta de tener "un click" y no
   quemarlo con un pre-fetch.
4. Verificar por enlace **no inicia sesión**. Termina en `views/verificacion/resultado.ejs` con un
   "Listo, tu correo quedó verificado" y un botón a `/login`.

### D5 — El estado vive desnormalizado en `User`, y **cambiar el dato lo borra**

Los campos nuevos de `models/User.js`:

```js
emailVerifiedAt:  { type: Date,   default: null },
emailVerifiedVia: { type: String, enum: ['enlace','codigo','staff','importacion'], default: null },
phoneVerifiedAt:  { type: Date,   default: null },
phoneVerifiedVia: { type: String, enum: ['codigo','staff'],                        default: null },
phoneE164:        { type: String, default: null },   // ver D7
```

`null` = no verificado. No hay booleano: **la fecha es el dato**, porque "verificado hace 8 meses,
antes de que se le venciera el número" es información distinta de "verificado ayer", y porque un
booleano no se puede mostrar en la línea de tiempo del legajo ni en la auditoría.

**La regla de oro de toda la feature**, y el bug clásico que hunde estas implementaciones:

> Toda escritura de `User.email` pone `emailVerifiedAt = null`.
> Toda escritura de `User.phone` pone `phoneVerifiedAt = null` y recalcula `phoneE164`.

No hay excepciones, ni siquiera "es el mismo valor con otro espacio". Los lugares que hoy escriben
esos campos y que **hay que tocar sí o sí** (el implementador los verifica de nuevo con
`grep -rn "\.email *=\|\.phone *=" routes/ services/`):

**Lo que el barrido encontró de verdad — son 4, no 6, y uno no estaba en la lista:**

| Archivo | Qué escribe | Cómo quedó |
|---|---|---|
| `routes/courses.js` | `POST /profile/change-email` | `user.setEmail()` |
| `routes/courses.js` | `PATCH /profile/contact` (celular) | `User.camposDeContacto({ phone })` |
| `routes/preceptor.js` | el preceptor edita correo/teléfono del alumno | `setEmail()` + `setPhone()` |
| **`services/dbFixes.js`** | **`pasarCorreo()`: la fusión de DNI duplicados INTERCAMBIA correos entre dos cuentas** | `camposDeContacto()` en los 3 `$set` |

El cuarto es el que la spec original no había visto, y es el peor de todos: mueve un correo de
una cuenta a otra: sin el arreglo, la marca verde de la cuenta que cede el correo quedaría
certificando una dirección que ya no es suya.

Los que la spec listaba y **no hacía falta tocar**: `routes/admin.js`, `routes/superadmin.js` y
la importación de Excel escriben con `User.create()`, o sea cuentas **nuevas**, que nacen con
`emailVerifiedAt` en `null`. No hay verificación que borrar. Quedan documentados como excepción
explícita en `ASIGNACIONES_PERMITIDAS` (`tests/unit/verificacionRegla.test.js`), con el motivo,
para que el test pueda distinguir "se olvidaron" de "se decidió".

La forma de que esto no se olvide **no es acordarse**: es un método del modelo,
`user.setEmail(nuevo)` / `user.setPhone(nuevo)`, que hace las dos cosas juntas, más un test que
recorre las rutas y falla si alguna asigna `.email =` directamente. Es el mismo remedio que la
lista única `CARPETAS` + su test en la feature de backup.

### D6 — La verificación asistida es una decisión de producto, no un parche

`phoneVerifiedVia: 'staff'`: el preceptor toca "Verificado" en la ficha del alumno y queda
registrado **quién** lo hizo y **cuándo** (en `AuditLog`, con la acción `verificacion.staff`).

Por qué está en el alcance y no es trampa:

- **El SMS y el WhatsApp se pagan.** En Argentina un SMS por Twilio ronda los USD 0,05 y una
  plantilla de autenticación de WhatsApp Cloud tiene costo por conversación. Verificar 600
  alumnos, con reintentos, es un gasto real para una escuela pública, y sostenerlo todos los años
  con los ingresantes, más.
- **Muchos alumnos de 1° y 2° no tienen celular propio**: el número que figura es el de la madre.
  Un código que llega al teléfono de la madre y que la madre le dicta al hijo verifica exactamente
  lo mismo que el preceptor confirmando por teléfono, y no cuesta nada.
- **La escuela ya hace esta verificación**: es la misma persona que chequea el DNI contra el
  documento en la mano.

Lo que la hace honesta y no un botón de "poner verde todo": **queda firmada**. `verifiedVia`
distingue `staff` de `codigo`, los listados pueden filtrar por una u otra, y el chip de la UI dice
*"Verificado por la escuela"* y no *"Verificado"* a secas. Nadie que lea la pantalla se confunde
sobre qué evidencia hay detrás.

Quién puede: `admin`, `superadmin`, `directivo` y `preceptor` (este último solo sobre alumnos de
**sus** divisiones — el alcance ya existe en `middleware/preceptor.js`, se reusa, no se reinventa).
**Nadie puede auto-verificarse por esta vía**, ni siquiera el superadmin sobre su propia cuenta:
la ruta rechaza `req.params.id === req.userId`.

### D7 — El número que se guarda no es el número al que se manda

`sanitizePhone()` acepta hoy `(261) 15 555-1234`, `261 155551234`, `+54 9 261 555 1234` y
`2615551234`. Para el humano que lee la ficha, todas están bien. Para un proveedor de SMS,
**solo la tercera existe**: hace falta E.164 (`+5492615551234`).

Y Argentina es el peor caso posible del planeta para esto, por dos particularidades que se pisan:

- el **`15`** que se marca localmente para llamar a un celular y que **no va** en el formato
  internacional;
- el **`9`** que sí va después del `+54` para celulares, y que **no** va para fijos.

Con lo cual `+54 261 15 555-1234` está mal de dos formas distintas a la vez, y es lo que la gente
escribe.

**La decisión**: `User.phone` **no se toca** — es lo que la gente escribió, es lo que muestran
`views/partials/contact-info.ejs` y las fichas, y cambiarlo rompería pantallas por todos lados. Al
lado se guarda `User.phoneE164`, calculado por `services/telefonoAR.js`, que:

1. Deja solo dígitos y un `+` inicial.
2. Si arranca con `+`, lo respeta (alguien con número de otro país).
3. Si no: saca el `0` de área inicial, saca el `15` (esté donde esté, después del área), antepone
   `+549`.
4. Valida largo (10 dígitos nacionales) y devuelve `{ e164, error }`.

Si `phoneE164` sale `null`, el botón "Verificar" del perfil **no aparece** y en su lugar se
muestra *"Revisá el número: no pudimos interpretarlo como un celular argentino"*. **No se manda
nunca a un número que no se pudo normalizar** — la alternativa es pagar por mensajes que no llegan
a ningún lado, o peor, que llegan al lugar equivocado.

Este módulo es **puro y sin dependencias**, así que se testea con una tabla de ~20 casos reales sin
levantar nada. Es el archivo más importante de la feature y el más barato de dejar bien.

### D8 — Proveedores enchufables, y `log` es el que se usa en desarrollo

`services/canales/` con una interfaz de una sola función:

```js
async function enviar({ destino, asunto, texto, html }) // → { ok, id, error }
```

Adaptadores:

| Canal | Proveedor | Cuándo |
|---|---|---|
| email | `smtp` | producción — `nodemailer`, sirve para Gmail con contraseña de aplicación, Brevo, Resend, el que sea |
| email | `log` | desarrollo — escribe el mail entero en `logs/` y **no manda nada** |
| celular | `whatsapp` | WhatsApp Cloud API de Meta, con plantilla de autenticación |
| celular | `twilio` | SMS, el respaldo universal |
| celular | `log` | desarrollo |
| ambos | `off` | el canal no existe: el botón no se muestra y la ruta contesta 503 |

El proveedor se elige por variable de entorno, **no** por escuela: es infraestructura del servidor.
Qué escuela lo usa lo decide el módulo (D1).

`log` no es un mock de test: es el modo de desarrollo real, y por eso escribe el mensaje completo
—código incluido— en un archivo aparte, `logs/verificacion-dev.log`, para poder terminar el flujo
entero en local sin cuenta de SMTP. **Ese archivo no se escribe nunca si `NODE_ENV=production`**;
el arranque tira error si alguien deja `log` en producción, en vez de escribir códigos en claro al
disco de un servidor.

### D9 — El servidor todavía no sabe su propia URL, y el enlace la necesita

Trampa descubierta al revisar el proyecto: **no existe hoy ninguna configuración con la URL pública
de la plataforma**. `config/network.js` es estadísticas de red, no direcciones. Todo lo que la app
genera son rutas relativas, que en un mail no sirven.

Se agrega `APP_URL` al `.env` (hoy: `https://169-58-248-255.sslip.io`, el VPS Contabo), leída en
`config/verificacion.js`. **No se deriva de `req.headers.host`**: ese header lo controla el cliente,
y un `Host: sitio-del-atacante` convierte el mail de verificación en un phishing firmado por la
escuela. Si `APP_URL` no está y el canal de email no es `off`, el proceso **no arranca** — es un
error de configuración, y el momento de descubrirlo es el `pm2 reload`, no el primer mail.

Nota de futuro: cuando exista la feature de **dominios por escuela** (`specs/dominios-por-escuela.spec.md`),
`APP_URL` pasa a ser el respaldo y el enlace usa el hostname de la escuela del usuario. La función
`urlDeVerificacion(user, token)` se escribe **desde ahora** recibiendo el `user`, aunque hoy ignore
la escuela, para que ese cambio sea de una línea.

### D10 — Anti-abuso: por usuario, nunca por IP

La regla de la casa, repetida en cada limiter de `middleware/rate-limits.js`: **la escuela entera
sale por una sola IP pública NAT**, ~300 personas. Un límite por IP acá significaría que los
primeros 20 alumnos de la mañana dejan a los otros 580 sin poder verificar.

| Límite | Valor | Por qué |
|---|---|---|
| Envíos por canal | **5 por hora, por usuario** | reintentos legítimos (no llegó, fue a spam, se equivocó de número) sin financiarle a nadie una campaña de SMS |
| Reenvío | **60 segundos de espera** entre uno y otro | el botón se deshabilita con cuenta regresiva; es lo que corta el doble click, que es el 90% del "abuso" real |
| Intentos de código | **5 por verificación** | al sexto, la verificación se quema y hay que pedir una nueva |
| Vida del código | **15 minutos** | suficiente para ir a buscar el teléfono |
| Vida del enlace | **24 horas** | el mail se lee a la noche |
| Verificaciones vivas | **1 por usuario y canal** | pedir una nueva **invalida la anterior** (y no "las últimas 3 valen") |

Además, un tope **global por escuela y por día** (`VERIF_TOPE_DIARIO_ESCUELA`, default 300 envíos
de celular): es la única red que evita que un error de código o un script suelto se convierta en
una factura. Al llegar al tope, los envíos se rechazan con un mensaje claro y **queda un registro
de nivel `warn`** en el log.

El límite se implementa con `express-rate-limit` y `keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip)`,
copiando textualmente el patrón de `roomMessageLimiter` — incluido el paso por `ipKeyGenerator`, sin
el cual `express-rate-limit` v8 no arranca (`ERR_ERL_KEY_GEN_IPV6`).

⚠️ **Los dos workers de PM2**: `express-rate-limit` cuenta en memoria por proceso, así que el techo
real es **el doble** del configurado. Ya está documentado para el monitor de rate limit y vale
igual acá; los números de arriba son los de la config, no los efectivos.

### D11 — No confirmar nunca si un contacto existe

Las rutas de envío **exigen sesión** (salvo el GET del enlace, D4), así que la enumeración clásica
—"probar correos hasta que uno conteste distinto"— no aplica. Pero quedan dos filtraciones sutiles
que hay que cerrar igual:

1. **Correo ya usado por otra cuenta.** Si alguien pone el correo de un compañero y el sistema
   contesta *"ese correo ya está en uso"*, eso es un oráculo. El índice único ya da ese mensaje en
   `change-email`, y ahí es correcto (es cambiar el correo, no verificarlo). En **verificación** no
   se llega a esa situación: se verifica el correo que **ya** está en la cuenta.
2. **Tiempos de respuesta.** Código correcto y código incorrecto se comparan con
   `crypto.timingSafeEqual` sobre los hashes, no con `===`.

### D12 — Dónde se ve el estado: un chip, un partial, nueve lugares

El proyecto ya aprendió esta lección de la peor manera con los formatos de archivo (9 lugares) y
las subidas de imagen (6 caminos): **una regla que se repite en cada pantalla es una regla que va a
divergir**. Entonces:

- **`public/js/estadoVerificacion.js`** — la regla, compartida entre servidor y navegador, con el
  mismo patrón de `visibilidadActividad.js`, `estadoActividad.js` y `pendienteActividad.js`
  (`module.exports` al pie si existe `module`, `window.X` si no). Expone
  `estadoContacto(user, canal)` → `{ estado: 'verificado'|'pendiente'|'sin-dato', via, desde, texto, icono, color }`.
- **`views/partials/chip-verificado.ejs`** — el chip. Espera `person` y `canal`. Un solo lugar
  donde se decide el color, el ícono y el texto.

Los lugares donde se incluye (todos ya muestran hoy un correo o un teléfono):

| # | Pantalla | Archivo |
|---|---|---|
| 1 | Mi perfil — correo | `views/profile.ejs:83` |
| 2 | Mi perfil — celular | `views/profile.ejs:159` |
| 3 | Chips de contacto (reusado en varias fichas) | `views/partials/contact-info.ejs` |
| 4 | Admin › Usuarios (listado + filtro) | `views/admin/users.ejs` |
| 5 | Admin › Perfil de usuario | `views/admin/user-profile.ejs` |
| 6 | Superadmin › Usuarios | `views/superadmin/users.ejs` |
| 7 | Directivo › Alumnos y Docentes | `views/directivo/students.ejs`, `teachers.ejs` |
| 8 | Directivo › Detalle | `views/directivo/student-detail.ejs`, `teacher-detail.ejs` |
| 9 | Preceptor › Detalle del alumno | `views/preceptor/student-detail.ejs` |

**Contraste**: el chip usa las variables del tema (`--text-secondary`, no `--text-hint`, que no
llega a AA en ningún tema) y **nunca** un color en `style=` inline, que le gana a la variante
oscura — es exactamente el bug de 1,10:1 que dejó texto invisible en la sala.

**Fechas**: `fmt` (de `res.locals.fmt`, viene de `services/liveRoom.js`) en el servidor, `Fecha` en
el navegador. Nunca `toLocaleDateString`.

---

## Modelo de datos

### `models/ContactVerification.js` (nuevo)

```js
{
  user:       ObjectId, // → User, índice
  school:     ObjectId, // → School, para el tope diario por escuela (D10)
  canal:      String,   // 'email' | 'celular'
  destino:    String,   // el correo o el E164 al que se mandó, congelado
  tokenHash:  String,   // SHA-256 del token del enlace (solo canal email)
  codigoHash: String,   // SHA-256 del código de 6 dígitos
  intentos:   Number,   // default 0, tope 5
  enviadoEn:  Date,
  expiraEn:   Date,     // índice TTL
  usadoEn:    Date,     // null mientras esté viva
  proveedor:  String,   // 'smtp' | 'whatsapp' | 'twilio' | 'log' — para diagnóstico
  envioId:    String,   // el id que devuelve el proveedor, para rastrear una queja real
  envioError: String,   // si el proveedor rechazó
}
```

Índices:
- `{ user: 1, canal: 1, usadoEn: 1 }` — buscar la verificación viva de alguien.
- `{ tokenHash: 1 }` sparse — resolver el enlace en un solo golpe.
- `{ expiraEn: 1 }` con `expireAfterSeconds: 0` — **TTL de Mongo**, la limpieza la hace la base.
  No hay cron que barrer ni tarea que se olvide de correr.
- `{ school: 1, canal: 1, enviadoEn: -1 }` — el tope diario por escuela.

⚠️ **`destino` se congela** al crear la verificación y se compara al confirmar. Si el usuario pide
el código, cambia el número y después mete el código, **se rechaza**: verificó otra cosa.

⚠️ **Este modelo tiene que aparecer en `routes/backup.js`.** Es la trampa que ya costó 14
colecciones de 29 y los legajos del SOE, y el proyecto ya tiene el remedio montado: `COLLECTIONS`
(lo que se respalda) y `EXCLUIDAS_DEL_BACKUP` (lo que se deja afuera **a propósito**), con
`tests/unit/backupCobertura.test.js` fallando ante cualquier modelo que no esté en ninguna de las
dos. O sea: **el test va a romper solo** cuando se cree el modelo, y ahí hay que decidir.

La decisión propuesta: **`EXCLUIDAS_DEL_BACKUP`**, con el comentario del porqué. Son tokens
efímeros con TTL de 24 horas; restaurar un backup de la semana pasada resucitaría códigos de
verificación vencidos, que es peor que no tenerlos. Lo que sí se respalda —los cinco campos de
`User`— viaja en `users`, que ya está en `COLLECTIONS`.

### `models/User.js` (5 campos nuevos)

Los de D5. Más el índice `{ school: 1, emailVerifiedAt: 1 }` para el contador de cobertura, que
sobre 600 usuarios por escuela no es imprescindible pero cuesta nada.

### `models/School.js`

Nada nuevo: el módulo `verificacion` entra en `School.modules`, que ya existe y ya lo edita el
superadmin desde `/superadmin/schools`.

---

## Rutas

Router nuevo `routes/verificacion.js`, montado en `server.js` **antes** de `/courses`:

```js
app.use('/verificacion', verificacionRoutes);
```

| Método y ruta | Quién | Qué hace |
|---|---|---|
| `POST /verificacion/email/enviar` | el propio usuario | genera token + código, manda el mail, invalida la anterior |
| `POST /verificacion/email/codigo` | el propio usuario | confirma con los 6 dígitos |
| `GET  /verificacion/enlace/:token` | **sin sesión** | página de confirmación con botón (D4) |
| `POST /verificacion/enlace/:token` | **sin sesión** | verifica y muestra el resultado |
| `POST /verificacion/celular/enviar` | el propio usuario | idem, por WhatsApp/SMS |
| `POST /verificacion/celular/codigo` | el propio usuario | confirma |
| `DELETE /verificacion/:canal` | el propio usuario | "este ya no es mío" — borra la marca |
| `POST /verificacion/staff/:id/:canal` | admin/directivo/preceptor | verificación asistida (D6) |
| `DELETE /verificacion/staff/:id/:canal` | admin/directivo/preceptor | revierte una asistida |
| `GET  /verificacion/cobertura` | admin/directivo | JSON con los contadores del panel |

Todas menos las dos del enlace llevan `requireAuth` **y** `requireModulo('verificacion')`.

**Auditoría** — entradas nuevas en `config/audit-actions.js`, categoría `user`:

```js
'verificacion.enviada':  { label: 'pidió verificar un contacto',  icon: 'send',       color: '#1a73e8' },
'verificacion.ok':       { label: 'verificó su contacto',         icon: 'verified',   color: '#137333' },
'verificacion.staff':    { label: 'verificó el contacto de',      icon: 'how_to_reg', color: '#137333' },
'verificacion.revocada': { label: 'quitó la verificación de',     icon: 'gpp_maybe',  color: '#ea8600' },
```

`verificacion.enviada` **no se audita en cada reintento** (sería ruido: el mismo caso que las 30
marcas de asistencia que se decidió no auditar). Se audita el primer envío de cada verificación.

---

## Configuración

### `.env` (nuevas)

```
APP_URL=https://169-58-248-255.sslip.io

VERIF_EMAIL_PROVEEDOR=smtp          # smtp | log | off
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="Escuela 4-118 <no-responder@...>"

VERIF_CELULAR_PROVEEDOR=off         # whatsapp | twilio | log | off
WA_PHONE_ID=
WA_TOKEN=
WA_PLANTILLA=codigo_verificacion
TWILIO_SID=
TWILIO_TOKEN=
TWILIO_FROM=

VERIF_TOPE_DIARIO_ESCUELA=300
```

**Se arranca con `VERIF_CELULAR_PROVEEDOR=off`.** El correo se puede tener andando hoy con una
cuenta de Gmail y una contraseña de aplicación (500 mails/día, de sobra para 600 usuarios de a
tandas) o con Brevo (300/día gratis). El celular necesita una decisión de gasto que es del usuario,
y hasta que la tome **la verificación asistida (D6) cubre el canal entero sin costo**.

### `config/verificacion.js` (nuevo)

Catálogo único, hermano de `config/modulos.js`: los dos canales, sus límites, sus plantillas de
mensaje, el proveedor elegido y las validaciones de arranque. Una sola lista que leen la pantalla,
la ruta y el envío.

### Dependencia nueva

`nodemailer` (^7). Es la única. WhatsApp Cloud y Twilio se hablan con `fetch` nativo de Node 22 —
no hace falta el SDK de Twilio para hacer un POST con Basic Auth, y una dependencia menos en un
proyecto que despliega por webhook a un VPS es una dependencia menos que puede romper el arranque.

---

## Plan de implementación

Seis fases. Cada una es un commit que deja el sistema andando y con los tests en verde. El flujo
SDD de la casa (arquitecto → tester → implementador → revisor) aplica a partir de la aprobación de
esta spec.

### Fase 0 — Los cimientos que no mandan nada *(sin riesgo, sin red)*

1. `services/telefonoAR.js` + su test de tabla (D7). **Es el archivo más importante.**
2. `public/js/estadoVerificacion.js` + su test (D12).
3. Los 5 campos en `models/User.js`, con `setEmail()` / `setPhone()` (D5).
4. `models/ContactVerification.js` con sus 4 índices.
5. Anotarlo en `EXCLUIDAS_DEL_BACKUP` (`routes/backup.js`) con el porqué —
   `tests/unit/backupCobertura.test.js` va a estar en rojo hasta que se haga.
6. `config/verificacion.js` con los límites y la validación de arranque.

Al terminar la fase 0 no cambió nada visible y ya hay 3 tests nuevos.

### Fase 1 — La regla de oro *(la que más rompe si sale mal)*

6. Reemplazar las asignaciones directas de `.email` / `.phone` por los métodos, en los 6 lugares de
   la tabla de D5.
7. El test que recorre `routes/` y falla si aparece una asignación directa.
8. `phoneE164` se calcula para todos los usuarios existentes con un script de migración
   (`migrate-phone-e164.js`), con `--dry-run` primero, como los demás scripts del proyecto.

Al terminar la fase 1 nadie verificó nada todavía, pero **ya es imposible que una verificación
quede pegada a un dato viejo**.

### Fase 2 — El caño de salida *(la primera que toca la red)*

9. `services/canales/` con los 4 adaptadores + el despachador.
10. `logs/verificacion-dev.log` y el rechazo al arrancar con `log` en producción.
11. Un comando de diagnóstico, `node tools/probar-canal.js --email walter@...`, que manda un mensaje
    de prueba y devuelve el error del proveedor tal cual. **Sin esto, el primer fallo en producción
    se diagnostica a ciegas** — es la misma lección que dejó `tools/ver-subida.js`.

### Fase 3 — El flujo del correo *(la mitad que se puede tener andando ya)*

12. `routes/verificacion.js` con las rutas de email, sus limiters y el modelo.
13. `views/verificacion/resultado.ejs` y la plantilla del mail (HTML + texto plano, las dos: hay
    clientes que no muestran HTML y el código tiene que estar en las dos).
14. La UI en `views/profile.ejs`: botón, campo de 6 dígitos, cuenta regresiva de 60s.
15. El módulo `verificacion` en `config/modulos.js` y su `requireModulo`.

### Fase 4 — El celular y la verificación asistida

16. Las rutas de celular (mismo modelo, otro canal).
17. La UI de celular en el perfil, con el mensaje de "no pudimos interpretar el número" (D7).
18. La verificación asistida: botón en `views/preceptor/student-detail.ejs`,
    `views/admin/user-profile.ejs` y las fichas del directivo, con el alcance de
    `middleware/preceptor.js` y el rechazo de auto-verificarse.

### Fase 5 — La marca en las 9 pantallas

19. `views/partials/chip-verificado.ejs` y su inclusión en los 9 lugares de D12.
20. Columna y **filtro** "sin verificar" en `/admin/users` y `/superadmin/users`.
21. `GET /verificacion/cobertura` y la tarjeta de cobertura en el panel de admin y de directivo.
22. Exportar la columna en el CSV de usuarios, si existe.

### Fase 6 — Cierre

23. Los 4 audit-actions.
24. `agente.md`: changelog + la sección de la feature en Backend/Rutas/Modelos.
25. El backlog de auditoría: tachar "no hay verificación de contacto", anotar lo que quedó fuera.
26. Las tres suites en verde: `npm run test:unit`, `npm run test:smoke`, `npm run test:roles`.
27. ⚠️ **`git archive HEAD` y arrancar el árbol commiteado antes de pushear.** El 502 del 29/08 fue
    exactamente esto: `models/SoeRequest.js` existía en la carpeta y no en el commit. Esta feature
    agrega 8 archivos nuevos, es el escenario perfecto para que vuelva a pasar.

---

## Criterios de aceptación

Para el agente **tester**, que escribe los tests antes de que exista el código.

### Normalización de teléfono (`services/telefonoAR.js`)

| Entrada | `e164` esperado |
|---|---|
| `2615551234` | `+5492615551234` |
| `261 15 555-1234` | `+5492615551234` |
| `0261 155551234` | `+5492615551234` |
| `+54 9 261 555 1234` | `+5492615551234` |
| `+5492615551234` | `+5492615551234` |
| `(261) 15 555 1234` | `+5492615551234` |
| `+1 415 555 2671` | `+14155552671` (otro país, se respeta) |
| `1234` | `null` + error |
| *(vacío)* | `null`, **sin** error |
| `261555123456789` | `null` + error (largo) |

### Estado (`public/js/estadoVerificacion.js`)

- Sin dato → `sin-dato`. Con dato y `verifiedAt: null` → `pendiente`. Con fecha → `verificado`.
- `verifiedVia: 'staff'` → el texto dice **"por la escuela"** y no "Verificado" a secas.
- Es la **misma** función en servidor y navegador (el test la carga con `require` y la evalúa como
  script, igual que hace `tests/unit/visibilidadActividad.test.js`).

### La regla de oro (D5)

- Verificar el correo, después cambiarlo por `POST /profile/change-email` → `emailVerifiedAt` queda
  en `null`.
- Idem con el celular por `PATCH /profile/contact`.
- Idem cuando **el preceptor** edita el teléfono del alumno desde su ficha.
- Idem en el alta y la edición desde `/admin/users`.
- Cambiar el correo por **el mismo valor con espacios distintos** también lo borra.
- Un test estático falla si alguna ruta asigna `.email =` o `.phone =` directo.

### Flujo del correo

- Pedir verificación crea **una** `ContactVerification` viva; pedir otra **invalida la primera**
  (el código viejo ya no sirve).
- El código correcto verifica; el incorrecto suma un intento; al **6°** la verificación se quema.
- El código **expirado** (16 minutos) no verifica.
- El enlace verifica **sin sesión**.
- El `GET` del enlace **no verifica** — solo muestra el botón. Solo el `POST` verifica. *(El test
  hace GET dos veces y después POST: tiene que funcionar igual.)*
- Un enlace ya usado muestra "ya estaba verificado", no un error feo.
- Pedir el código, **cambiar el correo**, y meter el código → **rechazado** (`destino` congelado).
- Ni el token ni el código quedan en claro en la base (el test lee el documento y compara).

### Celular

- Todo lo del correo, salvo el enlace.
- Un `phone` que no normaliza **no genera envío**: 400 con el mensaje de "revisá el número", y
  **cero llamadas al proveedor** (el test espía el adaptador y cuenta 0).

### Verificación asistida

- El preceptor verifica a un alumno **de sus divisiones** → OK, `verifiedVia: 'staff'`, queda en
  `AuditLog` con su nombre.
- El preceptor sobre un alumno **de otra división** → 403.
- Cualquiera **sobre sí mismo** → 403, incluido el superadmin.
- El docente (`teacher`) → 403.

### Lo opcional

- Escuela **sin** el módulo: las rutas dan 403, el chip no se renderiza, el botón no está en el
  perfil. (Va en `tests/roles/`, que ya prueba matriz de roles × solapas.)
- Un usuario **sin verificar nada** puede: iniciar sesión, entrar a una materia, entregar una
  actividad, entrar a la sala en vivo. **Este test es el que protege la decisión de D1** y no se
  borra nunca.

### Límites

- 6° envío en una hora → 429.
- 2° envío dentro de los 60 segundos → 429 con los segundos que faltan.
- Superado el tope diario de la escuela → 429 + `warn` en el log.

---

## El bug que solo apareció probando en el navegador

⚠️ **El enlace NO puede colgar de `/verificacion/email/`.** Así estaba escrito acá, y en Express
gana el primero que matchea: `POST /verificacion/email/enviar` —la ruta para PEDIR un código—
entraba en `/email/:token` con `token = "enviar"`, y **devolvía 200 con la página HTML del
enlace** donde el navegador esperaba JSON. Lo mismo le pasaba a `/email/codigo`.

Los dos paths tienen dos segmentos, así que ninguna prueba de lógica lo ve: la función del
service andaba perfecto, el modelo andaba perfecto, los 122 unitarios estaban en verde. Se
manifestó como *"Error de conexión"* en la pantalla, que es el mensaje menos informativo posible,
y el log del servidor decía `POST /email/enviar 200` — o sea, todo bien.

Por eso el enlace vive en **`/verificacion/enlace/:token`**: un prefijo que ningún canal puede
tomar. La lección general: **cuando un router mezcla un parámetro de path (`:token`) con nombres
fijos en la misma posición, agregar un nombre nuevo puede robarle requests a una ruta vieja sin
que nada falle** — y si las dos devuelven 200, no hay error que mirar.

---

## Trampas

Las que ya tienen nombre y apellido en este proyecto y que esta feature vuelve a pisar:

1. **La verificación pegada a un dato viejo.** Es *el* bug de esta clase de features (D5). El
   remedio no es acordarse: son los métodos del modelo + el test estático.
2. **`NODE_ENV=production` en el `.env` local**: los cambios en `.ejs` no se ven hasta reiniciar el
   server, y nodemon no alcanza. Van a ser 12 vistas tocadas; se pierde media hora la primera vez.
3. **Los dos workers de PM2**: el rate limit cuenta por proceso, el techo real es el doble (D10).
4. **La lista del backup**: `ContactVerification` va en `EXCLUIDAS_DEL_BACKUP` **a propósito y por
   escrito**, no por olvido. `backupCobertura.test.js` avisa solo — no hay que acordarse, hay que
   no ignorarlo.
5. **El contraste del chip**: `--text-secondary`, nunca `--text-hint`, nunca un color inline.
6. **Las fechas**: `fmt` en el servidor, `Fecha` en el navegador.
7. **`grep '^router\.'` no ve todas las rutas** — `routes/attendance.js` declara dos routers. Si
   hay que barrer rutas para el test estático de D5, usar el grep bueno.
8. **El correo del dueño del sistema** (`SYSTEM_OWNER_EMAIL`) no puede cambiar de dirección por las
   rutas normales; la verificación **sí** tiene que poder correr sobre él (verificar no es cambiar).
9. **`git archive HEAD`** antes de pushear: 8 archivos nuevos.
10. **La caché de 45s del documento de usuario** (`middleware/cache.js`): cada escritura de
    verificación tiene que llamar a `invalidateUser()`, o el chip sigue gris 45 segundos después de
    verificar y parece que no funcionó. *(Resuelto: lo hace `marcarVerificado()`, un solo lugar.)*

11. ⚠️ **TRAMPA NUEVA, no estaba anticipada: los `.select()` que no traen los campos.** Una ruta
    que arma su `.select()` a mano y se olvida de `emailVerifiedAt`/`phoneVerifiedAt` **no da
    ningún error**: le pasa a la vista un usuario sin esos campos, y el chip —que no puede
    distinguir "no vino en el select" de "no está verificado"— muestra **"Sin verificar" para
    todo el mundo**. Es la misma clase de falla silenciosa que el backup al que le faltaban 14
    colecciones: anda perfecto y miente.

    El remedio es la constante `CAMPOS_SELECT` de `public/js/estadoVerificacion.js`, que se pega
    al select (`.select('_id name email ' + CAMPOS_SELECT)`). Ya se aplicó en los tres lugares
    que lo necesitaban: `routes/directivo.js` (ficha del alumno y ficha del docente) y
    `routes/preceptor.js` (ficha del alumno). `routes/admin.js` y `routes/superadmin.js` no lo
    necesitan porque traen el documento completo.

12. **El alcance del preceptor no es un campo del usuario.** La spec suponía un `target.division`
    que no existe: un alumno pertenece a las **materias** (`Course.students`) y la división sale
    de ahí. La comprobación es una consulta, no una comparación — y la hace `alumnoEnAlcance()`,
    **exportada** desde `routes/preceptor.js` y no copiada, porque dos implementaciones de una
    barrera terminan siendo una sola barrera.

---

## Decisiones que quedan para el usuario

No bloquean el arranque — la Fase 0 y la 1 se pueden hacer con cualquier respuesta. Con el default
propuesto, la feature funciona entera salvo el envío real al celular.

1. **Proveedor de correo.** Propuesta: **Gmail con contraseña de aplicación** para arrancar (gratis,
   500/día, 10 minutos de configuración), migrable a Brevo o Resend cambiando 5 variables.
2. **Proveedor de celular, o ninguno.** Propuesta: **arrancar con `off`** y cubrir el canal con la
   verificación asistida (D6). Si después se quiere automático: WhatsApp Cloud API es lo que la
   gente de la escuela realmente lee; Twilio SMS es lo que llega siempre.
3. **Presupuesto mensual de mensajes**, si se activa el celular. Fija el
   `VERIF_TOPE_DIARIO_ESCUELA`; el default de 300 es un número prudente, no medido.
4. **¿Se le pide activamente al usuario que verifique?** Propuesta: **no en esta entrega**. Un
   cartel en el perfil y nada más. Un recordatorio en el dashboard es fácil de agregar después y es
   fácil de volver molesto.
