# Rate limit en el tiempo — panel del monitor

> **Estado: FASES 1 Y 2 IMPLEMENTADAS** (2026-08-13). La sección está completa: tarjetas,
> gráfico temporal y selector de rango. **D-01 aprobada por el usuario**: se guarda la IP
> del pico de cada minuto. Queda pendiente solo la fase 3 (opcional) y las decisiones
> D-02/D-03/D-04.
>
> Pedido del usuario (2026-08-13): *"una vista para que pueda visualizar a través del tiempo
> el ratelimit usado y el actual"*, al lado de Ancho de banda en `/superadmin/monitor`.
>
> Nace de un caso concreto: ese mismo día el cupo general se agotó corriendo dos suites de
> tests seguidas (429 en la limpieza final) y hubo que subirlo de 1200 a 12000. La pregunta
> que no se pudo contestar con datos fue *"¿qué tan cerca del techo venimos en un día normal
> de clase?"*. Hoy la única huella de un 429 es una línea `warn` en `logs/combined.log`.

## Objetivo

Que el superadmin pueda ver, sin entrar al servidor, **cuánto del cupo del rate limit se
está consumiendo, cómo evolucionó en las últimas horas o días, y cuántas peticiones se
rechazaron con 429**, para decidir con evidencia si el techo actual (12000/15min por IP)
está bien calibrado.

## Responsabilidades

- Recolectar el consumo del `generalLimiter` sin alterar su comportamiento.
- Persistir una serie temporal agregada que sobreviva a los reloads de PM2.
- Exponerla en `GET /superadmin/monitor/ratelimit`.
- Dibujar la sección "Rate limit" en `views/superadmin/monitor.ejs`, debajo de Ancho de banda.

## No responsabilidades

- **No cambia ningún límite** ni la unidad de conteo (sigue por IP; ver el changelog del
  2026-08-13 en `agente.md`).
- **No instrumenta los otros limiters** (`authLimiter`, `uploadLimiter`, y los 5 por usuario
  de `middleware/rate-limits.js`). Solo el general, que es el que se agotó y el que cubre
  toda la navegación. Los demás quedan como extensión natural si el panel resulta útil.
- **No introduce una librería de charting.** El monitor ya dibuja sparklines con
  `<polyline>` a mano (`sparklinePoints`, monitor.ejs:380); esto extiende ese vocabulario.
  Tampoco usa los partials de `directivo-graficos.spec.md`: son de otra audiencia, con
  requisitos de impresión que acá no aplican.
- **No parsea `logs/combined.log`.** Los 429 ya quedan ahí (request-log.js registra todo
  status ≥ 400), pero reconstruir una serie leyendo un archivo sin rotación configurada es
  frágil y caro. Se recolecta en caliente.

## El problema real: 2 workers, 2 contadores

Es lo que hace que esto no sea "leer un número y graficarlo", y condiciona todo el diseño:

1. **`ecosystem.config.js` levanta `instances: 2` en modo cluster.** `express-rate-limit`
   usa `MemoryStore`, que vive **dentro de cada worker**. Hay dos contadores independientes
   para la misma IP.
2. Consecuencia incómoda pero cierta: **el techo efectivo real es ~24000, no 12000.** Una IP
   recibe 429 recién cuando el worker que le tocó agotó *su* cuenta. Esta vista lo va a
   dejar a la vista por primera vez; conviene saberlo antes de mirarla.
3. Consecuencia para el gráfico: `/monitor/stats` cae en un worker u otro por round-robin,
   así que **dos refrescos consecutivos leen contadores distintos**. Graficar el valor crudo
   daría un diente de sierra que no significa nada. Por eso la serie se **agrega sumando los
   pids por minuto**, y no se grafica la lectura instantánea.

La solución de fondo sería un store compartido (Mongo/Redis) para el limiter, que además
haría que 12000 signifique 12000. **Fuera de alcance**: cambia el comportamiento del límite
y agrega una escritura por request. Queda anotado como decisión abierta D-03.

