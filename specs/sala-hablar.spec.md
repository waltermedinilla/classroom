# "Hablar" en la sala en vivo (voz del docente y, si él quiere, de los alumnos)

Estado: **APROBADA · IMPLEMENTADA en la rama `feat/hablar`, sin pushear** (2026-09-23) · **Fase 0 hecha** (falta medir desde la red de San José) · Módulo: `hablar`

> Tests: `tests/unit/hablar.test.js` (46), `tests/unit/hablarMedios.test.js` (16) y el smoke
> `sala-hablar`. Escritos antes de implementar: **56 fallan** como corresponde; los 6 que pasan
> son guardas de regresión (la escalera de video, el ticket de escucha, la voz del docente).

> **Decidido por el usuario el 2026-09-23**: módulo propio (H11); es para alumnos **en casa y en
> el aula** (H12); tope de **docente + 2 alumnos** (H4); DonWeb abrió UDP y TCP 40000–40999 en
> su firewall (H7, camino A) — medido, ver "Resultado de la Fase 0".

> Pedido del usuario, 2026-09-23: *"que las salas puedan tener la opción de 'Hablar': si el docente
> en la sala en vivo presiona ese botón, puede tener una comunicación con los alumnos de audios, y
> que el docente elija si quiere hablar solo él, o habilitar al resto a hablar. Tiene que ser
> congruente con el VPS que tenemos, que gaste lo mínimo en recursos y en megabytes."*

Hermana de [`transmision-en-vivo.spec.md`](transmision-en-vivo.spec.md) y de
[`sala-en-vivo.spec.md`](sala-en-vivo.spec.md). **No construye infraestructura nueva: le saca a la
transmisión la pantalla y la cámara, y le agrega que los alumnos puedan hablar.**

---

## La respuesta corta

**Hablar es la transmisión que ya existe, apagada, sin pantalla ni cámara.** El SFU
(`media/servidor.js`), el ticket de 60 s, el túnel `/rtc`, el gobernador y el módulo de dos ejes
están escritos, testeados y desplegados apagados desde el 31/08. Le falta:

1. un botón **"🎙 Hablar"** que la abra **solo con micrófono**,
2. el interruptor **"Solo yo hablo / Todos pueden hablar"**,
3. **pulsar para hablar** del lado del alumno, con **tope de voces simultáneas**,
4. afinar el Opus para voz y no cargar nada hasta que alguien toque un botón.

Y hay **un bloqueante que no es de código**: el firewall de DonWeb está aguas arriba y deja pasar
solo 5840, 80 y 443 (medido el 09/09). El audio de WebRTC viaja por UDP en otro puerto. **Sin
resolver eso, no suena nada** — con la señalización perfecta y sin un error en ningún log (D14
de la transmisión). Por eso la Fase 0 es medir los puertos, y va primero.

### Lo que cuesta, en números

Una voz en Opus mono afinada para habla (H5): **~33 kbps mientras suena** — ✅ medido el
2026-09-23 con `getStats()`, 24 de audio + ~9 de cabeceras con paquetes de 60 ms — y **~1 kbps
en silencio** (DTX). Con un docente que habla el ~60 % de la clase:

| | Hablar (1 voz) | Hablar (tope: 3 voces) | Transmisión 180p | Transmisión 360p |
|---|---|---|---|---|
| **Datos del alumno, por hora** | **~11 MB** (15 si nadie hace pausa) | ~30 MB | ~70 MB | ~195 MB |
| Subida del servidor, aula de 30 | **1,0 Mbit/s** | 3,0 Mbit/s | 4,7 Mbit/s | 13 Mbit/s |
| Escuela entera (450) escuchando | **15 Mbit/s** | 45 Mbit/s | 71 Mbit/s | — |
| Subida del que habla | 33 kbps | 33 kbps | ~650 kbps | ~2,9 Mbit/s |

Con un navegador que ignore los paquetes de 60 ms (Safari no está medido), la voz pesa ~51 kbps:
todo lo de la columna de Hablar se multiplica por 1,5. El gobernador cuenta ese peor caso.

**Por mes**, si las 15 divisiones usaran Hablar **2 horas por día**, los 20 días: ~**200 GB**.
Hoy la plataforma entera saca ~230 GB/mes y el plan de DonWeb trae **3 TB**. Entra holgada, aun
en un uso que la escuela no va a tener.

**CPU**: un SFU no transcodifica, reenvía paquetes. 450 oyentes con 1 voz son ~22.500 paquetes
por segundo, y un solo worker C++ de mediasoup reenvía decenas de miles. **RAM**: se propone
bajar `MEDIA_WORKERS` de 4 a **1** en el VPS (H10): la máquina tiene 6 GB, no 24.

---

## Problema

La sala en vivo resuelve casi todo por escrito. Pero hay cosas que por escrito no se hacen: leer
en voz alta, explicar un ejercicio mientras se piensa, pronunciar en inglés, que un alumno lea su
respuesta. Hoy eso obliga a salir de la plataforma a un Meet o un audio de WhatsApp, y ahí se
pierden la moderación, la asistencia y el control de quién está.

La transmisión completa (video + pantalla) está hecha pero **apagada**, y es una herramienta
cara: consume 6 a 17 veces más datos por alumno. Lo que se pide acá es **la mitad barata**: voz.

---

## Alcance

1. **Botón "🎙 Hablar"** en la sala, para el gestor de la materia habilitado.
2. **Dos modos**, que el docente cambia en cualquier momento:
   - **Solo yo hablo** (default): el docente habla, los alumnos escuchan.
   - **Todos pueden hablar**: los alumnos hablan **pulsando para hablar**, con tope de voces.
3. **"🔊 Escuchar"** del lado del alumno, explícito (H6).
4. **Indicador de quién está hablando**, para todos. Nadie habla de forma anónima.
5. **Moderación**: silenciar a un alumno, volver a "Solo yo hablo" (corta todos los micrófonos
   en el acto), dejar de hablar.
6. Registro mínimo para el diagnóstico y para la pregunta *"¿cuánto costó?"* (H9).

### Fuera de alcance (decidido, no olvidado)

- **Grabación.** Mismo motivo que D9 de la transmisión: son menores; necesita consentimiento
  de las familias y política de retención. No lo decide una spec.
