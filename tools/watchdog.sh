#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# WATCHDOG — mide TODAS las capas por las que pasa un usuario para llegar al sitio,
# en el mismo instante, y deja una línea por chequeo.
#
# ── Por qué existe ───────────────────────────────────────────────────────────
# El 2026-08-14, ante "a la mañana producción se cae", los logs del servidor estaban
# IMPECABLES: cero errores, cero reinicios, cero 429. Eso no descartaba nada — probaba que
# el problema no dejaba huella donde estábamos mirando. Un usuario que "no puede entrar"
# puede estar trabado en cualquiera de seis capas distintas, y cinco de ellas son invisibles
# desde adentro de la aplicación:
#
#   1. La app         → responde en localhost:3000
#   2. Los workers    → PM2 los tiene arriba
#   3. La base        → Mongo contesta
#   4. El cupo        → el rate limit no está agotado
#   5. El DNS público → el nombre .ts.net resuelve desde internet   ← invisible desde adentro
#   6. El Funnel      → el edge de Tailscale acepta y enruta TLS    ← invisible desde adentro
#
# Este script mide las seis a la vez. Correlo por cron cada minuto: cuando alguien reporte
# "no anda", la respuesta va a estar escrita, con la hora exacta y la capa culpable.
#
# ── Regla de diseño ──────────────────────────────────────────────────────────
# ACÁ NO SE DIAGNOSTICA NADA. Este script solo mide y escribe datos crudos. El veredicto lo
# calcula tools/analizar-watchdog.js, que está testeado (tests/unit/watchdog.test.js). Si el
# veredicto viviera también acá, tarde o temprano las dos versiones se contradirían y no
# habría forma de saber cuál miente.
#
# ── Instalación ──────────────────────────────────────────────────────────────
#   chmod +x tools/watchdog.sh
#   ( crontab -l 2>/dev/null; echo "* * * * * /home/walter/classroom/tools/watchdog.sh" ) | crontab -
#
# Para leer los resultados:  npm run watchdog:informe
# ─────────────────────────────────────────────────────────────────────────────

APP_DIR="${APP_DIR:-/home/walter/classroom}"
PUERTO="${PUERTO:-3000}"
HOST_PUBLICO="${HOST_PUBLICO:-classroom-4118.tailc1c538.ts.net}"
LOG="${WATCHDOG_LOG:-$APP_DIR/logs/watchdog.log}"

mkdir -p "$(dirname "$LOG")"

# Todo con timeout: este script corre cada minuto y NO puede quedarse colgado esperando a
# una capa rota — que es justamente cuando más importa que escriba su línea. En el peor caso
# (todas las capas colgadas) la suma de timeouts queda holgadamente debajo del minuto.
TIMEOUT_CORTO=4
TIMEOUT_LARGO=8

ts=$(date '+%Y-%m-%dT%H:%M:%S%z')

# Deja un valor apto para el formato clave=valor, o el default si vino vacío.
#
# NO es una precaución teórica: `ss ... | grep -c` devuelve "0" Y exit code 1 cuando no hay
# coincidencias, así que un `|| echo 0` agregaba un SEGUNDO cero en otra línea y partía el
# registro en dos — con `conn=0` cortado a la mitad. Cualquier comando ausente o con salida
# multilínea rompe el formato igual, así que todo pasa por acá.
limpio() {
  local v
  v=$(printf '%s' "$1" | head -1 | tr -d ' \t\r\n')
  [ -z "$v" ] && v="$2"
  printf '%s' "$v"
}

# ── 1. LA APP, desde adentro ────────────────────────────────────────────────
# Es la medición de control: si esto responde 200 mientras nadie puede entrar, el problema
# NO está en el código y no hay nada que buscar en las rutas.
app_raw=$(curl -sS -o /tmp/wd_health.$$ -m "$TIMEOUT_CORTO" \
  -w '%{http_code}:%{time_total}' "http://localhost:$PUERTO/health" 2>/dev/null)
app_code="${app_raw%%:*}"
app_time="${app_raw##*:}"
[ -z "$app_code" ] && app_code="000" && app_time="0"

