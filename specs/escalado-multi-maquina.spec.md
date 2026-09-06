# Escalado a varias máquinas — plan completo

**Estado:** PROPUESTA (2026-08-31) · **Autor:** sesión de Claude Code · **Alcance:** infraestructura + los cambios de código que la habilitan

Pedido del usuario: *"configurar dos o más máquinas para trabajar este sistema, una base de datos
que en el futuro pueda configurar como un servicio de API para crecer horizontalmente, porque
dentro de poco vamos a expandirnos en roles y usuarios y no quiero tener problemas de usuarios,
roles, internet ni bases de datos."*

---

## 1. El punto de partida, medido

Todo esto está verificado contra el código de `main` en v1.0.72 y contra la producción real
(el VPS de Contabo, `https://sanjose.escuela.site`).

| Pieza | Cómo está hoy |
|---|---|
| Máquinas | **Una sola.** VPS Contabo: 8 vCPU, 23 GB RAM, 290 GB de disco |
| App | PM2 en cluster, **2 workers** ([ecosystem.config.js](ecosystem.config.js)) |
| Entrada | Caddy con Let's Encrypt, `sanjose.escuela.site` + `escuela.site` (página neutra) |
| Base | MongoDB 8.0 **nativo, escuchando solo en `127.0.0.1:27017`**, en la misma máquina |
| Pool | `maxPoolSize: 10` por proceso → 20 conexiones ([config/db.js:5](config/db.js:5)) |
| Sesión | **JWT HS256 en cookie httpOnly**, sin estado de servidor |
| Archivos | Disco local: 1,2 GB públicos + 15 GB de entregas + salas + SOE |
| Datos | 1.448 usuarios · 1.104 actividades · 3.544 entregas · 56.016 mensajes de sala · 15.831 auditlogs |

### ⭐ La conclusión que reordena todo el plan

**El dump completo de la base pesa decenas de MB. Los archivos pesan 16 GB.**

O sea: el problema de escala de este sistema **no son las queries, son los archivos y el ancho
de banda**. La base tiene 115 mil documentos, que para MongoDB es nada — un solo `mongod` en
esta máquina puede con diez veces eso sin despeinarse.

Eso cambia el orden de las prioridades respecto de lo que uno supondría:

1. **Sacar los archivos de la máquina de la app** es lo que realmente desbloquea la segunda máquina.
2. **Sacar la base de la máquina de la app** es la condición previa, y es barata.
3. **Repartir la base** (replica set) hace falta por **disponibilidad**, no por volumen.
4. **Sharding** — partir la base en trozos — está lejísimos. Meterlo hoy sería complejidad pura.

El plan respeta ese orden. La parte de "base de datos como servicio" está entera en la Fase 1 y
la Fase 7, pero no es lo que hay que hacer primero.

---

## 2. Lo que YA está listo para varias máquinas (no tocar)

Esto es la buena noticia, y es mérito de decisiones que ya están tomadas en el código:

- **La autenticación no tiene estado.** El login firma un JWT HS256 y lo manda en cookie
  httpOnly ([routes/auth.js](routes/auth.js)); `middleware/auth.js` lo verifica con
  `JWT_SECRET`. Cualquier máquina con el mismo secreto valida la misma cookie.
  **No hacen falta sesiones pegajosas** (*sticky sessions*) en el balanceador — que es el
  dolor de cabeza número uno de los sistemas que sí usan sesiones en memoria.
  `connect-mongo` figura en `package.json` pero **nadie lo requiere**: es dependencia muerta,
  se puede borrar.
- **No hay WebSockets ni SSE.** La sala en vivo funciona por *polling* HTTP normal. Cada
  petición es independiente y la puede atender cualquier nodo. Un sistema con WebSockets
  necesitaría afinidad de conexión o un bus entre nodos; este no.
- **Mongo ya se consume como servicio de red**, por `MONGODB_URI`. Mudarlo a otra máquina, a
  un replica set o a Atlas es **una línea del `.env`**.
- **Los caches en memoria ya asumen que hay varios procesos.** `middleware/cache.js` usa
  TTL de 45 s justamente porque el cache es por worker y un rol cambiado puede servirse viejo
  desde otro proceso. Con N máquinas **la ventana de inconsistencia sigue siendo 45 s**: no
  empeora, porque no depende de cuántos procesos haya sino del TTL.
- **La telemetría del rate limit ya va a Mongo**, no a memoria.
- **El módulo de recursos ya está escrito con guardas de concurrencia de verdad** (índice único
  parcial + contador atómico). Es el precedente correcto y hay que copiarlo.

---

## 3. Lo que se ROMPE al enchufar la segunda máquina

