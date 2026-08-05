# Gráficos del panel directivo (infraestructura de visualización)

> **Primera spec del repositorio.** `specs/` estaba vacío antes de este lote, así que no
> hay specs previas con las que contradecirse. Las cuatro specs de este lote son:
> `directivo-graficos` (esta) → `directivo-umbrales` → `directivo-riesgo` →
> `directivo-informe-impresion`.
>
> **Por qué está separada del resto:** es la única pieza puramente de presentación (EJS +
> CSS, cero rutas, cero schema, cero queries). La aprueba y la implementa quien mira UI, y
> las otras tres specs la consumen sin conocer su interior. Además es la única que toca
> vistas que HOY funcionan (`grades.ejs`, `teacher-detail.ejs`, `teachers.ejs`), así que su
> riesgo de regresión es distinto en naturaleza al de las demás.

## Objetivo

Dar al panel directivo un vocabulario visual único y reutilizable de gráficos —barras
horizontales, barras apiladas y barras agrupadas— para que las métricas que hoy se leen
como números sueltos en tablas se puedan comparar de un vistazo, respetando el tema de la
escuela (incluido el modo oscuro) y siendo legibles al imprimir en blanco y negro.

## Responsabilidades

- Definir **partials EJS reutilizables** que reciben datos ya calculados y devuelven HTML.
- Definir el **bloque CSS de gráficos** en `public/css/style.css`, con variables de tema.
- Definir la **paleta semántica** (`--chart-*`) y su variante para modo oscuro.
- Garantizar que todo gráfico exponga su valor numérico **como texto**, no solo como ancho.
- Definir el comportamiento en `@media print` de los gráficos (ver
  `directivo-informe-impresion.spec.md`, que es su primer consumidor).

## No responsabilidades

- **No calcula nada.** Los partials no hacen queries ni derivan métricas: reciben arrays ya
  armados por la ruta o el service.
- **No introduce una librería de charting** ni ningún archivo en `public/js/vendor/`
  (decisión justificada abajo, en *Reglas de negocio* RN-01).
- **No cambia ninguna ruta, schema, permiso ni acción auditable.**
- **No rediseña las vistas existentes.** La migración de las 3 vistas que hoy tienen
  gráficos hechos a mano es opt-in y está en el *Plan de migración*, fase 2.
- No cubre gráficos de línea, torta, dispersión ni ejes temporales: no hay caso de uso hoy
  (ver *Decisiones abiertas* del reporte).

## Entidades/Schemas

Ninguna entidad de base de datos. Los contratos son de **locals de EJS**.

### Partial `views/partials/charts/bar-list.ejs` — barras horizontales comparativas

```
locals:
  items:     [{ label: String,          // texto de la fila (obligatorio)
                value: Number|null,     // valor numérico; null = "sin datos"
                display: String,        // texto a mostrar (ej: "72 %", "6,4"); default String(value)
                max:   Number,          // opcional por ítem; si falta usa `max` global
                tone:  'ok'|'warn'|'bad'|'neutral',  // color semántico; default 'neutral'
                href:  String|null,     // si viene, la fila es un link
                hint:  String }]        // opcional, texto chico bajo el label
  max:       Number                     // escala común. Default: el mayor `value` (mín 1)
  title:     String                     // opcional, encabezado del bloque
  empty:     String                     // texto si items está vacío. Default 'Sin datos para mostrar.'
```

### Partial `views/partials/charts/stacked-bar.ejs` — barra apilada de distribución

```
locals:
  segments:  [{ label: String, value: Number, color: String /* var(--chart-*) */ }]
  total:     Number       // opcional; default = suma de values. Si es 0 → barra vacía gris
  legend:    Boolean      // default false (la leyenda suele ser común a varias barras)
  compact:   Boolean      // default false; true = altura 8px para usar dentro de una celda
```

### Partial `views/partials/charts/grouped-bars.ejs` — columnas agrupadas por categoría

```
locals:
  categories: [String]                    // ej: ['mar','abr','may','jun','jul','ago']
  series:     [{ label: String,           // ej: 'Actividades creadas'
                 color: String,           // var(--chart-*)
                 values: [Number] }]      // misma longitud que categories
  height:     Number    // px del área de barras. Default 124 (el actual de teacher-detail)
  legend:     Boolean   // default true
  empty:      String    // texto cuando todas las series son 0
```

