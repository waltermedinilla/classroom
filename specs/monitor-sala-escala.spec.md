# Monitor de la sala en vivo: qué cuesta y qué palanca lo está sosteniendo

Estado: **IMPLEMENTADA** (2026-09-08) · Módulo: `superadmin` + `rooms` · Rol: superadmin

> El generador de carga local (`tools/carga-salas.js`) quedó **sin hacer**, por decisión del
> usuario: el panel con datos reales alcanza para vigilar y para decidir. Se hace el día que
> haya que contestar "¿aguanta el doble?", y para entonces el panel ya da la línea de base.

## Problema

Palabras del usuario:

> *"crea una herramienta que pueda medir cómo se comporta el servidor por la cantidad de salas
> de chat abiertas que tiene y cómo influye cada una de las herramientas que usaste para
> hacerlo... quiero poder ver qué es lo que está interfiriendo y que vos también tengas una
> medición clara si hay que rediseñar y planificar nuevamente la spec"*

Hoy la sala tiene **cuatro palancas** puestas (RN-1, RN-2, RN-4 en producción; RN-3 pendiente) y
**ninguna forma de saber si siguen funcionando**. Todos los números que hay —11,4 ms, 4.981
bytes, 2,6 núcleos— salieron de mediciones a mano, en la máquina de desarrollo, un día puntual.

Eso alcanza para decidir un cambio. **No alcanza para dos cosas que vienen después:**

1. **Detectar que una palanca dejó de funcionar.** Si mañana alguien agrega un `populate` en el
   poll, o rompe la invalidación del cache, o un `.lean()` de más deja la huella de presencia
   siempre distinta, la sala **sigue andando** y nadie se entera hasta que la escuela se queja.
2. **Decidir si hay que rediseñar.** La pregunta "¿aguanta 40 salas?" hoy se contesta con una
   regla de tres sobre una medición vieja.

## ⭐ La pregunta que esta herramienta tiene que contestar

> **"Con N salas abiertas, ¿cuánto cuesta un poll, y cuál de las cuatro palancas está
> sosteniendo ese número?"**

Todo lo que no ayude a contestar eso queda afuera.

---

## Qué se mide: el poll, porque es la única ruta caliente

La unidad es **un poll**. Todo lo demás de la sala (abrir, cerrar, escribir, subir) pasa unas
pocas veces por clase; el poll pasa 15 veces por minuto y por persona.

Por cada poll se acumulan en memoria, sin tocar la base:

| Contador | Qué dice |
|---|---|
| `polls` | Cuántos hubo |
| `ms` (suma) | Tiempo total dentro del handler |
| `bytes` (suma) | Peso de las respuestas |
| `cacheAciertos` / `cacheFallos` | **RN-1**: ¿el curso salió del cache? |
| `presenciaOmitida` / `presenciaEnviada` | **RN-2**: ¿viajaron las listas? |
| `presenciaNoEscrita` / `presenciaEscrita` | **RN-3**: ¿se escribió el ping? |

Y una vez por minuto, un solo worker muestrea el contexto:

| Muestra | Cómo |
|---|---|
| `salasAbiertas` | `RoomSession.countDocuments({ closedAt: null })` |
| `personasEnSalas` | `RoomPresence.countDocuments({ lastPingAt: { $gte: hace 45 s } })` |

---

## ⭐ El corazón: cómo se atribuye el efecto de cada palanca

Ésta es la parte que hace falta pensar, y la razón por la que esto es un diseño y no una tarea.

**Una palanca que está prendida no se puede medir apagándola** — eso sería degradar producción a
propósito. Lo que sí se puede es **contar lo que evitó**, porque en cada poll la decisión ya se
toma y solo hay que sumarla:

| Palanca | Lo que se cuenta | Lo que se ahorró, con el costo unitario medido hoy |
|---|---|---|
| **RN-1** cache del curso | `cacheAciertos` | × **4 queries** y × **11,4 ms** |
| **RN-2** huella de presencia | `presenciaOmitida` | × **~3.500 bytes** |
| **RN-3** ventana de presencia | `presenciaNoEscrita` | × **1 escritura** |
| **RN-4** cadencia adaptativa | polls reales vs. los que habría a 4 s fijos | × todo lo de arriba |