- **Cola de manos / dar la palabra de a uno.** Está diseñada (D7 de la transmisión, backend ya
  hecho). "Todos pueden hablar" con pulsar-para-hablar y tope cubre el pedido; la cola queda
  para después si el uso la pide.
- **Audio por WebSocket como plan C** (ver H7): se descarta por ahora, con su motivo.
- **Subtítulos / transcripción.** Mismo motivo que en la transmisión.
- **Mezclar las voces en el servidor** (MCU). Ver H4.

---

## Decisiones de diseño

### H1 — No es infraestructura nueva: es una transmisión con `micro` y nada más

`RoomSession.transmision` ya tiene `micro`, `pantalla` y `camara` independientes. "Hablar" es
abrirla con `{ micro: true, pantalla: false, camara: false }`. Se reusa **todo**:

| Pieza | Estado | Qué cambia para Hablar |
|---|---|---|
| `media/servidor.js` (SFU, proceso aparte, fork único) | hecho, apagado | pulsar-para-hablar, tope, cierre de voces |
| Ticket JWT de 60 s (D4) | hecho | `emitir: 'audio'` también para alumnos en modo abierto |
| Túnel `/rtc` por Express (D13) | hecho | nada |
| Gobernador (`media/aforo.js`) | hecho | una capa más: `voz` |
| Módulo de dos ejes (D10) | hecho | un módulo más (ver H11) |
| Autocierre no cuenta la transmisión como inactividad (RN-4) | hecho | nada |
| `RoomPresence` como única asistencia (D8) | hecho | nada |

**Cero procesos nuevos, cero dependencias nuevas, cero colecciones nuevas.**

### H2 — Los dos modos son el espejo del chat

La sala ya tiene el interruptor "solo yo escribo / todos escriben" (`settings.studentsCanWrite`).
El docente ya lo entiende. Hablar usa **el mismo modelo mental** con su propio interruptor:
`transmision.vozAbierta` (`false` = Solo yo hablo).

Son independientes a propósito: una docente puede querer el chat abierto y la voz cerrada (que
pregunten por escrito mientras ella explica), o al revés.

**Default: Solo yo hablo.** Abrir la voz a los alumnos es un segundo toque, consciente.

### H3 — El alumno **pulsa para hablar**. Nunca un micrófono abierto

Es la decisión que más ahorra y la que más protege, y las dos razones son independientes:

- **Son menores** (D7 de la transmisión). Un micrófono que queda abierto en la casa de un chico
  de 13 años, transmitiendo lo que pasa en su cocina, no se diseña así. Con pulsar-para-hablar el
  micrófono **solo manda mientras el dedo está apoyado**.
- **Cuesta cero en silencio.** El productor se crea pausado y con `zeroRtpOnPause: true` de
  mediasoup-client: soltado, **no viaja ni un paquete** (ni siquiera el de DTX). 30 alumnos con
  el botón a la vista y nadie hablando = 0 kbps.
- **Y resuelve el acople.** 30 micrófonos abiertos con 30 parlantes son 30 fuentes de eco y del
  ruido de 30 casas. El que pulsa es uno.

Detalles que no son cosméticos:

- **Mantener apretado** (táctil y mouse) y **barra espaciadora** en PC.
- **Tope de 60 s por pulsación** (`MAX_PULSACION_MS`), controlado en el navegador **y en el
  servidor**: si se pierde el `touchend` (pasa en celulares), el micrófono no queda abierto.
- El transporte de **subida** se crea recién en la **primera** pulsación. El alumno que nunca
  habla no crea ni un transporte de envío.
- Al volver a "Solo yo hablo" o al salir, se hace `track.stop()`: **se apaga la lucecita del
  micrófono del navegador**, que es la señal que la familia entiende.
- La primera pulsación dispara el permiso del navegador y no transmite: el cartel dice
  *"Aceptá el permiso y volvé a apretar"*.

**El docente no pulsa**: tiene el micrófono abierto con un botón de silenciarse, porque es quien
da la clase. Con DTX, sus silencios cuestan ~1 kbps.

### H4 — Tope de voces simultáneas, impuesto en el servidor

`MAX_VOCES = 3`: **el docente más 2 alumnos** a la vez. ✅ Decidido por el usuario el 2026-09-23. Si un cuarto aprieta, el servidor le
contesta `lleno` y ve *"Esperá: ya están hablando dos compañeros"*.

- Es lo que hace que el costo **no dependa de cuántos aprieten**: cada oyente recibe como mucho
  3 voces = 120 kbps, siempre. Sin tope, 30 alumnos apretando a la vez son 29 flujos a cada uno.
- El lugar del docente está **reservado**: su voz nunca queda afuera por el tope.
- Lo decide el proceso de medios porque es **un límite de recursos, no un permiso** — no
  contradice D4: quién puede hablar lo sigue decidiendo Express con el ticket; cuántos a la vez,
  quien cuenta los productores.

**Alternativas descartadas:**

- *ActiveSpeakerObserver* de mediasoup (reenviar solo a los que más fuerte suenan): más código,
  y el resultado depende del volumen de cada casa. El tope por pulsación es determinístico.
- *Mezclar en el servidor* (MCU, un solo flujo por oyente): exige decodificar y recodificar
  Opus = CPU por cada aula. El tope de 3 ya deja la bajada en 120 kbps sin gastar un núcleo.

#### ¿Y si hablan el docente y TODOS los alumnos conectados?

*(Pregunta del usuario, 2026-09-23.)* "Todos pueden hablar" ya significa eso: **cualquier alumno
conectado puede hablar**. Lo que el tope limita es cuántos **a la vez**. Con un SFU, cada oyente
recibe **todas las voces activas** menos la suya, así que el costo crece con el cuadrado de los
que hablan juntos:

Con los ~33 kbps por voz medidos:

| Aula de 30, hablando **a la vez** | Por alumno | Servidor, 1 aula | Servidor, 15 aulas |
|---|---|---|---|
| Solo el docente | 33 kbps | 1,0 Mbit/s | 15 Mbit/s |
| Docente + 2 (**tope elegido**) | 99 kbps | 3,0 Mbit/s | 45 Mbit/s |
| Docente + 4 | 165 kbps | 5,0 Mbit/s | 74 Mbit/s |
| **Los 30 con micrófono abierto, sin tope** | **~1 Mbit/s** | **29 Mbit/s** | **430 Mbit/s → se cae la plataforma** |