cuerpo=$(cat /tmp/wd_health.$$ 2>/dev/null)
rm -f /tmp/wd_health.$$
db_estado=$(limpio "$(echo "$cuerpo" | grep -o '"db":"[^"]*"'      | cut -d'"' -f4)" "?")
version=$(limpio   "$(echo "$cuerpo" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)" "?")
app_uptime=$(limpio "$(echo "$cuerpo" | grep -o '"uptime":[0-9]*'  | cut -d':' -f2)" "0")

# ── 2. EL CUPO DEL RATE LIMIT ───────────────────────────────────────────────
# Headers RateLimit-* de una request real. Si el cupo se agota, el sitio "no anda" para
# todos aunque la app esté perfecta. /health está exento del limiter, así que se pega a `/`.
cupo_hdr=$(curl -sS -o /dev/null -m "$TIMEOUT_CORTO" -D - "http://localhost:$PUERTO/" 2>/dev/null \
  | grep -i '^ratelimit-' | tr -d '\r')
cupo_rest=$(limpio "$(echo "$cupo_hdr" | grep -i 'ratelimit-remaining' | awk '{print $2}')" "?")
cupo_lim=$(limpio  "$(echo "$cupo_hdr" | grep -i 'ratelimit-limit'     | awk '{print $2}')" "?")

# ── 3. LOS WORKERS ──────────────────────────────────────────────────────────
# Se cuentan los procesos reales y no `pm2 list`, que como root devuelve una tabla vacía
# (mira /root/.pm2 en vez de /home/walter/.pm2) y haría creer que la app está caída.
workers=$(limpio "$(pgrep -fc "node $APP_DIR/server.js" 2>/dev/null)" "0")
conn=$(limpio    "$(ss -tn 2>/dev/null | grep -c ":$PUERTO")" "0")

# ── 4. RECURSOS ─────────────────────────────────────────────────────────────
load=$(limpio      "$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)" "0")
mem_usada=$(limpio "$(free -m 2>/dev/null | awk '/Mem:/{print $3}')" "0")
mem_total=$(limpio "$(free -m 2>/dev/null | awk '/Mem:/{print $2}')" "0")
rss=$(limpio       "$(ps -o rss= -C node 2>/dev/null | awk '{s+=$1} END {print int(s/1024)}')" "0")

# ── 5. MONGO ────────────────────────────────────────────────────────────────
# `docker exec` es caro para correrlo cada minuto, así que solo se confirma que el
# contenedor esté arriba. El estado real de la base ya viene en `db` de /health.
mongo=$(docker ps --filter "name=mongodb" --format "{{.Status}}" 2>/dev/null | grep -qi "^up" && echo "up" || echo "down")

# ── 6. DNS PÚBLICO ──────────────────────────────────────────────────────────
# EL CHEQUEO MÁS IMPORTANTE, y el que no se puede hacer desde la app: el modo de falla
# documentado del Funnel (20/07, 22/07, 10/08) es que el nombre deja de resolver desde
# internet mientras el servidor sigue perfecto.
#
# Se consulta 8.8.8.8 EXPLÍCITAMENTE: el resolver del sistema tiene MagicDNS de Tailscale
# enganchado y devuelve la IP interna 100.x, lo que daría un falso OK. Si la respuesta cae
# en el rango CGNAT (100.64.0.0/10) se marca como "local" y NO cuenta como prueba externa.
dns_ip=""
if command -v dig >/dev/null 2>&1; then
  dns_ip=$(limpio "$(timeout "$TIMEOUT_CORTO" dig +short +time=2 +tries=1 "$HOST_PUBLICO" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | head -1)" "")
elif command -v nslookup >/dev/null 2>&1; then
  dns_ip=$(limpio "$(timeout "$TIMEOUT_CORTO" nslookup "$HOST_PUBLICO" 8.8.8.8 2>/dev/null | awk '/^Address: /{print $2}' | grep -E '^[0-9.]+$' | head -1)" "")
else
  dns_ip="sin-herramienta"
fi

if [ -z "$dns_ip" ]; then
  dns="nxdomain"
elif [ "$dns_ip" = "sin-herramienta" ]; then
  dns="n/d"                      # falta dnsutils: apt install -y dnsutils
elif echo "$dns_ip" | grep -qE '^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.'; then
  dns="local"                    # respondió MagicDNS: no prueba nada de cara a internet
else
  dns="ok"
fi

# ── 7. EL CAMINO PÚBLICO COMPLETO ───────────────────────────────────────────
# Se fuerza la IP pública que devolvió el DNS de arriba con --resolve. Sin eso, un curl al
# nombre desde el propio server sale por el túnel de Tailscale y responde 200 aunque el
# Funnel esté roto para todo el mundo (la trampa del incidente del 22/07).
#
# Sigue siendo el server llegándose a sí mismo, así que no reemplaza una prueba desde otra
# red — pero recorre DNS público + edge de Tailscale + TLS, que es donde está el problema.
if [ "$dns" = "ok" ]; then
  ext_raw=$(curl -sS -o /dev/null -m "$TIMEOUT_LARGO" \
    --resolve "$HOST_PUBLICO:443:$dns_ip" \
    -w '%{http_code}:%{time_appconnect}' \
    "https://$HOST_PUBLICO/health" 2>/dev/null)
  ext_code=$(limpio "${ext_raw%%:*}" "000")
  ext_tls=$(limpio  "${ext_raw##*:}" "0")
else
  ext_code="skip"
  ext_tls="0"
fi

# ── 8. EL FUNNEL ────────────────────────────────────────────────────────────
# Vale poco por sí solo: en los tres incidentes decía "Funnel on" con el proxy bien
# apuntado mientras el sitio estaba caído. Se registra igual porque un "off" SÍ es
# concluyente, y porque distingue "se apagó" de "está prendido pero no enruta".
fu=$(timeout "$TIMEOUT_CORTO" tailscale funnel status 2>/dev/null)
if echo "$fu" | grep -qi "funnel on\|https://"; then
  funnel="on"
elif [ -z "$fu" ]; then
  funnel="n/d"
else
  funnel="off"
fi
ts_estado=$(limpio "$(timeout "$TIMEOUT_CORTO" tailscale status --json 2>/dev/null | grep -o '"BackendState":"[^"]*"' | cut -d'"' -f4)" "n/d")

# ── Una línea, campos clave=valor ───────────────────────────────────────────
# Formato pensado para dos lectores: `grep`/`tail` a ojo, y el analizador. Nada de comas
# adentro de los valores para que un `cut` casual no se rompa.
echo "$ts app=$app_code t=$app_time db=$db_estado ver=$version up=$app_uptime cupo=$cupo_rest/$cupo_lim workers=$workers conn=$conn load=$load mem=$mem_usada/$mem_total rss=$rss mongo=$mongo dns=$dns dnsip=${dns_ip:-none} ext=$ext_code tls=$ext_tls funnel=$funnel tsnet=$ts_estado" >> "$LOG"

# Rotación simple: sin esto el archivo crece para siempre (el access log ya tiene ese
# problema y está anotado como deuda). 20000 líneas ≈ 14 días de un chequeo por minuto.
lineas=$(wc -l < "$LOG")
if [ "$lineas" -gt 20000 ]; then
  tail -n 15000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