Ocho bloqueantes reales, con el archivo y la línea. Ninguno es opinión: se rompe.

### B1 — Los archivos viven en el disco del nodo que atendió la subida ⛔ *el bloqueante grande*

`multer.diskStorage` escribe en el disco local; `express.static` y `res.sendFile` lo buscan en
el disco local. Con dos nodos y reparto por turnos, **la mitad de las descargas dan 404**.

Escriben: [routes/activities.js:54](routes/activities.js:54) y
[:58](routes/activities.js:58), [routes/admin.js:44-45](routes/admin.js:44),
[routes/announcements.js:23](routes/announcements.js:23),
[routes/courses.js:47](routes/courses.js:47),
[routes/soe.js:144](routes/soe.js:144), [services/liveRoom.js:112](services/liveRoom.js:112),
[middleware/image-upload.js](middleware/image-upload.js).

Sirven: [server.js:221](server.js:221) (`express.static('public')`),
[routes/activities.js:1009](routes/activities.js:1009) y
[:1038](routes/activities.js:1038), [routes/rooms.js:852](routes/rooms.js:852),
[routes/soe.js:694](routes/soe.js:694).

### B2 — El modo mantenimiento es un archivo en disco

[config/maintenance.js:24](config/maintenance.js:24). El comentario del propio código lo dice:
*"en PM2 cluster el disco se comparte entre procesos, la memoria no"*. **Entre máquinas el disco
tampoco se comparte.** Prender mantenimiento en el nodo A deja al nodo B atendiendo como si
nada, y el 50 % de la gente sigue entrando durante la ventana.

### B3 — El promotor de la ventana elige un worker *por máquina*

[server.js:825](server.js:825): `NODE_APP_INSTANCE === '0'`. Con dos máquinas hay **dos
promotores**, cada uno convencido de ser el único. Los dos leen "hay espera" en el mismo tick y
escriben **dos eventos de auditoría para una única promoción** — exactamente el bug que ese
`if` existe para evitar, reaparecido un nivel más arriba.

### B4 — El webhook de deploy despliega una sola máquina ⛔

[server.js:225](server.js:225). GitHub manda **una** petición, el balanceador la entrega a
**un** nodo, y ese nodo hace `git reset --hard` + `pm2 reload` **de sí mismo**. Los demás quedan
con el código viejo.

Y lo peor: la verificación final compara `/health` contra el `package.json` **de su propio
disco**, así que **dice `OK deploy verificado` mientras media flota está atrasada**. Es el
Frankenstein del changelog 2026-07-28, ahora distribuido y silencioso.

### B5 — El rate limit cuenta por proceso

[server.js:137](server.js:137) y [:164](server.js:164),
[middleware/rate-limits.js](middleware/rate-limits.js). Ya hoy el techo real es **2×** por los
dos workers. Con dos máquinas pasa a **4×**, y el número que dice el código deja de significar
nada. El `authLimiter` (3000 intentos por IP) es el que más importa: la escuela entera sale por
una sola IP.

### B6 — Las muestras de telemetría se llavean por PID

[services/rateLimitStats.js](services/rateLimitStats.js) y
[models/RateLimitSample.js](models/RateLimitSample.js) usan `{ minuto, pid }`. **Dos máquinas
pueden repetir el PID** y las muestras de nodos distintos se fusionan en un `$max`. El gráfico
del monitor empieza a mentir sin avisar.

### B7 — El backup lee el disco de un solo nodo

[routes/backup.js:73-80](routes/backup.js:73). El nodo que atienda el POST comprime **sus**
archivos. En una flota, un backup "completo" saldría con la mitad de las entregas. Y el
restore deja los archivos en un solo nodo.

### B8 — Los logs y el monitor son por máquina

`logs/*.log`, [services/diskStats.js](services/diskStats.js),
[config/network.js](config/network.js) (que lee `/proc/net/dev`). `/superadmin/monitor` te
muestra **el nodo que te tocó, al azar**. Y el sistema de diagnóstico —el access log con
`requestId`, que es la herramienta para cualquier *"no me anda"*— queda **partido en N
archivos**: el código `SUB-XXXXXX` que reporta un usuario está en un archivo y vos estás
mirando otro.

### Menores, pero anotados

- [server.js:47](server.js:47): `APP_DIR = '/home/walter/classroom'` hardcodeado, y el
  `deployCmd` invoca `/usr/local/bin/pm2` por ruta absoluta (deuda ya conocida de la mudanza).
- El autocierre perezoso de salas ([services/liveRoom.js](services/liveRoom.js)) puede
  dispararse en dos nodos a la vez. Hay que verificar que la escritura sea condicional
  (`updateOne` con filtro sobre el estado actual), no un `save()` sobre un documento leído.

