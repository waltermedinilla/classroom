# Dominios por escuela — identidad, marca y módulos desde el superadmin

Estado: **propuesta, sin aprobar** (2026-08-28) · Panel: `superadmin` · Pedido del usuario

## Problema

La plataforma ya es multi-escuela por dentro (`School`, `User.school`, todo filtrado por
escuela), pero **por fuera es una sola dirección**. Hoy entran todos por la de San José, y
eso trae tres consecuencias:

1. **La escuela nueva no se siente suya.** Arboit entraría por una URL que dice "San José",
   con la pantalla de login de otra institución. Para ofrecerle la plataforma a una segunda
   y una tercera escuela, la puerta de entrada tiene que llevar su nombre.
2. **La configuración de una escuela está repartida en cuatro pantallas** del superadmin: el
   perfil (`/superadmin/schools/:id`) prende módulos, `Temas` ofrece la paleta, `Roles`
   reparte solapas y el acceso al SOE. No hay un lugar donde se lea "así está parada esta
   escuela".
3. **No hay dónde poner el dominio**, porque el concepto no existe en el modelo.

El pedido concreto del usuario: una solapa **Dominios** en el superadministrador donde cada
escuela tenga su dirección (`arboit.conecta.net`), su configuración propia, sus colores, y
desde donde se vea el equipamiento —la sala de informática de *esa* escuela— que los docentes
pueden reservar.

## La restricción que ordena todo el diseño

> **Hoy entran todos por la dirección de San José, y eso tiene que seguir funcionando.** El
> usuario proyecta un único dominio registrado (`conecta.net`) del que cuelguen los
> subdominios de cada escuela.

Por lo tanto la resolución por dominio es **aditiva y fail-open**: un host que no está mapeado
a ninguna escuela se comporta **exactamente como hoy** (entrada compartida, sin marca previa al
login). Una escuela sin subdominio propio no pierde nada.

Esto es lo contrario del criterio de `config/modulos.js`, que es fail-closed, y la diferencia
es deliberada: ahí el default es "no existe"; acá el default es "seguí como siempre".

## Lo que YA existe (no rehacer)

| Pieza | Dónde vive | Estado |
|---|---|---|
| Escuela con nombre, slug, color, descripción | `models/School.js` | ✅ |
| Módulos opcionales por escuela | `School.modules` + `config/modulos.js` + `middleware/modulos.js` | ✅ |
| **Recursos y reservas separados por escuela** | `models/Recurso.js:20`, `models/Reserva.js:20`, índice único `{school,name}`, rutas que filtran por `escuelaDe(res)` | ✅ |
| Temas visuales ofrecidos por el superadmin y aceptados por el admin | `School.themes` + `/superadmin/themes` + `/admin/theme` | ✅ |
| Permisos de solapas y acceso al SOE por escuela | `School.rolePermissions`, `School.soeAccess` + `/superadmin/roles` | ✅ |
| HTTPS automático por hostname | Caddy en el VPS | ✅ |

**La mitad del pedido ya está construida.** Lo genuinamente nuevo es el **hostname**, la
**marca antes del login** y la **pantalla que unifica**.

## Alcance

### 1. Modelo de datos

```js
// models/School.js
hostnames: [{ type: String, lowercase: true, trim: true }],  // ["arboit.conecta.net"]
logo:      { type: String, default: null },                  // public/archivos/{schoolId}/marca/
```

- **Índice único PARCIAL, no sparse**: `{ hostnames: 1 }` con
  `partialFilterExpression: { hostnames: { $type: 'string' } }`. Así un array vacío y un array
  ausente no chocan entre sí. Con `sparse` a secas volveríamos a pisar la misma piedra que
  `inviteToken`, que está documentada en `models/School.js`: dos escuelas sin enlace chocaban
  en el índice único y el botón "Nueva escuela" nunca había funcionado.
- Normalización al guardar: minúsculas, sin `http://`, sin barra final, sin puerto.
- Array y no string: una escuela puede tener su subdominio y, más adelante, su dominio propio.