⚠️ **Los costos unitarios son constantes medidas, no cosas que la app remida en vivo.** Viven en
un solo lugar, con la fecha de medición al lado, y la pantalla dice *"estimado sobre la medición
del 08/09"*. Fingir precisión acá sería peor que no medir: el número honesto es un orden de
magnitud, y sirve igual.

**RN-4 es la única que se infiere y no se cuenta**, porque la decide el navegador. Se deriva:

```
polls esperados a ritmo fijo = personasEnSalas × 60/4 s
ahorro de RN-4               = 1 − (polls reales / polls esperados)
```

Con todo el mundo en silencio eso debería dar ~50%. **Si da 0%, RN-4 no está llegando a los
navegadores** — que es exactamente la clase de cosa que hoy no se vería.

### Qué se lee cuando algo se rompe

Este es el valor real de la herramienta, y conviene escribirlo antes de construirla:

| Síntoma en el panel | Qué se rompió |
|---|---|
| `cacheAciertos` cae a ~0 | RN-1: alguien invalida de más, o el TTL quedó en 0 |
| `presenciaOmitida` cae a ~0 | RN-2: la huella cambia siempre — un campo no determinista en el bloque |
| `presenciaNoEscrita` cae a ~0 | RN-3: la ventana no está frenando nada |
| Ahorro de RN-4 en 0% | El `salaPoll.js` que llega al navegador es viejo, o el ritmo no se aplica |
| `ms` por poll sube y el cache sigue alto | **Apareció una query nueva en el poll** |
| `bytes` por poll sube con presencia omitida alta | Creció otra parte de la respuesta (mensajes, transmisión) |

---

## ⭐⭐ La otra mitad: medir los SÍNTOMAS, no solo el costo

Agregado el 2026-09-08 a pedido del usuario:

> *"que puedas medir a ciencia cierta cómo se comporta la spec de las salas, cosa que si hay
> algún inconveniente en cuestión de tiempo o que no se leen los mensajes puedas identificarlo
> rápidamente"*

Los contadores de arriba dicen **cuánto cuesta** la sala. No dicen **si anda**. Son preguntas
distintas: la mañana del 08/09 la sala estaba baratísima —no pintaba nada, así que no gastaba
nada— y estaba rota. Un panel que solo mire el costo habría dado todo verde.

Los dos síntomas que el usuario reporta cuando algo falla son siempre los mismos, y hay que
medir esos dos:

### 1. "Tarda" — el tiempo de entrega de un mensaje

Cuando el poll serializa un mensaje ya tiene su `createdAt` a mano. La resta contra el momento
de la entrega es, literalmente, **cuánto esperó ese mensaje para llegarle a esa persona**:

```
entregaMs = ahora − mensaje.createdAt
```

Se acumulan p50 y p95. Es una resta por mensaje **entregado**, no por poll: los mensajes son
raros comparados con los polls, así que no cuesta nada.

⚠️ **Qué mide y qué no**: mide de la base al navegador, o sea el poll y la cadencia. **No** mide
el pintado ni el viaje de vuelta. Un p95 de ~8 s es lo NORMAL con RN-4 aflojando — el número a
mirar no es el valor absoluto sino que se mantenga estable.

### 2. ⭐ "No se leen los mensajes" — el cursor que no avanza

Éste es el que hubiera cazado el bug de hoy a la mañana, y sale gratis: en cada poll el servidor
ya sabe dos cosas, el `since` que trae el navegador y el `lastSeq` de la sesión.

```
atraso = lastSeq − since
```

En una sala sana el atraso es 0 casi siempre, y salta a 1 o 2 por un instante entre que alguien
escribe y el poll siguiente lo trae. **Un atraso que crece y no vuelve a bajar significa que los
navegadores no están avanzando el cursor**: reciben y no pintan, o descartan. Que es exactamente
lo que pasaba esta mañana.

Se acumulan `pollsAtrasados` (los que llegan con `since < lastSeq`) y `atrasoMax` (el peor caso
del minuto, en cantidad de mensajes).

### La tabla de diagnóstico de los síntomas

| Lo que se ve | Qué está pasando |
|---|---|
| p95 de entrega ~8 s, estable | **Normal.** Es RN-4 aflojando en una sala en silencio |
| p95 de entrega ≫ 8 s | La red del aula, o el poll tardando: mirar también `ms` por poll |
| `atrasoMax` crece y no baja | ⭐ **El congelamiento.** Los navegadores no avanzan el cursor |
| `pollsAtrasados` alto con p95 normal | Ráfaga: mucha gente escribiendo a la vez. No es una falla |
| Todo en cero y `polls` en cero | No hay nadie en ninguna sala. Es un dato, no un problema |

