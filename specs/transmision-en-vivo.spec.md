# Transmisión en vivo del docente (audio + pantalla + cámara)

Estado: **APROBADA E IMPLEMENTADA — Fase 1** (2026-08-31) · Módulo: `transmision`, **desplegado APAGADO**

> El usuario aprobó la spec el 2026-08-31 con un cambio de alcance: *"generala pero dejala
> desactivada desde el panel de superadmin, y permitime habilitarla por escuela o por docente"*.
> De ahí sale el módulo de DOS EJES de D10, que es lo primero que se construyó.
>
> **Lo que quedó afuera de esta entrega y por qué**, en una línea cada uno: la Fase 2 (dar la
> palabra desde la interfaz — el backend y las reglas ya están) y la grabación (D9, frenada por
> el consentimiento).
>
> **El media SÍ se verificó**: viaja y vuelve, navegador → SFU → navegador, con cuadros
> decodificados. Lo que falta es que una persona mire una clase real con cámara y micrófono para
> juzgar la calidad. Ver "Lo que falta probar" al final.

Hermana de [`sala-en-vivo.spec.md`](sala-en-vivo.spec.md): **no la reemplaza, se le cuelga adentro.**

---

## Problema

La sala en vivo ya tiene todo lo que rodea a una clase —quiénes están, quién escribe, qué se
comparte, quién modera— pero **le falta la clase**. Hoy la docente escribe "abran la página 14"
y espera. Para explicar algo tiene que salir de la plataforma: manda un link de Meet por
WhatsApp, y ahí se pierde la asistencia, la moderación, el registro y el control de quién entra.

Lo que se pide es la parte que falta: que la docente **transmita** —voz, pantalla, cámara— desde
adentro de la sala que ya existe.

Y hay una restricción que no es negociable y que ordena todo el diseño: **el servidor tiene un
puerto de salida finito**. Una clase de 30 alumnos mirando 720p consume 76 Mbit/s. El VPS entero
tiene entre 200 Mbit/s y 1 Gbit/s. **Tres clases en calidad alta saturan la escuela entera**, y
lo primero que se cae no es el video: es la plataforma, para todos, incluidos los que no están
transmitiendo. Esta spec es, en buena medida, el diseño de ese techo.

---

## Alcance

1. **Emisión del docente**: micrófono, pantalla compartida y cámara, en cualquier combinación.
2. **Recepción del alumno**, explícita (botón "Ver la clase") y con calidad adaptativa.
3. **Levantar la mano** y **dar la palabra**: el docente le abre el micrófono a un alumno.
4. **Gobernador de ancho de banda**: techo por escuela, degradación automática y honesta.
5. **Moderación**: cortar el micrófono, sacar a alguien de la transmisión, cortar todo.
6. **Panel de la transmisión** en `/superadmin/monitor`: cuántas clases, cuánto ancho de banda.
7. Todo esto **adentro de la sala existente**, sin mudar el chat ni tocar la asistencia.

### Fuera de alcance en Fase 1 (decidido, no olvidado)

- **Grabación.** Ver D9. Es la única que se rechaza por motivos que no son técnicos.
- **Subtítulos automáticos y traducción.** Necesitan un motor de voz a texto: o servicio pago
  (datos de menores saliendo de la escuela) o un modelo local que compite por la CPU justamente
  con la clase. Fase 3, con decisión aparte.
- **Salas de grupos (breakout rooms).** Multiplican las salas activas por 4 o 5 y el techo de
  ancho de banda es lo primero que se rompe. Además, la unidad de esta plataforma es la
  **materia**: una sala de grupo no tendría curso, ni asistencia, ni dueño.
- **Fondos virtuales y desenfoque.** Corren en la máquina del docente, no en el servidor, pero
  en las netbooks del aula el costo de CPU se paga en video entrecortado.
- **Llamar por teléfono (dial-in).** Necesita un troncal SIP y un proveedor pago.
- **Pizarra colaborativa.** Es una feature propia, no parte de la transmisión.
- **Transmitir a quien no es de la materia** (un acto escolar para toda la escuela). Es otra cosa:
  un evento sin curso, con miles de espectadores, que se resuelve con HLS y no con un SFU.

---

## Decisiones de diseño

### D1 — Transmite el docente, no la clase. Es LA decisión que hace que esto entre en el servidor

Google Meet es una grilla: 30 personas publican y 30 reciben 29 flujos cada una. Eso, acá, son
**870 flujos por aula**, y el servidor se cae con la primera.

Esta feature es una **transmisión**, no una videollamada: **una persona emite y N reciben**. El
alumno participa por donde ya participa —el chat, las reacciones, la mano levantada— y solo
publica cuando el docente le da la palabra, de a uno (D7).

Esa sola decisión divide el problema por 30. Y no es una limitación disfrazada: es la forma real
de una clase. Nadie da clase mirando 30 caras de 180 píxeles.

**Las cuentas, que son el argumento entero.** Bajada por alumno, con audio Opus mono (~32 kbps)
y las capas estándar de simulcast (125 kbps a 180p, 400 kbps a 360p, 2,5 Mbps a 720p):

| Modo | Por alumno | Aula de 30 (subida del servidor) |
|---|---|---|
| Solo audio | 32 kbps | **~1 Mbit/s** |
| Audio + 180p | 157 kbps | **4,7 Mbit/s** |
| Audio + 360p | 432 kbps | **13 Mbit/s** |
| Audio + 720p | 2,53 Mbit/s | **76 Mbit/s** |

Contra un puerto de 200 Mbit/s, reservando el 20 % para el resto de la plataforma (las páginas,
las entregas de 15 GB, los backups) quedan **~160 Mbit/s usables**:

| Calidad | Clases simultáneas de 30 que entran |
|---|---|
| Solo audio | ~160 |
| 180p | **34** |
| 360p | **12** |
| 720p | **2** |

La escuela 4-118 tiene ~15 divisiones: **a 360p entra justo, a 180p sobra, a 720p no entra
ninguna configuración realista**. De ahí sale el techo de D5.

**El cupo mensual NO es el problema.** Un módulo de 40 minutos con 30 alumnos a 360p son 3,9 GB.
Un mes escolar completo (15 clases × 7 módulos × 20 días) da **~8,2 TB** contra las 32 TB del
plan (~3 TB si se transmite a 180p). Verificado además contra el tráfico real del VPS: 1,06 GB de
salida en dos días y medio. **El cuello es el puerto (Mbit/s), no el cupo (TB).**

### D2 — SFU propio con mediasoup, en un proceso APARTE. El cluster de PM2 es el motivo

Tres arquitecturas posibles, y gana la del medio:

- **Malla P2P (sin servidor).** El docente sube 30 copias de su video: 30 × 2,9 Mbit/s =
  87 Mbit/s **de subida desde su casa o desde la escuela**. En Argentina la subida es el recurso
  escaso. Descartada: no es que ande mal, es que no arranca.
- **SFU (Selective Forwarding Unit).** El docente sube **una vez** y el servidor reparte. No
  transcodifica: reenvía paquetes. Es la arquitectura de Meet, Zoom y Jitsi. **Elegida.**