---

## 4. La topología objetivo

```
                        Internet
                            │
                  ┌─────────▼─────────┐
                  │    Cloudflare     │  DNS + proxy + caché de estáticos
                  │  (health checks)  │  ← el "ojo externo" que hoy no existe
                  └─────────┬─────────┘
                            │
                  ┌─────────▼─────────┐
                  │  entrada (Caddy)  │  TLS + reverse_proxy + lb_policy
                  │  health_uri /health│
                  └────┬─────────┬────┘
                       │         │
          ┌────────────▼──┐   ┌──▼────────────┐
          │     app1      │   │     app2      │   ← PM2 cluster en cada una
          │  (2 workers)  │   │  (2 workers)  │      sin estado, intercambiables
          └───┬────────┬──┘   └──┬────────┬───┘
              │        │         │        │
   ┌──────────▼────────▼─────────▼────────▼──────────┐
   │            red privada (WireGuard)              │
   └──────────┬──────────────────────────┬───────────┘
              │                          │
   ┌──────────▼──────────┐   ┌───────────▼───────────┐
   │  MongoDB (db1)      │   │  Almacenamiento de    │
   │  → replica set      │   │  objetos S3           │
   │    db1 + db2 + db3  │   │  (entregas, material) │
   └─────────────────────┘   └───────────────────────┘
```

Piezas nuevas respecto de hoy: **Cloudflare**, la **red privada**, la **base en su propia
máquina** y el **almacenamiento de objetos**. Las máquinas de app pasan a ser desechables: se
suman y se sacan sin ceremonia, que es exactamente lo que significa "crecer horizontalmente".

---

## 5. Las fases

Cada fase **deja el sistema entero y sirve sola**. No hay big bang, y cada una tiene su vuelta
atrás. La segunda máquina recién aparece en la Fase 4: las tres anteriores son la condición
para que enchufarla no rompa nada.

### Fase 0 — Higiene: sacar la infraestructura del código

**Por qué primero:** hoy hay decisiones de infraestructura escritas dentro de archivos `.js`.
Mientras estén ahí, cambiar de máquina implica cambiar código, y cambiar código implica un
deploy — que es justo lo que no anda cuando estás mudando máquinas.

- `APP_DIR` y la ruta de `pm2` salen de [server.js:47](server.js:47) al `.env`.
- Nace `NODE_ID` en el `.env` (`app1`, `app2`, …). Aparece en `/health`, en cada línea del
  access log y en cada muestra de telemetría.
- Nace `FILES_BASE`: **un solo lugar** del que salen las 8 rutas de archivos que hoy están
  repetidas en 8 archivos.
- Se borra `connect-mongo` de `package.json` (nadie lo usa).
- Se da de alta el **servicio externo de uptime con aviso al teléfono** — ya está pendiente
  desde la mudanza y a partir de acá deja de ser opcional.

**Criterio de aceptación:** `GET /health` devuelve `nodo`; el access log trae el nodo en cada
línea; `npm run test:smoke`, `test:roles` y `test:unit` en verde.
**Vuelta atrás:** trivial, no cambia comportamiento.

---

### Fase 1 — La base sale de la máquina de la app

**Esto es literalmente lo que el usuario pidió como "la base como servicio de API".** Ver la
sección 6 para la aclaración conceptual: no hay que envolver Mongo en una API HTTP; Mongo *ya
es* un servicio de red, solo que hoy está atado a `127.0.0.1`.

1. VPS nuevo `db1`. MongoDB 8.0 nativo, mismo procedimiento que el de la mudanza.
2. **WireGuard** entre los nodos. Mongo escucha en la IP de WireGuard, **nunca en la pública**.
   WireGuard y no la red privada de Contabo: no depende del proveedor, cifra igual y sigue
   funcionando el día que una máquina esté en otro lado.
3. Usuario y contraseña de Mongo + `authorization: enabled`. Hoy no hay autenticación porque
   escucha en loopback; en cuanto sale a una red, hace falta.
4. `MONGODB_URI` apunta a `db1`. Una línea.
5. Migración: `mongodump` con la plataforma en modo mantenimiento, `mongorestore` en `db1`,
   verificación de conteos colección por colección — el mismo procedimiento de la mudanza, que
   ya está probado y comparó 115.311 documentos campo por campo.

⚠️ **La latencia deja de ser cero.** Hoy la app y la base comparten memoria del mismo host;
mañana hay un salto de red por query. Dentro del mismo datacenter son ~0,3 ms y no se nota,
**pero una pantalla que hace 40 queries paga 40 saltos**. Antes de cortar hay que medir el p95
de las 5 pantallas más pesadas y compararlo después. Si alguna se degrada, el arreglo es juntar
queries (`$lookup` o `populate` en lote), no volver atrás.

