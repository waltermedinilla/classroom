# Umbrales configurables del panel directivo

> **Parte del lote de 4 specs del panel directivo.** Orden sugerido de aprobación:
> `directivo-graficos` → **`directivo-umbrales`** (esta) → `directivo-riesgo` →
> `directivo-informe-impresion`.
>
> **Por qué está separada:** es la única de las cuatro que **escribe** (nuevo campo en
> `School`, nuevo POST, nueva acción auditable, invalidación de cache) y la única que
> cambia el comportamiento de pantallas que ya están en producción. Su gate de aprobación
> humano es distinto: acá se decide *quién puede configurar qué*, no cómo se ve un gráfico.

## Objetivo

Que cada escuela pueda ajustar, con su propio criterio pedagógico, los números que hoy
están hardcodeados en `routes/directivo.js` y que definen cuándo un alumno aparece marcado
como "Bajo rendimiento", "Silencioso" o "Muchas tardías", y cuándo una actividad vencida
sin calificar entra en las alertas del panel — sin tocar código ni redesplegar.

## Responsabilidades

- Definir el **catálogo único** de umbrales configurables (`config/directivo-thresholds.js`)
  con sus valores por defecto, rangos válidos, unidades y textos en español.
- Definir **dónde se guardan** (`School.directivoThresholds`) y **quién los edita**.
- Definir la **pantalla de ajustes** (`GET/POST /directivo/settings`) con su entrada en
  `config/sections.js` y en el nav.
- Definir la **resolución** de umbrales (defaults + lo guardado) para las rutas que hoy
  usan constantes.
- Definir la **acción auditable** `school.directivo_thresholds_update`.
- Garantizar que **una escuela que nunca configura nada vea exactamente los mismos números
  que hoy**.

## No responsabilidades

- **No cambia ninguna métrica ni ninguna fórmula.** Solo hace variable un número que hoy es
  constante. La definición de "tardía" (`updatedAt > activity.dueDate`,
  `routes/directivo.js:405-421`), de "entrega" o de "promedio normalizado" no se toca.
- **No configura los pesos ni los cortes del score de riesgo** (`directivo-riesgo.spec.md`):
  esos quedan como constantes documentadas en su service. Ver *Decisiones abiertas*.
- **No convierte el panel directivo en un panel de escritura sobre datos institucionales.**
  El único write posible sigue siendo la configuración de su propia vista. Alumnos,
  materias, notas y divisiones siguen siendo de solo lectura para este rol.
- **No toca `School.settings`** (namespace del admin) ni `School.rolePermissions`
  (namespace del superadmin). Ver RN-01.
- No agrega umbrales por usuario ni por división: la configuración es **por escuela** (RN-02).

## Entidades/Schemas

### Nuevo catálogo: `config/directivo-thresholds.js`

Fuente única de verdad, con el mismo criterio que `config/sections.js` y
`config/audit-actions.js`: lo leen la vista, la validación del POST y la resolución en las
rutas, y no pueden desincronizarse.

```js
const THRESHOLDS = [
  { key: 'lowAvg',        default: 6,  min: 0, max: 10,  step: 0.1, tipo: 'decimal',
    label: 'Promedio de bajo rendimiento',
    help:  'Un alumno se marca "Bajo rendimiento" si su promedio normalizado es menor a este valor.',
    unidad: 'puntos (0-10)' },
  { key: 'silentDays',    default: 30, min: 1, max: 180, step: 1,   tipo: 'entero',
    label: 'Ventana de silencio',
    help:  'Un alumno se marca "Silencioso" si no hizo ninguna entrega en esta cantidad de días.',
    unidad: 'días' },
  { key: 'latePct',       default: 30, min: 1, max: 100, step: 1,   tipo: 'entero',
    label: 'Porcentaje de entregas tardías',
    help:  'Un alumno se marca "Muchas tardías" si supera este porcentaje de entregas fuera de plazo.',
    unidad: '%' },
  { key: 'lateMinSubs',   default: 3,  min: 1, max: 50,  step: 1,   tipo: 'entero',
    label: 'Mínimo de entregas para evaluar tardanza',
    help:  'Por debajo de esta cantidad de entregas no se evalúa la tardanza, para no marcar a un alumno por una sola entrega.',
    unidad: 'entregas' },
  { key: 'ungradedDays',  default: 15, min: 1, max: 120, step: 1,   tipo: 'entero',
    label: 'Antigüedad de "vencida sin calificar"',
    help:  'Una actividad vencida y sin ninguna nota cargada entra en las alertas después de esta cantidad de días.',
    unidad: 'días' },
];

// resolveThresholds(school) → { lowAvg, silentDays, latePct, lateMinSubs, ungradedDays }
// Mezcla los defaults del catálogo con lo guardado en school.directivoThresholds.
// Descarta valores fuera de rango o no numéricos: nunca devuelve algo inválido.
```

