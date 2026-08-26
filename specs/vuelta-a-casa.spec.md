# Vuelta a Casa — acompañamiento del regreso

Estado: **propuesta** (2026-08-25) · Módulo: `acompaniamiento` · Segundo módulo OPCIONAL por escuela

> ⚠️ Esta spec **no está aprobada ni implementada**. Es el paso "arquitecto" del flujo SDD: hay
> preguntas abiertas al final que decide el usuario, no el código.

## Problema

El alumno sale de la escuela a las 19:00 en junio, de noche, y camina veinte cuadras. Hoy la
plataforma no sabe nada de eso. El que se siente inseguro le escribe por WhatsApp a un docente —
si tiene el número, si el docente lo tiene agendado, si contesta— y el que no tiene a quién
escribirle no le escribe a nadie. Nadie en la escuela se entera de si llegó.

Es un vínculo que ya existe informalmente y que la escuela sostiene con celulares personales,
grupos de WhatsApp y buena voluntad. Lo que falta no es la voluntad: es que quede **abierto,
visible para varios y con constancia**, en vez de repartido en chats privados.

## Alcance

1. **Consentimiento** de la familia, cargado por preceptoría. Sin él, el botón no existe.
2. El alumno abre una **línea**: "voy para casa, acompáñenme". Siempre la abre él.
3. Su navegador **reporta su posición** mientras la pantalla esté encendida y la pestaña abierta.
4. **Panel de guardia**: las líneas abiertas de la escuela, con mapa, recorrido y chat.
5. Los custodios **se suman** a una línea y el alumno **ve quién lo está acompañando**.
6. **Llegué** — lo marca el alumno; el custodio puede cerrarla por él.
7. **Alarma por silencio**: si dejan de llegar puntos, la línea grita. Es la función principal.
8. **Red de custodia entre escuelas** (Fase 2, ver D7): custodios de otra escuela con acuerdo.
9. **Purga automática** del recorrido a los 30 días.

### Fuera de alcance (decidido, no olvidado)

- **App nativa / notificación push.** El proyecto no tiene service worker ni web-push (verificado).
  Todo el aviso es dentro de la aplicación abierta. Es la limitación que ordena el diseño (D1).
- **Avisar a la familia.** Sin push y sin SMS, no hay canal. Que la familia vea la línea implicaría
  cuentas de familias, que hoy no existen (`User.role` no tiene `tutor`).
- **Botón de pánico / llamada al 911.** Es otra función, con otra responsabilidad legal, y
  mezclarla acá haría que esta prometa algo que no puede cumplir.
- **Geocercas, rutas sugeridas, "camino habitual", detección de desvío.** Perfilan al alumno.
- **Guardar la dirección de casa.** El destino es un punto que el alumno marca en el mapa, se usa
  solo para el radio de llegada, y se borra con la línea. Ver D8.
- **Historial navegable de recorridos.** Se puede ver una línea de los últimos 30 días desde
  auditoría con motivo; no hay pantalla de "por dónde anduvo Fulano".

---

## Decisiones de diseño

### D1 — El navegador NO es un rastreador, y es la decisión que ordena todo lo demás

`navigator.geolocation.watchPosition()` **se detiene** cuando la pantalla se apaga o la pestaña
pasa a segundo plano, en iOS y en Android. No es un bug a esquivar: es el sistema operativo
defendiendo la batería y la privacidad, y no hay forma de evitarlo desde una web.

Consecuencia: **es imposible prometer "te seguimos hasta que llegues"**. Y una función que lo
promete y se corta en silencio es peor que no tenerla, porque el custodio deja de mirar creyendo
que el sistema mira por él.

Entonces se invierte la promesa: **el evento no es el punto que llega, es el punto que no llegó.**

- La línea no vale por el mapa. Vale por la alarma.
- La pantalla del alumno dice, con todas las letras, que tiene que quedar abierta.
- Se usa **Wake Lock API** para mantener la pantalla encendida, y se asume que va a fallar
  (Chrome Android sí, Safari iOS 16.4+, el resto no). Es una mejora, nunca una garantía.