- **HLS / transcodificación.** Escala a miles y se cachea, pero mete 3–10 s de retraso (nadie
  puede preguntar nada) y transcodificar sí quema CPU. Queda anotada para el día del acto escolar
  (fuera de alcance).

**Por qué mediasoup y no LiveKit ni Jitsi.** LiveKit es un servidor en Go con un clúster
coordinado por Redis: excelente, y de más para una máquina sola — suma dos servicios nuevos que
hoy no existen. Jitsi Videobridge arrastra la JVM y Prosody. **mediasoup es una librería npm**:
`require('mediasoup')` dentro de un proceso Node, con los workers C++ como subprocesos. Encaja en
el stack que ya hay (Node 22 + PM2, sin Docker, sin Redis) y no agrega ni un servicio de terceros.

**La trampa que hay que ver ANTES de escribir una línea: los dos workers de PM2.**
`ecosystem.config.js` corre `classroom` en modo **cluster con 2 instancias**. Un router de
mediasoup vive **en la memoria de un proceso**. Si la señalización cae en el worker A y el router
está en el B, no hay clase — y como PM2 reparte por conexión, **fallaría la mitad de las veces,
al azar**. Es el mismo tipo de problema que el proyecto ya documentó para los timers
(`sesionAbierta()` evalúa el autocierre de forma perezosa justamente porque un `setInterval`
correría dos veces).

Solución: **un tercer proceso**, `media/servidor.js`, en PM2 **modo fork, instancia única**,
escuchando en `127.0.0.1:4100`. Los dos workers de Express le hablan por HTTP local; los
navegadores, por WebSocket a través de Caddy.

Beneficio secundario que también es una trampa evitada: `max_memory_restart: 400M` reinicia hoy a
los workers de Express **sin avisar**. Con la transmisión adentro, eso cortaría la clase en el
medio. Separado, cada proceso tiene su propio límite y su propia vida.

### D3 — La señalización va por WebSocket propio. El chat NO se muda

El poll de 4 s es perfecto para el chat e **inservible para WebRTC**: negociar ICE tarda cientos
de milisegundos y hay que hacerlo en los dos sentidos.

La tentación es "ya que ponemos WebSocket, mudamos el chat". **No.** El chat de la sala tiene
cursor por `seq`, moderación, adjuntos, citas, reacciones, presencia y una suite de tests. Mudarlo
pondría en riesgo lo que ya funciona todos los días, para ganar 4 segundos que nadie pidió.

El WebSocket lleva **solo lo que no puede esperar 4 segundos**: SDP, candidatos ICE, "empecé a
transmitir", "se cayó tu conexión". Todo lo demás —quién levantó la mano, quién tiene la palabra,
si la transmisión está prendida— **viaja por el poll que ya existe**, como un campo más del
estado. Cuesta cero y ya está probado.

### D4 — El proceso de medios NO decide permisos. Ticket JWT de 60 segundos

`routes/rooms.js` ya sabe quién puede estar en una sala: `cargarSala` resuelve `esAlumno`,
`esGestor` y `Course.canWatchLive()`. Y hay un antecedente caro de lo que pasa cuando un endpoint
no revalida: la fuga de datos por la API del curso, donde la pantalla decía 403 y la API decía
200. Reimplementar esas reglas en el proceso de medios sería **fabricar la segunda copia que se
queda vieja**.

En cambio: `POST /courses/:id/sala/transmision/ticket` corre **dentro de Express**, detrás de
`cargarSala`, y firma con el `JWT_SECRET` que ya existe un ticket de **60 segundos**:

```json
{ "sid": "<RoomSession._id>", "cid": "<Course._id>", "uid": "<User._id>",
  "nom": "PEREZ, Ana", "rol": "student", "emitir": false, "exp": 1234567890 }
```

El proceso de medios **solo verifica la firma**. No abre Mongo, no conoce roles, no puede
equivocarse en una regla que no tiene. Si la regla cambia en Express, cambia en un solo lugar.

`emitir: true` lo lleva únicamente el gestor de la materia, o el alumno a quien se le dio la
palabra en ese momento (D7). El ticket se pide de nuevo en cada reconexión.

### D5 — El gobernador de aforo: el techo se decide en el servidor y se dice en voz alta

Sin techo, la clase 13 no "anda un poco peor": **el puerto se satura y se cae la plataforma
entera**, incluso para quien está entregando una tarea desde otra aula. El modo de falla es global
y no tiene nada que ver con el video.

Un presupuesto explícito, en `config/transmision.js`:

```js
TX_PRESUPUESTO_MBPS = 160      // subida reservada a la transmisión (el 80 % de 200)
TX_UMBRAL_360   = 0.60         // hasta el 60 % del presupuesto se permite 360p
TX_UMBRAL_180   = 0.80         //   "    "  80 %                          180p
TX_UMBRAL_AUDIO = 0.95         //   "    "  95 %                     solo audio
TX_MAX_CLASES   = 20           // red de seguridad, NO el gobernador (ver abajo)
```

**El gobernador elige la capa más alta cuyo consumo total quede por debajo de su umbral.** Se
evalúa en cada alta y baja de espectador, sobre el consumo **real medido** y no sobre el estimado:

| Capa | Techo de consumo | Espectadores simultáneos que entran |
|---|---|---|
| **360p** (432 kbps c/u) | 96 Mbit/s | hasta **222** |
| **180p** (157 kbps c/u) | 128 Mbit/s | hasta **815** |
| **Solo audio** (32 kbps c/u) | 152 Mbit/s | hasta **4.750** |
| Rechazo | — | *"La escuela llegó al tope de clases transmitiendo. Podés seguir con el chat."* |

⭐ **La conclusión que cambia la conversación: la escuela entera entra, en 180p.** Los ~450
alumnos mirando al mismo tiempo consumen **71 Mbit/s, el 44 % del presupuesto**. El único techo
real es el de la calidad: pasados ~222 espectadores simultáneos en toda la escuela, el gobernador
baja a 180p, y desde ahí ya no hay pared. El rechazo del último renglón es una red de seguridad
que en esta escuela **no se debería tocar nunca** — y si se toca, es la señal de que algo se
desbocó, no de que la escuela creció.

Por eso `TX_MAX_CLASES` es una red y no el gobernador: un tope de clases contadas a mano habría
rechazado la clase 13 mientras sobraba el 65 % del puerto. **Lo que se raciona es el ancho de
banda, no la cantidad de aulas.**

Las dos mitades del criterio de la casa:

- **Degradar antes que caerse.** Una clase en 180p es una clase; la plataforma caída no es nada.
- **Y decirlo.** El docente ve un cartel —"estás transmitiendo en calidad baja porque hay 9 clases
  al aire"— y el superadmin lo ve en `/superadmin/monitor`. Un sistema que se degrada en silencio
  se lee como "esto anda mal", y ese reclamo llega igual, pero sin el dato.

El techo también **protege la subida del docente**, que en Argentina es lo escaso: con el tope en
180p, el docente sube ~0,65 Mbit/s en vez de ~2,9.

### D6 — Arranca sin cámara: el modo por defecto es **audio + pantalla**

