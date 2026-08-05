# Informe institucional imprimible

> **Parte del lote de 4 specs del panel directivo.** Orden sugerido de aprobación:
> `directivo-graficos` → `directivo-umbrales` → `directivo-riesgo` →
> **`directivo-informe-impresion`** (esta, la última: consume a las tres anteriores).
>
> **Por qué está separada:** es la única cuyo destino no es la pantalla sino el papel, y por
> lo tanto la única que introduce `@media print` en un proyecto que hoy **no tiene una sola
> regla de impresión** (verificado: cero coincidencias de `@media print` en todo el repo).
> Además concentra una decisión de privacidad propia —qué datos de menores se llevan
> impresos a una reunión— que no aparece en ninguna de las otras tres.

## Objetivo

Que el directivo tenga **una sola página, en papel**, con el panorama de su escuela para
llevar a una reunión: los conteos, el ranking de riesgo, la distribución de notas y la
comparación de entrega entre divisiones, con una nota metodológica que explique de dónde
sale cada número. Sin generar archivos, sin librerías nuevas y sin depender de que alguien
sepa configurar la impresión del navegador.

## Responsabilidades

- Definir la **vista** `GET /directivo/report`, que compone datos que ya calculan otras
  rutas y services del panel.
- Definir el **CSS de impresión** (`@media print`): qué se oculta, cómo se pagina y cómo se
  neutraliza el modo oscuro para que el papel salga legible.
- Definir el **orden y el contenido** de los bloques del informe.
- Definir la **nota metodológica** impresa al pie (qué significa cada métrica y con qué
  ventana temporal se calculó).
- Definir la **degradación por permisos**: un bloque cuyo origen está deshabilitado para esa
  escuela no se imprime (RN-04).
- Definir la **serie mensual institucional** (único dato agregado nuevo de esta spec, RN-06).

## No responsabilidades

- **NO es una exportación.** No genera archivos, no descarga nada, no crea un endpoint de
  export, no agrega ninguna dependencia. Ver RN-01, que trata explícitamente la relación
  con la decisión del 2026-07-21.
- **No genera PDF.** No se suma `puppeteer`, `pdfkit`, `jsPDF` ni ninguna otra librería. Si
  el usuario elige "Guardar como PDF" en el diálogo de impresión, eso lo hace **su
  navegador**, no la aplicación.
- **No notifica a nadie.** No se envía por mail, no se programa, no se agenda. La decisión
  del 2026-07-21 de descartar notificaciones para este panel sigue vigente y esta spec no la
  toca ni de costado.
- **No calcula métricas nuevas**, con una única excepción declarada: la serie mensual
  institucional (RN-06), que reusa las agregaciones y la semántica de atribución que ya
  existen en `GET /directivo/teachers`.
- **No escribe nada**: sin POST, sin schema, sin acción auditable.
- **No imprime datos nominales de alumnos** en la versión 1 — ver RN-03 (decisión
  confirmada por el usuario el 2026-08-05: solo agregados).
- **No cambia el diseño en pantalla de ninguna vista existente.** El único `@media print`
  global es la utilidad `.no-print`; todo lo demás va scopeado (RN-07).

## Entidades/Schemas

Sin cambios en la base de datos. Sin modelos nuevos.

### Vista nueva

`views/directivo/report.ejs` (`activePage: 'report'`), con `<body class="doc-print">`.

### Nueva entrada en `config/sections.js`

```js
{ key: 'directivo_report', panel: 'directivo', label: 'Informe', icon: 'print',
  path: '/directivo/report', roles: ['directivo', 'admin', 'superadmin'] },
```

Sin `locked` (una escuela puede no querer esta salida impresa) y con el mismo trío de roles
que el resto del panel, que es lo que ya concede `middleware/directivo.js:5`.

### Nuevo bloque en `public/css/style.css`