- Se llama **acompañamiento**, no rastreo ni seguimiento. El nombre es parte de la spec.

### D2 — Es la sala en vivo de la vereda: se reusa su transporte, no se inventa uno

El proyecto **no tiene SSE ni WebSockets** (verificado: cero `EventSource`, cero `text/event-stream`,
cero `socket.io`). Todo lo en vivo es polling con cursor `since=seq` contra `RoomSession.lastSeq`,
que se incrementa con un `$inc` atómico porque hay **dos workers de PM2**. Ese patrón ya está
probado en producción y esta función lo copia entero.

Lo que **no** se copia son los tiempos, y por un motivo que no es de servidor:

| | Sala en vivo | Vuelta a casa | Por qué |
|---|---|---|---|
| poll del que mira | 4 s | **10 s** | nadie cruza una calle en 4 segundos |
| reporte del alumno | 4 s (latido) | **20 s** | es su batería y **son sus datos móviles** |
| autocierre | 30 min | **3 h** | una vuelta a casa larga no es una sala olvidada |
| silencio → alarma | — | **3 min** | 9 reportes perdidos seguidos ya no es un semáforo |

El alumno **acumula puntos y los manda de a varios** (`POST /vuelta/:id/puntos` con un array): si
se corta el 4G media cuadra, al volver la señal el recorrido se completa solo en vez de quedar con
un agujero que parece un desvío.

### D3 — El recorrido es una colección aparte, append-only y con TTL

Dos horas de caminata a un punto cada 20 s son **360 puntos**. Embebidos en el documento de la
línea, cada poll de cada custodio releería los 360 para enterarse de uno.

`AcompPunto` es una colección propia con `{ acompaniamiento, seq, lat, lng, accuracy, at }`, índice
`{ acompaniamiento: 1, seq: 1 }`, y **TTL de 30 días** (`expires`, como `models/RateLimitSample.js`,
el único precedente del proyecto). El poll trae solo `seq > since`: el mapa dibuja el tramo nuevo.

**El TTL es una decisión de privacidad, no de disco.** Mongo lo borra solo; no depende de que
alguien se acuerde de correr una limpieza. La línea (quién, cuándo, cómo terminó) **sobrevive** al
recorrido: a los 31 días queda "el 3 de junio Fulano volvió acompañado y llegó bien", sin el mapa.

### D4 — Quién mira, y por qué el alumno lo sabe

Ver una línea **no** es un permiso de rol: es ser custodio de esa línea. Tres condiciones, y las
tres, fail-closed:

1. Rol de personal (`teacher`, `preceptor`, `directivo`, `jefe`, `soe`, `admin`) **de la escuela del
   alumno** — o custodio externo con acuerdo vigente (D7).
2. Marcado como **custodio** por la escuela (`User.custodio`), que es un opt-in del adulto y no una
   consecuencia automática de ser docente.
3. La línea está **abierta** o `sin_senal`. Cerrada, ya no se ve el mapa.

Y una inversión deliberada respecto de la sala en vivo: **acá el observado ve a los observadores.**

En la sala, `room.observe` es el ingreso silencioso del directivo, y es correcto porque ahí se
supervisa el trabajo de un adulto. Acá el observado es un chico caminando solo de noche, y el
sentido entero de la función es que sepa quién lo está acompañando — su tarjeta lista los nombres y
las caras, y ese listado **es** el producto: eso es lo que lo hace sentirse acompañado. Una línea
que mira gente anónima es vigilancia; una donde ve tres caras conocidas es comunidad.

Entrar a una línea **se audita igual** (`escort.watch`), porque el rastro no es para el chico: es
para la institución, el día que haya que reconstruir quién vio qué.

### D5 — Doble llave: la escuela prende, la familia autoriza, el alumno abre