### 2. Resolución del host

Middleware nuevo (`middleware/hostSchool.js`), montado en `server.js` **antes** de `checkUser`:

- `req.hostname` → busca en un **índice en memoria** `hostname → schoolId`.
- Publica `res.locals.hostSchool`, el doc de la escuela de la DIRECCIÓN — que es **otra cosa**
  que `res.locals.school`, la escuela del USUARIO (`server.js:395`).
- Host sin mapear → `res.locals.hostSchool = null` → comportamiento de hoy.

**Precedencia, explícita:**

| Situación | Qué manda |
|---|---|
| Sin sesión (login, registro por invitación) | `hostSchool` — es lo único que hay |
| Con sesión, host sin mapear | `user.school` — como hoy |
| Con sesión, host mapeado a la MISMA escuela | Coinciden, sin conflicto |
| Con sesión, host de OTRA escuela | **Decisión D1, abajo** |

### 3. Marca antes del login

Es el resultado visible de toda la feature. `views/login.ejs` y `views/invite-register.ejs`
leen `hostSchool` y pintan nombre, logo y color. Sin `hostSchool`, la pantalla de hoy, intacta.

El logo se sube por **una ruta de subida que ya existe**, con un preset propio en el pipeline
de `sharp`. No inventar un camino nuevo: ya hay seis y cada uno costó un bug.

### 4. Certificados: emisión bajo demanda

Agregar una escuela en el panel **no puede requerir entrar por SSH al servidor**. Caddy resuelve
esto con `on_demand_tls`, que le pregunta a la app antes de emitir:

```
{
	on_demand_tls {
		ask http://127.0.0.1:3000/internal/tls-check
	}
}

https:// {
	tls { on_demand }
	reverse_proxy 127.0.0.1:3000
}
```

Y en la app, `GET /internal/tls-check?domain=` responde 200 si ese hostname pertenece a alguna
escuela y 404 si no. Ruta sin autenticación —la llama Caddy desde localhost— pero **atada a
127.0.0.1** y exenta del rate limit.

> ⚠️ **El `ask` no es opcional.** Sin él, cualquiera que apunte su dominio a la IP del VPS te
> hace emitir un certificado. Con unos cientos de intentos se agota el límite semanal de Let's
> Encrypt y te quedás **sin poder emitir para las escuelas de verdad**.

### 5. La pantalla `/superadmin/dominios`

Una fila por escuela, y al abrirla:

- **Dirección**: los hostnames, con el registro DNS que hay que crear (`A → 169.58.248.255`)
  en un campo copiable, y un botón **Verificar** que consulta si ese nombre ya resuelve a la IP
  del servidor y si el certificado está emitido. Los dos errores que van a pasar siempre son
  "todavía no propagó el DNS" y "lo escribiste con el prefijo del protocolo adelante"; la
  pantalla tiene que decirlos con esas palabras, no con un 500.
- **Marca**: logo y color.
- **Equipamiento**: el interruptor del módulo `recursos` y, si está prendido, la lista de
  recursos de esa escuela (`Recurso.find({ school })`) con su estado — para que el superadmin
  vea de un vistazo que Arboit tiene cargada su sala de informática. Enlace a `/admin/recursos`
  para editarla.
- **Resto de la configuración**: enlaces a `Temas` y a `Roles`, **no** una copia de sus
  controles.

### 6. Nueva solapa en el catálogo

```js
{ key: 'superadmin_dominios', panel: 'superadmin', label: 'Dominios', icon: 'language',
  path: '/superadmin/dominios', roles: ['superadmin'], locked: true },
```

## Fuera de alcance

- **Base de datos por escuela.** Sigue siendo una sola base con todo filtrado por `school`.
- **Wildcard `*.conecta.net`.** Requiere compilar Caddy con el plugin DNS del proveedor y un
  token de API. Con la emisión bajo demanda no hace falta.
- **Comprar o administrar dominios desde el panel.** El registro DNS se crea en Cloudflare.
- **Que el admin de la escuela edite su propio dominio.** Solo el superadmin.

