# Monitor de la sala en vivo: qué cuesta y qué palanca lo está sosteniendo

Estado: **DISEÑO, sin aprobar** (2026-09-08) · Módulo: `superadmin` + `rooms` ·
Rol: superadmin

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