## Entidades / Schema

`models/RateLimitSample.js` — una muestra por minuto y por worker.

| Campo | Tipo | Qué es |
|---|---|---|
| `minuto` | Date | Inicio del minuto, truncado, UTC |
| `pid` | Number | Worker que la escribió (sin esto no se puede sumar sin duplicar) |
| `pasadas` | Number | Requests que el limiter contó y dejó pasar |
| `bloqueadas` | Number | Requests rechazadas con 429 |
| `picoUsado` | Number | Mayor `used` visto en el minuto (qué tan cerca del techo se llegó) |
| `claves` | Number | Claves (IPs) distintas vistas en el minuto |
| `limite` | Number | El `max` vigente. Guardarlo permite dibujar el techo histórico y ver dónde cambió |
| `ventanaMs` | Number | Idem, para que un cambio de ventana no falsee la lectura vieja |
| `createdAt` | Date | Índice **TTL 14 días** |

- Índice único `{ minuto: 1, pid: 1 }` (el upsert idempotente depende de él).
- Volumen: 2 workers × 1440 min = **2880 documentos por día**, ~40k vivos con TTL de 14 días.
  Despreciable al lado de `submissions` o `roommessages`.

## Recolección — `services/rateLimitStats.js`

Contadores en memoria del worker, volcados a Mongo cada 60 s. **Dos puntos de enganche**,
porque uno solo no alcanza:

- `registrarPaso(req)` — middleware liviano montado **inmediatamente después** de
  `generalLimiter` en server.js. Lee `req.rateLimit` (`{ limit, used, remaining, resetTime }`,
  que express-rate-limit v8.5.2 deja seteado) y actualiza `pasadas` y `picoUsado`.
- `registrarBloqueo(req)` — se llama desde el `handler` del limiter. **Es obligatorio que
  sea acá**: cuando el cupo se agota, el limiter responde 429 y *no* llama a `next()`, así
  que ningún middleware posterior ve esas requests. Contarlas desde el middleware daría
  siempre cero, que es justo el número que importa.

Volcado: `setInterval(60_000)` con `.unref()` y upsert `{ minuto, pid }`. Si Mongo está
caído, se descarta la muestra y se sigue: **esto es telemetría, no puede tumbar el server**
(mismo criterio que `disk = null` en `/monitor/stats`).

## Rutas / Contratos

### `GET /superadmin/monitor/ratelimit?rango=1h|6h|24h|7d`

Ya protegida por el `requireSuperadmin` del router. Responde:

```jsonc
{
  "ahora": {                  // Estado de la IP que consulta, en el worker que atendió
    "usado": 143, "restante": 11857, "limite": 12000,
    "resetEnSeg": 512, "pid": 3288
  },
  "serie": [                  // Buckets ya agregados (suma de todos los pids)
    { "t": "2026-08-13T21:00:00Z", "pasadas": 812, "bloqueadas": 0, "picoUsado": 1180 }
  ],
  "resumen": {
    "bloqueadasTotal": 0, "ultimoBloqueo": null,
    "picoMaximo": 1180, "limite": 12000, "workers": 2
  }
}
```

- El **bucket** se agranda con el rango para no mandar 10080 puntos en "7d":
  1h → 1 min · 6h → 5 min · 24h → 15 min · 7d → 1 hora.
- `ahora` sale del `req.rateLimit` del propio request. Es el único dato verdaderamente "en
  vivo" y vale para **la IP desde la que se mira el monitor**, que puede no ser la de la
  escuela. La vista tiene que decirlo con todas las letras.

## Vista

Sección nueva `<div class="section-title">Rate limit</div>` después del bloque de Ancho de
banda (monitor.ejs:197), con la misma `monitor-grid` y las mismas `metric-card`:

1. **Cupo de esta IP** — `usado / limite`, barra con `barColor()` reutilizado, y "se reinicia
   en X min". Es el "actual" del pedido.
2. **Bloqueos (429)** — total del rango y cuándo fue el último. En verde si es 0.
3. **Consumo en el tiempo** (`grid-column: span 2`) — área/línea SVG con la serie, línea
   punteada en el techo, y selector de rango 1h / 6h / 24h / 7d.

Al pie, en `metric-sub`, dos advertencias que sin ellas el número engaña:

- **Qué no se cuenta**: el limiter exime `/css/`, `/js/` y el polling de la sala en vivo
  (server.js:113). El tráfico real es bastante mayor que esta curva.
- **Suma de 2 workers**, cada uno con su propio cupo (ver arriba).

Además: el propio monitor refresca cada 5 s y **ese polling consume del mismo cupo**
(~180 requests por cada 15 min de pestaña abierta, 1,5% del techo). Con el monitor abierto
la curva se auto-infla un poco; conviene decirlo en el mismo lugar.

## Criterios de aceptación

1. Con el server recién levantado y ninguna request, `GET .../ratelimit` responde 200 con
   `serie: []` y `ahora.usado ≥ 1`.
2. Tras N requests, `ahora.usado` crece en N (± el propio polling) y `restante = limite - usado`.
3. Al agotar el cupo, `bloqueadas` del minuto en curso es > 0 **y** `resumen.ultimoBloqueo`
   trae la fecha. (Se verifica con un limiter de `max: 3` en un server de prueba, no
   mandando 12000 requests.)
4. Dos muestras del mismo minuto y el mismo pid **no duplican** documentos (upsert idempotente).
5. Muestras de distinto pid en el mismo minuto **se suman** en un solo punto de la serie.
6. Con Mongo caído, `/monitor/stats` y la página siguen respondiendo; solo falta la serie.
7. Un rol que no es superadmin recibe 403 en el endpoint.
8. La serie respeta el bucket declarado por rango y viene ordenada ascendente por `t`.
9. Un cambio de `max` en server.js queda visible: los puntos viejos conservan su `limite`.

## Tests

- **`tests/unit/rateLimitStats.test.js`** — lo puramente calculable, sin Mongo ni HTTP:
  truncar al minuto (incluido el cruce de hora y de día), elegir el tamaño de bucket por
  rango, agregar muestras de varios pids en un bucket, y el formateo de "se reinicia en X".
  Se extrae a función pura por el mismo motivo que `public/js/devoluciones.js`.
- **`tests/smoke/specs.js`** — el endpoint end-to-end: forma de la respuesta, 403 para el
  resto de los roles, y el caso 429 con un limiter de prueba.

Aplica la regla de trabajo de `agente.md`: el test se escribe con el cambio, se comprueba
que falla sin él, y se corren las tres suites.

## Fases

| Fase | Qué entra | Estado |
|---|---|---|
| 1 | Modelo + servicio + enganches + endpoint + tarjetas | ✅ **Hecha** el 2026-08-13 |
| 2 | Gráfico temporal + selector de rango | ✅ **Hecha** el 2026-08-13 |
| 3 (opcional) | Top de IPs del minuto (no solo la del pico) | Sin hacer. La del pico ya entró en la fase 1 (D-01 aprobada) |

### Lo que se implementó en la fase 1

- `models/RateLimitSample.js` — muestra por minuto y por worker, TTL 14 días, único `{minuto, pid}`.
- `services/rateLimitStats.js` — parte pura (truncado, rangos, agregación, resumen) + contadores
  en memoria + volcado a Mongo cada 60 s con `.unref()`.
- `server.js` — `handler` en el `generalLimiter` para contar los 429, `app.use(registrarPaso)`
  pegado al limiter, `iniciarVolcado()` en el arranque y un último volcado en el `shutdown`
  (sin eso se pierde el minuto en curso en cada deploy, que es justo cuando uno mira esto).