### Partial `views/partials/charts/legend.ejs` — leyenda suelta

```
locals: items: [{ label: String, color: String }]
```

## Entradas

- Arrays en memoria pasados como locals por la vista que incluye el partial.
- Variables CSS del tema activo (`:root` / `[data-theme="dark"]` de `public/css/style.css`).

## Salidas

- HTML sin scripts. Cada barra lleva `title` con el texto completo (`label: display`).
- Ningún partial escribe en `res.locals` ni depende de globales fuera de las variables CSS.

## Reglas de negocio

- **RN-01 — Sin librería de charting: barras CSS/HTML hechas a mano.** Decisión tomada
  contra la alternativa de vendorizar Chart.js en `public/js/vendor/`. Fundamento:
  1. **Ya es la convención del proyecto y está documentada en el código.**
     `views/directivo/teacher-detail.ejs:60-61` dice literalmente: *"Barras CSS puras, sin
     librería de charting (mismo criterio que .bucket-bar en grades.ejs y el sparkline de
     teachers.ejs)"*. Hay tres gráficos hechos así, funcionando. Meter una librería crea un
     cuarto estilo y deja los tres viejos como deuda.
  2. **Chart.js dibuja en `<canvas>`, y un canvas no conoce las variables CSS.** El
     requisito de respetar el tema (incluido `[data-theme="dark"]`) obligaría a leer los
     colores con `getComputedStyle` y a re-renderizar cada gráfico al cambiar el tema. Con
     divs, el modo oscuro es gratis: la variable cambia y el gráfico ya está pintado bien.
  3. **La vista de impresión es un requisito de este mismo lote.** Con CSS puedo redefinir
     las variables dentro de `@media print` y todo el gráfico se adapta; con canvas
     dependo de `-webkit-print-color-adjust` y del tamaño con que se rasterizó en pantalla.
  4. **Los tres gráficos pedidos son barras.** Distribución en buckets (apilada),
     comparación entre divisiones (horizontal) y ranking de riesgo (horizontal). Ninguno
     necesita ejes calculados, escalas logarítmicas, interpolación ni interacción.
  5. Costo evitado: ~200 KB de vendor commiteado al repo, que hay que actualizar a mano
     ante un CVE, en un proyecto que hoy no tiene ni un solo archivo de terceros en
     `public/js/`.

  **Cuándo revisar esta decisión** (queda escrito para no discutirlo de nuevo desde cero):
  si aparece la necesidad de gráficos de línea con eje temporal real, más de ~8 series
  simultáneas, o zoom/hover interactivo con tooltips ricos. En ese caso la opción es
  Chart.js self-hosted en `public/js/vendor/chart.umd.min.js` (nunca CDN externo: es un
  panel de escuela con datos de menores).

- **RN-02 — El número va siempre como texto.** Todo valor representado por un ancho o una
  altura tiene que estar además impreso como texto (o al menos en el `title`). Un gráfico
  que solo comunica por tamaño es ilegible impreso en blanco y negro, invisible para un
  lector de pantalla y ambiguo cuando dos barras difieren en 2 px.

- **RN-03 — Colores por variable, nunca hardcodeados en la vista.** Los partials aceptan
  colores solo como `var(--chart-*)`. Se define la paleta semántica en `:root`:

  | Variable | Significado | Valor claro | Valor oscuro |
  |---|---|---|---|
  | `--chart-bad`     | crítico / peor tramo (nota < 4, riesgo alto)   | `#ea4335` | `#f28b82` |
  | `--chart-warn`    | atención (nota 4-6, riesgo medio)              | `#ea8600` | `#fbbc04` |
  | `--chart-info`    | neutro-positivo (nota 6-8, series primarias)   | `#1a73e8` | `#8ab4f8` |
  | `--chart-ok`      | bueno (nota 8-10, riesgo bajo)                 | `#34a853` | `#81c995` |
  | `--chart-neutral` | sin datos / fondo de barra                     | `var(--border)` | `var(--border)` |

  Los valores del tema claro son exactamente los que hoy usan `grades.ejs:88-91,124-127` y
  `teacher-detail.ejs:74-85`, para que migrar esas vistas no cambie ni un píxel de color.
  Los del tema oscuro son los mismos tonos aclarados (contraste sobre `--surface: #1e2124`).