Tres candados en serie, y ninguno alcanza solo:

| llave | quién | dónde |
|---|---|---|
| el módulo | **superadmin** | `School.modules.acompaniamiento` |
| el consentimiento | **preceptoría**, con el papel firmado | `CustodiaConsentimiento` |
| la línea | **el alumno**, cada vez | `POST /vuelta/iniciar` |

La tercera es la que importa: **no existe ninguna ruta que abra un acompañamiento sobre otra
persona.** Ni el admin, ni el directivo, ni el superadmin. Un adulto no puede pedir la ubicación de
un alumno desde ningún lado de la plataforma, y eso tiene que seguir siendo cierto después de cada
cambio — es CA-19, un test, no una promesa.

El consentimiento se carga **por alumno** y guarda `{ alumno, otorgadoPor, fecha, vence, revocadoAt }`.
Revocarlo **no borra** el historial y **sí** corta las líneas abiertas.

### D6 — Máquina de estados: el silencio es un estado, no una ausencia

```
        abierta ──3 min sin punto──> sin_senal ──vuelve un punto──> abierta
           │                             │
           │ "llegué" / cierra el staff  │ cierra el staff
           v                             v
      llego / cerrada_staff         cerrada_staff
           │
           └── 3 h sin cerrar ──> vencida
```

`sin_senal` **no cierra la línea**: la pone roja arriba de todo en el panel y suena. Que se apagó el
celular y que pasó algo se ven exactamente igual desde acá, y por eso la respuesta es la misma —
que un humano mire.

⚠️ **El barrido no puede ser solo perezoso.** `services/liveRoom.js` cierra las salas vencidas al
entrar al panel, sin `setInterval` (con 2 workers un timer correría dos veces), y eso ya causó el
bug de las salas fantasma. Acá es peor: una alarma que solo suena si alguien ya está mirando **no
es una alarma**. Van las dos mitades:

- el barrido perezoso en el poll del panel de guardia — el caso normal, porque una línea abierta
  implica custodios con la pantalla puesta;
- `POST /guardia/barrido` con token, para el **cron de producción**, que es la red que atrapa el
  caso "el último custodio cerró el navegador". Mismo lugar donde ya vive el cron del guardián del
  Funnel.

### D7 — La red entre escuelas (Fase 2): rompe el multi-tenant, así que se rompe a propósito

Todo el sistema asume **una escuela por usuario**: `res.locals.school`, los `.find({ school })`, el
alcance del preceptor, `sectionGuard`, `requireModulo`. Un docente de otra escuela mirando a un
alumno de la 4118 no entra por ninguna de esas puertas — y **hacerle un agujero a esas puertas para
que entre es exactamente el tipo de cambio que rompe cosas lejos de donde se escribió.**

Por eso no se toca nada de eso. La custodia externa entra por una puerta **propia**:

```
AcuerdoCustodia { escuelaA, escuelaB, estado, aprobadoPorA, aprobadoPorB, vence }
```

- Lo proponen las dos escuelas y **lo aprueban las dos**. Una sola no alcanza.
- **Vence** (12 meses sugeridos). Un acuerdo que no vence es un permiso que nadie revisa nunca.
- El custodio externo es un usuario de B con `custodio: true`, habilitado por **su propia escuela**.
- Router propio (`routes/custodia.js`) con `requireCustodioExterno`, montado **fuera** de `/admin` y
  de `/app`, que no pasa por `sectionGuard` ni lee `res.locals.school` para autorizar.
- Ve **solo**: nombre de pila del alumno, mapa, recorrido y chat de la línea, mientras esté abierta.
  Nunca el legajo, ni el curso, ni las notas, ni el resto de la escuela. Es una lista blanca de
  campos en el service, no un `.select()` en la ruta — así el campo nuevo que alguien agregue el año
  que viene **no** se filtra solo.