⚠️ **`atrasoMax` es el número que hay que mirar primero ante un "no me llegan los mensajes".**
Los demás dicen cuánto cuesta la sala; éste dice si la sala **funciona**.

---

## Los dos ejes, y por qué hacen falta los dos

**Eje 1 — el tiempo.** La serie de siempre: salas abiertas, polls/s, ms por poll, bytes por
poll. Contesta *"¿qué pasó hoy a las 10:15?"*.

**Eje 2 — ⭐ contra la cantidad de salas.** El mismo dato, pero con las salas abiertas en el eje
X en vez del tiempo. Contesta la pregunta del usuario:

> *"¿el costo por poll se mantiene plano a medida que suben las salas, o se dobla para arriba?"*

**Plano = escala. Curvado hacia arriba = hay algo superlineal y la spec necesita otra vuelta.**
Es el único gráfico que puede decir "hay que rediseñar" antes de que se note en el aula.

---

## Dónde vive: el patrón que ya existe

**Se copia `services/rateLimitStats.js`, no se inventa nada.** Ese módulo ya resolvió los tres
problemas difíciles y están documentados ahí:

- Acumular en memoria y volcar a Mongo **una vez por minuto** (no una escritura por evento).
- **El `pid` en la clave**: en cluster los dos workers cuentan por separado, y el endpoint los
  **suma** al leer. Sin eso, el gráfico depende de a qué worker le tocó el refresco.
- Rangos con bucket creciente (1h/6h/24h/7d) para no mandarle 10.080 puntos al navegador.

Archivos nuevos, todos calcados de sus equivalentes:

```
services/salaStats.js        ← services/rateLimitStats.js
models/SalaSample.js         ← models/RateLimitSample.js
public/js/sala-chart.js      ← public/js/ratelimit-chart.js
```
Más una sección en `views/superadmin/monitor.ejs` y una ruta
`GET /superadmin/monitor/sala?rango=`.

### ⚠️ La regla de oro, heredada

> *"Esto es telemetría. Si algo falla acá, se descarta la muestra y la aplicación sigue. Nada de
> lo que pasa en este módulo puede tumbar un request."*

En el poll eso es literal: los contadores son `++` sobre enteros en memoria, sin `try` que
pueda fallar, sin await, sin nada que pueda lanzar.

### ⚠️⚠️ Que la telemetría no se vuelva la carga

Es el riesgo más obvio de una herramienta que mide una ruta caliente, y hay que escribirlo:

- **En el poll**: solo incrementos de enteros y **un** par de `process.hrtime`. Cero I/O, cero
  objetos nuevos, cero JSON. Presupuesto: **por debajo de 0,05 ms**, o sea menos del 1% de lo
  que ya cuesta un poll hoy.
- **El muestreo de salas abiertas**: dos `countDocuments` por minuto, y **solo en el worker 0**
  (mismo criterio que el promotor de mantenimiento en `server.js`). Son 2 queries por minuto
  contra las ~7.200 que hace la sala en ese mismo minuto.
- **El volcado**: un upsert por worker por minuto.

Criterio de aceptación: **con la herramienta prendida, el `ms` por poll medido tiene que estar
dentro del ruido del medido sin ella.**

---

## La pantalla

Sección nueva **"Sala en vivo"** en `/superadmin/monitor`, debajo de "Rate limit", con la misma
estructura visual.

**Tarjetas** (el ahora):

```
Salas abiertas    Personas en sala    Polls/min    ms por poll    KB por poll
      12                 287             1.240        3,4 ms        0,6 KB
```

**Las cuatro palancas**, cada una con su porcentaje de efectividad y lo que ahorró en el rango:

```
RN-1 cache del curso     ████████████████░░  94%    ~41.000 queries · ~7,8 min de CPU
RN-2 huella de presencia ███████████████░░░  89%    ~118 MB
RN-3 ventana de presencia███████████░░░░░░░  72%    ~29.000 escrituras
RN-4 cadencia adaptativa ████████░░░░░░░░░░  46%    ~33.000 requests   (inferido)
```

**Dos gráficos**: la serie temporal, y el de costo contra salas abiertas.

Con el selector de rango 1h / 6h / 24h / 7d, igual que rate limit.

---