**Todos los defaults son exactamente los valores hardcodeados de hoy**, verificados en el
código: `lowAvg = 6` (`routes/directivo.js:459`), `silentDays = 30`
(`routes/directivo.js:380`, `monthAgo`), `latePct = 30` y `lateMinSubs = 3`
(`routes/directivo.js:461`), `ungradedDays = 15` (`routes/directivo.js:31` y `:613`,
`twoWeeksAgo`).

### Campo nuevo en `models/School.js`

```js
// Umbrales del panel directivo, que edita el propio DIRECTIVO desde /directivo/settings.
// Formato: { <key del catálogo>: <número> } — se guardan SOLO los que la escuela cambió.
// Campo ausente o key ausente = default del catálogo (config/directivo-thresholds.js),
// por eso las escuelas existentes no necesitan migración y su panel no cambia ni un número.
//
// Por qué NO va adentro de `settings`: ese namespace lo edita el ADMIN desde /admin/tasks
// (lista blanca TASK_SETTINGS en routes/admin.js) y castea todo a booleano. Estos son
// números y los edita otro rol. Mismo criterio, ya escrito, que separó `rolePermissions`
// de `settings`: un namespace por dueño (ver el comentario de rolePermissions más abajo).
//
// Ojo: mismo caveat que `settings` y `rolePermissions` — hay que sumarlo al .select()
// de server.js que arma res.locals.school, o el campo nunca llega a las rutas.
directivoThresholds: { type: Schema.Types.Mixed, default: undefined },
```

Se elige `Mixed` con `default: undefined` (y no un sub-schema con defaults) por el mismo
motivo que `rolePermissions` (`models/School.js:45-61`): sumar un umbral nuevo al catálogo
no obliga a migrar escuela por escuela, y una key vieja que ya no exista se ignora sola.

### Nueva entrada en `config/sections.js`

```js
{ key: 'directivo_settings', panel: 'directivo', label: 'Ajustes', icon: 'tune',
  path: '/directivo/settings', roles: ['directivo', 'admin', 'superadmin'] },
```

Sin `locked`: una escuela puede querer que su directivo no toque los umbrales, y entonces
el superadmin apaga la solapa desde `/superadmin/roles`. Como `sectionGuard('directivo')`
cubre GET y POST bajo el mismo `path` (`middleware/sections.js:36-53`), apagar la solapa
apaga también el POST. No hace falta ninguna guarda extra.

### Nueva entrada en `config/audit-actions.js`

```js
'school.directivo_thresholds_update': { label: 'cambió los umbrales del panel directivo',
  icon: 'rule', color: '#1a73e8', category: 'school' },
```

Convención `<entidad>.<verbo>`, alineada con `school.settings_update` y
`school.role_permissions_update`, que son las otras dos acciones de configuración por
escuela.

## Entradas

### `GET /directivo/settings`
- Sesión de un usuario con rol `directivo`, `admin` o `superadmin` (`middleware/directivo.js`).
- `res.locals.user.school` — obligatorio; sin escuela se renderiza `directivo/no-school`
  (mismo comportamiento que el resto del panel, `routes/directivo.js:27`).

### `POST /directivo/settings`
- Body JSON: `{ key: String, value: Number|String }` — un umbral por request.
  Se elige el mismo formato de `POST /admin/tasks/settings` (`routes/admin.js:1556-1584`)
  para que la vista pueda guardar con un `fetch` por control, sin formulario completo.
- Body JSON alternativo para restablecer: `{ reset: true }` — devuelve todos los umbrales
  de la escuela a los valores por defecto (espejo de `POST /superadmin/roles/reset`).

## Salidas