```
/* ─── Impresión ─── */
@media print {
  .no-print { display: none !important; }          /* única regla GLOBAL */

  body.doc-print { /* variables neutralizadas: ver RN-08 */ }
  body.doc-print .header,
  body.doc-print .admin-nav,
  body.doc-print .footer,
  body.doc-print .pagination { display: none; }
  body.doc-print .doc-block { break-inside: avoid; }
  body.doc-print thead { display: table-header-group; }
  body.doc-print .chart-bar,
  body.doc-print .chart-seg { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
@page { size: A4 portrait; margin: 14mm; }
```

### Función nueva en `services/directivoMetrics.js`

(El archivo lo crea `directivo-riesgo.spec.md`; acá se le suma una función.)

```js
// getSchoolMonthlySeries(schoolId) → { meses, mesesLabel, creadas, corregidas }
// Serie institucional de los últimos SERIE_MESES meses. Reusa tal cual las dos
// agregaciones de GET /directivo/teachers (routes/directivo.js:707-731) pero sumando
// TODA la escuela en vez de agrupar por autor.
```

Requiere **mover** al service los tres helpers de ventana temporal que hoy viven sueltos en
`routes/directivo.js:575-606`: `SERIE_MESES`, `inicioVentanaSerie()`, `etiquetasMeses()`,
`NOMBRES_MES` y `mesCorto()`. Es una extracción sin cambio de comportamiento: las usan
`GET /teachers` y `GET /teachers/:id`, que pasan a importarlas.

## Entradas

### `GET /directivo/report`

| Parámetro | Tipo | Default | Qué hace |
|---|---|---|---|
| `print` | `1` | — | Si viene, la página abre el diálogo de impresión al cargar (RN-10) |

- Sesión con rol `directivo`, `admin` o `superadmin`.
- `res.locals.user.school` obligatorio; sin escuela se renderiza `directivo/no-school`,
  igual que el resto del panel (`routes/directivo.js:27`).
- `res.locals.school` para el nombre y el color de la escuela (`models/School.js:16,22`).
- `res.locals.user.name` y `res.locals.roleNames` para el pie de página (`server.js:317`).
- Umbrales vigentes vía `resolveThresholds(res.locals.school)` si
  `directivo-umbrales.spec.md` ya está implementada; si no, las constantes de hoy. Solo se
  usan para **rotular** la nota metodológica (RN-05).

Sin parámetros de rango de fechas: la versión 1 usa las mismas ventanas que el resto del
panel. Ver *Decisiones abiertas* del reporte.

## Salidas

`views/directivo/report.ejs`, con los bloques en este orden:

| # | Bloque | Fuente del dato | Gráfico |
|---|---|---|---|
| 1 | Encabezado institucional | `res.locals.school` (nombre + color como franja de acento), fecha y hora de generación | — |
| 2 | Panorama | los 6 conteos de `GET /directivo` (`routes/directivo.js:35-45`) | — |
| 3 | Requiere atención | los 3 conteos de `attention` (`:87-91`) | — |
| 4 | Riesgo por división | `getDivisionRisk()` de `directivo-riesgo.spec.md`, top 10 | `bar-list` |
| 5 | Rendimiento | `schoolAvg`, `totalCount` y `divisionsByAvg` de `GET /directivo/grades` (`:338-357`) | `stacked-bar` + `legend` |
| 6 | Entrega por división | `tasa` de `getDivisionMetrics()` | `bar-list` |
| 7 | Evolución institucional (6 meses) | `getSchoolMonthlySeries()` | `grouped-bars` |
| 8 | Nota metodológica + pie | texto fijo + umbrales vigentes + quién y cuándo generó | — |

Locals de la vista:

```
{ school, generadoEl: Date, generadoPor: { name, role },
  stats:      { studentCount, teacherCount, courseCount, divisionCount, connectedNow, newLastMonth },
  attention:  { orphanedCourses, unenrolledCount, overdueUngradedCount },
  riesgo:     { top: [ { name, riesgo } ], resumen: { alto, medio, bajo, sinDatos } } | null,
  notas:      { schoolAvg, totalCount, divisionsByAvg } | null,
  entrega:    [ { name, tasa } ] | null,
  serie:      { mesesLabel, creadas, corregidas } | null,
  umbrales:   { lowAvg, silentDays, latePct, lateMinSubs, ungradedDays },
  autoPrint:  Boolean,
  activePage: 'report' }
```