⚠️ **`maxPoolSize: 10` por proceso** ([config/db.js:5](config/db.js:5)) deja de ser un detalle:
2 máquinas × 2 workers × 10 = 40 conexiones. Mongo aguanta miles, pero el número hay que
recalcularlo cada vez que se suma un nodo, y anotarlo en ese comentario.

**Criterio:** los conteos de las 28 colecciones coinciden con el manifiesto; login real por
HTTPS; p95 de las pantallas pesadas dentro del 20 % del valor anterior.
**Vuelta atrás:** devolver `MONGODB_URI` a `127.0.0.1` — el `mongod` viejo queda intacto y con
los datos hasta el corte. Es la misma red de seguridad que se usó con el servidor viejo.

---

### Fase 2 — Los archivos salen del disco de la app ⛔ *la fase que desbloquea todo*

Tres caminos posibles. Los pongo los tres porque la elección tiene consecuencias que conviene
ver antes de firmarla:

| | Qué es | A favor | En contra |
|---|---|---|---|
| **A. Objetos S3** *(recomendado)* | Contabo Object Storage / Backblaze B2 / Cloudflare R2 | Los archivos no viven en **ninguna** máquina. Escala sin límite, versionado, backup del proveedor | Hay que escribir el adaptador y migrar 16 GB una vez |
| **B. Disco de red (NFS)** | Un volumen montado en todos los nodos | Cambio de código casi nulo: `FILES_BASE=/mnt/archivos` | El NFS pasa a ser **punto único de falla**, y 15 GB de entregas por red son lentos |
| **C. Replicación (rsync/Syncthing)** | Cada nodo tiene su copia, se sincronizan | Barato, cero cambios de código | **Eventualmente consistente**: el alumno sube en app1 y el docente pide en app2 tres segundos después → **404**. Inaceptable para entregas |

**Recomendación: A**, con un adaptador `services/almacenamiento.js` que exponga
`guardar()`, `leer()`, `borrar()` y `urlPara()`, y que elija destino según `STORAGE_DRIVER`
(`disco` | `s3`). Así la Fase 2 se puede desplegar con `disco` —sin cambio de comportamiento— y
el cambio a `s3` es una variable de entorno, con vuelta atrás inmediata.

Las subidas pasan de `multer.diskStorage` a `memoryStorage` + adaptador (los archivos ya pasan
por memoria para la recompresión a WebP en varios caminos, así que no es nuevo).

⚠️ **Los formatos de archivo viven en 9 lugares** y **las subidas de imagen tienen 6 caminos**
—las dos cosas ya están documentadas y ya causaron bugs—. El adaptador tiene que ser **uno
solo** para los 6 caminos, o el problema se duplica en vez de resolverse.

⚠️ **`public/archivos` hoy se sirve por `express.static` sin ningún control de permisos**,
mientras que entregas, salas y SOE pasan por rutas con permisos y `res.sendFile`. Al mover a
objetos hay que **conservar esa diferencia**: lo público puede ir con URL directa, pero las
entregas y sobre todo **el material del gabinete del SOE tienen que quedar privados, con URL
firmada de vida corta**. El legajo psicopedagógico es confidencial por diseño y esa es
exactamente la razón por la que la feature de adjuntos del SOE se había rechazado dos veces.

⚠️ **El backup hay que rehacerlo, no ignorarlo.** Hoy [routes/backup.js](routes/backup.js)
comprime desde disco. Con objetos, el backup pasa a ser *dump de Mongo + inventario de objetos*,
y la copia de los objetos la hace el versionado del proveedor. La lista única `CARPETAS` y el
test que la obliga siguen siendo el lugar donde se declara qué entra.

**Criterio (el test que define la fase):** subir una entrega forzando `app1` y descargarla
forzando `app2` → **200 y el mismo hash**. Ese ida y vuelta va como caso nuevo de
`tests/smoke/`.
**Vuelta atrás:** `STORAGE_DRIVER=disco`. Se deja el disco como lectura de respaldo hasta que
el S3 acumule semanas sin un 404.

---

### Fase 3 — El estado que hoy vive en un proceso pasa a estar compartido

Resuelve B2, B3, B5 y B6.

- **Mantenimiento** → de `maintenance.json` a un documento en Mongo. La lectura por request ya
  existe (sin cache, a propósito, para que apagarlo sea inmediato); solo cambia el origen.
  **El fail-open se conserva**: si la lectura falla, la escuela no se queda afuera.