### `GET /directivo/settings`
`views/directivo/settings.ejs`, renderizada con:
```
{ thresholds: [ ...catálogo, con `value` resuelto y `esDefault: Boolean` ],
  activePage: 'settings' }
```
La vista **itera el catálogo**, no hardcodea controles (mismo criterio que
`views/admin/tasks/index.ejs`, que itera sobre `school.settings`). Cada umbral muestra:
label, valor actual, unidad, texto de ayuda, y una marca cuando difiere del default.

### `POST /directivo/settings`
- Éxito: `200` con `{ ok: true, thresholds: { ...resueltos } }`.
  **Devuelve los umbrales ya resueltos** (no solo el que se cambió) para que el cliente no
  tenga que releer: `res.locals.school` va cacheado 45 s **por worker de PM2**
  (`middleware/cache.js:3-13`) y un GET inmediato puede caer en otro worker y devolver el
  valor viejo. Ver *Riesgos*.
- Errores: JSON `{ error: '<mensaje en español>', code: '<CODIGO_EN_INGLES>' }`.
  El campo `error` conserva la forma que ya devuelven los demás POST del proyecto; `code`
  se **suma** (no reemplaza) para cumplir la convención de códigos en `SCREAMING_SNAKE`.

## Reglas de negocio

- **RN-01 — Namespace propio, porque el dueño es otro.** Los umbrales NO van en
  `School.settings`. El propio schema ya dejó escrita la regla al separar
  `rolePermissions`: *"Por qué NO va adentro de `settings`: ese namespace lo edita el ADMIN
  de la escuela desde /admin/tasks (lista blanca TASK_SETTINGS en routes/admin.js). Si esto
  viviera ahí, sumar una key a esa lista por error le daría al admin la llave para
  desbloquearse sus propias solapas. Son dos dueños distintos, dos campos distintos."*
  (`models/School.js:54-57`). Acá pasa lo mismo, y además `TASK_SETTINGS` castea todo a
  booleano (`routes/admin.js:1561`), lo que directamente no sirve para números.
  **Un namespace por dueño no rompe el patrón: es el patrón.**

- **RN-02 — Configuración por ESCUELA, no por usuario.** Aunque el directivo sea quien la
  edita, el valor se guarda en `School`. Tres motivos: (1) la restricción multi-tenant del
  proyecto es que todo esté scoped a `school`; (2) si dos directivos de la misma escuela
  tuvieran umbrales distintos, el mismo alumno estaría "en riesgo" para uno y no para el
  otro, y el informe que se lleva a una reunión dejaría de ser institucional; (3) el
  criterio de aprobación es una decisión pedagógica de la escuela, no una preferencia
  personal.

- **RN-03 — Lo edita el DIRECTIVO (y quien más entre a su panel).** La pantalla vive en el
  panel directivo y hereda su guarda (`requireDirectivo` acepta `directivo`, `admin` y
  `superadmin`, `middleware/directivo.js:5`). Fundamento:
  - El radio de daño es nulo: estos números solo cambian **etiquetas de una pantalla de
    solo lectura que únicamente ven directivo/admin/superadmin**. No cambian notas, no
    cambian permisos, no cambian nada que vea un alumno o un docente.
  - Es su herramienta de diagnóstico: hacerlo depender del admin agrega fricción sin
    ganancia de seguridad.
  - No hay que elegir entre "directivo" y "admin": el admin también entra al panel
    directivo, así que con esta ubicación **los dos** pueden configurarlo, y el superadmin
    puede quitarle la solapa al directivo por escuela si alguna quiere ese control.
  - Contraparte honesta: es el **primer POST** del panel directivo. La frase "panel de solo
    lectura" pasa a significar "de solo lectura sobre los datos institucionales". Queda
    escrito acá y en el encabezado de `routes/directivo.js`.

- **RN-04 — Los defaults son los valores de hoy, sin excepción.** Una escuela que nunca
  entre a la pantalla tiene que ver **exactamente** los mismos conteos que antes del
  cambio. Es el criterio *fail-open* que ya usa `isDenied()` (`config/sections.js:105-113`)
  y el mismo motivo por el que `rolePermissions` guarda las denegadas y no las habilitadas.

- **RN-05 — Se guardan solo los umbrales cambiados.** Si un valor coincide con el default,
  se hace `$unset` de esa key en vez de guardarlo. Así, si algún día se decide cambiar un
  default, las escuelas que nunca lo tocaron heredan el nuevo, y las que lo ajustaron a
  propósito conservan el suyo.