- **RN-04 — Nunca usar `var(--background)`.** Esa variable **no existe**; la real es
  `--bg`. Es un error preexistente en las tablas de directivo y preceptor, ya detectado y
  anotado (`agente.md:445`). Los gráficos nuevos no lo replican.

- **RN-05 — Un valor 0 se dibuja, no se omite.** Barra de altura/ancho mínimo (2 px) para
  que un mes o una división en cero se lea como "cero" y no como "hueco/no cargado". Es el
  criterio que ya aplica `teacher-detail.ejs:161` y `style.css` `.serie-bar { min-height }`.

- **RN-06 — `null` no es `0`.** Un valor `null` (métrica no calculable: división sin
  actividades, materia sin notas) se renderiza como `—` con la barra en
  `--chart-neutral`, nunca como una barra de 0. Es la misma distinción que ya hacen
  `routes/directivo.js:159` (`deliveryRate = ... : null`) y `:1004` (`tasa: ... : null`),
  documentada ahí como *"null se renderiza como '—', no como 0%, que se leería como fracaso"*.

- **RN-07 — El gráfico no puede ensanchar la página.** Contenedor con `overflow-x: auto`
  y `min-width` por columna (mismo criterio que `.serie-grid`, `style.css` vía
  `teacher-detail.ejs:77`). El panel se usa en celular.

- **RN-08 — Sin JavaScript.** Los partials no emiten `<script>`. Cualquier interactividad
  (ordenar, filtrar) se resuelve con links y query params, como ya hace todo el panel.

- **RN-09 — El CSS de gráficos vive en `public/css/style.css`, no en un `<style>` por
  vista.** Hoy cada vista del panel repite su propio bloque `<style>` con `.section-h`,
  `.simple-table`, `.badge-*`… y los gráficos siguen el mismo camino. Los estilos nuevos
  (`.chart-*`) se agregan una sola vez, en un bloque rotulado `/* ─── Gráficos ─── */`.

## Casos de uso

| Caso de uso | Quién | Qué obtiene |
|---|---|---|
| Comparar la tasa de entrega entre divisiones | directivo | `bar-list` con una fila por división, escala 0-100 |
| Ver la distribución de notas de una división/materia | directivo | `stacked-bar` con los 4 buckets ya calculados en `GET /grades` |
| Ver el ranking de riesgo | directivo | `bar-list` con `tone` derivado de la etiqueta de riesgo |
| Ver la evolución mensual de un docente | directivo | `grouped-bars` con las series `creadas` y `corregidas` |
| Llevar cualquiera de los anteriores a papel | directivo | el mismo gráfico, legible en B/N (ver spec de impresión) |

No hay casos de uso auditables: esta spec no genera ninguna acción de
`config/audit-actions.js` porque no escribe nada.

## Criterios de aceptación

- **CA-01** — Dado un `bar-list` con `items` de valores 10, 20 y 40 y sin `max` explícito,
  cuando se renderiza, entonces la barra de 40 ocupa el 100 % del ancho útil, la de 20 el
  50 % y la de 10 el 25 %, y las tres muestran su `display` como texto.
- **CA-02** — Dado un ítem con `value: null`, cuando se renderiza, entonces se muestra `—`
  como texto y la barra queda pintada con `--chart-neutral`, sin ancho proporcional.
- **CA-03** — Dado un ítem con `value: 0`, cuando se renderiza, entonces se dibuja una
  barra de ancho mínimo visible (≥ 2 px) y el texto `0`, distinguible de CA-02.
- **CA-04** — Dado un `bar-list` con `items: []`, cuando se renderiza, entonces se muestra
  el texto de `empty` y no se emite ninguna barra ni tabla vacía.
- **CA-05** — Dado un `stacked-bar` con segmentos 3/1/0/6, cuando se renderiza, entonces
  hay 4 segmentos (el de valor 0 con ancho 0), la suma de anchos es el 100 % del contenedor
  y cada segmento tiene `title` con su etiqueta y su valor absoluto.
- **CA-06** — Dado un `stacked-bar` cuyos segmentos suman 0, cuando se renderiza, entonces
  la barra queda completa en `--chart-neutral` y no se produce división por cero
  (ni `NaN`, ni `Infinity` en el HTML emitido).
- **CA-07** — Dado un `grouped-bars` con 2 series y 6 categorías, cuando se renderiza,
  entonces hay 6 columnas, cada una con 2 barras, todas escaladas contra el máximo común de
  ambas series, y el eje de categorías muestra las 6 etiquetas.