El modo por defecto de una clase no es la cara del docente: es **lo que está mostrando**. Una
pantalla compartida con un texto quieto se codifica en 200–400 kbps a 5 fps (contenido estático,
casi sin movimiento) contra los 400 kbps *sostenidos* de una cámara a 360p.

Entonces el diálogo de inicio ofrece tres interruptores —🎤 micrófono (prendido), 🖥️ pantalla
(prendido), 📹 cámara (**apagada**)— y la cámara se prende cuando hace falta.

Con la cámara apagada, el alumno ve el avatar del docente y la barra de nivel de voz. Es lo mismo
que ve en Meet cuando alguien apaga la cámara, y cuesta 0 kbps.

### D7 — El alumno nunca publica solo. La mano se levanta y la palabra se da, de a una

Dos motivos, y el segundo es el que manda:

- **Ancho de banda**: cada alumno que publica es un flujo más de subida y N flujos de bajada.
- **Son menores.** El proyecto ya tomó esta decisión tres veces (el chat se cierra con la sesión,
  las fotos del alumno tienen interruptor propio, los adjuntos viven fuera de `/public`). Un
  micrófono o una cámara que se abre solo en la casa de un chico de 13 años **no se diseña así**.

El flujo:

1. El alumno toca ✋ **Levantar la mano** → un campo en la sala, que va por el poll de 4 s.
2. El docente ve la cola **en orden de llegada** y toca "Darle la palabra".
3. El servidor emite un ticket con `emitir: true` **solo para audio**. El navegador del alumno
   pide permiso del micrófono (el navegador siempre pregunta; nunca se abre sin que él acepte).
4. La cámara del alumno es un **segundo permiso**, explícito, que el docente concede aparte.
5. **Un alumno con la palabra a la vez.** Dársela a otro se la quita al anterior.
6. Se corta sola: al bajar la mano, al cerrar la transmisión, o a los **5 minutos** sin hablar.

**Quién tiene la palabra vive en `RoomSession`, no en la memoria del proceso de medios**: si el
proceso se reinicia en mitad de la clase, el estado vuelve tal cual estaba.

### D8 — La transmisión NO es una segunda fuente de asistencia

`RoomPresence` **es** el registro de asistencia (así está escrito en el modelo). Si "mirar la
transmisión" creara su propio registro, la escuela tendría dos números distintos de presentes en
la misma clase, y el día que difieran nadie va a saber cuál mirar.

Entonces: recibir la transmisión **toca la misma `RoomPresence`**, por el poll, que sigue
corriendo. Lo que la transmisión agrega son **campos**, no una colección: `txSegundos`,
`txCapaMax`, `txCortes`. "Estuvo en la clase" lo sigue contestando el mismo documento de siempre;
"y además la vio" es un dato más adentro de él.

### D9 — Sin grabación en la Fase 1, y el motivo no es técnico

Técnicamente se puede (guardar el RTP y componer con ffmpeg, ~1 núcleo por clase). No se hace
todavía porque:

- **Es grabar a menores.** Eso no es una decisión de arquitectura: necesita consentimiento de las
  familias, una política de retención escrita y alguien que responda por ella. No lo decide una
  spec.
- **El disco.** Una clase de 40 minutos en 360p son ~120 MB. Quince clases por día, veinte días:
  **36 GB al mes**, contra 290 GB de disco que ya tienen 16 GB de archivos y los backups.
- **Y el backup.** Si se graba, esos archivos **tienen que entrar a `CARPETAS`** de
  `routes/backup.js` y al test que obliga la lista. Es exactamente la deuda que ya quedó abierta
  con `SALAS_BASE`. Sumar grabaciones sin resolver eso sería repetir el mismo agujero, más grande.

Queda diseñada en la Fase 3, y con una versión barata: **grabar solo audio + pantalla** (sin
cámaras, ~15 MB por clase), que es el 90 % del valor pedagógico al 12 % del costo.

### D10 — Módulo de DOS ejes: la escuela lo prende, y adentro se elige a quién