## La segunda mitad: medir lo que TODAVÍA NO PASÓ

El panel mide lo que la escuela hace. No puede contestar *"¿aguanta 50 salas?"* porque eso
nunca pasó.

Para eso va una herramienta **aparte y fuera de producción**: `tools/carga-salas.js`, que
simula N salas × M alumnos contra una instancia **local** y reporta el costo por poll a medida
que sube N. Es el eje 2 pero barrido a propósito en vez de esperar a que la escuela lo recorra.

Cierra además el **criterio de aceptación 1 de `sala-en-vivo-escala.spec.md`**, que quedó sin
hacer: *"prueba de carga antes de dar nada por bueno... el 'antes' tiene que reproducir los ~2,6
núcleos"*.

⚠️ **Guardas, no negociables**: se niega a correr si la URL no es local, igual que
`tests/smoke/run.js`; crea sus propias salas y usuarios y **los borra al terminar filtrando por
lo que creó**, nunca por curso ni por escuela.

---

## Lo que NO entra

- **Medir por sala o por persona.** Es un chat de menores: el panel dice cuántas salas y cuánto
  cuestan, no quién escribió. Los agregados no llevan identidad.
- **Instrumentar todas las rutas.** Solo el poll. Lo demás no es caliente y el ruido costaría
  más que el dato.
- **Un tracer por request.** Ya existe el access log con `requestId` para eso.
- **Alertas automáticas.** Primero hay que mirar el gráfico un tiempo y aprender cómo es un día
  normal. Poner umbrales antes de tener una línea de base es inventar el umbral.
- **Guardar para siempre.** Retención de **30 días**, como el resto de la telemetría. Al minuto,
  son ~43.000 documentos por mes entre los dos workers.

---

---

## ⭐⭐⭐ El panel se contradijo a sí mismo (2026-09-11, v1.0.97)

Lo que mostró producción, tal cual, en una sola tarjeta:

> **El proceso está saturado: el event loop se atrasa 338.17 ms**
> De los 59.99 ms del poll, **0.02** son esperando turno y no trabajando. El cuello es CPU, no
> la base: acá no sirve tocar queries ni índices.

⚠️ **Las dos frases se contradicen.** Si solo 0,02 ms son espera, los otros **59,97 son
trabajo** — y el trabajo del poll son consultas a la base. El panel mandaba a buscar CPU justo
cuando sus propios números decían "la base".

### La causa: una rama que no miraba su propia prueba

```js
if (r.loopP99Ms != null && r.loopP99Ms > 50) {        // ← entra solo por el pico
  titulo:  `El proceso está saturado: ...`,
  detalle: `... ${d.resto} son esperando turno ...`   // ← imprime resto sin mirarlo
```

La rama de abajo (`d.resto > mongo`) sí hacía la comparación correcta, pero nunca se alcanzaba.

### ⭐ Y la razón de fondo: dos números que se agregan distinto

| Número | Qué es realmente |
|---|---|
| `loopP99Ms` = 338,17 | El p99 **del peor minuto** del rango. Se agrega con `$max`, y dentro del minuto ya es un p99. Un reinicio o una recolección de basura lo fija para las 24 h enteras |
| `resto` = 0,02 | Un promedio de verdad: `msTotal / polls`, sobre todos los polls del rango |

**Un pico de un minuto se estaba reportando como un estado permanente.** Es la misma clase de
error que el `atrasoMax` del 08/09 —el máximo leído como si fuera la norma— en otro número.

**La regla ahora**: saturación es pico alto **y** polls pagando cola. Con una sola de las dos, es
un pico, y se dice que es un pico.

### ⭐ El pico se informa incluso sin tráfico

Antes, el corte `if (!r.polls) return` lo tapaba. Pero `loopP99Ms` **no es un promedio sobre los
polls**: lo muestrea el worker del scheduler una vez por minuto, haya o no gente. Así que un día
sin nadie —un feriado, un domingo— es justo el que contesta **si el proceso se traba solo**, y es
la única medición que se puede hacer sin aula. Ahora se informa, aclarando que nadie lo pagó.

### El otro arreglo: un mínimo de 200 polls para promediar

El panel afirmaba con un puñado de muestras. El caso que lo destapó: un `pm2 reload` deja el
cache del curso **vacío en los dos workers**, así que los primeros polls son todos fallos; con la
escuela vacía esos polls fríos se quedan con el promedio del rango entero.