- **CA-08** — Dado un `grouped-bars` cuyas series son todas 0, cuando se renderiza,
  entonces se muestra el texto de `empty` en vez de la grilla de barras.
- **CA-09** — Dado cualquier partial de esta spec, cuando se inspecciona el HTML emitido,
  entonces no aparece ningún color literal (`#rrggbb` o `rgb(`) fuera de los definidos por
  `var(--chart-*)`, ni la cadena `var(--background)`.
- **CA-10** — Dado el tema oscuro activo (`<html data-theme="dark">`), cuando se renderiza
  cualquier gráfico, entonces los colores salen de las variables redefinidas en
  `[data-theme="dark"]` y el texto de las etiquetas usa `--text` / `--text-secondary`
  (verificable porque el HTML no cambia entre temas: solo cambian las variables).
- **CA-11** — Dado un `bar-list` con `href` en sus ítems, cuando se renderiza, entonces
  cada fila es un `<a>` navegable con el foco visible por teclado; sin `href`, no hay `<a>`.
- **CA-12** — Dado cualquier partial de esta spec, cuando se renderiza, entonces el HTML no
  contiene etiquetas `<script>` ni atributos `on*=`.
- **CA-13** — Dado un `label` con `<`, `>` o `&`, cuando se renderiza, entonces aparece
  escapado (`<%= %>`, nunca `<%- %>`): un nombre de división o de materia viene de la base y
  no es contenido confiable.
- **CA-14** — Dado que se agregan los estilos de gráficos, cuando se busca en
  `public/css/style.css`, entonces existe un único bloque rotulado `/* ─── Gráficos ─── */`
  con todas las clases `.chart-*` y las variables `--chart-*` declaradas en `:root` y en
  `[data-theme="dark"]`.

## Errores posibles

Esta spec no produce respuestas HTTP propias: los partials se renderizan dentro de vistas
que ya resolvieron su autorización. Los modos de falla son de programación, y se resuelven
con defaults en vez de con excepciones:

| CODIGO | HTTP | Mensaje en español | Cuándo |
|---|---|---|---|
| `CHART_MISSING_DATA` | — (no HTTP) | «Sin datos para mostrar.» | El partial recibe `items`/`series` vacío, `undefined` o `null`. Se renderiza el estado vacío; **nunca** se lanza una excepción que rompa la página entera. |
| `CHART_INVALID_SERIES` | — (no HTTP) | «Sin datos para mostrar.» | En `grouped-bars`, una serie con largo distinto al de `categories`. Se recorta/rellena con 0 y se sigue. En desarrollo (`NODE_ENV !== 'production'`) además se emite un `logger.warn`. |

Justificación: un gráfico es adorno informativo. Si el dato viene mal, la pantalla del
directivo tiene que seguir sirviendo sus tablas — es el mismo criterio *fail-soft* que ya
aplica `middleware/audit.js` («un fallo del audit no puede romper la operación real»).

## Tests necesarios

**Smoke HTTP (`tests/smoke/specs.js`)** — el proyecto no tiene test runner de vistas, así
que los partials se verifican por el HTML que producen sus consumidores:

1. `charts-render-in-grades` — `GET /directivo/grades` como directivo devuelve 200 y el
   HTML contiene `class="chart-stack"` (o el nombre de clase que quede) y las 4 etiquetas
   de bucket. Cubre CA-05.
2. `charts-no-nan-in-html` — para `/directivo/grades`, `/directivo/divisions` y
   `/directivo/risk`: el HTML **no** contiene `NaN`, `Infinity`, `undefined` ni
   `var(--background)`. Cubre CA-06 y CA-09 de la forma más barata posible: una escuela
   real siempre tiene alguna división sin actividades.
3. `charts-empty-state` — una búsqueda sin resultados
   (`/directivo/divisions?search=zzzznoexistezzz`) devuelve 200 con el estado vacío y sin
   barras. Cubre CA-04.
4. **Regresión de las vistas existentes** (bloquea la fase 2 de la migración):
   `directivo-teacher-detail` ya asserta `'Evolución de los últimos'`
   (`tests/smoke/specs.js:2039`) y `directivo-teachers` asserta
   `'Actividades por mes' || 'Sin calificar'` (`:2004`). Esos asserts **no se tocan**: si la
   migración de `teacher-detail.ejs` a `grouped-bars` los rompe, la migración está mal.