*(Decisión del usuario, 2026-08-31, al aprobar la spec: "dejarla desactivada desde el panel de
superadmin, y permitirme habilitarla por escuela o por docente".)*

Va a `config/modulos.js` junto a `recursos`, pero **estrena un eje que hoy no existe**. Hasta
ahora un módulo era todo o nada por escuela; éste necesita además elegir personas, porque la
transmisión no es como reservar la sala de computación: **consume el puerto de todos**, y lo
sensato es arrancar con dos o tres docentes y mirar qué pasa antes de dárselo a sesenta.

El catálogo gana un campo `alcance`:

| `alcance` | Qué significa | Quién lo usa |
|---|---|---|
| `'escuela'` | La escuela lo prende y vale para todos. | `recursos` (sin cambios) |
| `'escuela+persona'` | La escuela lo prende **y además** elige a quiénes. | `transmision` |

Y `School.modules.transmision` guarda los dos ejes:

```js
transmision: {
  enabled:  { type: Boolean, default: false },              // eje 1: la escuela
  alcance:  { type: String, enum: ['todos','lista'], default: 'lista' },
  personas: [{ type: ObjectId, ref: 'User' }],              // eje 2: los docentes
}
```

**Los tres estados, y por qué los defaults son los que son:**

- `enabled: false` → **nadie**. Es el default de todas las escuelas, incluida la 4-118: el
  código se despliega **apagado**, que es exactamente lo pedido.
- `enabled: true, alcance: 'lista', personas: []` → la escuela lo tiene, todavía no hay ningún
  docente habilitado. **Es el default al prender el interruptor de la escuela**, y es
  deliberado: prender la escuela no puede repartirle la transmisión a sesenta docentes de golpe.
- `enabled: true, alcance: 'todos'` → toda la escuela, cuando ya se probó.

⭐ **La sutileza que hay que entender o la feature queda al revés: el eje de persona se mide
sobre QUIEN EMITE, nunca sobre quien mira.** Si se midiera sobre el que mira, cada alumno
tendría que estar en la lista para poder ver a su profesora — absurdo. La pregunta que contesta
`moduloActivoPara(school, user, 'transmision')` es **"¿esta persona puede transmitir?"**. El
alumno nunca la hace: para él la transmisión está o no está prendida, y punto.

**Quién lo edita: el superadmin, los dos ejes.** No el admin de la escuela, por lo mismo de
siempre (quien habilita no puede ser quien usa) y porque acá se reparte un recurso escaso que es
de todas las escuelas del servidor, no de una.

**Compatibilidad:** `moduloActivo(school, id)` —la función que ya usan `server.js` y
`middleware/modulos.js`— **no cambia de firma ni de significado**: sigue contestando por la
escuela. El eje de persona es una función nueva al lado. Los 4 usos existentes no se tocan.

Y por la regla escrita en ese mismo archivo: **el módulo se agrega recién cuando su código
existe**. Entra en el commit de la Fase 1, no antes.

### D11 — UDP directo al SFU. ICE-TCP como red. Sin coturn

Un SFU con **IP pública propia** no necesita TURN: el navegador le habla directo. Verificado en la
máquina: `169.58.248.255/17` está **directamente sobre eth0**, sin NAT, así que `listenIp` es la
IP real y no hay que andar anunciando otra.

Fallback en dos escalones:

1. **UDP 40000–40199** hacia el SFU. Es el camino de casi todas las conexiones domésticas.
2. **ICE-TCP en el 3478**, que mediasoup ofrece con `enableTcp: true` sobre el mismo transporte.
   Cubre las redes que bloquean UDP saliente. Es el puerto estándar de STUN/TURN y suele estar
   permitido.

Si una red bloquea las dos cosas, el alumno **no ve el video y la sala sigue funcionando entera**:
chat, adjuntos, presencia, mano levantada. La degradación es a "la sala de siempre", no a un
error. Se le dice con todas las letras: *"Tu conexión no permite recibir video. Seguís en la clase
por el chat."*

**`ufw` hoy permite 22, 80 y 443 y nada más.** Los puertos nuevos son un paso de despliegue, no un
detalle: sin ellos la señalización va a andar perfecto y **no va a haber audio ni video**, que es
el síntoma más difícil de diagnosticar de todos.

### D13 — El túnel del WebSocket lo hace Express, no Caddy

*(Cambio del 2026-08-31, durante la implementación.)*

El plan decía "un bloque en el Caddyfile". Funciona, pero deja dos problemas: **en desarrollo no
hay Caddy**, así que la transmisión no se podía probar sin desplegarla —probar una feature de
video por primera vez en producción es exactamente lo que no hay que hacer— y era un paso manual
más de despliegue, en un proyecto cuyos pasos manuales ya tienen su historial de olvidos.

Ahora Express reenvía el `upgrade` de `/rtc` a `127.0.0.1:4100`. El mismo código anda en las dos
partes y no hay nada que configurar.

**No reintroduce el problema del cluster (D2)**: los dos workers hacen proxy al MISMO proceso
único, así que el router sigue viviendo en un solo lugar. Y por ahí pasa **solo señalización**
—unos pocos KB por persona al entrar—; el audio y el video van por UDP directo del navegador al
SFU y **nunca tocan Node**.

### D14 — La IP anunciada: el error que no da ningún síntoma útil

*(Encontrado el 2026-08-31 probando en el navegador, después de que los 11 tests de señalización
pasaran con el bug puesto.)*

Escuchando en `0.0.0.0` sin `announcedIp`, mediasoup **anuncia `0.0.0.0`** como dirección del
candidato ICE — y nadie puede conectarse a esa dirección.

Lo grave es cómo se ve: la señalización anda perfecto, el transporte se crea, el productor se
crea, el simulcast reporta sus dos capas, la aplicación dice "transmitiendo"… y `packetsSent`
se queda en **0 para siempre, sin un error en ningún log**.

Tres defensas, porque una sola no alcanza para algo que no avisa:

1. **Se detecta sola**, con orden de preferencia: pública (el VPS) → LAN privada (la PC de
   desarrollo) → CGNAT/Tailscale. Sin esto, en la máquina de desarrollo elegía la de Tailscale.
2. **El proceso se niega a arrancar** si no puede determinar ninguna, con tres líneas que dicen
   qué pasa y cómo arreglarlo. Arrancar igual sería peor que no arrancar.
3. **Un test** que falla si algún candidato vuelve a anunciar `0.0.0.0`.

### D12 — La transmisión no arranca sola en el navegador del alumno

El alumno entra a la sala y ve **"▶ Ver la clase en vivo"**. Tiene que tocarlo.

No es cosmético, son tres cosas a la vez:

- **Es la mitad del ahorro.** En una clase presencial los 30 alumnos están **en la misma aula que
  el docente**: transmitir ahí sería sacar el video de la escuela, mandarlo a Contabo y traerlo de
  vuelta 30 veces por el mismo caño — 13 Mbit/s de bajada al aula para ver lo que está proyectado
  en la pared. Con el botón, en una clase presencial nadie lo toca y el costo es cero.
- **Los navegadores no dejan** reproducir audio sin un gesto del usuario. Sin botón, media clase
  vería el video mudo sin entender por qué.
- **Es honesto con el dato móvil.** Un chico con datos del celular decide si gasta 100 MB.

Su contracara: la **primera vez** que el alumno lo toca ve cuánto va a consumir
(*"Calidad baja · ~70 MB por hora"*).

---

## Paridad con Google Meet, función por función

El pedido fue "todas las funcionalidades que tiene Meet". La tabla es la respuesta completa, y la
primera columna sorprende: **la sala en vivo ya cubre buena parte**, porque el chat, la moderación
y la asistencia ya están construidos.

| Función de Meet | Estado | Cómo queda acá |
|---|---|---|
| Audio del que expone | 🆕 Fase 1 | Opus mono con DTX. El corazón de la feature. |
| Compartir pantalla | 🆕 Fase 1 | `getDisplayMedia`. Pestaña, ventana o pantalla. Modo por defecto (D6). |
| Cámara del que expone | 🆕 Fase 1 | Apagada por defecto, con simulcast de 2–3 capas. |
| Compartir el audio de la pestaña | 🆕 Fase 1 | Casilla al compartir, para mostrar un video. Solo Chrome/Edge. |
| Ver la transmisión | 🆕 Fase 1 | Con botón explícito (D12) y calidad adaptativa. |
| Levantar la mano ✋ | 🆕 Fase 1 | Con **cola ordenada**, que Meet no tiene. Va por el poll. |
| Dar la palabra al alumno | 🆕 Fase 2 | De a uno, audio primero, cámara con permiso aparte (D7). |
| Silenciar a un participante | ✅ + 🆕 | El chat ya tiene `mutedStudents`; se le suma cortar el micrófono. |
| Silenciar a todos | 🆕 Fase 1 | "Cortar la palabra" es un solo botón: no quedan micrófonos abiertos. |
| Expulsar de la reunión | ✅ + 🆕 | Ya existe el silenciado por sesión; se suma "sacar de la transmisión". |
| Sala de espera / admitir | ✅ ya está | **Mejor que Meet**: no entra un desconocido con un link. Entra quien está en la materia (`cargarSala`). No hay link que filtrar. |
| Controles del anfitrión | ✅ + 🆕 | `settings` de la sesión ya lo es. Se suman los de transmisión. |
| Chat de la reunión | ✅ ya está | Con citas, adjuntos, moderación y transcripción. |
| Reacciones con emoji | ✅ ya está | 12 emojis, por mensaje. |
| Lista de asistentes | ✅ ya está | Y **queda registrada**: `RoomPresence` es la asistencia (D8). |
| Informe de asistencia | ✅ ya está | Mejor que Meet: por materia, por división y exportable. |
| Indicador de calidad de red | 🆕 Fase 1 | De `getStats()`: verde / amarillo / rojo, con el motivo. |
| Fijar / destacar a alguien | 🆕 Fase 1 | Trivial acá: hay un solo emisor. Pantalla grande, cámara chica. |
| Picture-in-picture | 🆕 Fase 1 | API del navegador, tres líneas. |
| Atajos de teclado | 🆕 Fase 1 | `M` micrófono, `E` pantalla, `H` mano. |
| Cancelación de ruido | 🆕 Fase 1 | Gratis: `echoCancellation` + `noiseSuppression` del navegador. |
| Encuestas | 🔜 Fase 3 | Se apoya en el chat que ya existe. |
| Preguntas y respuestas | 🔜 Fase 3 | Con votos, como Meet. El chat ya tiene el modelo de citas. |
| Grabación | 🔜 Fase 3 | Rechazada por ahora, y no por lo técnico (D9). |
| Subtítulos en vivo | 🔜 Fase 3 | Necesita motor de voz a texto. Decisión aparte: son voces de menores. |
| Traducción en vivo | ❌ | Servicio pago, con audio de menores saliendo de la escuela. |
| Resumen con IA | ❌ | Ídem. Ya hay un backlog de IA aparte para esto. |
| Salas de grupos | ❌ | Rompen el techo de ancho de banda y no tienen curso al que pertenecer. |
| Fondos virtuales / desenfoque | ❌ | El costo lo paga la CPU de la netbook del aula. |
| Llamar por teléfono | ❌ | Troncal SIP pago. |
| Modo compañero | ❌ | Resuelve un problema de oficina: varios en la misma sala de reuniones. |
| Pizarra | ❌ | Feature propia, no parte de la transmisión. |

**Lo que esta implementación tiene y Meet no:** la cola ordenada de manos levantadas; la asistencia
que queda en el legajo de la materia; que no exista un link que se pueda reenviar; el gobernador de
ancho de banda visible; y que la transmisión caída degrade a una sala que sigue funcionando entera
en vez de a una pantalla de error.

---

## Entidades / Schemas

### `models/RoomSession.js` — se le agrega un subdocumento, no se toca nada existente

```js
transmision: {
  activa:      { type: Boolean, default: false },
  iniciadaAt:  { type: Date,    default: null },
  // Qué está publicando el docente. Los tres son independientes: se puede tener
  // micrófono sin cámara y pantalla sin micrófono.
  micro:       { type: Boolean, default: false },
  pantalla:    { type: Boolean, default: false },
  camara:      { type: Boolean, default: false },
  // Techo de calidad VIGENTE, que puede haberlo bajado el gobernador (D5) y no el
  // docente. Se guarda para que el cartel del docente pueda explicar por qué.
  capaMax:     { type: String, enum: ['audio', '180p', '360p'], default: '360p' },
  degradadaPor:{ type: String, default: '' },   // '' | 'aforo' | 'red' | 'docente'

  // Quién tiene la palabra AHORA. Vive acá y no en la memoria del proceso de medios
  // para que un reinicio de ese proceso no le regale el micrófono a nadie ni se lo
  // saque a quien lo tenía. Ver D7.
  palabra:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  palabraDesde:{ type: Date, default: null },
  palabraCamara:{ type: Boolean, default: false },

  // Cola de manos levantadas, EN ORDEN DE LLEGADA. Es un array y no un Set ni un
  // campo en RoomPresence justamente porque el orden es el dato: "quién levantó la
  // mano primero" es la pregunta que el docente hace.
  manos: [{
    user:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    nombre:{ type: String, default: '' },       // snapshot, igual que authorName
    desde: { type: Date, default: Date.now },
    _id:   false,
  }],
}
```

**Por qué adentro de `RoomSession` y no en una colección propia:** la transmisión no sobrevive a
la sesión. Empieza y termina adentro de una clase, igual que `settings` y `mutedStudents`, que ya
están ahí por el mismo motivo. Una colección aparte obligaría a una query más en el camino más
caliente de la app (el poll cada 4 s por persona).

### `models/RoomPresence.js` — tres campos, ningún índice nuevo

```js
txSegundos: { type: Number, default: 0 },   // cuánto tiempo recibió la transmisión
txCapaMax:  { type: String, default: '' },  // la mejor calidad que llegó a recibir
txCortes:   { type: Number, default: 0 },   // cuántas veces se le cortó
```

Se acumulan desde el poll, igual que `pings`. Son **para el diagnóstico**, no para la asistencia
(D8): contestan "a este chico se le cortó nueve veces" cuando la familia reclama.

### `models/Transmision.js` (nuevo) — el registro histórico, uno por emisión

Una fila por vez que el docente prende y apaga. **No es lo mismo que la sesión**: en una clase el
docente puede transmitir, cortar para hacer un ejercicio y volver a transmitir.

```js
{ session, course, school, division, docente, docenteNombre,
  iniciadaAt, terminadaAt, cerradaPor,        // 'docente' | 'cierre-sala' | 'caida'
  picoEspectadores, espectadoresUnicos,
  bytesSalida, capaMaxAlcanzada, degradaciones,
  cortesTotales, ticketsRechazados }
```

Alimenta el panel del superadmin y, sobre todo, la conversación del año que viene: *"¿cuánto nos
costó realmente esto?"*. Sin este registro esa pregunta no tiene respuesta.

Índices: `{ school: 1, iniciadaAt: -1 }` (el panel) y `{ course: 1, iniciadaAt: -1 }` (historial
de la materia).

### `config/transmision.js` (nuevo) — todas las constantes, con su fundamento al lado

Sigue el patrón de `services/liveRoom.js`: **las constantes de la feature viven en un solo
archivo**. Presupuesto, escalera de degradación, capas de simulcast, rango de puertos UDP, TTL del
ticket, tiempo de palabra sin hablar.

### `config/modulos.js` — la entrada nueva (D10)

```js
{ id: 'transmision', label: 'Transmisión en vivo', icon: 'cast',
  localsKey: 'transmisionEnabled',
  descripcion: 'La o el docente transmite voz, pantalla y cámara dentro de la sala en vivo.',
  secciones: [] }
```

`secciones: []` a propósito: **no agrega ninguna solapa**. Vive adentro de la solapa "En vivo",
que ya existe y ya tiene sus permisos por rol resueltos en `config/sections.js`.

### `config/audit-actions.js` — acciones nuevas

`tx.start`, `tx.stop`, `tx.grant_mic`, `tx.revoke_mic`, `tx.kick`, `tx.degraded`, `tx.rejected`.

`tx.degraded` y `tx.rejected` son las importantes: son la prueba de que el techo actuó, y lo que
convierte un "el video andaba mal el martes" en una línea con hora y número.

---

## Entradas y salidas

### Rutas nuevas en `routes/rooms.js` (todas detrás de `cargarSala`)

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /courses/:id/sala/transmision/abrir` | gestor | Prende la transmisión. **Acá corre el gobernador** (D5): puede contestar 503 con motivo. |
| `POST /courses/:id/sala/transmision/cerrar` | gestor | La apaga. Cierra el `Transmision` con `cerradaPor: 'docente'`. |
| `POST /courses/:id/sala/transmision/modo` | gestor | Prende/apaga micrófono, pantalla, cámara. |
| `POST /courses/:id/sala/transmision/ticket` | cualquiera de la sala | El JWT de 60 s (D4). Es la única puerta al proceso de medios. |
| `POST /courses/:id/sala/transmision/mano` | alumno | Levanta o baja la mano. |
| `POST /courses/:id/sala/transmision/palabra/:uid` | gestor | Da o quita la palabra. `?camara=1` suma el video. |
| `POST /courses/:id/sala/transmision/echar/:uid` | gestor | Saca a alguien de la transmisión (sigue en el chat). |
| `GET /superadmin/monitor/transmision` | superadmin | Estado del SFU: clases, espectadores, Mbit/s, ocupación. |

### `GET /courses/:id/sala/poll` — el estado crece, no cambia de forma

Se le agrega **una clave** al JSON que ya devuelve `estadoDeSala()`, para no partir en dos la
única forma de la sala:

```json
"transmision": {
  "activa": true, "micro": true, "pantalla": true, "camara": false,
  "docente": "GOMEZ, Laura", "desde": "14:05",
  "capaMax": "180p", "degradadaPor": "aforo",
  "puedoVer": true, "puedoEmitir": false,
  "miMano": false, "manos": [{ "uid": "...", "nombre": "PEREZ, Ana", "desde": "14:12" }],
  "palabra": { "uid": "...", "nombre": "PEREZ, Ana", "camara": false },
  "espectadores": 18
}
```

Cuando no hay transmisión: `{"activa": false, ...}` con el resto en su default. Mismo criterio que
la sala cerrada — una forma sola, siempre.

### Protocolo del WebSocket (`wss://sanjose.escuela.site/rtc`)

Mensajes JSON, `{ t: '<tipo>', ... }`. Lo mínimo, y nada más:

**Del navegador**: `hola` (con el ticket) · `crearTransporte` · `conectarTransporte` ·
`producir` · `consumir` · `reanudar` · `capa` (pedir otra calidad) · `stats` · `chau`.

**Del servidor**: `bienvenido` (capacidades RTP del router) · `transporte` · `productorNuevo` ·
`productorSeFue` · `capaCambiada` (el gobernador te bajó) · `expulsado` · `error`.

Todo lo que **no** está en esa lista —manos, palabra, presencia, chat— va por el poll (D3).

---

## Reglas de negocio

- **RN-1** La transmisión existe solo dentro de una sesión abierta. Cerrar la sala la corta y
  cierra el `Transmision` con `cerradaPor: 'cierre-sala'`.
- **RN-2** Un solo emisor principal por sesión: el gestor de la materia. Los co-docentes pueden
  tomarla, pero **de a uno**; tomarla se la quita al anterior y queda en auditoría.
- **RN-3** El módulo apagado hace que las rutas contesten **403 "Acceso denegado"**, igual que
  `requireModulo` en `middleware/modulos.js`. La spec decía 404 en su primera versión; se cambió
  para no inventar un código propio: la casa ya tiene una pantalla de rechazo y todos los módulos
  usan la misma.
- **RN-3b** Un docente **no habilitado en la lista** de una escuela que sí tiene el módulo recibe
  el mismo 403 al intentar abrir la transmisión, y **no ve el botón**. Los alumnos de su curso no
  ven nada distinto de hoy: para ellos la sala es la de siempre (D10).
- **RN-4** El autocierre de la sala (30 min de inactividad) **no cuenta la transmisión como
  inactividad**: `lastActivityAt` se toca con cada latido del emisor. Sin esto, una clase
  expositiva de 35 minutos sin un solo mensaje de chat **se cerraría sola en el medio**.
- **RN-5** Con la palabra dada, el alumno sigue sujeto a `mutedStudents`: si está silenciado en el
  chat, no se le puede dar la palabra. Silenciar a alguien lo silencia entero — es la misma regla
  ya escrita para las imágenes en `puedeCompartirImagen`.
- **RN-6** El modo observación de dirección **también aplica acá**: quien mira en silencio no
  aparece en la lista de espectadores ni deja presencia. Si se presenta, aparece.
- **RN-7** Un ticket vencido no se renueva solo desde el proceso de medios: el navegador vuelve a
  Express a pedir uno. Es lo que hace que revocar el acceso surta efecto en 60 segundos.
- **RN-8** El preceptor y dirección pueden **ver** la transmisión (ya pueden entrar a la sala),
  nunca emitir ni dar la palabra. La transmisión no cambia quién manda en la sala.
- **RN-9** Cerrar la pestaña corta el consumo en el acto (el WebSocket se cae). Un alumno que
  cierra no sigue consumiendo puerto.
- **RN-10** Si el proceso de medios se cae, la sala **no se cae**: el poll sigue, el chat sigue, y
  el estado de transmisión pasa a `activa: false` con el aviso *"Se cortó la transmisión, se puede
  volver a empezar"*. Nunca una pantalla de error.

---

## Criterios de aceptación

### Lógica pura (`services/transmision.js`, se testea sin base ni navegador)

1. `consumoMbps(espectadores, capa)` devuelve el consumo total a partir de la cantidad de
   espectadores y la capa vigente.
2. `capaPermitida(espectadores)` devuelve `'360p'` hasta 222, `'180p'` hasta 815, `'audio'` hasta
   4.750 y `null` (rechazar) por encima. Los cuatro bordes se testean con su valor exacto y con
   ±1.
3. `capaPermitida` es **monótona**: más espectadores nunca devuelve mejor calidad. Test con 5.000
   valores consecutivos.
3b. Con los ~450 alumnos de la escuela mirando a la vez, `capaPermitida` devuelve `'180p'` y
   `consumoMbps` da 71 Mbit/s — el 44 % del presupuesto. **La escuela entera entra.** Es el test
   que documenta que el rechazo es una red de seguridad y no un límite operativo.
4. `puedeEmitir(session, ctx)` es true para el gestor, para el alumno con la palabra, y falso para
   todos los demás — incluido el preceptor y el directivo (RN-8).
5. `puedeVer(session, ctx)` respeta el modo observación (RN-6).
6. `siguienteEnLaCola(manos)` devuelve la mano más vieja; con la cola vacía devuelve null.
7. `darLaPalabra` a alguien que ya la tiene es idempotente; a otro, se la quita al anterior (D7).
8. `darLaPalabra` a un alumno silenciado devuelve error (RN-5).
9. Un alumno que baja la mano sale de la cola sin alterar el orden de los demás.
10. `estimarMB(capa, minutos)` da el número que ve el alumno antes de tocar "Ver" (D12).

### Transmisión — apertura y cierre

11. El gestor abre la transmisión: `transmision.activa` queda en true y el poll de todos lo
    refleja **en el ciclo siguiente**, sin recargar.
12. Un alumno que hace el POST de abrir recibe 403.
13. Con el módulo apagado, el POST devuelve 404 (RN-3).
14. Cerrar la sala con la transmisión prendida la cierra y deja `cerradaPor: 'cierre-sala'`.
15. Abrir dos veces seguidas no crea dos `Transmision`.
16. Con la transmisión prendida y sin un solo mensaje de chat durante 35 minutos, **la sala NO se
    autocierra** (RN-4). Este test tiene que **fallar** antes del arreglo.

### El gobernador (D5)

17. Con 230 espectadores en la escuela, una clase nueva arranca con `capaMax: '180p'` y
    `degradadaPor: 'aforo'`.
18. Con 900 espectadores, arranca en `'audio'`.
19. Por encima de 4.750, el POST devuelve **503** con el mensaje en castellano, se registra
    `tx.rejected`, y **la sala sigue funcionando entera**.
20. Al cruzar de 220 a 230 espectadores, las clases **ya abiertas** bajan a 180p y sus docentes
    ven el cartel con el motivo, en el poll siguiente.
21. Cuando el aforo baja, las clases **no vuelven a subir solas** de calidad: devolverle 360p a
    doce aulas en el mismo segundo es un pico coordinado, justo lo que el techo existe para
    evitar. Vuelve a subir la que se reabra.
21b. Cruzar `TX_MAX_CLASES` (la red de seguridad) rechaza aunque sobre presupuesto, y deja
    `tx.rejected` con motivo `'red-de-seguridad'` — distinto del rechazo por ancho de banda, para
    que en el registro se distinga "se desbocó algo" de "la escuela creció".

### Mano y palabra (Fase 2)

22. El alumno levanta la mano y aparece en `manos` con su nombre en snapshot.
23. Dos alumnos que levantan la mano quedan en orden de llegada, no por nombre ni por id.
24. Dada la palabra, el ticket del alumno sale con `emitir: true` y **sin video**.
25. Con `?camara=1`, sale con video.
26. A los 5 minutos sin audio, la palabra se corta sola y queda `tx.revoke_mic` en auditoría.
27. Cerrar la transmisión limpia `palabra` y `manos`.

### Acceso y seguridad

28. Un ticket firmado con otro secreto es rechazado por el proceso de medios.
29. Un ticket vencido (más de 60 s) es rechazado (RN-7).
30. Un ticket válido para el curso A **no sirve** para la sala del curso B.
31. Un alumno que no está en el curso no consigue ticket (403 en Express, antes del WebSocket).
32. El proceso de medios **no tiene credenciales de Mongo** en su entorno. Se verifica leyendo su
    configuración: si algún día las necesita, es que la regla se filtró donde no va (D4).

### Degradación honesta

33. Con UDP y TCP bloqueados, el alumno ve el cartel *"Tu conexión no permite recibir video"* y la
    sala sigue entera (D11).
34. Con el proceso de medios caído, el poll sigue contestando 200 y el chat funciona (RN-10).
35. El alumno que nunca toca "Ver la clase" **no genera ni un byte** de media (D12).

### Regresión (lo que no se puede romper)

36. Las tres suites (`test:unit`, `test:smoke`, `test:roles`) pasan sin tocar sus casos previos.
37. El poll sin transmisión devuelve exactamente la misma forma que antes más la clave nueva.
38. La asistencia de una clase con transmisión da **el mismo número** que sin ella (D8).
39. `npm run test:roles` sigue verde: la matriz de roles × solapas no cambia (D10, `secciones: []`).

---

## Archivos

**Nuevos**

| Archivo | Qué es |
|---|---|
| `media/servidor.js` | El proceso SFU: WebSocket, routers de mediasoup, gobernador. |
| `media/sfu.js` | Envoltorio de mediasoup: workers, routers, transportes, productores. |
| `media/aforo.js` | El gobernador. Lógica pura, sin mediasoup adentro, para testearla. |
| `config/transmision.js` | Todas las constantes con su fundamento. |
| `services/transmision.js` | Reglas de negocio puras + acceso a Mongo, hermano de `liveRoom.js`. |
| `models/Transmision.js` | El registro histórico. |
| `public/js/transmision.js` | El cliente: `mediasoup-client`, capas, `getStats`, reconexión. |
| `views/partials/transmision.ejs` | La UI, embebida en `live-room.ejs`. |
| `specs/transmision-en-vivo.spec.md` | Este archivo. |
| `tests/unit/transmision.test.js` | Lógica pura. |
| `tests/unit/aforo.test.js` | El gobernador, que es donde está el riesgo. |
| `tools/tx-carga.js` | Simulador de N espectadores, para medir de verdad antes de abrirlo. |

**Modificados**

| Archivo | Cambio |
|---|---|
| `models/RoomSession.js` | El subdocumento `transmision`. |
| `models/RoomPresence.js` | Tres campos de diagnóstico. |
| `routes/rooms.js` | Las 7 rutas nuevas + la clave nueva en `estadoDeSala()`. |
| `services/liveRoom.js` | `shouldAutoClose` mira la transmisión (RN-4). |
| `views/partials/live-room.ejs` | Incluye el partial nuevo. |
| `config/modulos.js` | El módulo `transmision`. |
| `config/audit-actions.js` | Las 7 acciones. |
| `ecosystem.config.js` | La app `classroom-media`, **fork, instancia única**. |
| `routes/backup.js` | La colección `transmisiones` a `COLLECTIONS`. |
| `routes/superadmin.js` | El panel del monitor. |
| `package.json` | `mediasoup`, `mediasoup-client`, `ws`. |
| `agente.md` | Changelog y roadmap. |

**Fuera del repo (pasos de despliegue en el VPS)**

- `ufw allow 40000:40199/udp` y `ufw allow 3478/tcp`.
- Bloque `handle /rtc*` → `reverse_proxy 127.0.0.1:4100` en el `Caddyfile` (Caddy hace el upgrade
  a WebSocket solo).
- `apt install build-essential python3-pip` **antes** del primer deploy con mediasoup. Ver riesgos.

---

## Riesgos y trampas del despliegue

**R1 — `npm install` de mediasoup puede tumbar el deploy automático.** mediasoup 3.12+ baja un
binario precompilado y la instalación es instantánea; **si esa descarga falla, compila localmente**
— y el VPS **no tiene gcc, g++, make, meson ni ninja** (verificado hoy). El webhook hace
`git reset --hard` + `npm install` + `pm2 reload`: un `npm install` que falla deja **archivos
nuevos en disco y código viejo en memoria**, que es el "Frankenstein" ya documentado en el
historial de deploy. Mitigación en tres partes: instalar `build-essential` y `python3-pip` antes,
**fijar la versión exacta** de mediasoup en `package.json`, y probar `npm ci` en el LXC de Proxmox
antes de pushear.

**R2 — El deploy no recarga el proceso nuevo.** El `deployCmd` de `server.js` recarga la app
`classroom` y nada más. Con `classroom-media` afuera, un push que cambie el SFU **no lo despliega**
y nadie se entera: la transmisión sigue corriendo con el código viejo. Hay que sumarlo al comando,
y ese cambio —como siempre— **no se aplica a su propio deploy**: la primera recarga va a mano.

**R3 — El puerto UDP cerrado da el peor síntoma posible.** Todo conecta, la señalización anda,
el estado dice "transmitiendo"… y no hay audio. Sin los puertos abiertos, el diagnóstico se va a
buscar a WebRTC cuando el problema es `ufw`. Mitigación: un chequeo de arranque del proceso de
medios que verifique que puede bindear el rango y **lo escriba en el log**, y una fila en el panel
del monitor.

**R4 — El gobernador con un número mal puesto.** Es el único componente que puede tirar abajo la
plataforma entera si se equivoca hacia arriba. Por eso `media/aforo.js` es **lógica pura sin
mediasoup adentro**: se testea con 200 escenarios sin levantar nada. Y por eso existe
`tools/tx-carga.js`: **medir antes de abrirlo**, no estimar.

**R5 — El puerto real del VPS no está confirmado.** Contabo vende entre 200 Mbit/s y 1 Gbit/s
según el plan, y castiga con la mitad de velocidad al que supera su límite diez días seguidos.
Todos los números de acá suponen **200 Mbit/s**, que es el peor caso. Si resulta ser 1 Gbit/s, el
techo se multiplica por cinco cambiando **una constante**. Se confirma en la Fase 0 midiendo, no
leyendo el panel.

**R6 — La netbook del aula.** Decodificar 360p es liviano; **codificar** no. Si la máquina del
docente es una netbook vieja, la cámara a 720p le come la CPU y el video sale a tirones. Mitigación
ya incorporada: la cámara arranca apagada (D6) y el techo del emisor es 360p.

**R7 — Retrocompatibilidad de las sesiones abiertas.** Una sala abierta en el momento del deploy
lee `transmision` como `undefined`. Los defaults de Mongoose la hacen comportarse como apagada,
igual que se resolvió con `studentsCanShareImages`. Hay un test para eso.

**R8 — La transmisión escondida detrás de una solapa.** El partial de la sala **vive en el DOM
aunque la solapa no esté a la vista** — es el motivo por el que existe `aLaVista()`. Un `<video>`
reproduciendo en una solapa oculta consumiría puerto sin que nadie mire. El consumo se corta con
la misma función que ya corta el poll.

---

## Fases y esfuerzo

| Fase | Qué entra | Esfuerzo |
|---|---|---|
| **0 — Medir** | `tools/tx-carga.js`, medir el puerto real del VPS, mediasoup instalado y probado en el LXC de Proxmox. **Sin tocar la app.** | 1 día |
| **1 — Transmisión** | Docente emite (micro + pantalla + cámara), alumno recibe con botón, mano levantada, gobernador, panel del monitor, moderación básica. **Es la feature.** | 5–7 días |
| **2 — La palabra** | Cola de manos, dar/quitar micrófono, cámara del alumno con permiso aparte, corte por inactividad. | 2–3 días |
| **3 — Lo que Meet suma** | Encuestas, preguntas y respuestas, y **grabación solo si el usuario resuelve el consentimiento** (D9). Subtítulos con decisión aparte. | a definir |

**La Fase 0 no es opcional.** Es la que convierte "creemos que entran 12 clases" en un número
medido, y es barata comparada con descubrirlo un martes a las 8 de la mañana con la escuela
adentro.

---

## Supuestos tomados (decisiones que se pueden revertir sin rediseñar)

Se resolvieron con el criterio que ya usa el proyecto, para no frenar el plan. Cada uno es una
constante o un default, no una decisión de arquitectura:

1. **Puerto de 200 Mbit/s** como peor caso (R5). Cambia una constante.
2. **Techo en 360p**, nunca 720p. Una clase a 720p se come el 38 % del puerto entero.
3. **Alcance: la materia.** Transmitir a toda la escuela (un acto) es otra feature.
4. **La cámara arranca apagada** (D6).
5. **Sin grabación** hasta que exista el consentimiento de las familias (D9).
6. **Se prende escuela por escuela**, y arranca apagada para todas (D10).
7. **El alumno no publica hasta que se le da la palabra** (D7). Es la que menos se debería tocar.


---

## Lo que falta probar (2026-08-31)

Lo verificado y lo no verificado, sin mezclar.

### ✅ Verificado de verdad

- **878 tests unitarios, 394 de humo y la matriz de roles**, todos verdes. 57 tests nuevos.
- **El gobernador**, con los cuatro bordes exactos (222/223, 815/816, 4750/4751), monotonía
  sobre 5.000 valores y la comprobación de que nunca excede el presupuesto sin rechazar.
- **La frontera de seguridad del proceso de medios**, levantándolo de verdad y hablándole por
  WebSocket: ticket con otra firma, ticket vencido, ticket basura, un espectador intentando
  `producir`, y alguien con permiso de audio intentando colar video. Todos rechazados.
- **Los candidatos ICE**, que vienen por UDP **y** por TCP (la red de D11).
- **Los dos ejes del módulo, en el navegador y contra la base**: se prendió la escuela, se
  eligieron dos docentes, se guardó por el formulario real y se leyó de vuelta. El docente
  elegido recibe `puedoEmitir: true` y ve el botón; el no elegido recibe `false` y, forzando la
  ruta a mano, un **403 "Tu escuela todavía no te habilitó para transmitir"**.
- **El módulo apagado**: el poll devuelve `transmision: null`, las rutas dan 403, y la página de
  la sala **no trae el partial, ni sus estilos, ni los 231 KB del bundle de mediasoup**. El chat
  sigue entero.
- **El autocierre** (RN-4): se comprobó que el test FALLA sin el arreglo y pasa con él.

### ✅ Verificado DESPUÉS, con media real (2026-08-31, segunda vuelta)

- **El media viaja.** Con un `<canvas>` animado como fuente (un `MediaStreamTrack` de verdad, sin
  necesidad de cámara): transporte `connecting → connected`, simulcast de 2 capas, **357 paquetes
  y 103 KB enviados en 4 segundos**.
- **Y vuelve.** Segunda conexión como receptor: los dos transportes `connected`, **cuadros
  decodificados** y el `<video>` reportando **640×360** reales. O sea: navegador → SFU →
  navegador, completo.
- **El túnel de Express** (D13), con su test: el primer mensaje no se pierde, el orden se
  respeta, y con el proceso de medios caído el frente sigue en pie.

### ❌ NO verificado — hace falta una prueba con gente

- **Que se vea y se escuche BIEN.** El media viaja y se decodifica, pero nadie miró todavía una
  clase real con cámara y micrófono: queda por confirmar la calidad, el eco, la latencia
  percibida y el audio, que en la prueba sintética no se ejercitó.
- **El simulcast bajo carga**, y por lo tanto los números del gobernador contra el cable. Es la
  Fase 0 de la spec, que sigue pendiente y sigue sin ser opcional.
- **El comportamiento en la netbook del aula** (R6).
- **La red de la escuela**: si el UDP saliente está bloqueado ahí, la red de ICE-TCP se estrena
  recién el día de la prueba.

### Pasos de despliegue que NO están en el código

1. `ufw allow 40000:40199/udp` y `ufw allow 3478/tcp` en el VPS — hoy solo pasan 22, 80 y 443.
   **Sin esto la señalización anda y no hay audio**, que es el síntoma más difícil de todos.
2. Bloque `handle /rtc*` → `reverse_proxy 127.0.0.1:4100` en el `Caddyfile`.
3. `pm2 start ecosystem.config.js` para levantar `classroom-media` la primera vez.
4. Sumar `classroom-media` al `deployCmd` de `server.js` (R2) — y recordar que **ese arreglo no
   se aplica a su propio deploy**: la primera recarga va a mano.
5. Verificar que `npm ci` en el VPS deja el binario de mediasoup. En Windows y en el paquete
   publicado **el binario viene precompilado** (verificado: `mediasoup-worker` arranca sin
   compilador), lo que baja mucho el riesgo R1 — pero el VPS no se pudo probar porque **desde la
   red de la escuela el puerto 22 no sale**.