**Va en Fase 2, después de que Fase 1 esté andando en producción.** No por tamaño: porque el modo
de fallar de esta mitad es "un adulto de otra institución vio a un menor que no le correspondía", y
ese error no se descubre con un test — se descubre cuando ya pasó. Conviene que llegue a un sistema
que ya funciona, no a uno que se está estrenando.

### D8 — Qué se guarda de la posición, y qué no

| se guarda | no se guarda |
|---|---|
| `lat`/`lng` a **5 decimales** (~1,1 m) | la dirección de casa |
| `accuracy` en metros | el barrio, el nombre de la calle |
| `at` (instante del **dispositivo**) | nada del acelerómetro, la batería o la red |

- **5 decimales, no menos.** El objetivo es ver en qué esquina está; a 3 decimales (~110 m) la
  esquina se pierde y el mapa deja de servir para lo único que sirve.
- Un punto con `accuracy > 200 m` **se descarta**: es la posición por antena, y dibuja saltos de
  diez cuadras que parecen un secuestro y son un semáforo. Se descarta callado, no rompe el lote.
- El **destino** es un punto que el alumno marca en el mapa al abrir, opcional, y **se borra con el
  TTL** junto con el recorrido. No es una dirección, no se autocompleta, no se geocodifica.
- Entrar en el radio del destino (**150 m**) **no cierra la línea**: pregunta "¿llegaste?". Cerrar
  solo por coordenadas es cómo un sistema decide que un chico llegó cuando pasó por la esquina.

### D9 — El mapa: Leaflet local, y una pantalla que funciona sin mapa

`helmet` tiene el CSP **apagado** (`server.js:98`), así que técnicamente entraría un CDN. No va por
CDN igual: la escuela ya tiene historial de caídas de conectividad, y el día que el CDN no cargue la
pantalla que no anda es justo la del chico volviendo de noche. **Leaflet servido desde
`public/vendor/leaflet/`**, como parte del repo.

Las **tiles** sí son un pedido a un tercero (OpenStreetMap), desde el navegador del custodio. Dos
cosas: la política de uso de OSM no contempla volumen de producción (hay que mirar un proveedor con
key si esto crece), y ese pedido le cuenta a un tercero que alguien está mirando ese pedazo de
ciudad. No lleva ningún dato del alumno, pero conviene saberlo antes que después.

Y el fallback importa más que el mapa: sin tiles, la pantalla muestra **última posición, hace cuánto
llegó, a qué distancia del destino y el chat**. Con eso ya se acompaña.

### D10 — Fecha y hora

Regla de la casa, sin excepción: **`fmt` de `services/liveRoom.js` en el servidor, `Fecha` en el
navegador, nunca `toLocaleString`**. Producción corre en **UTC** y "hace 3 minutos" mal calculado es,
en esta función, la diferencia entre una alarma y una alarma tarde.

⚠️ El `at` del punto viene del **dispositivo del alumno**, cuyo reloj puede estar corrido. Para
dibujar el recorrido se usa `at`; para **decidir el silencio** se usa el instante en que el servidor
recibió el lote. El reloj de un celular no puede apagar una alarma.

---

## Modelo

```
Acompaniamiento         alumno, school, estado, abiertaAt, cerradaAt, cerradaPor, motivoCierre,
                        destinoLat, destinoLng, lastSeq, lastPuntoAt, custodios[]
AcompPunto              acompaniamiento, seq, lat, lng, accuracy, at      ← TTL 30 días
AcompMensaje            acompaniamiento, seq, autor, autorNombre, autorRol, texto, at
CustodiaConsentimiento  alumno, school, otorgadoPor, fecha, vence, revocadoAt, nota
AcuerdoCustodia         escuelaA, escuelaB, estado, aprobadoPorA/B, vence  ← Fase 2
User.custodio           Boolean                                           ← opt-in del adulto
School.modules.acompaniamiento.enabled
```