- **Tareas únicas** (el promotor de la ventana, los crons, el barrido de salas) → **lease en
  Mongo**: un `findOneAndUpdate` sobre `{ tarea, dueño, expira }` con TTL de 60 s. El que lo
  gana corre; los demás no hacen nada. Reemplaza a `NODE_APP_INSTANCE === '0'`, que es una
  elección *por máquina* y por eso deja de servir.
- **Rate limit** → store compartido. **Con Mongo alcanza** (`rate-limit-mongo`): el límite
  vuelve a significar lo que dice, y no hay que meter Redis en el sistema para esto. Redis
  recién si se mide que el store es el cuello de botella.
- **`RateLimitSample`** → la clave pasa a `{ minuto, nodo, pid }`.

⚠️ **El cache de 45 s se queda como está.** Es tentador "arreglarlo" con invalidación entre
nodos, pero la ventana de inconsistencia **no crece** con más máquinas: sigue siendo el TTL.
Sumar un bus de invalidación sería complejidad por nada.

**Criterio:** prender mantenimiento contra `app1` → la petición **siguiente** a `app2` devuelve
503. Con los dos nodos arriba, una promoción de ventana escribe **un** solo evento de
auditoría. El `authLimiter` bloquea al intento 3001 contado **entre los dos nodos**, no 6001.

---

### Fase 4 — Balanceador y la segunda máquina de app

Recién acá aparece el segundo nodo, y para entonces ya no rompe nada.

- Caddy en la entrada con `reverse_proxy app1 app2`, `lb_policy round_robin` y
  `health_uri /health`. `/health` **ya devuelve 503 cuando la base está caída**
  ([server.js:190](server.js:190)), así que el balanceador saca solo al nodo enfermo sin que
  nadie haga nada. Eso ya está bien hecho y se aprovecha tal cual.
- **Todos los nodos detrás del mismo nombre.** La cookie es por host: dos nombres sirviendo lo
  mismo serían dos sesiones distintas. Ya está resuelto para `www` con el 301 y la misma regla
  aplica acá.
- **Cloudflare delante de la entrada.** Es la respuesta a *"no quiero problemas de internet"*:
  aporta el health check externo, el caché de estáticos, protección de DDoS y —lo más
  importante— **hace que el balanceador deje de ser el punto único de falla**.

⚠️ **`trust proxy` pasa a estar mal.** Hoy es `1` ([server.js:88](server.js:88)), correcto con
un solo Caddy delante. Con **Cloudflare + Caddy son dos saltos**, y con `trust proxy: 1`
Express toma como `req.ip` la IP del **borde de Cloudflare**. Consecuencia:
**todo el tráfico cuenta como una sola IP y el rate limit banea a la escuela entera.**
Es el error más silencioso de toda esta migración —no rompe nada hasta el primer pico de las
7:30— así que va con test propio: `GET /health` con un `X-Forwarded-For` armado a mano tiene
que reflejar la IP del cliente y no la del proxy.

**Criterio:** apagar `app1` a mitad de una sesión → el balanceador lo saca en menos de 10 s y
**ninguna petición devuelve 502**; el usuario no vuelve a loguearse (la cookie sigue valiendo
en `app2`). `npm run test:smoke` corriendo contra el balanceador, no contra un nodo.

---

### Fase 5 — Deploy a la flota

Resuelve B4, que hoy además **miente diciendo que salió bien**.

Dos formas. Recomiendo la segunda:

- **Coordinador:** el nodo que recibe el webhook despliega en todos por SSH. Necesita claves
  cruzadas, orden, y falla entera si el coordinador se cae a mitad.
- **Pull-based** *(recomendado)*: un `systemd timer` en **cada nodo**, cada 60 s, que compara
  `git rev-parse HEAD` con `origin/main` y despliega si difieren. Sin coordinador, sin SSH
  cruzado, y **cada nodo se autorrepara**: un nodo que estuvo apagado se pone al día solo al
  volver. Es la misma filosofía por la que el deploy actual usa `reset --hard` en vez de
  `pull` — que sea idempotente.

El webhook `POST /deploy` se conserva como **disparador** (acelera el ciclo de 60 s), pero deja
de ser quien despliega.

La verificación final deja de mirar el `package.json` del disco propio: consulta `/health` de
**todos** los nodos de la lista y solo entonces escribe `OK`.

⚠️ **Regla de la casa que sigue valiendo: el arreglo del deploy nunca se aplica a su propio
deploy.** La primera vez hay que recargar a mano, en cada nodo.