Los bloques que llegan en `null` **no se renderizan** (RN-04). El botón "Imprimir" y el nav
llevan la clase `.no-print`.

## Reglas de negocio

- **RN-01 — Esto no es la exportación descartada, y la spec lo deja escrito.** El
  2026-07-21 el usuario descartó explícitamente, para este panel, **exportar a Excel** y
  **notificaciones** (`agente.md:1259`: *"todo lo del roadmap Alta+Media hecho; Baja —
  export Excel, notificaciones — descartada por decisión del usuario"*). Esta vista **no
  contradice** esa decisión, y las diferencias son verificables, no interpretativas:

  | | Export descartado | Este informe |
  |---|---|---|
  | Genera un archivo | Sí (.xlsx) | **No** |
  | Endpoint de descarga | Sí | **No** (una vista HTML más) |
  | Dependencia nueva | `xlsx` del lado de escritura | **Ninguna** |
  | Sale del sistema | Sí, el archivo circula | **No**, sale una impresión que el directivo pide |
  | Se dispara solo | Notificaciones: sí | **No**, requiere que alguien apriete Imprimir |
  | Dato crudo reutilizable | Sí, una planilla para recalcular | **No**, un resumen ya interpretado |

  Si el usuario considera que igual entra en el espíritu de aquella decisión, esta spec se
  descarta entera y no arrastra a las otras tres del lote.

- **RN-02 — Impresión nativa del navegador. Cero librerías.** El botón llama a
  `window.print()`. No se agrega ninguna dependencia a `package.json`, ni del lado del
  servidor ni en `public/js/vendor/` (que sigue sin existir). Es la misma línea que
  `directivo-graficos.spec.md` RN-01: el proyecto no tiene build step ni archivos de
  terceros en el front, y esta feature no es motivo suficiente para estrenarlos.

- **RN-03 — Sin datos nominales de alumnos en la versión 1.** El informe muestra
  **agregados** (por escuela, por división) y **conteos**. No imprime nombres, DNI ni mails
  de alumnos. Fundamento: es un papel que circula en una reunión y sale del control de la
  aplicación, y el proyecto ya viene tratando los datos de menores con criterio restrictivo
  —el perfil ampliado se muestra solo en tres vistas y con una advertencia explícita
  (`agente.md:774-782`)—. Los nombres siguen estando donde ya estaban y con la misma
  autorización: en pantalla, en `/directivo/students`.
  **Confirmado por el usuario (2026-08-05): solo agregados**, sin nómina de alumnos. Si más
  adelante se decide incluirla, se agrega como bloque 4-bis con sus propios CA, sin cambiar
  el resto de la spec.

- **RN-04 — El informe no puede ser un rodeo a los permisos de solapas.** Cada bloque
  respeta el permiso de la sección de la que salen sus datos, evaluado con el mismo helper
  `can()` que usa el nav (`server.js:342-346`):

  | Bloque | Requiere |
  |---|---|
  | 4 · Riesgo | `can('directivo_risk')` |
  | 5 · Rendimiento | `can('directivo_grades')` |
  | 6 · Entrega por división | `can('directivo_divisions')` |
  | 7 · Evolución | `can('directivo_teachers')` |

  Los bloques 1, 2, 3 y 8 salen del dashboard, que es `locked` y siempre está disponible.
  Sin esta regla, una escuela que le apagó "Promedios" al directivo se lo estaría
  entregando impreso, que es exactamente lo que la pantalla de Roles vino a evitar
  (`config/sections.js:1-12`). El chequeo va **en la ruta** (qué se calcula), no solo en la
  vista: si el bloque no se va a mostrar, tampoco se pagan sus queries.

- **RN-05 — El informe declara su método.** Al pie, texto fijo con: qué es la tasa de
  entrega (`entregas / (actividades × alumnos)`), cómo se normalizan las notas
  (`points obtenidos / points de la actividad × 10`, descartando actividades con
  `points: null`, `routes/directivo.js:269-271` y `:282`), qué ventana usa cada alerta
  (con los umbrales **vigentes de esa escuela**, no con los literales), y la aclaración de
  que la suma de alumnos por división supera el total de la escuela porque un alumno cursa
  materias de más de una división (`routes/directivo.js:920-923` y `agente.md:815`). Un
  informe impreso sin nota metodológica es un número sin apellido: en una reunión, alguien
  va a preguntar "¿y esto cómo se mide?" y la respuesta tiene que estar en la hoja.

- **RN-06 — Una sola métrica nueva, y reusa la semántica existente.** La serie mensual
  institucional suma lo que `GET /directivo/teachers` ya calcula por docente. Se conservan
  sus dos reglas, que están documentadas en el código y son fáciles de romper:
  1. Atribución por `Activity.author` (no por `course.owner`), que es quien realmente creó
     la actividad y hace visible el trabajo de los co-docentes (`routes/directivo.js:696-702`).
  2. **`grades.manual: true` es obligatorio** al contar correcciones: sin ese filtro, el
     autocalificador —que escribe `gradedAt` en el momento de la entrega con
     `manual: false`— infla el conteo con cientos de correcciones que nadie hizo
     (`routes/directivo.js:717-721`).
  Los meses sin actividad se imprimen en cero, no se omiten: ver el bache es el objetivo
  (`routes/directivo.js:588-590`).

- **RN-07 — El `@media print` global se limita a `.no-print`.** Todo el resto de las reglas
  de impresión va scopeado a `body.doc-print`, que solo pone esta vista. Es la primera regla
  de impresión del proyecto y no se puede saber sin probar cómo afectaría a las ~40 vistas
  restantes; acotarla es más barato que auditarlas. Si más adelante se quiere una impresión
  decente en toda la app, es un trabajo aparte y con su propia verificación.

- **RN-08 — En papel no hay modo oscuro.** Dentro de `@media print`, `body.doc-print`
  redefine las variables del tema a una paleta clara (`--bg` y `--surface` en blanco,
  `--text` en negro, `--border` gris, sombras anuladas). Así, un directivo que usa la app en
  modo oscuro imprime blanco sobre negro… en el sentido correcto, y no gasta un cartucho por
  informe. Esto es posible **porque los gráficos son CSS y no canvas**
  (`directivo-graficos.spec.md` RN-01): redefinir una variable alcanza para repintarlos.

- **RN-09 — El informe tiene que servir impreso en blanco y negro.** Ningún dato puede
  estar codificado **solo** por color: cada barra lleva su valor como texto (RN-02 de la
  spec de gráficos) y cada etiqueta de riesgo lleva su palabra ("Alto", "Medio", "Bajo"),
  no solo su color. Se asume que muchas escuelas imprimen en láser monocromática.

- **RN-10 — `?print=1` abre el diálogo al cargar.** Para que "Imprimir informe" desde el
  dashboard sea un solo clic. La llamada a `window.print()` se hace después del evento
  `load` (con las imágenes y fuentes ya resueltas) y **solo** si el parámetro está presente:
  una página que dispara el diálogo sola, sin pedirlo, es hostil.

- **RN-11 — Multi-tenant sin excepciones.** Todo scoped a `res.locals.user.school`, igual
  que las siete rutas que ya tiene el panel. El informe de una escuela no puede contener ni
  un número de otra.

- **RN-12 — El informe no inventa: si un dato falta, lo dice.** Una escuela sin
  calificaciones cargadas imprime "Sin calificaciones cargadas" en el bloque 5, no un
  promedio 0. Es la distinción `null ≠ 0` que ya sostiene todo el panel
  (`routes/directivo.js:994-996`) y que en papel importa más todavía, porque el lector no
  puede hacer hover ni preguntar.

## Casos de uso

| # | Caso de uso | Actor | Qué resuelve |
|---|---|---|---|
| CU-01 | Llevar el panorama de la escuela a una reunión de equipo directivo | directivo | Una hoja con todo, sin transcribir de tres pantallas |
| CU-02 | Imprimir en un clic desde el dashboard | directivo | Link con `?print=1` |
| CU-03 | Guardarlo como PDF para adjuntarlo a un acta | directivo | Lo hace el navegador; la app no genera archivos (RN-02) |
| CU-04 | Explicar en la reunión de dónde sale cada número | directivo | Nota metodológica al pie (RN-05) |
| CU-05 | Que una escuela no exponga este informe | superadmin | Apagar `directivo_report` en `/superadmin/roles` |
| CU-06 | Que el informe no muestre promedios en una escuela que apagó esa solapa | superadmin | RN-04, automático |

Ninguno es auditable: no hay escritura. **No se agrega nada a `config/audit-actions.js`.**
(Si en el futuro se quisiera registrar quién imprimió, eso sería una acción nueva
—`school.report_print`— y una decisión aparte: hoy imprimir una pantalla que ya se puede
ver no genera evento en ningún lado del sistema.)

## Criterios de aceptación

**Ruta y autorización**

- **CA-01** — Dado un directivo con escuela, cuando abre `/directivo/report`, entonces
  recibe 200 y la página contiene el nombre de su escuela y la fecha de generación.
- **CA-02** — Dado un usuario `teacher`, `student`, `preceptor` o `soe`, cuando abre
  `/directivo/report`, entonces recibe 403.
- **CA-03** — Dado que el superadmin apagó `directivo_report` para el rol `directivo` en esa
  escuela, entonces `GET /directivo/report` responde 403 y la solapa "Informe" desaparece
  de `views/partials/directivo-nav.ejs`.
- **CA-04** — Dado un directivo **sin escuela asignada**, entonces ve `directivo/no-school`
  con 200 (no 500).
- **CA-05** — Dado un directivo de la escuela A, cuando genera el informe, entonces ningún
  conteo, nombre de división ni promedio proviene de otra escuela.

**Degradación por permisos (RN-04)**

- **CA-06** — Dado que la escuela apagó `directivo_grades` para el rol `directivo`, cuando
  ese directivo abre el informe, entonces el bloque "Rendimiento" **no aparece** y el resto
  del informe se imprime normalmente.
- **CA-07** — Dado que la escuela apagó `directivo_risk`, entonces el bloque "Riesgo por
  división" no aparece y no hay ningún link a `/directivo/risk`.
- **CA-08** — Dado que la escuela apagó `directivo_divisions` y `directivo_teachers`,
  entonces no aparecen los bloques 6 y 7, y **no se ejecutan** sus agregaciones (verificable
  en desarrollo instrumentando la ruta: el informe reducido tiene que hacer estrictamente
  menos queries que el completo).

**Contenido**

- **CA-09** — Dado el informe completo, entonces contiene los 8 bloques en el orden de la
  tabla de *Salidas*, cada uno con su título visible.
- **CA-10** — Dado el bloque "Panorama", entonces sus 6 conteos coinciden exactamente con
  los que muestra `GET /directivo` en el mismo momento.
- **CA-11** — Dado el bloque "Riesgo", entonces lista hasta 10 divisiones ordenadas por
  score descendente, cada una con su **palabra** de etiqueta ("Alto"/"Medio"/"Bajo"/"Sin
  datos"), no solo con color (RN-09).
- **CA-12** — Dado el bloque "Rendimiento" en una escuela **sin ninguna calificación
  cargada**, entonces se imprime "Sin calificaciones cargadas" y **no** aparece un promedio
  `0`, `null`, `NaN` ni una barra vacía sin explicación (RN-12).
- **CA-13** — Dado el bloque "Evolución", entonces muestra 6 meses etiquetados, incluidos
  los meses con valor 0, y las correcciones contadas **solo** con `grades.manual: true`
  (verificable: en una materia con plantilla autocalificada, el mes no muestra decenas de
  correcciones fantasma).
- **CA-14** — Dado el pie del informe, entonces indica fecha y hora de generación, nombre
  del usuario que lo generó, su rol **en español** (vía `res.locals.roleNames`) y el nombre
  de la escuela.
- **CA-15** — Dada la nota metodológica, entonces menciona la fórmula de la tasa de entrega,
  la normalización de notas a 0-10 y las ventanas temporales usando **los umbrales vigentes
  de esa escuela** (si `lowAvg` está en 7, el texto dice 7, no 6).
- **CA-16** — Dado el HTML del informe, entonces no contiene `NaN`, `Infinity` ni
  `undefined`, aunque la escuela tenga divisiones sin actividades y sin notas.

**Impresión**

- **CA-17** — Dada la vista impresa (o su vista previa), entonces **no** aparecen: el header
  de la app, el nav del panel, el footer, el botón "Imprimir" ni ningún control de
  paginación.
- **CA-18** — Dado el tema oscuro activo (`<html data-theme="dark">`), cuando se imprime,
  entonces el fondo sale blanco y el texto negro (RN-08).
- **CA-19** — Dado el informe impreso, entonces ninguna tarjeta ni tabla queda cortada al
  medio por un salto de página (`break-inside: avoid` en `.doc-block`), y si una tabla ocupa
  más de una hoja, su encabezado se repite (`display: table-header-group`).
- **CA-20** — Dadas las barras de los gráficos, cuando se imprime, entonces se ven (regla
  `print-color-adjust: exact`); y si el navegador o la impresora las descarta igual, el
  valor numérico impreso al lado sigue haciendo legible el gráfico (RN-09).
- **CA-21** — Dado cualquier **otra** vista de la aplicación (por ejemplo `/courses` o
  `/admin/users`), cuando se imprime, entonces su resultado es exactamente el mismo que
  antes de esta spec: las reglas nuevas están scopeadas a `body.doc-print` y la única global
  es `.no-print`, que ninguna vista existente usa (RN-07).
- **CA-22** — Dado `/directivo/report?print=1`, entonces la página abre el diálogo de
  impresión al terminar de cargar; dado `/directivo/report` sin el parámetro, entonces
  **no** lo abre.
- **CA-23** — Dado el informe, entonces existe un botón "Imprimir" con clase `.no-print`
  que dispara `window.print()`, y la página no depende de ninguna librería externa
  (verificable: el HTML no referencia ningún `.js` de terceros).

**Accesos desde el resto del panel**

- **CA-24** — Dado el dashboard `/directivo`, entonces hay un acceso al informe
  (`/directivo/report?print=1`) que **solo** se renderiza si `can('directivo_report')`.
- **CA-25** — Dado `/directivo/risk`, entonces hay un acceso al informe con la misma guarda.

## Errores posibles

| CODIGO | HTTP | Mensaje en español | Cuándo |
|---|---|---|---|
| — (comportamiento existente) | 403 | «Acceso denegado» | Rol sin acceso al panel (`middleware/directivo.js:6`) o sección `directivo_report` denegada (`middleware/sections.js:20`). Texto plano, igual que el resto del panel. |
| `NO_SCHOOL` | 200 (render) | «Todavía no tenés una escuela asignada.» | Usuario del panel sin `school`: se renderiza `directivo/no-school`, no un error. Mismo comportamiento que `routes/directivo.js:27`. |
| `REPORT_EMPTY` | 200 (render) | «Todavía no hay datos suficientes para armar el informe.» | La escuela no tiene divisiones ni actividades ni notas: se imprime el encabezado, los conteos en cero y este aviso, en vez de una hoja con siete bloques vacíos. |
| `SERVER_ERROR` | 500 | «Error del servidor» | Excepción no prevista. Se conserva el `res.status(500).send('Error del servidor')` del resto del panel. |

No hay errores 400: la ruta no acepta entrada del usuario más allá de `?print=1`, y un valor
distinto de `1` simplemente no activa la impresión automática (no es un error).

## Tests necesarios

**Smoke HTTP (`tests/smoke/specs.js`)**, junto al bloque directivo existente
(`tests/smoke/specs.js:1891-2082`):

1. `directivo-report-loads` — GET `/directivo/report` como directivo → 200; el HTML contiene
   el nombre de la escuela, el texto "Informe" y los títulos de los bloques 2 y 8.
   (CA-01, CA-09, CA-14)
2. `directivo-report-no-nan` — el HTML no contiene `NaN`, `Infinity`, `undefined` ni
   `var(--background)`. (CA-16)
3. `directivo-report-has-print-affordances` — el HTML contiene `window.print`, la clase
   `no-print` y `class="doc-print"`, y **no** referencia ningún script de terceros.
   (CA-17, CA-23)
4. `directivo-report-autoprint-flag` — `?print=1` devuelve un HTML que contiene la llamada
   condicional a `window.print()`; sin el parámetro, no. (CA-22)
5. `directivo-report-forbidden` — un `teacher` recibe 403. (CA-02)
6. `directivo-report-section-can-be-denied` — patrón `try/finally` de
   `tests/smoke/specs.js:930-960`: el superadmin apaga `directivo_report`, se verifica 403,
   y se vuelve a habilitar. (CA-03)
7. `directivo-report-degrades-by-permission` — el superadmin apaga `directivo_grades` para
   el rol `directivo`; el informe sigue devolviendo 200 pero **sin** el título del bloque
   "Rendimiento"; se restablece en el `finally`. Es el test que protege RN-04, que es la
   regla más fácil de perder en una refactorización. (CA-06)
8. **Regresión de la extracción de helpers**: `directivo-teachers` (`:1999-2007`) y
   `directivo-teacher-detail` (`:2032-2042`) tienen que seguir verdes después de mover
   `inicioVentanaSerie`/`etiquetasMeses`/`mesCorto` al service. El segundo ya assertea
   `'Evolución de los últimos'` (`:2039`).

**Verificación manual documentada** (la impresión no se puede automatizar con esta suite, y
pretender lo contrario sería peor que admitirlo):

9. `Ctrl+P` sobre `/directivo/report` en **tema claro** y en **tema oscuro**: en los dos
   casos el papel sale blanco con texto negro y las barras visibles. (CA-18, CA-20)
10. En la vista previa de impresión: ninguna tarjeta cortada por el salto de página, y el
    encabezado de la tabla de riesgo repetido si pasa a la segunda hoja. (CA-19)
11. Imprimir **en escala de grises** y verificar que se entiende igual: cada barra con su
    número y cada etiqueta con su palabra. (CA-11, CA-09/RN-09)
12. `Ctrl+P` sobre `/courses` y `/admin/users` **antes y después** del cambio: el resultado
    tiene que ser idéntico. (CA-21)
13. Probar en Chrome y en Firefox: `print-color-adjust` y `break-inside` tienen soporte
    dispar, y el informe tiene que ser legible en ambos aunque no salga idéntico.

## Dependencias

- **`directivo-graficos.spec.md`** — `bar-list` (bloques 4 y 6), `stacked-bar` + `legend`
  (bloque 5), `grouped-bars` (bloque 7). **Bloqueante**: sin la fase 1 de aquella spec, esta
  no se puede implementar sin volver a copiar y pegar bloques `<style>`, que es justo lo que
  se está tratando de terminar.
- **`directivo-riesgo.spec.md`** — `getDivisionRisk()` y `getDivisionMetrics()` de
  `services/riskScore.js` y `services/directivoMetrics.js`. **Bloqueante para el bloque 4**
  (riesgo) y **para el 6** (tasa por división). Si se decidiera implementar el informe antes
  que el riesgo, el bloque 4 se omite y el 6 usa una consulta propia — pero entonces se
  duplica la agregación de divisiones, que es exactamente lo que RN-11 de aquella spec
  prohíbe. **Recomendación: no implementar esta spec antes que `directivo-riesgo`.**
- **`directivo-umbrales.spec.md`** — *no bloqueante*. Si está, la nota metodológica imprime
  los umbrales configurados; si no está, imprime las constantes actuales. El único cambio es
  de dónde sale el número que se rotula.
- `routes/directivo.js` — ruta nueva; extracción de los helpers de ventana temporal
  (`:575-606`); links al informe en el dashboard.
- `config/sections.js` + `views/partials/directivo-nav.ejs` — solapa nueva.
- `public/css/style.css` — bloque `@media print` y `@page`.
- `server.js` — nada nuevo: `can()` (`:342-346`) y `roleNames` (`:317`) ya existen.

## Riesgos de refactorización

1. **Es el primer `@media print` del proyecto.** El riesgo real no está en esta vista sino
   en las otras cuarenta: una regla global mal puesta cambia cómo imprime toda la app y
   nadie se entera hasta que alguien imprime. Mitigación: RN-07 (todo scopeado a
   `body.doc-print`, salvo `.no-print`) + CA-21 + la verificación manual 12.
2. **Mover los helpers de ventana temporal toca dos rutas que ya funcionan.**
   `inicioVentanaSerie`, `etiquetasMeses` y `mesCorto` los usan `GET /teachers` y
   `GET /teachers/:id`, que muestran la serie mensual que el directivo ya viene leyendo.
   Mitigación: commit propio, sin cambio de comportamiento, cubierto por los dos smoke tests
   existentes (test 8).
3. **El informe compone datos de cuatro fuentes: es la vista más cara del panel.** Ejecuta,
   en una sola request, lo que hoy se reparte entre el dashboard, `/grades`, `/divisions` y
   parte de `/teachers`. En una escuela con ~419 materias puede tardar. Mitigación: (a) es
   una pantalla de uso ocasional, no el landing; (b) RN-04 recorta queries cuando hay
   bloques deshabilitados; (c) medir el tiempo de respuesta antes de mergear y, si molesta,
   la salida natural es cachear el informe por unos minutos —**no** convertirlo en un job ni
   en un archivo, que nos devolvería a la decisión descartada del 2026-07-21.
4. **`print-color-adjust` no es confiable entre navegadores e impresoras.** Un usuario puede
   terminar con barras blancas. Mitigación: RN-09 (el número al lado de la barra), que hace
   que el informe siga sirviendo aunque no se imprima un solo color.
5. **Riesgo de alcance: "ya que estamos, que lo mande por mail".** Queda escrito acá que la
   respuesta es no, y por qué (RN-01). El día que se quiera revisar, se revisa la decisión
   del 2026-07-21 de frente, no por goteo desde esta spec.
6. **Sin cambios en la base de datos.** No hace falta aviso previo de BD para esta spec.

## Plan de migración

1. **Extracción de los helpers de ventana temporal** de `routes/directivo.js:575-606` a
   `services/directivoMetrics.js`, con `GET /teachers` y `GET /teachers/:id` importándolos.
   Commit propio, sin cambios de comportamiento, validado por los smoke tests existentes.
2. **`getSchoolMonthlySeries(schoolId)`** en el mismo service, reusando las dos agregaciones
   de `routes/directivo.js:707-731` (con `grades.manual: true`, RN-06).
3. **Bloque `@media print` + `@page`** en `public/css/style.css`. Sin consumidores todavía:
   solo `.no-print` es global, y ninguna vista existente usa esa clase, así que al terminar
   este paso la app imprime exactamente igual que antes.
4. **`config/sections.js`** + **`views/partials/directivo-nav.ejs`**: solapa "Informe".
5. **`routes/directivo.js`**: `GET /report`, componiendo las fuentes con las guardas de
   RN-04, y **`views/directivo/report.ejs`** con los partials de gráficos.
6. **Links** al informe desde el dashboard y desde `/directivo/risk`, con `can('directivo_report')`.
7. **Smoke tests** (los 7 nuevos) y verificación de que los del panel directivo siguen verdes.
8. **Verificación manual de impresión** (puntos 9 a 13 de *Tests necesarios*), en Chrome y
   Firefox, en tema claro y oscuro. **Este paso no es opcional**: es la única cobertura real
   de lo que esta spec entrega.
9. **`agente.md`**: changelog, dejando asentado por escrito que el informe imprimible **no**
   reabre la decisión del 2026-07-21 sobre exportación a Excel y notificaciones (RN-01).

**Rollback**: revertir los pasos 4-6 saca la vista y la solapa; los pasos 1-3 pueden quedar
en el repo sin efecto visible (el service extraído es equivalente al código viejo y el CSS
de impresión no lo usa nadie).