- `routes/superadmin.js` — `GET /superadmin/monitor/ratelimit`.
- `views/superadmin/monitor.ejs` — sección "Rate limit" entre Ancho de banda y Memoria, con
  su propio fetch para no ensanchar `/monitor/stats`, que se llama cada 5 s.
- Tests: `tests/unit/rateLimitStats.test.js` (21) + 3 specs en `tests/smoke/specs.js`.

**Dato que salió de la propia verificación**: la suite de smoke consume ~1300 peticiones del
cupo en 4 minutos. Con el techo viejo de 1200 habría vuelto a dar 429 — la subida a 12000 del
mismo día no era holgura de más, era lo mínimo.

### Lo que se implementó en la fase 2

- `public/js/ratelimit-chart.js` — la matemática del gráfico, sin DOM: relleno de buckets,
  escala del eje Y, coordenadas del trazo y del área, alturas de las barras y etiquetas del
  eje X. Testeada en `tests/unit/ratelimitChart.test.js` (20 casos).
- Sección del gráfico en `monitor.ejs`: curva de ocupación del cupo con el techo punteado,
  barras de peticiones por intervalo (rojas donde hubo 429), eje temporal, leyenda y
  selector 1h / 6h / 24h / 7d.
- Cache de 30 s por rango en el endpoint. Sin él, dejar la pestaña abierta en "7d" serían 12
  lecturas por minuto de ~20 mil documentos para dibujar una curva que cambia una vez por
  minuto. Mismo criterio que el cache de `services/diskStats.js`. El `ahora` **no** se
  cachea: es el dato en vivo.

**Tres cosas que se corrigieron al verificar con datos reales**, y que valen como advertencia
para la fase 3:

1. **Los huecos.** Un minuto sin tráfico no genera documento. Dibujando solo los puntos que
   existen, un hueco de tres horas quedaba pegado al punto anterior igual que uno de un
   minuto: la curva mentía sobre *cuándo* pasó cada cosa. Por eso `rellenarBuckets` completa
   con ceros toda la ventana y marca esos buckets como `vacio` (que no es lo mismo que un
   cero real: puede ser que el servidor estuviera apagado).
2. **`workers` contaba PIDs del rango entero**, así que cada deploy sumaba uno: un día con
   cuatro reinicios mostraba "5 workers", y como el texto de la vista dice que el techo
   efectivo es esa cantidad de veces el cupo, el número engañaba justo sobre lo que hay que
   entender. Ahora es el máximo de PIDs distintos **dentro de un mismo minuto**, que es la
   concurrencia real.
3. **El eje venía en formato 12 h** (`es-AR` devuelve "12:59 a. m." por defecto) y en móvil
   las barras de "7d" medían 0,8 px con un gap de 1 px — más separador que dato. El eje pasó
   a 24 h y el gap se saca cuando hay más de 80 buckets.

## Decisiones abiertas

- **D-01 — ¿Se guarda qué IP consumió el cupo?** Sirve para distinguir "toda la escuela
  navegando" de "un script suelto", que es la única pregunta accionable cuando el número se
  dispara. Propuesta: guardar **solo la IP del pico de cada minuto**, no todas. Son IPs NAT
  de la escuela (poco identificatorias), pero es dato de red y conviene que la decisión sea
  explícita.
- **D-02 — Retención.** Propuesta: TTL 14 días. Alcanza para comparar dos semanas de clase y
  mantiene la colección chica.
- **D-03 — ¿Store compartido para el limiter?** Es lo que haría que 12000 signifique 12000 en
  vez de 12000-por-worker. Cambia el comportamiento del límite y agrega una escritura por
  request: **no entra en esta vista**, pero es la conversación que la vista va a abrir.
- **D-04 — ¿Instrumentar también `authLimiter` y `uploadLimiter`?** Mismo mecanismo, una
  serie por limiter. Se deja para después de ver si el panel se usa.