⚠️ **Durante un despliegue conviven la versión vieja y la nueva contra la misma base.** Regla
nueva, y es directamente el *"no quiero problemas de bases de datos"*: **toda migración de
schema tiene que ser compatible hacia atrás**. Agregar campos, sí. Renombrar o borrar un campo
en el mismo release que lo deja de usar, **no**: eso se parte en dos releases separados por un
despliegue completo. Esto no es teoría — con un solo nodo el `pm2 reload` ya hace convivir dos
versiones unos segundos; con una flota son minutos.

**Criterio:** un push a `main` deja a **todos** los nodos reportando la versión nueva en
`/health` en menos de 3 minutos, y `deploy.log` lo dice nodo por nodo.

---

### Fase 6 — Ver la flota entera

Resuelve B7 y B8. Sin esto, el sistema de diagnóstico —que es la herramienta de trabajo ante
cualquier *"no me anda"*— se degrada justo cuando hay más máquinas donde perderse.

- **Los logs a un solo lugar.** La opción que menos infraestructura nueva agrega: el access log
  a una colección de Mongo con índice TTL de 14 días, con el campo `nodo`. El `requestId` y el
  código `SUB-XXXXXX` siguen funcionando igual, pero se buscan **una sola vez** en lugar de N.
- **`/superadmin/monitor` pasa a mostrar una fila por nodo** — CPU, RAM, disco, red, versión,
  uptime. Hoy ya distingue workers por PID; hay que sumarle el nodo.
- **El backup se ejecuta en el nodo que tiene el lease**, y con objetos ya no depende del disco
  local.
- El watchdog de 6 capas corre en cada nodo, con el `NODE_ID` en cada línea.

**Criterio:** un `requestId` de una petición atendida por `app2` se encuentra desde el panel
sin entrar por SSH a ninguna máquina.

---

### Fase 7 — Alta disponibilidad de la base: el replica set

Ahora sí, con la base ya siendo un servicio, sumarle réplicas es incremental.

- Tres nodos: `db1` primario + `db2` y `db3` secundarios. Tres y no dos: la elección de
  primario necesita **mayoría**, y con dos nodos no hay mayoría posible cuando uno se cae.
- `MONGODB_URI` pasa a listar los tres con `replicaSet=`. Otra vez, una línea.
- **Lo que esto habilita, además de la disponibilidad: transacciones.** Un `mongod` suelto no
  las soporta; un replica set sí. Es la herramienta correcta para las escrituras que tocan
  varios documentos a la vez.

⚠️ **No repartir lecturas a los secundarios de entrada.** Un secundario va unos milisegundos
atrasado, y eso alcanza para que un docente cree una actividad y no la vea en la lista
siguiente. Arrancar con `readPreference=primaryPreferred` (que es HA sin cambiar la
consistencia) y mover lecturas a secundarios **de a una y midiendo**, solo pantallas de solo
lectura y tolerantes al atraso: informes, gráficos del directivo, históricos.

**Criterio:** apagar el primario en caliente → la app se recupera sola en menos de 30 s (el
driver reelige) y ninguna escritura se pierde.

---

### Fase 8 — Usuarios y roles a escala

El pedido explícito: *"vamos a expandirnos en roles y usuarios"*.

- **Los roles ya escalan bien.** `config/sections.js` es el catálogo único que leen la pantalla,
  el *enforcement* y la configuración; `School.rolePermissions` guarda las **denegadas** con
  default fail-open. Un rol nuevo se agrega **ahí y en ningún otro lado**, y
  `npm run test:roles` (la matriz roles × solapas) es lo que obliga a que así sea. Esta parte
  no necesita cambios: necesita que se respete la regla.
- **El límite real está en la identidad, no en los roles.** Hoy `user.role` y `user.school` son
  **singulares**: una persona con dos roles en dos escuelas necesita dos cuentas (habilitado a
  propósito por el índice `{school, dni}`). La spec
  [identidad-multiescuela](specs/identidad-multiescuela.spec.md) ya está escrita, propone que
  `role`/`school` pasen a ser **contexto activo** sin tocar los 183 usos, y **espera 4
  decisiones**.

  ⭐ **Esa spec hay que aprobarla ANTES de sumar escuelas.** Migrar 1.448 usuarios es un rato;
  migrar 15.000 con cuentas duplicadas ya creadas es un problema serio. Es la decisión más
  cara de postergar de todo este documento.
- **El login es lo más caro en CPU que hace el sistema** (bcrypt, a propósito). Es justamente lo
  que satura a las 7:30 cuando entran 300 personas a la vez — y es **la mejor razón para sumar
  nodos de app**, porque escala de forma perfectamente lineal: el doble de nodos, el doble de
  logins por segundo.
