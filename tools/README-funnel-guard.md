# Guardián del Funnel — que la página no se caiga esperando a que alguien entre por SSH

Chequea **cada minuto** que el sitio se pueda alcanzar desde internet y, si no, corre solo el
reset del Tailscale Funnel. Es la automatización del ritual manual:

```bash
sudo tailscale funnel status
sudo tailscale funnel reset && sudo tailscale funnel --bg 3000
sudo tailscale funnel status
```

Lo que hizo (y lo que no hizo falta hacer) se ve en **`/superadmin/monitor`**, primera sección.

## Por qué no resetea a ciegas

El pedido original era correr el reset cada 3 minutos, sin más. **Eso puede dejar el sitio
caído para siempre**: `funnel reset` da de baja el registro DNS público y `--bg 3000` lo vuelve
a publicar, y esa propagación tardó **10-15 minutos** el 2026-07-20 (aunque menos de 1 minuto
el 2026-08-10). Un reset a intervalo fijo pisa la propagación en curso y la reinicia desde
cero, una y otra vez. Encima, cada reset corta las conexiones TLS abiertas: a las 7 de la
mañana, con 300 personas entrando, son microcortes autoinfligidos.

Por eso el guardián **mide primero**:

| | |
|---|---|
| Cada minuto | mide las tres capas y escribe una línea en `logs/funnel-guard.log` |
| Repara | solo con **2 chequeos fallados seguidos** (`FUNNEL_FALLAS`) |
| Después de reparar | espera **10 minutos** (`FUNNEL_COOLDOWN`) para dejar propagar |
| Nunca repara | si la falla es de la aplicación: un reset no la arregla y suma un corte |

El criterio vive en `services/funnelGuard.js` y está testeado
(`tests/unit/funnelGuard.test.js`, 25 casos). El script solo mide y ejecuta.

## Qué mide

| Capa | Cómo | Por qué así |
|---|---|---|
| La app | `GET http://127.0.0.1:3000/health` | Medición de control: si responde 200 mientras nadie entra, el problema **no** está en el código |
| DNS público | resolver propio contra **8.8.8.8** | El resolver del sistema tiene MagicDNS enganchado y devuelve la IP interna `100.x`: daría un falso OK |
| Camino público | HTTPS **a la IP** que devolvió el DNS, con el nombre en SNI y en `Host` | Un pedido al nombre desde el propio server sale por el túnel y responde 200 aunque el Funnel esté roto para todo el mundo |
| El Funnel | `tailscale funnel status` | Vale poco solo (decía "on" en los tres incidentes), pero un "off" sí es concluyente |

## Instalación en el servidor

Como **root** (el reset necesita privilegios; corriendo como `walter` haría falta un `sudo`
sin contraseña para `tailscale`):

```bash
( crontab -l 2>/dev/null; echo "* * * * * $(command -v node) /home/walter/classroom/tools/funnel-guard.js >/dev/null 2>&1" ) | crontab -
```

Prueba inmediata, sin tocar nada:

```bash
cd /home/walter/classroom && node tools/funnel-guard.js --simular
```

Verificar que quedó andando (a partir del minuto siguiente):

```bash
npm run funnel:estado
```

## Uso

```bash
npm run funnel:estado                    # resumen de las últimas 6 h
node tools/funnel-guard.js --estado --horas 24
npm run funnel:simular                   # mide y dice qué haría, sin tocar nada
npm run funnel:reparar                   # repara AHORA (equivale a los tres comandos a mano)
```

`funnel:estado` sale con **código 1** si el último chequeo dio falla, así que sirve dentro de
otro script.

## Archivos que deja

| Archivo | Qué tiene |
|---|---|
| `logs/funnel-guard.log` | una línea por chequeo, formato `clave=valor`. Rota solo a las 20 000 líneas (≈ 14 días) |
| `logs/funnel-guard-detalle.log` | la salida cruda de los tres comandos de cada reparación, para leerla como si uno hubiera estado en la sesión SSH |

Una línea real:

```
2026-08-23T07:03:01-0300 app=200 dns=ok dnsip=199.38.181.54 ext=200 tls=0.21 funnel=on estado=ok capa=- accion=ninguna resultado=- fallas=0
```

## Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `FUNNEL_FALLAS` | `2` | chequeos fallados seguidos antes de reparar. `1` reacciona a la primera, a costa de resetear también por un falso positivo |
| `FUNNEL_COOLDOWN` | `10` | minutos de espera después de reparar |
| `FUNNEL_MODO` | `condicional` | `siempre` resetea en **cada** corrida — el pedido literal. Leer la advertencia de arriba antes de usarlo |
| `HOST_PUBLICO` | `classroom-4118.tailc1c538.ts.net` | el nombre a chequear |
| `PUERTO` | `3000` | el puerto que publica el Funnel |

## Cómo se lee el panel

En `/superadmin/monitor`, sección **Acceso público (Tailscale Funnel)**:

- **Camino público**: el veredicto del último chequeo. *Guardián detenido* (naranja) significa
  que hace más de 5 minutos que no llega una medición: el cron no está corriendo, y ahí el
  verde de antes no vale nada.
- **Reparaciones**: cuántas veces se arregló solo en el rango. Cada una deja su marca violeta
  bajo la franja de tiempo.
- **Disponibilidad**: con un chequeo por minuto, cada falla ≈ un minuto inalcanzable.
- Si aparece *"N reparaciones fallaron al ejecutarse"*, el guardián **detecta pero no puede
  arreglar**: casi siempre es que el cron no corre como root. Ver `funnel-guard-detalle.log`.

## Relación con el watchdog

`tools/watchdog.sh` mide **seis** capas para responder *"¿por qué no anda?"* y no toca nada.
El guardián mide **tres** y sí actúa. Conviven: uno diagnostica, el otro repara. Si algún día
se quiere una sola herramienta, la que tiene que sobrevivir es el watchdog — el guardián es un
parche mientras el sitio siga dependiendo del Funnel (ver `incidente-manana` en la memoria: el
arreglo de fondo es un dominio propio detrás de Caddy).