⭐ **El último renglón no es teórico.** Con micrófono abierto, el DTX solo ahorra cuando hay
silencio de verdad, y la tele, el hermano o el ruido de 30 casas **no son silencio**: cada micrófono
manda a tasa completa. Ahí están los 29 Mbit/s por aula, y además la clase es inescuchable. Con
pulsar-para-hablar y tope, **el peor caso queda fijo en 3 Mbit/s por aula**, apriete quien
apriete. En una conversación real rara vez hablan más de dos al mismo tiempo, así que el tope casi
no se nota.

### H5 — Opus afinado para voz, no para música

El router ya declara Opus con DTX y FEC. Del lado del que habla, al producir:

```js
codecOptions: {
  opusStereo: false,               // la voz es mono; estéreo es el doble para nada
  opusDtx: true,                   // silencio ≈ 1 kbps
  opusFec: true,                   // tolera pérdidas del celular sin reenviar
  opusMaxAverageBitrate: 24000,    // voz clara; más de 24 kbps no se oye distinto en un parlante de celular
  opusPtime: 20,                   // ver abajo
},
zeroRtpOnPause: true,              // H3: soltado = 0 paquetes
```

Y `getUserMedia` con `echoCancellation`, `noiseSuppression` y `autoGainControl` (ya se usa así
en `public/js/transmision.js`).

⭐ **Las cabeceras pesan más que la voz.** ✅ **MEDIDO el 2026-09-23** con `getStats()` en
Chromium, con un tono continuo (el peor caso, sin silencios para el DTX):

| | Paquetes/s | Audio | Cabeceras | **En la red** |
|---|---|---|---|---|
| `opusPtime: 20` | 51 | 24 kbps | ~27 kbps | **~51 kbps** |
| `opusPtime: 60` | 17 | 24 kbps | ~9 kbps | **~33 kbps** |

Chromium respeta el ptime de 60 (el SDP lo lleva y los paquetes por segundo lo confirman), así
que **se adoptó: un 35 % menos por voz**, a cambio de 40 ms más de retraso. La estimación de 40
kbps de la primera versión de esta spec **era baja**: el gobernador ahora cuenta **50 kbps** por
voz, el peor caso de un navegador que ignore el ptime (Safari no está medido). Con eso, las 450
personas escuchando tres voces a la vez son 67 Mbit/s = 42 % del presupuesto.

### H6 — El alumno toca "🔊 Escuchar". Nada suena ni se descarga solo

Herencia directa de D12 de la transmisión, y acá las razones pesan más:

- **Los navegadores no dejan reproducir audio sin un gesto.** Sin botón, el audio simplemente
  no suena y nadie entiende por qué.
- **En la clase presencial el ahorro es total.** Si el docente habla en el aula, 30 celulares
  reproduciéndolo **en la misma aula** no solo gastan datos: hacen **acople** (el micrófono del
  docente levanta 30 parlantes con medio segundo de retraso). El botón dice debajo: *"Si estás
  en el aula con tu profe, no hace falta"*.
- **El dato móvil**: el botón muestra *"~11 MB por hora"* antes del primer toque.

⭐ **Lo que no se descarga hasta el primer toque**: el bundle de `mediasoup-client` (**231 KB**)
hoy se carga con `<script>` en cada apertura de la sala cuando el módulo está prendido. Pasa a
cargarse **al tocar Escuchar o Hablar** (inyección del script bajo demanda). Un alumno que nunca
lo toca no baja ni un byte de la feature.

⭐ **La excepción deliberada a R8 de la transmisión**: el video se corta con la solapa oculta
(`aLaVista()`), **el audio no**. El alumno sale a hacer la actividad en otra solapa
([`sala-presencia-en-actividad.spec.md`](sala-presencia-en-actividad.spec.md)) y tiene que
seguir escuchando a la profe. Por eso los cambios de modo que afectan al audio (H8) viajan
**por el WebSocket**, que sigue vivo en segundo plano, y no solo por el poll, que ahí se corta.

### H7 — El camino del audio: el firewall de DonWeb decide, y se mide antes de programar

El proveedor filtra **fuera de la máquina** y solo deja pasar 5840, 80 y 443 (medido el 09/09:
el 2222 estaba abierto en `ufw` y escuchando, y no llegaba desde dos redes distintas). El SFU
hoy escucha en **UDP 40000–40199** y TCP en ese mismo rango. **Casi seguro no pasan.**

⭐ **El rango de hoy además es chico.** Sin `WebRtcServer`, mediasoup toma **un puerto por
transporte**, y cada oyente usa un transporte (dos si además habla). 200 puertos = **~200 personas
conectadas en toda la escuela**, y la escuela entera son ~450. Por eso el pedido es de **1.000**.

**Decisión (2026-09-23): camino A, pidiendo `40000–40999` en UDP y TCP.** El usuario autorizó
pedirle a DonWeb los puertos que hagan falta. Con eso:

- El código de hoy funciona **tal como está**, cambiando solo `RTC_MAX_PORT=40999` en el `.env`.
- `WebRtcServer` (un solo puerto para todos) **deja de ser necesario**: era para pedir 2 puertos
  en vez de 200. No se programa. Menos código que pueda romper la sala.
- El TCP en el mismo rango es el respaldo para las redes que bloquean UDP (D11).
- Un puerto abierto en el firewall en el que no escucha nadie **no expone nada**: mediasoup solo
  abre los que usa en cada momento.

Los caminos que quedan de respaldo, por si DonWeb no los abre:

| | Qué hace falta | Costo | Qué se pierde |
|---|---|---|---|
| **A** ✅ | Que DonWeb abra **UDP y TCP 40000–40999** hacia `138.219.40.80` | un pedido al soporte | nada |
| **B** | Si solo pasa el 443: mediasoup en **UDP 443** y Caddy **sin HTTP/3** (`servers { protocols h1 h2 }`) | una línea del Caddyfile | HTTP/3 (irrelevante acá) y el respaldo TCP: una red que bloquee UDP no escucha |
| **C** | Nada pasa | — | Hablar no se habilita. **No se construye** un relevo de audio por WebSocket (abajo) |