**Índices**: `{ school: 1, estado: 1, lastPuntoAt: -1 }` (el panel de guardia),
`{ alumno: 1, abiertaAt: -1 }` (sus líneas), `{ acompaniamiento: 1, seq: 1 }` (poll de puntos),
y **un índice único parcial que impide dos líneas abiertas del mismo alumno**:

```js
{ alumno: 1 }, { unique: true, partialFilterExpression: { estado: { $in: ['abierta', 'sin_senal'] } } }
```

⚠️ `partialFilterExpression`, **nunca `sparse`** — mismo motivo que en la spec de reservas.

## Pantallas

| ruta | quién | qué |
|---|---|---|
| `/vuelta` | alumno | botón grande, destino opcional, aviso de pantalla abierta |
| `/vuelta/:id` | alumno | mapa chico, **quiénes lo acompañan**, chat, "llegué" |
| `/guardia` | custodio | líneas abiertas; las `sin_senal` arriba y en rojo |
| `/guardia/:id` | custodio | mapa con el recorrido, "sumarme", chat, cerrar |
| `/admin/vuelta` | admin/preceptor | consentimientos, custodios, radio, franja horaria |
| `/superadmin/schools` | superadmin | el interruptor del módulo |

## Criterios de aceptación

Reglas puras en `services/acompaniamiento/{estado,recorrido,custodia}.js`, testeables sin base.

| # | Criterio |
|---|---|
| CA-01 | 3 min sin punto → `sin_senal`; un punto nuevo la devuelve a `abierta` |
| CA-02 | El silencio se mide contra el **reloj del servidor**, no contra el `at` del dispositivo |
| CA-03 | Un `at` del futuro o de ayer no apaga la alarma ni reordena el recorrido |
| CA-04 | 3 h abierta → `vencida`; `llego` y `cerrada_staff` son terminales |
| CA-05 | El barrido cierra vencidas y marca `sin_senal` **sin que nadie mire el panel** |
| CA-06 | Dos barridos simultáneos (2 workers) cierran la línea **una sola vez** |
| CA-07 | Un punto con `accuracy > 200 m` se descarta y no rompe el lote |
| CA-08 | Un lote desordenado o repetido se guarda una sola vez y en orden |
| CA-09 | Las coordenadas se guardan a 5 decimales exactos |
| CA-10 | La distancia al destino cruza el meridiano y el hemisferio sin dar negativo |
| CA-11 | Entrar al radio de 150 m **sugiere** llegar; no cierra nada |
| CA-12 | El poll con `since=seq` trae solo lo posterior; puntos y mensajes comparten el cursor |
| CA-13 | Sin módulo, sin consentimiento o con consentimiento revocado, `/vuelta/iniciar` da 403 |
| CA-14 | Revocar el consentimiento **cierra** las líneas abiertas de ese alumno |
| CA-15 | Un docente **no** marcado custodio no ve `/guardia` ni una línea por URL directa |
| CA-16 | Un custodio de **otra escuela** sin acuerdo vigente recibe 403 (Fase 2) |
| CA-17 | El alumno ve la lista de custodios; sumarse le aparece en el siguiente poll |
| CA-18 | Entrar a una línea deja `escort.watch` en auditoría |
| CA-19 | **No existe ninguna ruta que abra un acompañamiento sobre otro usuario** — barrido de rutas |
| CA-20 | Un alumno no puede tener dos líneas abiertas (el índice parcial rebota la segunda) |
| CA-21 | Un alumno no ve ni un punto de la línea de otro alumno |
| CA-22 | A los 30 días el recorrido no está y la línea sí |
| CA-23 | Las horas mostradas usan `fmt`/`Fecha`; ninguna `toLocaleString` en el diff |

⚠️ **CA-06 y CA-20 van con `Promise.all`, no en secuencia.** Un test secuencial pasa igual con la
versión ingenua y no mide nada — mismo aprendizaje que CA-17 de reservas.

⚠️ **CA-19 se escribe con el grep bueno de rutas** (`memory/grep_rutas_dos_routers.md`): un archivo
puede declarar dos routers y el grep ingenuo se saltea la mitad. Es justo el test que no puede
tener falsos negativos.

