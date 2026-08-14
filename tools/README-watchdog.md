# Watchdog — por qué no se puede entrar al sitio

Herramienta de diagnóstico para la pregunta *"no anda, ¿qué pasa?"*. Mide **todas las capas
por las que pasa un usuario** para llegar a la aplicación, en el mismo instante, y guarda una
línea por minuto. Cuando alguien reporta que no puede entrar, la respuesta ya está escrita.

## Por qué existe

El 2026-08-14, ante *"a la mañana producción se cae"*, los logs del servidor estaban
**impecables**: cero errores, cero reinicios de workers, cero 429. Eso no descartaba nada —
probaba que el problema no dejaba huella donde estábamos mirando.

Un usuario que "no puede entrar" puede estar trabado en seis capas distintas, y **cinco son
invisibles desde adentro de la aplicación**:

| # | Capa | ¿Se ve en los logs de la app? |
|---|---|---|
| 1 | La aplicación responde en `localhost:3000` | Sí |
| 2 | Los workers están arriba | Sí |
| 3 | Mongo contesta | Sí |
| 4 | El cupo del rate limit no está agotado | Solo como `warn` |
| 5 | El nombre `.ts.net` resuelve desde internet | **No** |
| 6 | El Funnel de Tailscale acepta y enruta el TLS | **No** |

Las capas 5 y 6 son las que ya fallaron tres veces (20/07, 22/07 y 10/08) dejando el sitio
inalcanzable **con el servidor perfectamente sano**.

## Instalación en el servidor

```bash
cd /home/walter/classroom
chmod +x tools/watchdog.sh

# dig es lo que verifica el DNS público. Sin él, la capa 5 queda sin medir
# (el informe lo avisa en vez de dar un OK que no verificó nada).
command -v dig >/dev/null || sudo apt install -y dnsutils

# Un chequeo por minuto
( crontab -l 2>/dev/null; echo "* * * * * /home/walter/classroom/tools/watchdog.sh" ) | crontab -

# Prueba inmediata
bash tools/watchdog.sh && npm run watchdog:ahora
```

## Uso

```bash
npm run watchdog:ahora       # el último chequeo y su veredicto
npm run watchdog:informe     # últimas 6 horas, con incidentes agrupados por tramo
npm run watchdog:manana      # SOLO la franja 6-11 h de la última semana
node tools/analizar-watchdog.js --horas 48
```

`watchdog:ahora` sale con **código 1** si hay una falla, así que sirve dentro de otro script.

## Cómo se lee el veredicto

El diagnóstico va **de adentro hacia afuera**, y ese orden importa: una capa rota explica a
todas las de afuera. Si la aplicación está caída, que el Funnel no enrute es una consecuencia,
no la causa — decir "es el Funnel" mandaría a mirar Tailscale cuando hay que abrir `error.log`.

| Capa del veredicto | Qué significa | Qué hacer |
|---|---|---|
| `app` | No responde en localhost | `logs/error.log`. Es del servidor o del código |
| `workers` | No hay procesos de Node | `sudo -u walter -H pm2 list` |
| `mongo` | La base no contesta | `sudo docker start mongodb` |
| `dns-funnel` | **La app está sana pero el nombre no resuelve desde internet** | `tailscale funnel reset && tailscale funnel --bg 3000` |
| `funnel` | Resuelve pero la conexión pública no completa | Igual que el anterior |
| `cupo` | Rate limit agotado | Subir `max` en `server.js`; ver `/superadmin/monitor` |
| `rendimiento` | Responde pero lento | Cruzar con las requests lentas de `combined.log` |

**Y el caso más importante de todos**: si alguien reporta que no anda y el watchdog dice `ok`
en ese minuto, el problema **no está ni en el servidor ni en el camino público**. Queda la red
de la escuela o el dispositivo. Eso también es un diagnóstico, y hasta ahora no había forma de
llegar a él.

## Dos precauciones de medición que ya están cubiertas

1. **El DNS se consulta contra `8.8.8.8` explícitamente.** El resolver del sistema tiene
   MagicDNS de Tailscale enganchado y devuelve la IP interna `100.x`, que daría un falso OK.
   Si la respuesta cae en el rango CGNAT, se marca `dns=local` y **no cuenta** como prueba
   externa.
2. **El chequeo público fuerza la IP con `--resolve`.** Un `curl` al nombre desde el propio
   servidor sale por el túnel y responde 200 aunque el Funnel esté roto para todo el mundo
   (la trampa del incidente del 22/07). Forzando la IP pública se recorre DNS + edge + TLS.

Sigue sin reemplazar una prueba hecha desde otra red: es el servidor llegándose a sí mismo
por el camino largo. Para la prueba externa real, datos móviles de un celular.

## Arquitectura

- **`tools/watchdog.sh`** — solo mide y escribe datos crudos. **No diagnostica nada.**
- **`services/watchdogDiagnostico.js`** — todo el criterio, testeado en
  `tests/unit/watchdog.test.js`.
- **`tools/analizar-watchdog.js`** — lee el log e imprime.

El veredicto vive en un solo lugar a propósito: si se calculara también en bash, tarde o
temprano las dos versiones dirían cosas distintas y no habría forma de saber cuál miente.

## Costo

Una línea por minuto (~200 bytes), con rotación automática a las 20.000 líneas (≈14 días).
El script tarda menos de 2 s en régimen normal y tiene timeout en cada chequeo, así que nunca
se solapa con la ejecución siguiente ni queda colgado cuando una capa se cae — que es
justamente cuando más importa que escriba su línea.