**Por qué no el relevo por WebSocket (plan C como código).** Técnicamente entra: 30 × 40 kbps
por el 443 que ya pasa. Pero el audio atravesaría Caddy y los workers de Express (lo que D13 se
cuidó de evitar), TCP acumula retraso en cuanto el celular pierde un paquete (la voz se va
atrasando y no se recupera), y sería **una segunda tubería de media** a mantener para siempre,
con sus propios bugs silenciosos. Queda anotado como salida si A y B fallan, con decisión aparte.

⚠️ **La otra punta: la red de la escuela.** Si el docente habla **desde la escuela** a alumnos que
están en casa, el UDP tiene que **salir** de la red de la escuela, donde ya se sabe que el 22 no
sale. Se mide en la Fase 0 desde ahí. Si la escuela bloquea UDP saliente, el respaldo TCP del
camino A lo cubre; el B no. **Si la escuela bloquea también el TCP a puertos altos**, el docente
no puede hablar *desde la escuela* a los de casa (sí desde su casa). La salida para ese caso es
TURN por TLS en el 443, compartido con Caddy: se diseña solo si la medición lo exige.

### H8 — Volver a "Solo yo hablo" corta en el acto, no en el próximo poll

El ticket dura 60 s, pero **el ticket se verifica al conectar, no en cada paquete**: un alumno
que ya estaba produciendo seguiría hablando. Y el poll tarda hasta 8 s (RN-4 de escala).

Entonces el POST del docente, además de guardar `vozAbierta: false`, le pide al proceso de medios
por `services/mediaClient.js` (que ya tiene `cerrarSala`) **`cerrarVoces(sid)`**: cierra todos los
productores de alumnos de esa sala y les manda `modoVoz` por el WebSocket. El docente sigue
hablando. **Objetivo medible: menos de 1 s** entre el toque y el último paquete de un alumno.

Lo mismo al **silenciar a un alumno** (`mutedStudents`, H9): se le cierra el productor en el
acto, además de negarle el próximo ticket.

Si el proceso de medios no contesta, el POST igual guarda el modo (la sala no se rompe, RN-10) y
los alumnos se enteran por el poll: el peor caso es el de hoy, no uno nuevo.

### H9 — Moderación y registro: lo mínimo, reusando lo que hay

- **Silenciar alumno = silenciado entero** (RN-5 de la transmisión, precedente de las fotos): el
  que está en `mutedStudents` no puede escribir, ni mandar fotos, ni hablar.
- **Indicador "🎙 Hablando: PEREZ, Ana"** para todos, docente incluido. Se manda por el
  WebSocket (`hablando`) al empezar y terminar cada pulsación: son unos bytes por evento, no un
  flujo. El nombre sale del ticket (que ya lo trae, `nom`), no de una query.
- **Registro**: el `Transmision` que ya existe gana `soloVoz`, `vozAbiertaSegundos`,
  `alumnosQueHablaron` (cantidad) y `pulsacionesRechazadasPorTope`. **No se guarda qué dijo nadie
  ni cuándo pulsó cada uno**: el dato sirve para dimensionar, no para vigilar.
- Auditoría: `voz.start`, `voz.stop`, `voz.abrir_alumnos`, `voz.cerrar_alumnos`. Cada pulsación
  **no** se audita (sería una línea por frase).

### H10 — Afinado del proceso de medios para una máquina de 6 GB

`MEDIA_WORKERS` default es 4, pensado para el VPS de 8 núcleos y 24 GB. En DonWeb (4 vCPU, 6 GB,
2 workers de Express con techo de 1280 MB cada uno, Mongo con 1 GB) se propone **`MEDIA_WORKERS=1`**
en el `.env`: para audio, un worker sobra para la escuela entera, y se queda con los 1.000
puertos del rango (con 4, cada uno tendría 250). Si algún día se prende el video para muchos
docentes, se sube.

`PRESUPUESTO_MBPS = 160` salió del peor caso de Contabo. **El puerto real de DonWeb no está
medido**; hasta medirlo se deja el número, que para audio sobra 3 veces aun en el peor caso.

### H11 — Módulo propio `hablar`, al lado de `transmision` ✅ DECIDIDO (2026-09-23)

Un módulo nuevo `hablar`, con el mismo `alcance: 'escuela+persona'` y la misma
regla de D10 (**se le pregunta a quien habla, nunca a quien escucha**).

El motivo es de costos: Hablar cuesta ~6 veces menos que la transmisión a 180p y tiene mucho menos
riesgo. Es razonable querer **Hablar para todos los docentes** y **video para dos o tres**. Con un
solo módulo, eso no se puede expresar.

Si la escuela tiene `transmision` prendido para un docente, ese docente también puede hablar
(transmitir incluye el micrófono); el módulo `hablar` es para dar **solo la voz**.

~~Alternativa: un solo módulo `transmision` con una opción "solo voz".~~ Descartada por el usuario.

### H12 — Alumnos en casa y en el aula a la vez ✅ DECIDIDO (2026-09-23)

La clase híbrida es el caso normal, no la excepción. La regla que ordena todo: **el que está en el
aula no usa el audio de la plataforma: escucha y habla en voz alta, como siempre.**

- **Escuchar**: el alumno del aula no lo toca. Si lo toca con parlante, el micrófono del docente
  levanta su celular con medio segundo de atraso y se acopla. El botón lo dice debajo: *"Si estás
  en el aula con tu profe, no hace falta"*.
- **Hablar**: el alumno del aula habla en voz alta y lo toma el micrófono del docente; los de casa
  lo escuchan por ahí. Si en cambio pulsa desde su celular, los de casa lo oyen **dos veces**
  (por su celular y por el micrófono del docente) — y ningún cancelador de eco lo arregla, porque
  son dos aparatos distintos. El botón de pulsar lleva el mismo aviso.
- **El micrófono del docente** conviene que sea el de la compu del aula, no uno de solapa: tiene
  que tomar también las voces del aula para que los de casa las escuchen.
- **La red de la escuela**: si 30 alumnos del aula tocaran Escuchar, serían 1,2 Mbit/s de la
  conexión de la escuela por aula para oír lo que ya oyen. Es la otra razón del botón.

