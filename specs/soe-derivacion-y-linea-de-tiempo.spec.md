# SOE — Derivación desde Preceptoría y línea de tiempo del legajo

Estado: **implementada** (2026-08-27) · Módulo: `soe` · Extiende `specs/soe-orientacion.spec.md`

## Problema

Tres cosas que hoy no están, pedidas por el usuario el 2026-08-27:

1. **El preceptor es el que ve al chico todos los días** —llega tarde, faltó tres veces
   seguidas, se peleó en el recreo— y no tiene ninguna forma de avisarle al gabinete dentro
   de la plataforma. Hoy el legajo lo abre **solo el SOE**, por su cuenta, mirando la lista
   de alumnos. El aviso viaja por WhatsApp o en el pasillo, y se pierde.
   La v1 lo dejó explícitamente fuera de alcance (`specs/soe-orientacion.spec.md`, sección
   "Fuera de alcance"): *"Pedido de intervención del docente/preceptor… en la v1 el legajo lo
   abre solo el SOE"*. Esta spec levanta esa decisión, acotada a `preceptor`.

2. **Las actuaciones del SOE están repartidas en dos listas que no se cruzan.** La ficha del
   legajo tiene un panel "Seguimiento" (las entradas) y otro "Derivaciones" (los servicios
   externos con sus devoluciones). Cada uno ordenado por su cuenta. Leído así, no se ve el
   RECORRIDO: no hay una sola pantalla donde se lea que el 3 de marzo fue la entrevista, el
   12 la derivación al hospital, el 2 de mayo la devolución y el 20 la observación de aula.
   El usuario mandó una referencia visual (`Screenshot_5.jpg`): una sola línea vertical con
   la fecha a la izquierda, el círculo con ícono sobre el hilo y la tarjeta con el hito.

3. **El legajo lo pueden ver más roles de los que corresponde.** `School.soeAccess` hoy
   ofrece configurar `directivo` y `admin` hasta `completo`, y `preceptor` y `teacher` hasta
   `resumen`. El usuario acotó: **solo el SOE y el equipo directivo.**

## Alcance

1. **Derivación interna** `preceptor → SOE`: un pedido con motivo y urgencia, desde la ficha
   del alumno del panel de Preceptoría.
2. **Bandeja del SOE**: los pedidos recibidos, que el gabinete **toma** (abre el legajo) o
   **descarta** (con motivo).
3. **Línea de tiempo unificada** en la ficha del legajo: entradas, derivaciones,
   devoluciones, apertura y cierre en un solo hilo cronológico.
4. **Recorte del acceso** al legajo: `soe` y `directivo` (más el `superadmin`, auditado).

### Fuera de alcance (decidido, no olvidado)

- **Derivación desde el rol `teacher`.** El usuario nombró a `preceptor`. Sumar al docente es
  cambiar una línea de la lista de roles, pero multiplica el volumen de la bandeja por veinte
  y esa es una decisión de producto, no técnica.
- **Notificación push o por mensajería al SOE.** El pedido aparece en el resumen de `/soe`,
  que es la pantalla de aterrizaje del rol (`server.js` redirige `/` ahí). Alcanza para la v1.
- **Adjuntos en el pedido.** Mismo motivo que en la spec madre: los adjuntos de hoy se sirven
  por URL adivinable desde disco.
- **Que el preceptor lea algo del legajo.** Es el punto 3 del alcance: no.
- **Exportar la línea de tiempo a PDF.** Sigue fuera, como en la spec madre.

---

## Decisiones de diseño

### D1 — El pedido es una colección propia, no un campo del legajo