200 es bajo a propósito: **una** persona en **una** sala aporta ~900 polls por hora, así que el
piso no puede tapar datos reales — solo el arranque y las visitas de treinta segundos. Por debajo
de eso el panel dice que no alcanza, en vez de concluir.

### Un tercer lugar decía lo mismo mal

La tarjeta del event loop remataba con `⚠️ el proceso tiene cola` **con la misma condición
suelta**, y rotulaba los dos números como "de media" cuando son del peor minuto. Ahora dice
`event loop, peor minuto: …  ⚠️ hubo un pico`, y no afirma nada sobre cola: eso lo decide el
diagnóstico, que es el único que mira si los polls la están pagando.

**Tests**: 8 casos nuevos, 6 de ellos verificados fallando contra el código viejo.

---

## ⭐⭐ Lo que corrigieron DOS DÍAS de datos reales (2026-09-10)

Reclamo del usuario: *"⚠️ Sube: cada 10 salas más agregan 125 ms al poll. Hay algo superlineal
y la spec necesita otra vuelta — ¿a qué se refiere?"*.

Dos problemas distintos, y el primero es de redacción mía.

### 1. El veredicto atribuía una causa que no puede saber

Decía *"hay algo superlineal"*, que suena a que **la cantidad de salas causa** el aumento. **No
se puede sostener**: "más salas" y "más polls por minuto" suben juntos —son colineales— y
cuando hay más salas la escuela está más activa, o sea que el servidor está más ocupado con
TODO lo demás. El `ms` es tiempo de reloj y se come esa contención venga de donde venga.

El texto ahora **describe la correlación y nombra el confundido**, sin atribuir causa.

### 2. Opinaba sobre nubes sin patrón

El rango de 7 días daba veredicto sobre esto:

```
 7 salas → 934 ms      8 → 469      9 → 314      10 → 182
```

…que va para abajo. Se agregó **R²**: si la recta no describe los puntos, el veredicto es
*"no se puede concluir de este rango"*.

⚠️ **Y ahí apareció una trampa que costó un test**: una curva **de verdad plana tiene R² casi
cero por construcción** —no hay varianza que explicar—, así que el filtro de R² marcaba como
"dispersa" la mejor noticia posible. El orden correcto es mirar primero **cuánto se mueven** los
puntos (`dispersion`): si apenas se mueven, es plano y el R² no viene al caso; si se mueven
mucho, ahí sí importa si una recta lo explica.

### 3. ⭐ Y lo que faltaba de fondo: el desglose del poll

El panel decía "78 ms por poll" y **no había forma de saber a dónde se iban**. Había que
adivinar entre "es Mongo" y "es el proceso saturado", que llevan a arreglos **opuestos**:
índices contra CPU.

Ahora el poll se cronometra por fases y la tarjeta las muestra:

```
sesión 12 · presencia 9 · estado 31 · armar 2 · espera 24  (ms)
event loop, peor minuto: 1,2 ms de media, 8 ms su peor 1%  (holgado)
```

**La suma de las fases NO da el total, y esa diferencia es el dato**: es el tiempo que el
handler pasó esperando para volver de un `await`. Resto alto con base baja = contención.

Y el **retraso del event loop** es el juez: mide cuánto tarda el proceso en atender un timer que
ya debía haber disparado. En el piso, el tiempo del poll es la base; si sube, el poll espera su
turno. El diagnóstico usa las dos cosas y dejó de adivinar:

| Lo que se ve | Qué dice ahora |
|---|---|
| loop p99 alto **y** espera > trabajo | **Alerta**: el proceso está saturado. El cuello es CPU: no sirve tocar queries ni índices |
| loop p99 alto, espera ≈ 0 | Aviso: **hubo un pico** en un minuto suelto. No es el estado del rango — ver la corrección del 11/09 |
| espera > trabajo, loop bien | Aviso: el proceso tiene cola, vigilar si sube el uso |
| trabajo real | Nombra **la fase más cara**: "31 ms se van en armar el estado" |
| menos de 200 polls | **No promedia**: la muestra no alcanza. El pico del loop sí se informa |

---

## ⭐⭐ Lo que corrigieron los primeros datos reales (2026-09-08, v1.0.91)

18 minutos de producción bastaron para encontrar **tres defectos del propio panel**. Ninguno se
podía ver en la máquina de desarrollo, y los tres hacían que la pantalla mintiera. Es la mejor
defensa de por qué esto había que construirlo.