### Matriz de roles

| rol | `/vuelta` | `/guardia` | `/admin/vuelta` |
|---|---|---|---|
| `student` | ✅ con consentimiento | ❌ | ❌ |
| `teacher`, `jefe`, `soe` | ❌ | ✅ si `custodio` | ❌ |
| `preceptor` | ❌ | ✅ si `custodio` | ✅ consentimientos |
| `directivo` | ❌ | ✅ si `custodio` | ✅ lectura |
| `admin` | ❌ | ✅ si `custodio` | ✅ |
| `superadmin` | ❌ | ❌ (sin escuela) | ❌ — vía impersonación |

## Archivos

**Nuevos**: `models/{Acompaniamiento,AcompPunto,AcompMensaje,CustodiaConsentimiento}.js` ·
`services/acompaniamiento/{estado,recorrido,custodia,barrido}.js` ·
`routes/{vuelta,guardia}.js` · `views/vuelta/*` · `views/guardia/*` · `views/admin/vuelta/*` ·
`public/js/acompaniamiento.js` · `public/vendor/leaflet/*` ·
`tests/unit/{acompEstado,acompRecorrido,acompCustodia}.test.js`

**Modificados**: `config/modulos.js` (el módulo) · `config/sections.js` (3 solapas) ·
`config/audit-actions.js` (categoría `custodia`) · `models/{School,User}.js` ·
`server.js` (`.select()`, `res.locals`, montaje) · `views/partials/{admin-nav,header}.ejs` ·
`tests/roles/check-roles.js` · `tests/smoke/specs.js`

## Cosas a tener en cuenta

- **Geolocalización exige HTTPS.** Producción va por Funnel con TLS, así que anda; **en local por
  `http://localhost` también** (es origen seguro), pero por IP de la LAN **no**. Probarlo desde el
  celular contra la IP de la máquina va a fallar sin que el código tenga nada malo.
- **`modules` tiene que estar en el `.select()` de `server.js`**, o `moduloActivo()` lee `undefined`,
  contesta que no —es fail-closed— y el módulo queda invisible. Mismo caveat que reservas.
- **El doc de escuela va cacheado 45 s por worker**: prender el módulo y no verlo al instante es lo
  esperado.
- **El permiso del navegador se pide una sola vez y si lo niegan queda negado.** La pantalla tiene
  que explicar *antes* de pedirlo, o el alumno aprieta "Bloquear" por reflejo y después hay que
  enseñarle a desbloquearlo desde la configuración del navegador.
- **Consume datos móviles del alumno.** Un punto cada 20 s durante 40 min son ~120 pedidos; con el
  lote de D2 son unos 40. Vale decirlo en la pantalla: hay alumnos contando megas.
- **Ley 25.326 de Protección de Datos Personales.** La geolocalización de menores es dato sensible.
  El consentimiento en papel de D5 existe por esto, y conviene que lo mire quien corresponda en la
  escuela antes de prender el módulo en producción. No bloquea escribir el código; sí bloquea
  prenderlo.

## Preguntas abiertas — las decide el usuario

1. **¿Fase 2 (otras escuelas) va?** Y si va, ¿con qué escuelas concretas y quién firma el acuerdo?
2. **¿Quién carga el consentimiento** — preceptoría, admin o dirección? ¿Vence al año?
3. **¿Franja horaria?** ¿Se puede abrir una línea a cualquier hora y cualquier día, o solo días de
   clase entre las 11:00 y las 23:00? (Un límite hace que la función sea "volver de la escuela" y
   no "que la escuela sepa dónde estoy el domingo".)
4. **¿30 días de recorrido está bien**, o la escuela prefiere 7?
5. **¿El alumno elige a quién avisa**, o la línea la ven todos los custodios de la escuela?
6. **¿Nombre visible?** "Vuelta a casa" es la propuesta.