## Las 6 trampas

1. **`res.locals.school` sale del USUARIO, no del host.** A partir de acá conviven dos escuelas
   por request. Todo el código que hoy dice "la escuela" asume la del usuario; cambiarle el
   significado rompe media aplicación. Por eso `hostSchool` es una variable NUEVA y `school`
   no se toca.
2. **El `.select()` de `server.js:395`.** Es la trampa que `models/School.js` documenta cuatro
   veces: un campo que no esté ahí **nunca llega a las vistas**. `hostnames` y `logo` hay que
   sumarlos, o la marca no se pinta y no hay forma de entender por qué.
3. **El caché del host, con PM2 en cluster, son DOS cachés.** El worker que atiende el POST que
   agrega el dominio invalida el suyo; el otro sigue con el índice viejo y la mitad de los
   requests no encuentran la escuela. Es un bug intermitente que depende de a qué worker caiga
   cada request — el peor tipo para diagnosticar. Salidas: TTL corto (30 s) o releer de la base
   cuando el host no está en el índice antes de contestar que no existe. **Preferir el TTL**:
   es la única que no depende de coordinar procesos.
4. **La cookie es host-only** (`routes/auth.js:48`, sin `domain`). Cada dominio es una sesión
   distinta: el superadmin que salta de `arboit.` a `sanjose.` **se loguea de nuevo en cada
   una**, y el impersonate igual. No es un bug, es cómo funcionan las cookies; hay que
   decidirlo a propósito (D3).
5. **El índice único parcial, no sparse** — ver el punto 1 del modelo de datos.
6. **`recursos` ya está separado por escuela**: sus rutas usan `escuelaDe(res)`, que es
   `res.locals.user.school`. Si alguna pantalla nueva pasara a filtrar por `hostSchool`, se
   abriría la puerta a ver el equipamiento de otra escuela. **La autoridad sobre los DATOS
   sigue siendo la escuela del usuario. El host decide la marca y la puerta, nunca el alcance.**

## Decisiones que necesito del usuario

**D1 — Un usuario de San José entra por `arboit.conecta.net`. ¿Qué pasa?**
- (a) **Se le rechaza el login** con "esta dirección es de otra escuela". Recomendado: es el
  sentido de tener un dominio por escuela.
- (b) Entra igual y ve su propia escuela, con la marca de Arboit en el login. Más permisivo y
  más confuso.

**D2 — ¿El panel del superadmin se abre desde cualquier dominio, o solo desde el principal?**
Restringirlo al dominio principal es una capa de seguridad barata.

**D3 — La sesión separada por dominio, ¿la asumimos?** Es consecuencia de cómo funcionan las
cookies. La alternativa —una cookie compartida en `.conecta.net`— une las sesiones de todas las
escuelas, que es peor para la separación.

**D4 — Los colores: ¿esta solapa los edita, o solo los muestra y manda a `Temas`?** Hoy hay dos
sistemas (el `color` de la escuela y los `themes`). Editarlos acá sería el tercer lugar.
Recomiendo **mostrar y enlazar**, no duplicar.

## Criterios de aceptación

1. Una escuela sin `hostnames` se comporta **exactamente como hoy**, por cualquier dirección.
2. Con `arboit.conecta.net` cargado y su DNS apuntando al servidor, esa dirección sirve el login
   **con el nombre, el logo y el color de Arboit**, sin que nadie toque el servidor.
3. El certificado se emite solo, y `/internal/tls-check` responde 404 para un dominio que no
   está en ninguna escuela.
4. Un docente de Arboit ve en `/reservas` **solo los recursos de Arboit**, entre por la
   dirección que entre.
5. Apagar el módulo `recursos` de una escuela le saca la solapa y su ruta contesta 403, sin
   afectar a las otras escuelas.
6. Agregar un hostname que ya usa otra escuela da un error claro, no un 500.
7. `npm run test:unit`, `npm run test:smoke` y `npm run test:roles` en verde, con casos nuevos
   para la resolución del host, el fail-open y el `tls-check`.