`SoeCase` existe **solo cuando el gabinete ya abrió el legajo**. El pedido del preceptor es
justamente lo que llega **antes** de que exista, y sobre un alumno que puede no tener legajo
nunca. Embeberlo en `SoeCase` obligaría a crear el legajo para poder recibir el pedido — que
es exactamente el filtro que la decisión del usuario quiere conservar ("el SOE lo toma o lo
descarta").

Además, la bandeja se lee **cruzando alumnos** ("qué pedidos tengo pendientes en la escuela"),
que es lo contrario de cómo se lee un legajo (entero, de un solo chico). El argumento de
`models/SoeCase.js` para embeber —"un legajo se lee siempre entero"— acá no aplica.

Colección nueva: `SoeRequest` (`models/SoeRequest.js`).

### D2 — Un solo pedido pendiente por alumno, garantizado por índice

Dos preceptores de turnos distintos pueden derivar al mismo chico la misma semana, y el
gabinete terminaría con dos pedidos idénticos. La guarda es un **índice único parcial**, el
mismo patrón que `Reserva` en `specs/recursos-reservas.spec.md`:

```js
soeRequestSchema.index(
  { student: 1 },
  { unique: true, partialFilterExpression: { estado: 'pendiente' } },
);
```

Solo los `pendiente` chocan: tomado o descartado un pedido, se puede volver a derivar al mismo
alumno el mes que viene. La ruta chequea antes y contesta con un mensaje claro; el índice es la
red para los dos clicks simultáneos, no la primera barrera.

### D3 — Tomar el pedido deja un hito INMUTABLE, firmado por el preceptor

Cuando el SOE toma el pedido, el motivo que escribió el preceptor entra al legajo como la
primera entrada del seguimiento, con:

- `tipo: 'derivacion'` — un tipo nuevo, con su ícono propio;
- `autor: pedido.solicitadaPor` — **el preceptor**, no el SOE que lo tomó.

Firmarlo con el preceptor no es un detalle estético: la ruta de edición
(`POST /soe/legajo/:id/entrada/:entryId/editar`) solo deja editar la **propia** entrada. Con el
autor puesto en el preceptor —que no entra al panel del SOE— la entrada queda **inmutable para
todo el mundo**, que es lo que corresponde: es lo que el preceptor dijo, no lo que el gabinete
interpretó.

> ⚠️ **Trampa.** `TIPOS_ENTRADA` es a la vez el enum del schema y la lista que dibuja el
> `<select>` del formulario de "Agregar al seguimiento". Sumarle `'derivacion'` a secas le daría
> al SOE la posibilidad de fabricar a mano una derivación de preceptoría que nunca existió. Por
> eso se parte en dos:
> - `TIPOS_ENTRADA` → el enum completo (lo que el modelo acepta), con `'derivacion'` adentro;
> - `TIPOS_ENTRADA_MANUALES` → lo que ofrece el formulario y lo que valida `deLista()` en
>   `POST /soe/legajo/:id/entrada`, **sin** `'derivacion'`.
>
> Es el mismo razonamiento por el que `deLista()` no confía en el `<select>` del cliente.

### D4 — El preceptor ve el ESTADO de su pedido, y nada más

Después de derivar, el preceptor ve en la ficha del alumno y en su solapa "Derivaciones al SOE":

| Ve | No ve |
|---|---|
| Motivo y urgencia que él mismo escribió | Si el alumno tiene legajo abierto (ni antes ni después) |
| Estado: `pendiente` / `tomada` / `descartada` | Una sola línea del legajo |
| Fecha en que el SOE lo resolvió | Quién lo atendió del gabinete |
| El campo `respuesta` que el SOE le escriba | Entradas, derivaciones, devoluciones, ánimo |

`respuesta` es el **único** canal de vuelta, y el formulario del SOE lo rotula como tal
("Esto lo lee el preceptor"), para que nadie escriba ahí un dato clínico creyendo que queda
adentro del gabinete. Máximo 500 caracteres, opcional al tomar, **obligatorio al descartar**:
un pedido que se descarta sin decir por qué le enseña al preceptor a no volver a derivar.

### D5 — El acceso al legajo se recorta a `soe` + `directivo`

Cambio en `services/soeAcceso.js`, que es la fuente única:

```js
const TECHO_POR_ROL = { directivo: COMPLETO };   // antes: + admin, preceptor, teacher
const ROLES_CONFIGURABLES = ['directivo'];       // antes: los cuatro
```

Consecuencias, todas automáticas porque el resto lee del catálogo:

- `nivelAcceso()` devuelve `NINGUNO` para `admin`, `preceptor` y `teacher` **siempre**, aunque
  la base tenga el valor viejo escrito. La tabla es la que vale (ya estaba comentado así).
- `/superadmin/roles` deja de pintar esas tres filas (la vista itera `ROLES_CONFIGURABLES`).
- `POST /superadmin/roles/soe-access` rechaza esos roles con 400 (ya valida contra el catálogo).
- `models/School.js` pierde los tres subcampos de `soeAccess`. El dato viejo que haya en Mongo
  queda huérfano y no se lee: doble cierre, schema y tabla.
- `config/sections.js`: `soe_dashboard` y `soe_alumnos` quedan en
  `['soe', 'directivo', 'superadmin']`. Es cosmético (`sectionGuard` es fail-open y la puerta
  real la abre `requireSoe`), pero el catálogo no puede mentir sobre quién entra.

**El `superadmin` sigue entrando**, con el mismo argumento del D3 de la spec madre: tiene la
base entera con `mongosh` y negarle la pantalla sería teatro. Su lectura queda auditada como
`soe.view_case`, la del `directivo` también, y la del propio `soe` no.

> ⚠️ Esto es un **recorte de permisos en producción**. Una escuela que hoy tenga
> `soeAccess.admin = 'completo'` pierde ese acceso al desplegar. Es el pedido explícito del
> usuario. No requiere migración: nada se borra de la base, simplemente deja de leerse.

### D6 — La línea de tiempo se arma en una función pura

`services/soeLinea.js` → `construirLinea(legajo, { orden })` recibe el legajo **ya sanitizado**
y devuelve un array de hitos planos:

```js
{ tipo, fecha, titulo, texto, icono, animo, autor, meta, refId }
```

Pura, sin mongoose y sin fecha del sistema: se testea con `node --test` sin base, que es la
regla de la casa para toda lógica que decide qué se ve.

**Que reciba el legajo sanitizado no es un detalle**: es lo que garantiza que la línea de
tiempo no pueda inventar una puerta nueva a los datos clínicos. Si mañana vuelve un nivel
`resumen`, `sanitizarLegajo` no le entrega `entries` ni `referrals` y la función devuelve `[]`
sola, sin ninguna regla propia que mantener sincronizada.

Hitos que se mezclan en un solo hilo:

| Hito | Fecha que ordena | De dónde sale |
|---|---|---|
| `apertura` | `openedAt` | El legajo. Texto: el `motivo` |
| `entrada` | `entries[].fecha` (la del HECHO) | Una por entrada, con su ánimo y su tipo |
| `derivacion` | `referrals[].fecha` | Una por derivación, con destino y estado actual |
| `devolucion` | `referrals[].devoluciones[].fecha` | **Hito propio**, no anidado |
| `cierre` | `closedAt` | Texto: el `cierreMotivo` |

La **devolución va como hito propio** y no adentro de la tarjeta de la derivación porque llega
meses después: dibujada dentro de la derivación, la fecha en que el hospital contestó
desaparece del hilo, que es exactamente el dato que la spec madre dice que hoy se pierde.

**La reapertura no tiene hito**, y es una limitación conocida: `POST /legajo/:id/reabrir` pone
`closedAt` y `closedBy` en `null`, así que no queda ninguna fecha con la que dibujarla. Se
anota en las preguntas abiertas.

### D7 — El orden por defecto es "lo último arriba", y se invierte sin recargar

Decisión del usuario. Para el trabajo diario importa lo último; para entender al chico, la
historia desde el principio. Un botón da vuelta la lista y la deja como el `Screenshot_5.jpg`.

> ⚠️ **Trampa del hilo.** El hilo se dibuja con `li::before` por ítem y se apaga en
> `:last-child`. Con la lista invertida (`flex-direction: column-reverse`), `:last-child` pasa
> a ser el ítem visualmente **primero** y el hilo queda cortado arriba en vez de abajo.
>
> **Corregido durante la implementación:** el diseño original de esta spec proponía mover el
> hilo al CONTENEDOR (`ol::before`, de `top:27px` a `bottom:27px`). No sirve, y se vio recién
> al medirlo en el navegador: desde el contenedor, `bottom` se mide contra el borde del `<ol>`,
> y el último ítem es tan alto como su TARJETA, no como su círculo — el hilo quedaba colgando
> unos 80px por debajo del último hito. Queda por ítem, con `top: 27px; bottom: -27px` (el
> negativo estira el tramo hasta el centro del círculo siguiente), más dos reglas que invierten
> cuál extremo se apaga:
>
> ```css
> .linea li:last-child::before             { display: none; }
> .linea.invertida li:last-child::before   { display: block; }
> .linea.invertida li:first-child::before  { display: none; }
> ```
>
> ⚠️ Y una segunda, encontrada en el mismo camino: **una media query no suma especificidad**.
> El reposicionamiento del hilo para móvil quedó sin efecto hasta moverlo *detrás* de la regla
> base en el archivo — con igual especificidad, gana la última del documento.

La preferencia se guarda en `localStorage` dentro de `try/catch` (un navegador con el
almacenamiento bloqueado tiene que dibujar la lista igual, en el orden por defecto).

### D8 — Color en las tarjetas: acento y tinte, nunca pastel saturado

El `Screenshot_5.jpg` usa tarjetas pastel saturadas con texto oscuro encima. Copiado tal cual,
en modo oscuro el texto desaparece: es exactamente el bug de contraste **1,10:1** que ya pasó
en la sala en vivo. La regla de la casa: **un fondo en hex obliga a declarar su color de texto
en hex**, y un color inline le gana a la variante oscura.

Adaptación: cada tipo de hito aporta un **borde de acento a la izquierda** (4px) y un tinte de
muy baja opacidad del mismo color (`#13733310`), sobre `var(--surface)`. El texto sigue en
`var(--text)` y los dos modos quedan legibles sin una sola declaración de color duplicada. El
color va **por clase**, nunca por `style=` inline — misma razón que el círculo de ánimo.

---

## Modelo

### `models/SoeRequest.js` (nuevo)

```js
const soeRequestSchema = new Schema({
  student:  { type: ObjectId, ref: 'User',     required: true },
  school:   { type: ObjectId, ref: 'School',   required: true },
  // Snapshot para listar la bandeja sin joins. NO se usa para autorizar: igual que en
  // SoeCase, el alcance se resuelve contra las divisiones ACTUALES del alumno.
  division: { type: ObjectId, ref: 'Division', default: null },

  motivo:   { type: String, trim: true, required: true, maxlength: 2000 },
  urgencia: { type: String, enum: ['baja', 'media', 'alta'], default: 'media' },
  estado:   { type: String, enum: ['pendiente', 'tomada', 'descartada'], default: 'pendiente' },

  solicitadaPor: { type: ObjectId, ref: 'User', required: true },

  resueltaPor: { type: ObjectId, ref: 'User',    default: null },
  resueltaEl:  { type: Date,                     default: null },
  soeCase:     { type: ObjectId, ref: 'SoeCase', default: null },

  // El ÚNICO texto del gabinete que lee el preceptor. Ver D4.
  respuesta: { type: String, trim: true, default: '', maxlength: 500 },
}, { timestamps: true });

soeRequestSchema.index({ student: 1 }, { unique: true, partialFilterExpression: { estado: 'pendiente' } });
soeRequestSchema.index({ school: 1, estado: 1, createdAt: -1 });   // la bandeja
soeRequestSchema.index({ solicitadaPor: 1, createdAt: -1 });       // "mis pedidos"
```

### `models/SoeCase.js`

Sin cambios de forma. `entrySchema.tipo` acepta un valor más porque `TIPOS_ENTRADA` crece.

### `models/School.js`

`soeAccess` queda con un solo subcampo:

```js
soeAccess: {
  directivo: { type: String, enum: ['none', 'resumen', 'completo'], default: 'none' },
},
```

---

## Rutas

### Preceptoría (`routes/preceptor.js`)

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/preceptor/students/:id/derivar-soe` | Crea el pedido. Valida alcance con el `alumnoEnAlcance(student._id, req.scopeDivisionIds)` local del archivo. Rechaza si ya hay uno `pendiente`. |
| `GET` | `/preceptor/soe` | Los pedidos hechos por **este** preceptor, con su estado. |

### SOE (`routes/soe.js`)

| Método | Ruta | Guarda | Qué hace |
|---|---|---|---|
| `GET` | `/soe/pedidos` | `requireCompleto` | La bandeja: pendientes arriba, después el historial. |
| `POST` | `/soe/pedidos/:id/tomar` | `requireEscrituraSoe` | Abre el legajo si no existe (idempotente, como `/abrir`), empuja el hito del D3, marca `tomada`, guarda `soeCase` y la `respuesta` opcional. |
| `POST` | `/soe/pedidos/:id/descartar` | `requireEscrituraSoe` | Marca `descartada`. **Exige `respuesta`.** No toca ningún legajo. |

Las dos de escritura validan el alcance del pedido igual que las del legajo: se resuelve el
alumno con `alumnoEnScope(req, pedido.student)` y se contesta 403 si queda afuera. El `estado`
se chequea antes de escribir: tomar un pedido ya tomado no vuelve a empujar el hito.

Auditoría: `soe.request_in` (lo crea el preceptor), `soe.request_take`, `soe.request_drop`.

---

## Pantallas

### 1. Ficha del alumno en Preceptoría — `views/preceptor/student-detail.ejs`

Un bloque nuevo al final. Tres estados posibles:

- **Sin pedido pendiente** → botón "Derivar al SOE" que despliega el formulario (motivo +
  urgencia). Debajo, una nota: *"El gabinete recibe el pedido y decide si abre el seguimiento.
  Vos vas a ver el estado, no el legajo."* Es la expectativa, escrita antes de que la pregunte.
- **Con pedido pendiente** → el motivo enviado, la fecha y un chip "Esperando al gabinete".
- **Resuelto** → chip `Tomada` / `Descartada`, la fecha y la `respuesta` del SOE si la hay.

### 2. Solapa nueva de Preceptoría — `views/preceptor/soe.ejs`

`preceptor_soe` · label "Derivaciones al SOE" · ícono `psychology` ·
`roles: ['preceptor', 'directivo', 'admin', 'superadmin']`.

Tabla de los pedidos propios: alumno, curso, fecha, urgencia, estado, respuesta. Nada más.

### 3. Bandeja del SOE — `views/soe/pedidos.ejs`

`soe_pedidos` · label "Pedidos" · ícono `move_to_inbox` · `roles: ['soe', 'directivo', 'superadmin']`.

Una tarjeta por pedido pendiente, ordenadas por urgencia y después por antigüedad —
**el más viejo primero** dentro de cada urgencia: en una bandeja lo que hay que evitar es que
algo se quede abajo para siempre. Cada una con el alumno (link a su ficha), quién derivó,
cuándo, el motivo completo, y los dos botones.

En `/soe` (el resumen) se suma la tarjeta **"Pedidos sin atender"**, al lado de las
derivaciones vencidas y los repasos. Es el aviso: el rol `soe` aterriza ahí.

### 4. Línea de tiempo — `views/soe/legajo.ejs`

Reemplaza al panel "Seguimiento". El panel "Derivaciones" **se queda**: es donde viven los
formularios para cambiar el estado y cargar devoluciones, y esas son pantallas de gestión, no
de lectura. La línea de tiempo es la lectura; el panel de derivaciones, el escritorio. Cada
tarjeta de derivación de la línea linkea a su ficha de gestión (`#deriv-<id>`).

Anatomía de un hito, siguiendo el `Screenshot_5.jpg`:

```
 12 mar        ┌─────────────────────────────────────────┐
 2026     ●────│ ENTREVISTA                    ◦ Bien    │
   │      │    │ Se habló de la situación en casa…       │
   │      │    │ Laura Gómez · 12/03/2026                │
   │           └─────────────────────────────────────────┘
   │  (hilo)
 20 mar       ┌──────────────────────────────────────────┐
 2026     ●───│ DERIVACIÓN · Hospital Zonal              │
              │ …                                        │
```

- **Columna izquierda**: la fecha en dos renglones (día + mes, año abajo). **No rotada**: el
  texto vertical del `Screenshot_5.jpg` se recorta contra el `overflow-x: hidden` del body en
  pantallas chicas, que es un problema ya conocido del proyecto. El año suelto lo imprime
  `fmt.anio`, agregado a `services/liveRoom.js` con su gemelo `Fecha.anio` en el navegador —
  el test de zona horaria exige el par.
- **Círculo**: ícono por tipo de hito; el tinte de **ánimo** solo en los hitos `entrada`, con
  las clases que ya existen (`.animo-bien`, `.animo-altibajos`, `.animo-preocupante`).
- **Tarjeta**: borde de acento por tipo de hito (D8).
- **En móvil (`max-width: 700px`)** la columna de fecha se pliega: la fecha pasa a ser un
  renglón chico arriba del título y el hilo se corre al borde.

Arriba del hilo, la barra de la línea: el contador de hitos y el botón de invertir el orden
(`swap_vert`, con `aria-pressed`).

---

## Criterios de aceptación

### Reglas puras — `tests/unit/soeLinea.test.js`

1. Un legajo con entradas, derivaciones y devoluciones devuelve **un hito por cada una**, más
   el de apertura.
2. Los hitos salen ordenados por fecha descendente con `orden: 'reciente'` y ascendente con
   `orden: 'cronologico'`.
3. Una devolución cargada seis meses después de su derivación aparece **en su propia fecha**,
   no junto a la derivación.
4. Un legajo cerrado suma el hito `cierre` con el `cierreMotivo`; uno abierto no lo tiene.
5. Un legajo sanitizado en nivel `resumen` (sin `entries` ni `referrals`) devuelve `[]` —
   sin ninguna regla propia de confidencialidad adentro de la función.
6. Una entrada con `animo: null` produce un hito sin tinte, no un hito roto.
7. `construirLinea(null)` devuelve `[]`.

### Reglas puras — `tests/unit/soeAcceso.test.js` (adecuar los existentes)

8. `nivelAcceso(escuela, 'admin')` devuelve `'none'` **aunque la escuela tenga
   `soeAccess.admin = 'completo'`** escrito a mano en la base.
9. Ídem `preceptor` y `teacher` con `'resumen'`.
10. `ROLES_CONFIGURABLES` es exactamente `['directivo']`.
11. `nivelAcceso(escuela, 'soe')` y `'superadmin'` siguen dando `'completo'`. Sin regresión.

### Reglas puras — `tests/unit/soePedido.test.js`

12. `TIPOS_ENTRADA` contiene `'derivacion'`; `TIPOS_ENTRADA_MANUALES` **no**.
13. Todo lo de `TIPOS_ENTRADA_MANUALES` está en `TIPOS_ENTRADA` (no se puede ofrecer en el
    formulario algo que el schema rechace).
14. Cada tipo de `TIPOS_ENTRADA` tiene label e ícono.

### Servidor — `tests/smoke/` (flujo `soe-derivacion-preceptor`)

15. El preceptor deriva un alumno de su alcance → 302 y queda un `SoeRequest` `pendiente`.
16. El preceptor deriva un alumno **fuera** de su alcance → 403 y no se crea nada.
17. Un segundo pedido para el mismo alumno con uno pendiente → **no** crea un segundo.
18. Con el pedido resuelto, un pedido nuevo para ese alumno **sí** se crea.
19. El SOE ve el pedido en `/soe/pedidos`.
20. El SOE lo **toma** → el legajo del alumno existe, tiene la entrada `tipo: 'derivacion'`
    con el texto del preceptor y `autor` = el preceptor, y el pedido queda `tomada` con
    `soeCase` apuntando al legajo.
21. Tomar un pedido **ya tomado** no agrega una segunda entrada.
22. El SOE **descarta** sin `respuesta` → no cambia de estado.
23. El SOE descarta con `respuesta` → `descartada`, y **no existe** legajo para ese alumno.
24. El preceptor ve `tomada` y la `respuesta` en `/preceptor/soe`.
25. El preceptor **sigue recibiendo 403** en `/soe/legajo/<alumno>` después de derivarlo.
26. Un `POST /soe/legajo/:id/entrada` con `tipo=derivacion` guarda la entrada como `'nota'`
    (el tipo se descarta: no es de la lista manual).

### Matriz de roles — `tests/roles/check-roles.js`

27. `admin`, `preceptor` y `teacher` reciben **403** en `/soe`, `/soe/alumnos`,
    `/soe/pedidos` y `/soe/derivaciones`, **con la escuela configurada o sin configurar**.
    La excepción documentada del paso 3 se actualiza: ya no es "403 porque `soeAccess` arranca
    en `none`", es "403 siempre, el rol salió del catálogo".
28. `directivo` con `soeAccess.directivo = 'completo'` entra a `/soe` y a `/soe/pedidos`, y
    recibe 403 en todos los POST de escritura del panel.

### Interfaz

29. En nivel `completo` la ficha muestra **una sola** lista de hitos, no dos.
30. El botón de invertir da vuelta el hilo sin recargar, y el hilo queda dibujado completo en
    los dos órdenes (ningún extremo suelto).
31. Con `localStorage` bloqueado, la lista se dibuja igual en el orden por defecto.
32. En `max-width: 700px` la columna de fecha se pliega y el `<body>` **no** scrollea en
    horizontal (`tests/unit/movil.test.js` — el patrón ya está).
33. Contraste ≥ 4,5:1 del texto de cada tarjeta de hito en los dos modos.
    Medido: **14,6:1** el título y el cuerpo en claro y en oscuro. El renglón de meta (fecha y
    autor) pasó de `--text-hint` a `--text-secondary` para llegar: hint daba **2,39:1** sobre
    el fondo de la tarjeta en modo claro. `--text-hint` está por debajo del mínimo en todo el
    proyecto, no solo acá — queda anotado como tarea aparte.
34. La ficha del alumno del preceptor **no** dice si el alumno tiene legajo, en ningún estado.

---

## Archivos

**Nuevos**
- `models/SoeRequest.js`
- `services/soeLinea.js`
- `views/soe/pedidos.ejs`
- `views/preceptor/soe.ejs`
- `tests/unit/soeLinea.test.js`
- `tests/unit/soePedido.test.js`

**Modificados**
- `services/soeAcceso.js` — `TECHO_POR_ROL`, `ROLES_CONFIGURABLES`, `TIPOS_ENTRADA` +
  `TIPOS_ENTRADA_MANUALES`, labels e íconos del tipo nuevo
- `models/School.js` — `soeAccess` queda con `directivo`
- `models/SoeCase.js` — comentario del tipo `'derivacion'`
- `config/sections.js` — recorte de `soe_*`; alta de `soe_pedidos` y `preceptor_soe`
- `routes/soe.js` — bandeja, tomar, descartar, tarjeta en el resumen, `deLista` con la lista manual
- `routes/preceptor.js` — derivar y "mis pedidos"
- `views/soe/legajo.ejs` — la línea de tiempo reemplaza al panel Seguimiento
- `views/soe/index.ejs` — tarjeta "Pedidos sin atender"
- `views/partials/soe-styles.ejs` — el hilo pasa al contenedor; estilos de hito
- `views/partials/soe-nav.ejs`, `views/preceptor/student-detail.ejs`
- `tests/unit/soeAcceso.test.js`, `tests/roles/check-roles.js`, `tests/smoke/specs.js`
- `agente.md` — changelog

---

## Preguntas abiertas

- **La reapertura no deja rastro** (D6). Arreglarlo pide un campo nuevo en `SoeCase`
  (`reaperturas: [{ fecha, por }]`) y es una tanda aparte.
- **¿El pedido descartado se le puede volver a mandar al mismo SOE?** Hoy sí, sin límite. Si
  aparece el caso de un preceptor insistiendo, se acota después.
- **Urgencia `alta` no dispara nada** más que el orden de la bandeja. Si hace falta un aviso
  real (mensaje interno al gabinete), es otra tanda.