**Descartado: detectar solo quién está en el aula** (por la IP de la escuela). Los celulares con
datos móviles no pasan por esa IP, y con CGNAT varias redes comparten IP. Un aviso claro es más
confiable que una detección que se equivoca en silencio.

---

## Paridad con lo que el usuario pidió

| Pedido | Cómo |
|---|---|
| "Si el docente presiona ese botón, comunicación de audio con los alumnos" | Botón 🎙 Hablar → transmisión con solo micrófono (H1) |
| "Que el docente elija si quiere hablar solo él" | Modo **Solo yo hablo**, el default (H2) |
| "…o habilitar al resto a hablar" | Modo **Todos pueden hablar**, pulsando, con tope (H3, H4) |
| "Congruente con el VPS" | Sin procesos ni servicios nuevos; 1 worker; 2 puertos (H7, H10) |
| "Lo mínimo en recursos y megabytes" | ~11 MB/h por alumno; 0 bytes a quien no toca Escuchar ni a quien no pulsa (H3, H5, H6) |

---

## Entidades / Schemas

### `models/RoomSession.js` — dos campos en el subdocumento que ya existe

```js
transmision: {
  // ...todo lo que ya está...
  soloVoz:    { type: Boolean, default: false }, // se abrió desde "Hablar" (no admite pantalla/cámara si el módulo es solo `hablar`)
  vozAbierta: { type: Boolean, default: false }, // H2: false = Solo yo hablo
}
```

Sesiones abiertas en el momento del deploy leen `undefined` → los defaults las dejan en "Solo yo
hablo" (mismo patrón que R7 de la transmisión). Test.

**Quién está hablando AHORA no se guarda en Mongo**: vive en el proceso de medios (los productores
activos). Si ese proceso se reinicia, todos sueltan el botón y vuelven a apretar: una pulsación
es un momento, no un estado que haya que conservar. `vozAbierta` sí va a Mongo: es una decisión
del docente y tiene que sobrevivir al reinicio.

### `models/Transmision.js` — campos de H9

`soloVoz`, `vozAbiertaSegundos`, `alumnosQueHablaron`, `pulsacionesRechazadasPorTope`.

### `config/transmision.js` — constantes nuevas, con su fundamento al lado

```js
MAX_VOCES = 3                 // H4: docente + 2 alumnos
MAX_PULSACION_MS = 60_000     // H3: el micrófono no queda abierto si se pierde el touchend.
                              //     Se puede pisar con la variable de entorno del mismo nombre
                              //     (los tests del proceso de medios la bajan a < 1 s).
VOZ_MAX_BITRATE = 24000       // H5
VOZ_PTIME = 60                // H5: medido, Chromium lo respeta (17 paquetes/s en vez de 51)
VOZ_KBPS_POR_VOZ = 50         // H5: el peor navegador (ignora el ptime): ~51 kbps medidos
VOZ_KBPS_TIPICO  = 24         // lo que se le MUESTRA al alumno: 1 voz × ~33 kbps × 60 % de habla, para arriba
```

**Dos números distintos a propósito.** El gobernador cuenta el **peor caso** por oyente:
`mbpsDeCapa('voz') = MAX_VOCES × VOZ_KBPS_POR_VOZ / 1000` = 0,15 Mbit/s. Con eso deja entrar a
~850 oyentes simultáneos antes del umbral del 80 %: la escuela entera, casi dos veces. Pero al
alumno se le muestra el consumo **típico**: `estimarMB('voz', 60)` = **11 MB** (24 kbps × 1 h).
Mostrarle el peor caso (68 MB) lo asustaría con un número que no va a gastar.

⚠️ **`voz` NO entra en la escalera `CAPAS`**, que es la de video (360p → 180p → audio) y la
recorre `capaPermitida()`. Meterla ahí haría que el gobernador pudiera "degradar" una clase de
video a voz. `mbpsDeCapa()` y `estimarMB()` la conocen aparte; `capaPermitida()` nunca la devuelve.

### `config/modulos.js` — si se aprueba H11

```js
{ id: 'hablar', label: 'Hablar en la sala', icon: 'mic', alcance: 'escuela+persona',
  localsKey: 'hablarEnabled',
  descripcion: 'La o el docente habla por voz en la sala en vivo, y puede habilitar a los alumnos.',
  secciones: [] }
```

Arranca **apagado para todas las escuelas**, y al prenderlo, con `alcance: 'lista'` y
`personas: []` (D10: prender la escuela no reparte la feature a sesenta docentes de golpe).

---

## Entradas y salidas