- ⚠️ Con el rate limit ya compartido (Fase 3), revisar que el `authLimiter` de 3000/15 min
  siga alcanzando: **la escuela entera sale por una sola IP**, y ese límite es por IP.

---

### Fase 9 — Crecer de verdad: cuándo sumar qué

Criterios numéricos, no fechas. La regla es no adelantarse:

| Señal medida | Qué hacer |
|---|---|
| CPU > 70 % sostenido y p95 subiendo | **Sumar un nodo de app.** Barato, lineal, sin consecuencias |
| El disco de objetos crece y las descargas van lentas | CDN delante del bucket (Cloudflare ya está) |
| El primario de Mongo satura en escrituras | Primero revisar índices y queries N+1. Casi siempre es eso |
| El *working set* no entra en RAM | **Ahí sí**, evaluar sharding |
| 5+ escuelas y nadie con tiempo de operar bases | **Mongo Atlas** — la base como servicio gestionado |

⭐ **Con 115 mil documentos, el sharding está a años de distancia.** Ponerlo hoy sería agregar
una complejidad enorme para resolver un problema que no existe. Lo que sí hace falta pronto es
el **replica set**, y por disponibilidad — que la escuela no se quede sin plataforma porque una
máquina se cayó— no por volumen.

---

## 6. Sobre "la base de datos como servicio de API"

Vale la pena aclararlo porque cambia qué hay que construir.

**MongoDB ya es un servicio de red.** Habla su propio protocolo por TCP, y la app se conecta con
una URI. No hay que envolverlo en una API HTTP: eso sería agregar un intermediario que traduce,
que hay que mantener, que agrega latencia y que **quita** funcionalidad (transacciones,
agregaciones, cambios en vivo). Es un camino que la industria probó y abandonó.

Lo que hoy le falta a la base para "crecer horizontalmente" **no es una API**, son tres cosas,
en este orden:

1. **Salir de la máquina de la app** (Fase 1) — hoy escucha en `127.0.0.1`, lo cual es correcto
   y seguro para una máquina, e imposible para dos.
2. **Replicarse** (Fase 7) — varias copias, elección automática de primario. Eso es alta
   disponibilidad, y es lo que hace que una máquina caída no sea una escuela sin plataforma.
3. **Partirse en trozos** (sharding, Fase 9) — repartir los datos entre varios servidores. Es
   lo que la palabra "horizontal" significa técnicamente para una base, y es lo que **este
   sistema no necesita todavía ni de lejos**.

Y si en algún momento la respuesta es "no quiero operar bases de datos", el nombre de eso es
**MongoDB Atlas**: la base como servicio gestionado, con réplicas, backups y escalado por
botón. El cambio en el código sigue siendo **una línea del `.env`** — por eso conviene dejar
todo listo para elegirlo más adelante sin rehacer nada. El costo de Atlas es dinero mensual y
un salto de red más largo; el costo del replica set propio es operarlo.

**Recomendación:** replica set propio en Contabo mientras sea una escuela; Atlas cuando sean
varias y el tiempo de operación valga más que la diferencia de precio.

---

## 7. Las cuatro preocupaciones del usuario, mapeadas

| *"No quiero problemas de…"* | Dónde lo resuelve el plan |
|---|---|
| **usuarios** | Fase 8: la identidad multiescuela aprobada **antes** de crecer. Fase 4: más nodos = más logins por segundo (bcrypt escala lineal) |
| **roles** | Fase 8: el catálogo único ya está bien; la regla es no romperlo, y `npm run test:roles` es quien la hace cumplir |
| **internet** | Fase 4: Cloudflare delante + health checks + caché. Fase 0: uptime externo con aviso al teléfono. Fase 7: una máquina caída deja de ser una escuela caída |
| **bases de datos** | Fase 1 (sale de la app), Fase 7 (replicada, con transacciones), Fase 5 (migraciones compatibles hacia atrás), Fase 9 (criterios para escalar sin adivinar) |

---

## 8. Cambios de código, archivo por archivo