**Verificación manual documentada** (no automatizable con esta suite):
5. Modo oscuro: abrir cada vista con gráficos en `[data-theme="dark"]` y comprobar que
   ninguna barra queda invisible sobre `--surface`. (CA-10)
6. Impresión: `Ctrl+P` sobre `/directivo/report` y verificar que las barras salen en la
   vista previa. (CA-10 + spec de impresión)

## Dependencias

- `public/css/style.css` — variables de tema `:root` / `[data-theme="dark"]` (líneas 5-40).
- `views/partials/` — convención de includes con locals ya usada por `contact-info.ejs`,
  `about-info.ejs`, `pagination.ejs`.
- **Consumidores** (specs de este mismo lote): `directivo-riesgo.spec.md` y
  `directivo-informe-impresion.spec.md`. Ninguno de los dos puede empezar antes que esta.
- Vistas existentes que quedarán en deuda hasta la fase 2: `views/directivo/grades.ejs`
  (`.bucket-bar`, líneas 33-45 y 123-128), `views/directivo/teacher-detail.ejs`
  (`.serie-*`, líneas 60-92 y 146-176), `views/directivo/teachers.ejs` (sparkline).

## Riesgos de refactorización

1. **Migrar las 3 vistas existentes puede cambiar números o textos que ya se leen.** Las
   barras de `grades.ejs` y `teacher-detail.ejs` están en producción y el directivo las
   viene mirando. Mitigación: la migración es **fase 2, separada del merge de la fase 1**, y
   los asserts de smoke sobre esas vistas se conservan tal cual.
2. **`style.css` es un archivo grande y compartido por toda la app.** Agregar clases
   genéricas (`.bar`, `.chart`) podría colisionar con reglas existentes. Mitigación: prefijo
   obligatorio `.chart-` en todas las clases nuevas, y ninguna regla sobre selectores de
   elemento (`div`, `span`) sin prefijo.
3. **`NODE_ENV=production` en el `.env` local cachea las vistas EJS**: al agregar partials
   nuevos, los cambios no se ven hasta reiniciar el server (nodemon no alcanza). Es un
   tropiezo conocido del entorno, no un bug de esta spec — anotarlo en el PR para que el
   revisor no reporte "no se ve nada".
4. **La paleta semántica podría chocar con los temas por escuela.** `School.themes` puede
   aplicar configuraciones visuales; si algún tema redefine `--primary` u otras variables,
   los `--chart-*` quedan independientes a propósito (son cinco variables propias, no
   alias). Riesgo bajo, pero verificar en una escuela con tema activo antes de mergear.

## Plan de migración

**Fase 1 — Infraestructura (sin tocar nada existente).**
1. Agregar las variables `--chart-*` a `:root` y a `[data-theme="dark"]` en
   `public/css/style.css`, con los valores exactos de RN-03.
2. Agregar el bloque `/* ─── Gráficos ─── */` con las clases `.chart-*`.
3. Crear `views/partials/charts/bar-list.ejs`, `stacked-bar.ejs`, `grouped-bars.ejs`,
   `legend.ejs`.
4. Ningún consumidor todavía: al terminar la fase 1, la app se ve **exactamente igual**.
   El diff no toca ninguna vista existente. Esto es lo que hace la fase 1 mergeable sola.

**Fase 2 — Consumo por las features nuevas.**
5. `directivo-riesgo` y `directivo-informe-impresion` incluyen los partials. Es el primer
   uso real y valida los contratos.

**Fase 3 — Migración de las vistas existentes (opt-in, PR aparte, una vista por commit).**
6. `grades.ejs` → `stacked-bar` + `legend`. Verificar visualmente que la barra queda
   idéntica (mismos colores, misma altura de 12 px).
7. `teacher-detail.ejs` → `grouped-bars`. **Conservar el texto "Evolución de los últimos"**
   (lo asserta `tests/smoke/specs.js:2039`).
8. `teachers.ejs` → sparkline. Conservar los textos que assertan los smoke tests.
9. Recién ahí borrar los bloques `<style>` duplicados de esas tres vistas.

**Sin cambios de base de datos.** No hace falta avisar por la BD de producción para este
lote (sí para `directivo-umbrales`, ver esa spec).