### Rutas (en `routes/rooms.js`, detrás de `cargarSala`)

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /courses/:id/sala/transmision/abrir` | gestor | **Ya existe.** Con `{ soloVoz: true }` abre solo micrófono. Pasa por el gobernador. |
| `POST /courses/:id/sala/transmision/voz` | gestor | **Nueva.** `{ abierta: true \| false }`. Al cerrar, llama a `cerrarVoces` (H8). |
| `POST /courses/:id/sala/transmision/ticket` | cualquiera de la sala | **Ya existe.** El alumno recibe `emitir: 'audio'` si `vozAbierta` y no está silenciado. |
| `POST /courses/:id/sala/transmision/cerrar` | gestor | **Ya existe.** Cierra todo, voces incluidas. |

### Poll: la clave `transmision` gana dos campos

`"soloVoz": true, "vozAbierta": false, "puedoHablar": false`. Nada más. Quién habla ahora **no**
va por el poll (llegaría con 4 a 8 s de atraso): va por el WebSocket (H9).

### Protocolo del WebSocket — mensajes nuevos

Precisado el 2026-09-23 al escribir los tests (son los nombres exactos que los tests fijan):

- Un ticket con `emitir: 'audio'` puede `producir` **solo audio**. El proceso de medios crea ese
  productor **pausado** y contesta `produciendo` con `pausado: true`. El del docente
  (`emitir: true`) nace andando y **nunca cuenta** contra el tope.
- **Del navegador**: `hablar` → `hablarOk` si hay lugar, o `lleno` (con `mensaje`) si ya hablan
  dos alumnos. `callar` → `callado`.
- **Del servidor, a TODOS en la sala** (oyentes, docente y el propio que habla): `hablando`
  `{ uid, nom, on }` al empezar y al terminar cada pulsación. `nom` sale del ticket.
- **Del servidor, al que habla**: `teCallaron` `{ motivo: 'tiempo' | 'voz-cerrada' }` cuando
  la pulsación pasa `MAX_PULSACION_MS` o el docente cierra la voz.
- **Del servidor, a los alumnos**: `modoVoz` `{ abierta: false }` al cerrarse la voz.

### Proceso de medios — endpoint local nuevo

`POST 127.0.0.1:4100/cerrar-voces` `{ sessionId }` → `{ ok: true, cerradas: N }`: cierra los
productores de **alumnos** de esa sala (no el del docente, no los de otra sala) y esas conexiones
dejan de poder producir: para volver a hablar necesitan un ticket nuevo. Mismo patrón y mismo
nombre de campo que el `/cerrar` que ya existe.

---

## Reglas de negocio

- **RH-1** Hablar existe solo dentro de una sesión abierta; cerrar la sala lo corta (RN-1 de la
  transmisión).
- **RH-2** El módulo se consulta sobre **quien abre la voz** (el docente), nunca sobre quien
  escucha o sobre el alumno que pulsa (D10).
- **RH-3** Un alumno puede emitir audio solo si: la voz está abierta **y** no está silenciado
  **y** está en la sala. **Nunca video** con un ticket de voz (ya verificado en el SFU: *"alguien
  con permiso de audio intentando colar video — rechazado"*).
- **RH-4** Como mucho `MAX_VOCES` productores activos por sala; el del docente no cuenta contra el
  cupo de los alumnos.
- **RH-5** Ninguna pulsación dura más de `MAX_PULSACION_MS`, controlado en las dos puntas.
- **RH-6** Pasar a "Solo yo hablo" o silenciar a un alumno cierra sus productores **sin esperar
  el poll** (H8).
- **RH-7** Preceptor y dirección **escuchan**, nunca hablan ni cambian el modo (RN-8 de la
  transmisión). El modo observación de dirección aplica igual (RN-6).
- **RH-8** Escuchar sigue con la solapa oculta (H6). Cerrar la pestaña corta el consumo en el
  acto (RN-9).
- **RH-9** Si el proceso de medios se cae, la sala sigue entera y se dice *"Se cortó el audio,
  se puede volver a empezar"* (RN-10).
- **RH-10** Nada se graba (fuera de alcance).

---

## Criterios de aceptación

### Lógica pura (sin base ni navegador)

1. `puedeHablar(session, ctx)`: true para el gestor; para el alumno, solo con `vozAbierta` y no
   silenciado; false para preceptor y dirección siempre (RH-3, RH-7).
2. `puedeHablar` es **false** para un alumno silenciado aunque la voz esté abierta.
3. `hayLugar(alumnosHablando, esDocente)` (en `media/aforo.js`, porque la usa el proceso de
   medios, que no puede cargar mongoose): el docente siempre tiene lugar; con `MAX_VOCES = 3`,
   con 0 o 1 alumnos hablando entra otro, con 2 ya no (RH-4).
4. `mbpsDeCapa('voz')` es `MAX_VOCES × VOZ_KBPS_POR_VOZ / 1000` y 450 oyentes en `voz` usan menos
   del 45 % del presupuesto (era 40 % con los 40 kbps estimados; se ajustó al medir 50 en el peor
   caso). `capaPermitida()` nunca devuelve `'voz'`.
5. `estimarMB('voz', 60)` devuelve **11** (el consumo típico, no el peor caso).
5b. `datosDelTicket(session, ctx)` → `{ emitir, video }`: el gestor habilitado emite con video
   solo si la transmisión NO es `soloVoz`; el alumno con la voz abierta y sin silenciar,
   `emitir: 'audio'` y `video: false`; cerrada o silenciado, `emitir: false`; el alumno con la
   palabra (D7) sigue como hoy.
6. Una sesión sin los campos nuevos (`undefined`) se comporta como "Solo yo hablo" (R7).

### Rutas (con base)

7. El gestor habilitado abre con `soloVoz: true`: la transmisión queda con `micro: true`,
   `pantalla: false`, `camara: false`, `vozAbierta: false`.
7b. Con solo el módulo `hablar` (sin `transmision`), pedir pantalla o cámara por
    `/transmision/modo` da **403**: el módulo da la voz y nada más (H11).
8. Un gestor **no** habilitado en el módulo recibe 403 y no ve el botón (RH-2).
9. Los alumnos de ese docente **no necesitan** estar en ninguna lista para escuchar ni para
   hablar (RH-2). Test que lo fija, como el de D10.
10. Un alumno que hace el POST de `/voz` recibe 403.
11. Con `vozAbierta: false`, el ticket del alumno sale con `emitir: false`; con `true`, con
    `emitir: 'audio'`; silenciado, con `emitir: false`.
12. Pasar a "Solo yo hablo" llama a `cerrarVoces`; con el proceso de medios caído, **igual guarda
    el modo y contesta 200** (RH-9).
13. Cerrar la sala con la voz abierta la cierra y el `Transmision` queda con `soloVoz: true`.

### Proceso de medios (levantándolo de verdad, como los tests de señalización que ya hay)

14. Con 2 alumnos hablando, el `hablar` de un tercero recibe `lleno`; el del docente, `ok`.
15. Al soltar uno, el siguiente `hablar` recibe `ok`.
16. Una pulsación que pasa `MAX_PULSACION_MS` se pausa sola y el alumno recibe `teCallaron`.
17. `/cerrar-voces` cierra los productores de alumnos de **esa** sala y **no** el del docente
    ni los de otra sala.
18. Un ticket `emitir: 'audio'` que intenta producir video es rechazado (ya existe; se reafirma).
19. Todos los oyentes reciben `hablando` al empezar y al terminar cada pulsación.

### Media real (la lección de D14: la señalización no prueba nada)

20. Con `getStats()`: el docente hablando da `packetsSent` creciendo; un alumno **con el botón
    suelto** da `packetsSent` **quieto** (`zeroRtpOnPause`). Es la prueba del "cuesta cero".
21. El oyente reporta `totalSamplesReceived` creciendo y `audioLevel` > 0 con voz real.
22. Bitrate medido de una voz hablando: ≤ 45 kbps con ptime 20. Se anota el valor con ptime 60.

### Costo cero para quien no participa (H6)

23. Con el módulo prendido, abrir la sala **no descarga** `mediasoup-client.bundle.js` ni abre
    el WebSocket. Se descarga al primer toque de Escuchar o Hablar.
24. El alumno que nunca toca Escuchar **no genera ni un byte** de media.
25. El alumno que escucha y nunca pulsa **no crea transporte de envío**.

### UI

26. El alumno con `vozAbierta: false` no ve el botón de pulsar para hablar; al abrirse, aparece
    sin recargar (por el WebSocket si está escuchando; por el poll si no).
27. Al pasar a "Solo yo hablo", el micrófono del alumno se libera (`track.stop()`) — la lucecita
    del navegador se apaga.
28. Con la solapa oculta, el audio sigue sonando (RH-8).
29. A 375 px, el botón de pulsar para hablar es alcanzable y se puede mantener apretado (patrones
    de la revisión móvil rol por rol).

### Regresión

30. Las tres suites (`test:unit`, `test:smoke`, `test:roles`) pasan sin tocar casos previos.
31. Con el módulo apagado, la sala es **byte a byte la de hoy**: sin partial, sin estilos, sin
    bundle, y el poll con `transmision: null`.
32. La asistencia de una clase con Hablar da el mismo número que sin él (D8).

---

## Archivos

**Nuevos**: ninguno de código. `specs/sala-hablar.spec.md` (este) y sus tests
(`tests/unit/hablar.test.js`, casos nuevos en los de señalización del SFU).

**Modificados**

| Archivo | Cambio |
|---|---|
| `media/servidor.js` | `hablar`/`callar`, tope, pulsación máxima, `/cerrar-voces`, evento `hablando` |
| `media/aforo.js` | la capa `voz` y `hayLugar` |
| `config/transmision.js` | las constantes de H5 y H4 |
| `config/modulos.js` | el módulo `hablar` (si se aprueba H11) |
| `config/audit-actions.js` | las 4 acciones de H9 |
| `services/transmision.js` | `puedeHablar`, `datosDelTicket`, `abrir` con `soloVoz`, `cambiarVoz` |
| `services/mediaClient.js` | `cerrarVoces(sid)` |
| `models/RoomSession.js` | `soloVoz`, `vozAbierta` |
| `models/Transmision.js` | los campos de H9 |
| `routes/rooms.js` | `abrir` con `soloVoz`, la ruta `/voz`, el poll con `transmision` si está `hablar` o `transmision` |
| `models/School.js` | `modules.hablar` con los mismos tres campos que `transmision` |
| `server.js` | el `deployCmd` recarga también `classroom-media` (R5) |
| `public/js/transmision.js` | pulsar para hablar, `codecOptions`, carga diferida del bundle |
| `views/partials/transmision.ejs` | botón Hablar, interruptor de modo, botón de pulsar, indicador |
| `views/partials/live-room.ejs` | nada o casi nada: el puente con el poll ya existe |
| `agente.md` | changelog y roadmap |

---

## Riesgos

- **R1 — El puerto (H7). Es el único bloqueante.** Todo lo demás es código que ya existe o que
  se prueba en la PC. Esto se resuelve **antes** de escribir una línea.
- **R2 — El síntoma sin síntomas.** Si el puerto está cerrado, todo "anda" y no suena nada. El
  proceso de medios ya se niega a arrancar sin IP anunciable; se suma un **autochequeo en el
  panel del monitor**: una conexión de prueba del propio servidor que diga *"el audio sale / no
  sale"* con `packetsSent` real.
- **R3 — Eco en clases híbridas (el caso normal, H12).** Un alumno del aula que toca Escuchar con
  parlante o pulsa para hablar desde su celular produce acople o voz doble. Mitigación: los avisos
  de H12 y la recomendación de auriculares. No se puede resolver por software; se juzga en la
  Fase 3 con una clase híbrida real.
- **R4 — iOS/Safari y el segundo plano.** Safari puede pausar el audio con la pantalla apagada
  o la app en segundo plano. No se promete escuchar con el celular bloqueado. Se prueba en la
  Fase 3.
- **R5 — El deploy NO recarga el proceso de medios. CONFIRMADO el 2026-09-23.** En el VPS,
  `classroom` está en v1.0.107 y **`classroom-media` en v1.0.98, con 12 días de uptime**: el
  `deployCmd` de `server.js` hace `pm2 reload classroom` y nada más (R2 de la transmisión). Con
  la feature apagada no importaba; con Hablar prendido, cada cambio al SFU quedaría sin
  desplegar y nadie se enteraría. **Entra en la Fase 1**: sumar
  `pm2 reload classroom-media --update-env` al `deployCmd`, con su test. Y como siempre, ese
  arreglo no se aplica a su propio deploy: la primera recarga va a mano.

---

## Fases y esfuerzo

| Fase | Qué entra | Esfuerzo |
|---|---|---|
| **0 — Medir y abrir el camino** | Qué deja pasar DonWeb (abajo), qué sale desde la escuela, pedido al soporte si hace falta, `getStats` con ptime 20 y 60. **Sin tocar la app.** | 1 día + lo que tarde DonWeb |
| **1 — Solo yo hablo** | Botón Hablar, Escuchar, carga diferida, Opus afinado, capa `voz`, módulo `hablar`, avisos de H12 | 1–2 días |
| **2 — Todos pueden hablar** | Pulsar para hablar, tope, pulsación máxima, `cerrarVoces`, indicador | 2–3 días |
| **3 — Una clase de verdad** | Un docente, un curso **híbrido** (alumnos en el aula y en casa), mirando el monitor. Juzgar eco, retraso y claridad | 1 clase |

### La medición de la Fase 0, sin tocar el firewall

`tcpdump` ve los paquetes **antes** de que `ufw` los descarte. Entonces no hace falta abrir nada
para saber si el proveedor los deja pasar:

1. En el VPS: `timeout 60 tcpdump -ni eth0 'portrange 40000-40999'`
2. Desde una PC de afuera, mandar un paquete UDP y abrir una conexión TCP a 40000 y a 40999.
3. Si `tcpdump` los muestra, DonWeb ya los deja pasar. Recién ahí se abren en `ufw`.
4. Repetirlo **desde la red de la escuela** (H7, la otra punta).

### Resultado de la Fase 0 (2026-09-23)

`tcpdump` en el VPS mientras una PC **de otra escuela** (IP `38.51.31.56`) mandaba paquetes. Eso
prueba de paso que desde la red de esa escuela **salen** UDP y TCP a puertos altos:

| Puerto | UDP | TCP (SYN) |
|---|---|---|
| 40000 | ✅ llegó | ✅ llegó |
| 40500 | ✅ llegó | ✅ llegó |
| 40999 | ✅ llegó | (la captura cortó en 30 paquetes) |

**El firewall de DonWeb ya los deja pasar.** Lo que sigue bloqueando es `ufw`, a propósito, hasta
el paso 3. Visto al pasar: a los pocos minutos de abrirse, un escáner de internet ya estaba
probando el 40992 — normal, y es la razón por la que `ufw` se abre recién cuando hace falta.

Estado del VPS en el mismo momento: `classroom-media` online (39,6 MB de RAM), **sin** `RTC_*` ni
`MEDIA_*` en el `.env` (usa los defaults: 4 workers, 40000–40199).

⏳ Falta medir **desde la red de San José**: la PC de la medición estaba en otra escuela.

**Pasos 1 a 4 hechos el 2026-09-23 a las 11:08** (a pedido del usuario): `ufw` con
`40000:40999/udp` y `/tcp` (v4 y v6), `RTC_MAX_PORT=40999` y `MEDIA_WORKERS=1` en el `.env`
(copia previa en `/root/env.antes-de-hablar.bak`), y `classroom-media` reiniciado: pasó de
v1.0.98 a **v1.0.107**, 1 worker con **UDP 40000-40999**, anunciando `138.219.40.80`, 20 MB de
RAM. `/health` del sitio y del proceso de medios, los dos `ok`.

### Pasos del usuario, en orden

1. **Pedirle a DonWeb** UDP y TCP `40000–40999` entrantes hacia `138.219.40.80`.
2. **Confirmar con la medición de arriba** que llegan (desde casa y desde la escuela).
3. En el VPS: `ufw allow 40000:40999/udp`, `ufw allow 40000:40999/tcp`, y en el `.env`
   `RTC_MAX_PORT=40999` y `MEDIA_WORKERS=1`.
4. `pm2 ls` para ver que `classroom-media` está corriendo (R5), y recargarlo para que lea el `.env`.

Hasta el paso 2, nada de esto toca la escuela: el módulo sigue apagado.

---

## Plan de vuelta atrás

*(Pedido del usuario al aprobar la implementación, 2026-09-23: "prevé lo necesario en caso que
tenga que tirar todo para atrás, a una versión que sí funcione".)*

**La versión que funciona es la v1.0.107**, commit **`f7e27b1`** (etiqueta local
`antes-de-hablar`). Es la que está en producción el día que se escribe esto.

### Por qué la vuelta atrás es barata

- **El módulo `hablar` se despliega APAGADO** para todas las escuelas. Con los dos módulos
  apagados, la sala es la de siempre: no se pinta el partial, el poll trae `transmision: null`,
  y ninguna ruta nueva contesta nada distinto de un 403.
- **No hay migración.** Todo lo nuevo en la base son campos con default (`modules.hablar`,
  `transmision.soloVoz/vozAbierta/vozAbiertaAt`, cuatro contadores en `Transmision`). El código
  de la v1.0.107 los ignora al leer. No se borra ni se renombra nada.
- **El cambio son los commits de la rama `feat/hablar`** (`cdbed1c` la feature, `ad8df00` la
  pregunta del panel, más el de esta nota y el `chore: bump`). Revertirlos deja el código idéntico
  al de la v1.0.107.
- Los ajustes del VPS del 23/09 (`ufw` 40000-40999, `RTC_MAX_PORT`, `MEDIA_WORKERS=1`) **no hace
  falta deshacerlos**: la v1.0.107 lee las mismas variables y con el módulo apagado nadie abre
  un puerto.

### Lo único que cambia aun con el módulo apagado

| Qué | Efecto | Riesgo |
|---|---|---|
| El `deployCmd` recarga también `classroom-media` | El proceso de audio queda al día en cada deploy | Si falla, escribe un AVISO y el deploy sigue |
| Dos iconos más en la fuente (`volume_up`, `voice_over_off`) | La URL de Google Fonts cambia: cada navegador la baja una vez | El mismo que cualquier icono nuevo |
| `media/servidor.js` | Gana los mensajes de Hablar | Nadie se conecta con el módulo apagado |

### Los tres escalones, de menor a mayor

**1 · Apagar el módulo (inmediato, sin deploy).** `/superadmin/schools` → editar la escuela →
destildar *Hablar en la sala*. En hasta 45 s (el cache del otro worker) desaparece el botón y
las rutas contestan 403. **Es lo primero ante cualquier problema CON la voz.**

**2 · Revertir el código (si algo falla aun con el módulo apagado).** Desde la carpeta del repo:

```bash
git revert --no-edit f7e27b1..HEAD
git push origin main
```

El webhook despliega solo. El `deployCmd` que corre es el de la versión nueva, que **ya recarga
`classroom-media`**, así que el revert deja los dos procesos con el código anterior. Verificar:
`https://sanjose.escuela.site/health` tiene que dar un número de versión NUEVO (el hook lo sube
igual) con el código de la v1.0.107.

**3 · A mano en el VPS (si el sitio está caído o el webhook no entrega).** Script preparado en el
VPS: `/root/volver-a-1.0.107.sh`. Hace `git reset --hard f7e27b1`, `npm install`, recarga
`classroom` y `classroom-media`, y verifica `/health`. ⚠️ **Después hay que hacer igual el
escalón 2**: el próximo push volvería a desplegar lo que esté en `origin/main`.

## Decisiones que necesita el usuario

1. ✅ **Módulo propio `hablar`** (H11).
2. ✅ **Docente + 2 alumnos a la vez** (H4).
3. ✅ **Pedirle a DonWeb el rango**: UDP y TCP `40000–40999` (H7, camino A).
4. ✅ **En casa y en el aula** (H12).