| Qué | Dónde | Fase |
|---|---|---|
| `APP_DIR` y ruta de pm2 al `.env` | [server.js:47](server.js:47), `deployCmd` | 0 |
| `NODE_ID` en health, logs y telemetría | [server.js:190](server.js:190), [config/logger.js](config/logger.js), [middleware/request-log.js](middleware/request-log.js) | 0 |
| Borrar `connect-mongo` | [package.json](package.json) | 0 |
| Adaptador `services/almacenamiento.js` | nuevo | 2 |
| Rutas de archivos al adaptador | activities `:54,:58` · admin `:44,:45` · announcements `:23` · courses `:47` · soe `:144` · liveRoom `:112` · backup `:73-80` · diskStats · cleanup-files · optimize-existing-images | 2 |
| Subidas a `memoryStorage` | [middleware/image-upload.js](middleware/image-upload.js) + los 6 caminos | 2 |
| Servido de archivos | [server.js:221](server.js:221), activities `:1009,:1038`, rooms `:852`, soe `:694` | 2 |
| Mantenimiento a Mongo | [config/maintenance.js](config/maintenance.js) | 3 |
| Lease en vez de `NODE_APP_INSTANCE` | [server.js:825](server.js:825) | 3 |
| Rate limit con store compartido | [server.js:137](server.js:137), [:164](server.js:164), [middleware/rate-limits.js](middleware/rate-limits.js) | 3 |
| Clave `{minuto, nodo, pid}` | [services/rateLimitStats.js](services/rateLimitStats.js), [models/RateLimitSample.js](models/RateLimitSample.js) | 3 |
| `trust proxy` a 2 (o lista de CIDR) | [server.js:88](server.js:88) | 4 |
| Webhook deja de desplegar | [server.js:225](server.js:225) | 5 |
| Monitor por nodo | [routes/superadmin.js](routes/superadmin.js), [services/diskStats.js](services/diskStats.js), [config/network.js](config/network.js) | 6 |
| Backup: dump + inventario | [routes/backup.js](routes/backup.js) | 6 |
| Escrituras condicionales en el autocierre | [services/liveRoom.js](services/liveRoom.js) | 3 |

---

## 9. Máquinas y costo

Sin inventar precios: la forma del gasto es lo que importa.

| Etapa | Máquinas | Nota |
|---|---|---|
| **Hoy** | 1 VPS (8 vCPU / 23 GB / 290 GB) | Sirve todo |
| **Mínimo viable multi-máquina** (F1–F5) | 3: `db1` + `app1` + `app2` | El VPS actual pasa a ser `app1`. Da capacidad, **no** alta disponibilidad de base |
| **Con alta disponibilidad** (F7) | 5: `db1/db2/db3` + `app1/app2` | Los de base pueden ser más chicos que el actual: la base pesa poco |
| **Servicios** | Object storage (por GB, ~16 GB hoy) + Cloudflare (plan gratis alcanza) | |

Las máquinas de base pueden ser modestas: **el dataset entero entra holgado en RAM**. Las de
app quieren CPU (bcrypt) más que RAM.

---

## 10. Decisiones tomadas por defecto

El usuario pidió el plan sin interrupciones, así que estas van **decididas**. Cambiar cualquiera
no altera la estructura del plan, solo la fase donde vive:

1. **Almacenamiento de objetos S3**, no NFS ni replicación de discos. *(Es la única de las tres
   que no tiene un modo de falla inaceptable.)*
2. **WireGuard** como red entre nodos, no la red privada del proveedor. *(No queda atado a Contabo.)*
3. **Replica set propio** antes que Atlas. *(Atlas cuando haya varias escuelas.)*
4. **Deploy pull-based** con `systemd timer`, no coordinador por SSH. *(Se autorrepara.)*
5. **Mongo como store del rate limit**, no Redis. *(Una pieza menos que operar.)*
6. **Cloudflare delante.** *(Resuelve el ojo externo, el caché y el punto único de falla de la
   entrada, de una sola vez.)*
7. **Los logs a Mongo con TTL**, no una pila de observabilidad. *(Conserva el `requestId` y el
   `SUB-XXXXXX` que ya funcionan.)*

Y una que **no** puedo tomar yo porque es de producto, no técnica: **aprobar la spec de
identidad multiescuela** (sus 4 decisiones abiertas). Es la única del documento que **se
encarece con el tiempo**, y por eso está señalada como lo primero a destrabar.

---

## 11. Orden de ejecución recomendado

```
F0 higiene ──► F1 base afuera ──► F2 archivos afuera ──► F3 estado compartido
                                                              │
                                          ┌───────────────────┘
                                          ▼
                              F4 balanceador + app2 ──► F5 deploy de flota ──► F6 ver la flota
                                          │
                                          └──► F7 replica set (en paralelo, independiente)

F8 (roles/identidad) es independiente de todo lo anterior — y la spec de identidad
conviene aprobarla YA, antes de sumar escuelas.
```

**El hito que hay que cuidar:** entre F3 y F4 el sistema sigue con una sola máquina pero ya
está listo para dos. Ese es el punto donde conviene dejarlo reposar unas semanas antes de
enchufar `app2`: todos los cambios peligrosos ya están desplegados y probados con una sola
máquina, donde un error es fácil de ver.