### 1. El "tiempo por poll" medía la red, no el servidor

Decía **137 ms** de promedio; el handler real cuesta ~4. La causa: se medía en
`res.on('finish')`, que dispara cuando la respuesta terminó de **salir por la red** — con 245 ms
hasta Alemania eso mide el viaje. La tarjeta dice "dentro del servidor", así que tiene que medir
eso: ahora se toma **antes de enviar**, y el listener de `finish` desapareció.

### 2. y 3. ⭐ Una reconexión se veía igual que un congelamiento

El panel mostró **"atraso máximo: 101 mensajes"** y **"los mensajes tardan 24 minutos"**. Las
dos cosas eran falsas, y venían del mismo evento: **una persona que se reconectó y se bajó 101
mensajes atrasados de una**.

```
minuto  msjs  entrega-prom  atrasoMax
19:02    101      1438s        101   ← la reconexión
19:03     56        13s          6
19:04     40        40s          4
19:05     21         7s          1   ← bajó solo
```

**Lo que las distingue no es el pico, es la repetición:**

| | Reconexión | Cursor congelado |
|---|---|---|
| Polls muy atrasados | **uno**, y se acabó | **decenas por minuto**, minuto tras minuto |
| Al minuto siguiente | ya está al día | sigue igual o peor |

Las dos correcciones:

- **`pollsMuyAtrasados`** (atraso ≥ 10) además del máximo. El diagnóstico mira el
  **porcentaje**, no el pico: ≥ 2% es alerta, un pico suelto se informa como reconexión.
- **La edad de un mensaje mayor a `ONLINE_WINDOW_MS` no es demora de entrega**: se escribió
  cuando esa persona no estaba conectada, por la definición que usa toda la app. Va a
  `mensajesDeReenganche`, que es un dato aparte y también útil.

### 4. ⭐ "Salas abiertas" contaba salas muertas

Reclamo del usuario: *"¿por qué hay un tope de 6 salas, es correcto esto?"*.

**Tope no era** —es un `countDocuments` sin `limit`, y de hecho bajó a 3 al rato— pero **el
número estaba mal definido**. Se contaba `RoomSession.countDocuments({ closedAt: null })`, o sea
*"sesiones que nadie cerró"*, que no es lo mismo que *"salas con clase en curso"*: el autocierre
(`closeStaleSessions`) **solo corre adentro de `getOpenSessions()`**, que únicamente llaman los
paneles de dirección y preceptoría. Una clase que terminó y a la que nadie volvió queda contada.

La **sospecha** vino de que las dos curvas divergían:

```
minuto   salas  personas
19:00       6        22     ← 3,7 por sala: poquísimo para una clase
19:30       6        19
19:35       4        24
19:55       3        39     ← 13 por sala: eso sí es una clase
```

Las salas bajaban mientras la gente subía.

**Por qué importaba más de lo que parece**: ese número es el **eje X del gráfico de "¿escala?"**.
Con el eje inflado de salas muertas, la curva compara peras con manzanas y no sirve para decidir
un rediseño — que es justo para lo que existe.

**El arreglo**: se cuentan las **sesiones distintas entre las presencias frescas**
(`RoomPresence.distinct('session', { lastPingAt: { $gte: hace 45 s } })`). Una presencia fresca
solo existe si alguien está polleando esa sala ahora mismo.

Y se guarda **además el crudo** (`sesionesSinCerrar`), porque **la diferencia entre los dos es
información**: "3 salas con gente, 6 sin cerrar" avisa que hay 3 colgadas y que el autocierre no
está barriendo. El diagnóstico lo levanta como aviso —no alerta: el servidor está bien, lo que
pasa es que dirección y preceptoría ven clases "en vivo" que no lo están.

#### ⚠️ Y la primera medición con el número corregido NO confirmó la sospecha

```
salas con gente: 5   ·   sesiones sin cerrar: 5   ·   COLGADAS: 0   ·   personas: 42
```

**Cero colgadas.** Las dos cuentas coinciden, así que el 6 de más temprano bien pudo ser real
—seis clases con poca gente cada una, al final de la jornada— y no sesiones muertas. La
divergencia entre las curvas era circunstancial y **no alcanzaba para concluir lo que concluí**.

Lo que el cambio sí compró, y sigue valiendo:

1. **La tarjeta ahora dice lo que mide.** "Sesiones sin cerrar" y "salas con clase" son cosas
   distintas, y el eje X del gráfico de escala necesita la segunda.
2. **Ahora se puede VER si hay colgadas**, en vez de suponerlo. Hoy no hay.

Queda anotado como advertencia sobre el propio panel: **una divergencia entre dos curvas es una
pista, no una conclusión.** Este panel existe justamente para no razonar así.

### 5. El panel no decía desde cuándo tenía datos

Reclamo del usuario: *"no sé desde cuándo es que mide"*. Pedir "24h" con la telemetría
desplegada hacía 18 minutos dibujaba un eje de 24 horas con 18 minutos de datos. Ahora la
tarjeta dice **"Datos desde … · N min de mediciones"** y avisa cuando el rango elegido es más
largo que lo que hay.

---

## Lo que se aprendió construyéndola (2026-09-08)

### ⭐ Medir el peso de una respuesta: dos caminos que NO funcionan

Fue el único problema real de la implementación, y conviene dejarlo escrito porque los dos
atajos obvios fallan **en silencio**, dando un número plausible pero falso:

| Camino | Qué pasa |
|---|---|
| `res.getHeader('Content-Length')` | `compression()` se lo saca a toda respuesta que comprime. La mayoría de los polls reportaba **0**, y el promedio daba **44 bytes** cuando el real eran **570** |
| delta de `res.socket.bytesWritten` | `finish` dispara **antes** de que zlib termine de volcar. También daba casi cero |

**Lo que sí funciona**: serializar el cuerpo a mano (`JSON.stringify`) y mandarlo con
`res.type('json').send(cuerpo)`. **No cuesta nada extra** — es el mismo `stringify` que iba a
hacer `res.json()`, solo movido de lugar para saber el largo.

⚠️ Corolario: **todos los bytes del panel son SIN COMPRIMIR.** Es como el servidor arma la
respuesta; por el cable viaja bastante menos. La pantalla lo dice.

### El costo de la instrumentación, medido

El presupuesto era < 0,05 ms por poll. Medido con 200.000 llamadas:

```
poll típico, sin mensajes          0,000935 ms
poll con 3 mensajes entregados     0,001077 ms   ← peor caso
                                   = 0,03% de lo que ya cuesta un poll (3,4 ms)
buffer tras 50.000 polls: 1 entrada (una por minuto)
```

**50 veces por debajo del presupuesto.** Y a 868 personas la sala hace ~52.000 operaciones de
Mongo por minuto; esto agrega 6.

### Dos guardas del proyecto que atajaron errores míos

Las dos fallaron en la suite antes de que yo notara nada, que es exactamente para lo que están:

1. **`backupCobertura.test.js`**: la colección nueva no estaba ni respaldada ni excluida a
   propósito. Va a `EXCLUIDAS_DEL_BACKUP` — es telemetría regenerable, con TTL de 30 días, y no
   describe a nadie.
2. **`iconos.test.js`**: cinco iconos nuevos (`sync`, `timer`, `schedule_send`,
   `running_with_errors`, `scatter_plot`) no estaban en el recorte de la fuente, y se habrían
   visto como su nombre en inglés al lado del control. Lo arregla `npm run iconos:actualizar`.

---

## Decisiones abiertas (lo que necesito que definas)

1. ⭐ **¿RN-3 antes o después de la herramienta?** Si la herramienta va **primero**, RN-3 queda
   medida antes y después en producción real — que es la única forma de comprobar que las 232
   escrituras/s bajaron de verdad. **Recomiendo la herramienta primero**, aunque sea invertir el
   orden que pediste.
2. **¿Los costos unitarios estimados van en la pantalla?** El panel puede decir "ahorró ~41.000
   queries" (útil, pero es una multiplicación por una constante medida un día) o quedarse en
   "94% de aciertos" (exacto, pero menos elocuente). **Recomiendo mostrar los dos**, con el
   estimado en gris y la fecha de la medición al lado.
3. **¿El gráfico de costo contra salas incluye las horas sin clase?** Con 0 salas abiertas el
   costo por poll no significa nada y ensucia la curva. **Recomiendo filtrar los puntos con
   menos de 3 salas.**
4. **¿`tools/carga-salas.js` entra ahora o queda para cuando haga falta?** Es la mitad más
   grande del trabajo y la que menos se usa: sirve el día que haya que decidir un rediseño.