- **RN-06 — Validación en el servidor, siempre, contra el catálogo.** La key tiene que
  existir en `THRESHOLDS`; el valor tiene que ser numérico y estar en `[min, max]`; los de
  `tipo: 'entero'` se redondean con `Math.round` y se revalidan. Nunca se persiste el body
  crudo. Es literalmente el criterio ya escrito en `routes/admin.js:1552-1553` (*"La key se
  valida contra una lista blanca y el value se castea… nunca se persiste el body crudo"*).

- **RN-07 — Toda escritura invalida el cache de la escuela.** `invalidateSchool(schoolId)`
  después del update, obligatorio: `res.locals.school` va cacheado
  (`middleware/cache.js`). Sin esto, el directivo guarda, recarga y sigue viendo lo viejo.

- **RN-08 — Toda escritura se audita.** `logAudit(req, 'school.directivo_thresholds_update',
  [{ type: 'school', id, name }], { umbral: key, valor: nuevo, anterior: previo })`.
  El reset usa `{ umbral: 'todos' }` (espejo de `{ seccion: 'todas' }` en
  `routes/roles.js:135`).

- **RN-09 — Los umbrales resueltos se aplican en TODOS los lugares que hoy usan la
  constante, sin excepción**, o la pantalla mentiría:

  | Umbral | Dónde se aplica hoy (hardcodeado) |
  |---|---|
  | `lowAvg` | `routes/directivo.js:459` (`flags.bajo`) |
  | `silentDays` | `routes/directivo.js:380` (`monthAgo`) → `:400` (aggregate del mes) → `:455,460` (`flags.silencioso`) |
  | `latePct` + `lateMinSubs` | `routes/directivo.js:461` (`flags.tardias`) |
  | `ungradedDays` | `routes/directivo.js:31` + `:76-80` (tarjeta del dashboard) y `:613` + `:659-666` (columna del listado de docentes) |

  **Fuera de alcance explícito:** las cuentas de "vencidas sin calificar" de
  `GET /directivo/courses` (`:136-143`) y `GET /directivo/divisions` (`:956-960`) usan
  `dueDate < ahora` **sin** ventana de días — son una métrica distinta ("vencida y sin
  calificar", no "hace más de N días") y **no se tocan**. Si se tocaran, cambiarían números
  que hoy el directivo ya lee.

- **RN-10 — La UI dice qué significa cada número y cuál es el valor por defecto.** Cada
  control muestra su `help` y una marca "por defecto: N" cuando fue modificado. Un umbral
  sin explicación es un número mágico movido de lugar, no una configuración.

- **RN-11 — Los textos de las etiquetas no cambian.** Los chips siguen diciendo "Bajo
  rendimiento", "Silenciosos" y "Muchas tardías" (`views/directivo/students.ejs:79,83,87`).
  Lo configurable es el umbral, no el vocabulario. Los smoke tests dependen de esas cadenas
  (`tests/smoke/specs.js:1980-1981`).

## Casos de uso

| # | Caso de uso | Actor | Acción auditable |
|---|---|---|---|
| CU-01 | Ver los umbrales vigentes de mi escuela | directivo / admin / superadmin | — |
| CU-02 | Ajustar un umbral (ej: "para nosotros bajo rendimiento es < 7") | directivo / admin / superadmin | `school.directivo_thresholds_update` |
| CU-03 | Restablecer todos los umbrales a los valores por defecto | directivo / admin / superadmin | `school.directivo_thresholds_update` (`{ umbral: 'todos' }`) |
| CU-04 | Ver el listado de alumnos etiquetado según los umbrales de mi escuela | directivo | — |
| CU-05 | Quitarle al directivo la posibilidad de configurar umbrales | superadmin | `school.role_permissions_update` (ya existe) |

## Criterios de aceptación

- **CA-01** — Dada una escuela que nunca guardó umbrales (campo `directivoThresholds`
  ausente), cuando un directivo abre `/directivo/students`, entonces los conteos de los
  chips "Bajo rendimiento", "Silenciosos" y "Muchas tardías" son **idénticos** a los
  anteriores a este cambio (defaults 6 / 30 días / 30 % con mínimo 3).
- **CA-02** — Dado un directivo con escuela, cuando hace `GET /directivo/settings`,
  entonces recibe 200 y la vista lista los 5 umbrales del catálogo con su valor vigente,
  su unidad y su texto de ayuda.
- **CA-03** — Dado un usuario con rol `teacher`, `student`, `preceptor` o `soe`, cuando
  hace `GET /directivo/settings`, entonces recibe 403 (lo resuelve `requireDirectivo`, sin
  código nuevo).
- **CA-04** — Dado un directivo, cuando hace `POST /directivo/settings` con
  `{ key: 'lowAvg', value: 7 }`, entonces recibe 200, el body incluye
  `thresholds.lowAvg === 7`, y en `School.directivoThresholds` queda `{ lowAvg: 7 }`.
- **CA-05** — Dado el umbral `lowAvg` en 7, cuando el directivo abre `/directivo/students`,
  entonces un alumno con promedio 6,5 aparece marcado como "Bajo" (con el default 6 no lo
  estaba) y el conteo del chip crece en consecuencia.
- **CA-06** — Dado un directivo, cuando hace `POST /directivo/settings` con
  `{ key: 'lowAvg', value: 6 }` (el valor por defecto), entonces la key se **elimina** del
  documento (`$unset`) en vez de guardarse, y la respuesta sigue informando `lowAvg: 6`.
- **CA-07** — Dado un directivo, cuando hace `POST /directivo/settings` con
  `{ key: 'noExisteEsteUmbral', value: 1 }`, entonces recibe 400 con
  `code: 'UNKNOWN_THRESHOLD'` y no se escribe nada en la base.
- **CA-08** — Dado un directivo, cuando hace `POST /directivo/settings` con
  `{ key: 'lowAvg', value: 11 }` o `value: -1`, entonces recibe 400 con
  `code: 'THRESHOLD_OUT_OF_RANGE'` y el mensaje indica el rango permitido (0 a 10).
- **CA-09** — Dado un directivo, cuando hace `POST /directivo/settings` con
  `{ key: 'lowAvg', value: 'siete' }` o `value: null`, entonces recibe 400 con
  `code: 'INVALID_THRESHOLD'` y no se escribe nada.
- **CA-10** — Dado un umbral de `tipo: 'entero'`, cuando se envía `{ key: 'silentDays',
  value: 14.7 }`, entonces se persiste `15` (redondeo) y la respuesta lo informa.
- **CA-11** — Dado un directivo con umbrales personalizados, cuando hace
  `POST /directivo/settings` con `{ reset: true }`, entonces `School.directivoThresholds`
  queda sin definir (`$unset` del campo completo) y la respuesta devuelve los 5 defaults.
- **CA-12** — Dado cualquier POST exitoso, cuando se consulta la auditoría, entonces existe
  un evento `school.directivo_thresholds_update` con actor, escuela y
  `meta: { umbral, valor, anterior }`; y para el reset, `meta.umbral === 'todos'`.
- **CA-13** — Dado un POST exitoso, cuando se recarga `/directivo/settings` en el **mismo**
  worker, entonces se ve el valor nuevo (el cache de escuela fue invalidado).
- **CA-14** — Dado un usuario `directivo` **sin escuela asignada**, cuando abre
  `/directivo/settings`, entonces ve la pantalla `directivo/no-school` (200, no 500); y si
  hace POST, recibe 400 con `code: 'NO_SCHOOL'`.
- **CA-15** — Dado que el superadmin deshabilita la sección `directivo_settings` para el rol
  `directivo` en esa escuela, cuando el directivo hace `GET /directivo/settings` **o**
  `POST /directivo/settings`, entonces recibe 403 en ambos casos, y la solapa "Ajustes"
  desaparece de `views/partials/directivo-nav.ejs`.
- **CA-16** — Dado un valor guardado en la base que quedó fuera de rango (por ejemplo,
  porque en el futuro se achicó el `max` del catálogo), cuando se resuelven los umbrales,
  entonces se usa el **default** de esa key y el resto de los umbrales sigue funcionando
  (nunca una excepción, nunca un `NaN` propagado a una query de Mongo).
- **CA-17** — Dado el umbral `ungradedDays` en 30, cuando el directivo abre `/directivo`,
  entonces la tarjeta "Actividades vencidas sin calificar" cuenta con ventana de 30 días y
  su rótulo dice "hace más de 30 días" (el texto de la vista se arma con el umbral, no con
  el literal "15").

## Errores posibles

| CODIGO | HTTP | Mensaje en español | Cuándo |
|---|---|---|---|
| `UNKNOWN_THRESHOLD` | 400 | «Ese ajuste no existe.» | `key` fuera del catálogo `config/directivo-thresholds.js`. |
| `INVALID_THRESHOLD` | 400 | «El valor tiene que ser un número.» | `value` no numérico, `null`, `NaN` o `Infinity`. |
| `THRESHOLD_OUT_OF_RANGE` | 400 | «El valor tiene que estar entre {min} y {max}.» | Numérico pero fuera del rango del catálogo. |
| `NO_SCHOOL` | 400 | «Este usuario no tiene escuela asignada.» | POST de un usuario sin `school` (mismo caso que `routes/admin.js:1563`). |
| `SCHOOL_NOT_FOUND` | 404 | «Escuela no encontrada.» | El `findByIdAndUpdate` no encontró la escuela (borrada entre el login y el POST). |
| — (sin código, comportamiento existente) | 403 | «Acceso denegado» | Rol sin acceso al panel (`middleware/directivo.js:6`) o sección denegada (`middleware/sections.js:20`). Se conserva el texto plano actual: cambiarlo rompería asserts de smoke ya existentes. |
| `SERVER_ERROR` | 500 | «Error del servidor.» | Excepción no prevista. En GET se mantiene el `res.status(500).send('Error del servidor')` del resto del panel, por coherencia. |

## Tests necesarios

**Smoke HTTP (`tests/smoke/specs.js`)**, agrupados junto al bloque directivo existente
(`:1891-2082`). Todos deben dejar la escuela **como la encontraron**: el patrón está en
`tests/smoke/specs.js:896-899` (*"Todos estos specs dejan la escuela como la encontraron:
usan try/finally o restablecen explícitamente al final"*). La suite corre contra un espejo
de producción, así que esto no es opcional.

1. `directivo-settings-screen-loads` — GET 200; el HTML contiene los 5 labels del catálogo
   y el endpoint `/directivo/settings` del `fetch`. (CA-02)
2. `directivo-settings-update-and-restore` — `try/finally`: POST `lowAvg: 7` → 200 y
   `thresholds.lowAvg === 7`; en el `finally`, POST `{ reset: true }` → 200. (CA-04, CA-11)
   **Assertar contra el body de la respuesta, no contra un GET posterior**: en cluster PM2
   el GET puede caer en otro worker con el cache viejo (`middleware/cache.js:3-11`).
3. `directivo-settings-rejects-garbage` — POST con key desconocida → 400; con `value: 11`
   → 400; con `value: 'siete'` → 400. (CA-07, CA-08, CA-09)
4. `directivo-settings-forbidden-for-teacher` — un `teacher` hace GET y POST → 403 en
   ambos. (CA-03)
5. `directivo-settings-section-can-be-denied` — con el patrón exacto de
   `roles-toggle-hides-and-blocks` (`tests/smoke/specs.js:930-960`): el superadmin apaga
   `directivo_settings` para el rol `directivo`, se verifica 403 en GET **y en POST**, y en
   el `finally` se vuelve a habilitar. (CA-15)
6. `directivo-thresholds-affect-students-view` — POST `lowAvg: 10` (todos los alumnos con
   nota quedan "bajo") → GET `/directivo/students?estado=bajo` devuelve 200 y un conteo
   ≥ al de antes; `finally` con reset. Es el único test que cruza configuración y métrica.
   (CA-05) — si resulta inestable contra el espejo de producción por el cache entre
   workers, degradarlo a verificación manual documentada antes que dejarlo intermitente.
7. **Regresión**: `directivo-students` (`:1974-1987`) sigue pasando sin cambios — los chips
   conservan sus textos. (RN-11, CA-01)

**Verificación manual documentada:** con la BD local, comparar los tres conteos de
`/directivo/students` antes y después del deploy **sin haber tocado nada**: tienen que ser
idénticos. Es la prueba de RN-04 y no hay forma barata de automatizarla.

## Dependencias

- `models/School.js` — campo nuevo.
- `server.js:305` — **obligatorio**: agregar `directivoThresholds` al
  `.select('name color slug _id themes settings rolePermissions')`. Sin esto el campo nunca
  llega a `res.locals.school` y la configuración queda muda. El propio schema deja escrito
  el caveat (`models/School.js:35-36` y `:59-60`).
- `middleware/cache.js` — `invalidateSchool`.
- `middleware/audit.js` + `config/audit-actions.js` — acción nueva.
- `config/sections.js` + `views/partials/directivo-nav.ejs` — solapa nueva.
- `routes/directivo.js` — reemplazo de las constantes y las dos rutas nuevas.
- **Consumidor:** ninguno obligatorio. `directivo-riesgo.spec.md` **no** depende de esta
  spec (usa sus propias constantes de score); las dos se pueden implementar en cualquier
  orden.

## Riesgos de refactorización

1. **Olvidarse de `server.js:305` es el modo de falla más probable.** El síntoma es
   silencioso: se guarda bien, se audita bien, y el panel sigue mostrando los defaults.
   Mitigación: CA-05 lo detecta y está listado primero en el plan de migración.
2. **Cache de escuela por worker (45 s) en PM2 cluster.** Guardar en un worker y leer desde
   otro devuelve el valor viejo hasta que expire el TTL — está documentado en
   `middleware/cache.js:3-11` y no es un bug de esta spec. Mitigación: el POST devuelve los
   umbrales resueltos y la vista se actualiza con eso, sin depender de un GET. La ventana
   máxima de inconsistencia es < 1 minuto.
3. **Cambiar `silentDays` cambia una ventana de query, no solo una comparación.** `monthAgo`
   (`routes/directivo.js:380`) se usa en el `$match` del aggregate de entregas del mes
   (`:400`). Con `silentDays: 180` ese aggregate escanea mucho más. Mitigación: `max: 180`
   en el catálogo y verificar el tiempo de respuesta de `/directivo/students` con el valor
   máximo antes de mergear (la escuela real tiene ~350 docentes y cientos de alumnos).
4. **El panel directivo pasa a tener escritura.** Hay que actualizar el comentario de
   encabezado de `routes/directivo.js` y la documentación (`agente.md`), o la próxima
   persona va a asumir que sigue siendo 100 % read-only. El smoke
   `directivo-cannot-edit-course` (`:1953-1963`) sigue siendo válido y **no se toca**: sigue
   siendo cierto que el directivo no puede mutar datos institucionales.
5. **Requiere cambio en la BD de producción**: el campo es nuevo y opcional, así que **no
   hace falta migración** (ninguna escuela necesita el campo para funcionar), pero el
   usuario pidió que se le avise **siempre antes de pushear cambios que toquen la BD de
   producción**. Avisar igual, aclarando que es aditivo y reversible.
6. **Un umbral mal puesto puede "apagar" las alertas.** Ejemplo: `lowAvg: 0` hace que nadie
   sea nunca "bajo rendimiento". Es una decisión legítima de la escuela, pero conviene que
   la pantalla lo diga (RN-10) para que nadie crea que el panel se rompió.

## Plan de migración

1. **`config/directivo-thresholds.js`** con el catálogo y `resolveThresholds(school)`.
   Se puede mergear solo: no lo usa nadie todavía.
2. **`models/School.js`**: campo `directivoThresholds` + `server.js:305`: sumarlo al
   `.select()`. Sin efecto visible.
3. **`routes/directivo.js`**: reemplazar las constantes por `resolveThresholds(res.locals.school)`
   en `/`, `/students` y `/teachers`. **Con el campo ausente, los números tienen que quedar
   idénticos** — este es el commit que hay que verificar contra la BD local comparando
   conteos antes/después. Todavía no hay pantalla para cambiarlos: la app se comporta igual.
4. **`config/audit-actions.js`** + **`config/sections.js`** + **`directivo-nav.ejs`**.
5. **`routes/directivo.js`**: `GET /settings` y `POST /settings`; **`views/directivo/settings.ejs`**.
6. **Smoke tests** (los 6 nuevos + verificar que los existentes siguen verdes).
7. **`agente.md`**: entrada de changelog, incluyendo la decisión de RN-03 (quién edita) y
   la aclaración de que el panel directivo dejó de ser estrictamente de solo lectura.
8. **Deploy**: avisar antes de pushear (cambio aditivo en `School`, sin migración). En
   producción no hace falta correr ningún script.

**Rollback**: revertir el commit del paso 3 devuelve todo al comportamiento anterior. El
campo `directivoThresholds` puede quedar en la base sin efecto ni riesgo.
