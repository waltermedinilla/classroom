# Score de riesgo por división (y por materia)

> **Parte del lote de 4 specs del panel directivo.** Orden sugerido de aprobación:
> `directivo-graficos` → `directivo-umbrales` → **`directivo-riesgo`** (esta) →
> `directivo-informe-impresion`.
>
> **Por qué está separada:** es la única que introduce **lógica de negocio nueva** (una
> fórmula que hoy no existe en ninguna parte del sistema) y la única que necesita una
> discusión sobre *cómo se pondera* algo. Mezclarla con la spec de gráficos escondería esa
> discusión adentro de un PR de CSS. Depende de `directivo-graficos`; **no** depende de
> `directivo-umbrales`.

## Objetivo

Cruzar en un solo número comparable las tres señales que hoy el directivo tiene que ir a
buscar a tres pantallas distintas —tasa de entrega, promedio normalizado y actividades
vencidas sin calificar— y ordenar las divisiones de la escuela por ese número, para que la
primera pregunta del día ("¿por dónde empiezo a mirar?") se conteste en una pantalla y no
en tres.

## Responsabilidades

- Definir la **fórmula del score de riesgo** y sus etiquetas, de forma explicable.
- Definir el manejo de **señales faltantes** (divisiones sin actividades, sin notas, nuevas).
- Definir la **vista nueva** `GET /directivo/risk` con su ranking, sus gráficos y su
  desglose por materia.
- Definir el **bloque resumido en el dashboard** (`GET /directivo`) que lleva a esa vista.
- Definir la **columna de riesgo** en el listado de divisiones ya existente.
- Extraer a un service las métricas por división para que el ranking y el listado **no
  puedan dar números distintos**.

## No responsabilidades

- **No inventa métricas nuevas.** Las tres señales ya se calculan hoy; esta spec solo las
  combina. Tasa de entrega: `routes/directivo.js:1004`. Promedio normalizado: `:977-990`.
  Vencidas sin calificar: `:956-960`.
- **No es un ranking de docentes.** El score es por división y por materia. Que una materia
  tenga un titular no lo convierte en un indicador de desempeño individual — ver RN-10.
- **No escribe nada**: sin POST, sin schema nuevo, sin acción auditable. Es una vista de
  solo lectura más del panel.
- **No usa los umbrales configurables** de `directivo-umbrales.spec.md`: sus constantes son
  propias y viven en el service (ver RN-09 y las *Decisiones abiertas* del reporte).
- **No genera alertas, ni notificaciones, ni exportaciones.** El usuario descartó
  explícitamente notificaciones y export a Excel para este panel el 2026-07-21
  (`agente.md:1259`). Esta spec no las reintroduce por la ventana.
- No hace ranking a nivel alumno: eso ya existe en `/directivo/students` con sus flags.

## Entidades/Schemas

Sin cambios en la base de datos. Las estructuras son en memoria.

### `services/riskScore.js` (nuevo)

```js
// Pesos de cada señal en el score final. Suman 1. Ver RN-02 para el fundamento.
const PESOS = { entrega: 0.40, rendimiento: 0.35, correccion: 0.25 };

// Cortes de etiqueta sobre el score 0-100. Ver RN-03.
const CORTES = { medio: 25, alto: 50 };

// Mínimo de calificaciones para que la señal de rendimiento cuente. Ver RN-05.
const MIN_NOTAS = 10;

// computeRisk(m) — función PURA, sin acceso a la base. Se testea sola.
//   m: { tasa, promedio, notas, actividades, vencidasSinCalificar, alumnos }
//   → { score, etiqueta, disponibles, senales }
//
//   score:       Number 0-100 redondeado, o null si no hay ninguna señal disponible
//   etiqueta:    'bajo' | 'medio' | 'alto' | 'sin-datos'
//   disponibles: 0-3, cuántas señales entraron en el cálculo
//   senales:     { entrega: Number|null, rendimiento: Number|null, correccion: Number|null }
//                cada una en escala 0-100 donde MÁS ES PEOR

// getDivisionRisk(schoolId, { search }) → [ { ...métricas de la división, riesgo } ]
// getCourseRisk(divisionId)             → [ { ...métricas de la materia,  riesgo } ]
```

### `services/directivoMetrics.js` (nuevo, por extracción)

`getDivisionMetrics(schoolId, { search })` — **mueve tal cual** el bloque de agregaciones
de `routes/directivo.js:934-1007` (el `Division.aggregate` con sus lookups, el aggregate de
entregas y el de notas). Devuelve una fila por división con exactamente los mismos campos
que la ruta arma hoy, **más `notas`** (la cantidad de calificaciones consideradas, que el
aggregate `notas` ya calcula en `n.count` pero la ruta descarta en `:988-990`):

```
{ _id, name, materias, alumnos, docentes, actividades,
  vencidasSinCalificar, entregas, esperadas, tasa, promedio, notas }
```

Motivo de la extracción, no de la duplicación: es exactamente la lección que dejó escrita
`services/divisionDetail.js:4-6` — *"Duplicar estas agregaciones garantizaba que en unos
meses los dos paneles mostraran números distintos para la misma división."*

### Vista nueva

`views/directivo/risk.ejs` (`activePage: 'risk'`).

### Nueva entrada en `config/sections.js`

```js
{ key: 'directivo_risk', panel: 'directivo', label: 'Riesgo', icon: 'crisis_alert',
  path: '/directivo/risk', roles: ['directivo', 'admin', 'superadmin'] },
```

Sin `locked`: un ranking de divisiones es información políticamente sensible dentro de una
escuela y tiene que poder apagarse por escuela desde `/superadmin/roles` (RN-10).

## Entradas

### `GET /directivo/risk`
| Parámetro | Tipo | Default | Qué hace |
|---|---|---|---|
| `division` | ObjectId | — | Si viene, se muestra además el desglose por materia de esa división |
| `search` | String | `''` | Filtra divisiones por nombre (mismo `$regex` case-insensitive que `:935`) |
| `sort` | `score-desc` \| `score-asc` \| `name` | `score-desc` | Orden del ranking |
| `page` | Number | 1 | Paginación de a 25, mismo criterio que el resto del panel |

Sesión con rol `directivo`, `admin` o `superadmin`; `res.locals.user.school` obligatorio.

### `GET /directivo` (dashboard, extensión)
Sin parámetros nuevos.

## Salidas

### `GET /directivo/risk`
```
{ divisions: [ { _id, name, materias, alumnos, docentes, actividades,
                 vencidasSinCalificar, entregas, esperadas, tasa, promedio, notas,
                 riesgo: { score, etiqueta, disponibles, senales } } ],
  resumen:   { alto: N, medio: N, bajo: N, sinDatos: N },   // conteos de TODA la escuela
  division:  { _id, name } | null,       // la división del drill-down, si hay
  courses:   [ { _id, name, teacher, ...métricas, riesgo } ] | null,
  search, sort, page, totalPages, total, queryParams,
  activePage: 'risk' }
```

Gráficos de la vista (partials de `directivo-graficos.spec.md`):
- `bar-list` con el **top 10 del ranking** (`value: score`, `max: 100`, `tone` derivado de
  la etiqueta, `href` al drill-down de esa división).
- `bar-list` con la **tasa de entrega** de las mismas divisiones, para leer la señal que más
  pesa sin salir de la pantalla.
- En el drill-down: `bar-list` de las materias de la división por score.

Tabla de respaldo con las tres señales en columnas separadas: el score sin sus componentes
es una caja negra, y el directivo tiene que poder ver **por qué** una división está arriba.

### `GET /directivo` (dashboard)
Suma `riesgoTop: [ { _id, name, riesgo } ]` con las **3 divisiones de mayor score** (solo
las de etiqueta `medio` o `alto`; si no hay ninguna, el bloque no se muestra) y
`riesgoResumen: { alto, medio, bajo, sinDatos }`.

## Reglas de negocio

- **RN-01 — Tres señales, todas normalizadas a 0-100 donde MÁS ES PEOR.**

  | Señal | Fórmula | Disponible cuando | Origen del dato |
  |---|---|---|---|
  | `entrega` | `100 − clamp(tasa, 0, 100)` | `tasa !== null` (o sea, `actividades × alumnos > 0`) | `routes/directivo.js:1004` |
  | `rendimiento` | `(10 − clamp(promedio, 0, 10)) × 10` | `promedio !== null` **y** `notas >= MIN_NOTAS` | `routes/directivo.js:977-990` |
  | `correccion` | `clamp(vencidasSinCalificar / actividades, 0, 1) × 100` | `actividades > 0` | `routes/directivo.js:956-960` |

  El `clamp` no es defensivo por gusto: `tasa` puede pasar de 100 (un alumno entregó y
  después lo sacaron de la materia, entonces `entregas > actividades × alumnos`) y
  `promedio` puede pasar de 10 si un docente cargó más puntos que el máximo de la actividad.
  Sin clamp, el score se iría de rango y el gráfico se rompería.

- **RN-02 — Score = promedio ponderado de las señales DISPONIBLES.**
  `score = Σ(peso_i × señal_i) / Σ(peso_i)` sobre las señales disponibles, redondeado a
  entero. Los pesos (`0.40 / 0.35 / 0.25`) se justifican así:
  - **Entrega (0.40), la más pesada**: es la señal más temprana y la más difícil de
    falsear. Aparece antes que las notas (no hay que esperar a que alguien corrija) y no
    depende del criterio de corrección de cada docente. Si en una división no se entrega,
    hay un problema ahí, se mire como se mire.
  - **Rendimiento (0.35)**: es el resultado pedagógico, que es lo que en el fondo importa,
    pero es más ruidoso: depende de cuán exigente sea cada docente y de la normalización
    por `points`, que descarta las actividades con `points: null` (`:282`). Pesa casi tanto
    como la entrega, pero no más.
  - **Corrección pendiente (0.25), la más liviana**: mide una conducta **institucional/
    docente**, no un resultado del curso, y es la más volátil — un solo docente que no
    corrige arrastra a toda la división. Se incluye porque es exactamente el problema que
    el directivo puede resolver con una llamada, pero no debe dominar el ranking.

- **RN-03 — Tres etiquetas, no cinco.** `score < 25` → **Bajo** (verde),
  `25 ≤ score < 50` → **Medio** (ámbar), `score ≥ 50` → **Alto** (rojo). Sin señales
  disponibles → **Sin datos** (gris). Tres etiquetas se corresponden con los tres colores
  de badge que la UI ya usa (`badge-ok` / `badge-warn` / `badge-red`) y con la única
  decisión que el directivo va a tomar mirando esto: mirar ahora, mirar esta semana, o no
  mirar. Calibración de referencia:
  - División sana (tasa 85 %, promedio 8, 5 % vencidas sin calificar) → **14 · Bajo**.
  - División intermedia (tasa 60 %, promedio 6,5, 20 %) → **33 · Medio**.
  - División en problemas (tasa 30 %, promedio 4,5, 60 %) → **62 · Alto**.

- **RN-04 — Una señal faltante NO vale cero, y tampoco vale cien.** Se renormaliza sobre
  los pesos de las señales presentes. Tratar `null` como 0 haría que una división sin notas
  cargadas apareciera artificialmente sana (que es justo el caso donde el directivo más
  necesita mirar); tratarlo como 100 llenaría el tope del ranking de divisiones nuevas y
  volvería la pantalla inútil en marzo. Es la misma distinción `null ≠ 0` que ya sostiene
  el panel (`routes/directivo.js:994-996`).

- **RN-05 — El rendimiento no cuenta con menos de `MIN_NOTAS = 10` calificaciones.** Con 3
  notas cargadas, un promedio de 4 no dice nada de la división y sí patea el ranking. Por
  debajo de ese piso la señal se considera no disponible y se renormaliza (RN-04).

- **RN-06 — Sin ninguna señal disponible → `score: null`, etiqueta "Sin datos".** Nunca 0.
  Una división recién creada, sin materias o sin actividades, no es una división sana. En el
  orden `score-desc` estas filas van **al final**, con el mismo criterio con el que las
  tasas `null` ya van al final en `/directivo/courses` (`:168-174`).

- **RN-07 — El score muestra siempre cuántas señales lo respaldan.** La vista imprime
  "2 de 3 señales" junto al score cuando `disponibles < 3`. Un número compuesto sin decir
  de qué está compuesto es una superstición, no un diagnóstico.

- **RN-08 — El mismo cálculo, a nivel materia, solo dentro de una división.** La fórmula
  aplica igual a una materia (las tres señales existen a nivel `Course`: `deliveryRate`
  en `:159`, promedio por curso en `/grades` `:338-345`, `overdueUngraded` en `:136-143`).
  Pero **el ranking principal es por división**, y el de materias aparece solo al entrar a
  una. Razones: (1) es la unidad con la que piensa un directivo, ya escrito en el propio
  código — *"Vista por división (1°A, 2°B…), que es como suele pensar un directivo antes
  que por materia suelta"* (`routes/directivo.js:913-915`); (2) a nivel materia las
  muestras son chicas y el score se vuelve ruidoso (una materia con 15 alumnos y 4
  actividades); (3) un ranking plano de ~419 materias no contesta "¿por dónde empiezo?",
  contesta "acá tenés 419 problemas". El flujo correcto es: división → materia → docente.

- **RN-09 — Los pesos y los cortes son constantes del service, no configurables.** Van
  documentados en `services/riskScore.js` con este mismo fundamento. Hacerlos configurables
  significaría ocho números más en la pantalla de ajustes y volvería incomparables los
  informes entre escuelas. La señal de rendimiento **no** usa el umbral `lowAvg` de
  `directivo-umbrales.spec.md` a propósito: ese umbral marca **alumnos**, este score mide
  **divisiones**, y encadenarlos haría que mover un umbral reordenara el ranking sin que
  nadie entienda por qué. Queda anotado como decisión abierta.

- **RN-10 — Es un mapa de calor, no una lista negra.** La vista lo dice en un texto fijo:
  *"El score ordena por dónde conviene mirar primero; no evalúa a personas."* Además la
  solapa se puede apagar por escuela (no va `locked`). Es la misma sensibilidad con la que
  ya se trató la atribución docente: *"las estadísticas institucionales no se pierden…"*
  (`routes/directivo.js:644-650`).

- **RN-11 — Los números del ranking tienen que coincidir con los del listado de
  divisiones.** Por eso ambos consumen `getDivisionMetrics()`. Si `/directivo/risk` dijera
  tasa 62 % y `/directivo/divisions` 58 % para la misma división, el panel entero pierde
  credibilidad.

- **RN-12 — Multi-tenant sin excepciones.** Todo scoped a `res.locals.user.school`. El
  drill-down por `?division=` valida que esa división pertenezca a la escuela del usuario
  y responde 403 si no, igual que `GET /directivo/divisions/:id` (`:1043-1045`).

- **RN-13 — El bloque del dashboard respeta los permisos de la solapa.** Se renderiza solo
  si `can('directivo_risk')`. Si la escuela apagó la sección, el dashboard no puede mostrar
  su contenido ni linkear a una URL que va a devolver 403.

- **RN-14 — `?division=` con un ObjectId malformado responde 404, no 500.** Es deuda
  conocida de las cuatro rutas `/:id` del panel (`agente.md:823`); las rutas nuevas no la
  heredan: `mongoose.isValidObjectId()` al entrar al handler.

## Casos de uso

| # | Caso de uso | Actor | Qué resuelve |
|---|---|---|---|
| CU-01 | Ver el ranking de riesgo de todas las divisiones | directivo | "¿Por dónde empiezo?" |
| CU-02 | Entender por qué una división está arriba | directivo | Las 3 señales desglosadas en columnas |
| CU-03 | Entrar a una división y ver qué materias la arrastran | directivo | Drill-down `?division=` |
| CU-04 | Ver de un vistazo, al entrar al panel, si hay algo urgente | directivo | Bloque top-3 en el dashboard |
| CU-05 | Buscar una división puntual y ver su score | directivo | `?search=` |
| CU-06 | Ordenar por las mejores divisiones (para reconocer, no solo para retar) | directivo | `?sort=score-asc` |
| CU-07 | Que la escuela no exponga este ranking | superadmin | Apagar `directivo_risk` en `/superadmin/roles` |

Ninguno es auditable: no hay escritura. No se agrega nada a `config/audit-actions.js`.

## Criterios de aceptación

**Fórmula (`computeRisk`, función pura — se testea sin base de datos):**

- **CA-01** — Dado `{ tasa: 85, promedio: 8, notas: 40, actividades: 100,
  vencidasSinCalificar: 5, alumnos: 30 }`, cuando se calcula el riesgo, entonces
  `score === 14`, `etiqueta === 'bajo'` y `disponibles === 3`.
  *(0,40×15 + 0,35×20 + 0,25×5 = 14,25 → 14)*
- **CA-02** — Dado `{ tasa: 30, promedio: 4.5, notas: 40, actividades: 100,
  vencidasSinCalificar: 60, alumnos: 30 }`, entonces `score === 62` y
  `etiqueta === 'alto'`. *(0,40×70 + 0,35×55 + 0,25×60 = 62,25 → 62)*
- **CA-03** — Dado `{ tasa: 60, promedio: 6.5, notas: 40, actividades: 100,
  vencidasSinCalificar: 20, alumnos: 30 }`, entonces `score === 33` y
  `etiqueta === 'medio'`.
- **CA-04** — Dado un caso con `promedio: null` (división sin notas), cuando se calcula,
  entonces `senales.rendimiento === null`, `disponibles === 2`, y el score es el promedio
  ponderado de las otras dos renormalizado sobre `0,40 + 0,25 = 0,65` — **no** el resultado
  de tratar el rendimiento como 0.
- **CA-05** — Dado `{ promedio: 3, notas: 4, ... }` (menos de `MIN_NOTAS`), entonces
  `senales.rendimiento === null` y esa señal no entra en el score.
- **CA-06** — Dado `{ tasa: null, promedio: null, actividades: 0 }`, entonces
  `score === null`, `etiqueta === 'sin-datos'`, `disponibles === 0`, y no se produce
  ninguna división por cero (`NaN`/`Infinity`).
- **CA-07** — Dado `{ tasa: 130 }` (posible con alumnos desmatriculados), entonces
  `senales.entrega === 0` (clamp) y el score nunca es negativo.
- **CA-08** — Dado `{ promedio: 12 }` (nota mayor al máximo de la actividad), entonces
  `senales.rendimiento === 0` (clamp) y el score se mantiene en 0-100.
- **CA-09** — Dado cualquier conjunto de entradas válidas, entonces `0 ≤ score ≤ 100`
  y `etiqueta` es uno de `'bajo' | 'medio' | 'alto' | 'sin-datos'`.
- **CA-10** — Dado `score === 25` exacto, entonces la etiqueta es `'medio'` (el corte es
  inclusivo hacia arriba); dado `score === 50` exacto, entonces es `'alto'`.

**Vista `GET /directivo/risk`:**

- **CA-11** — Dado un directivo con escuela, cuando abre `/directivo/risk`, entonces recibe
  200, ve una fila por división de **su** escuela, ordenadas por score descendente, y
  ninguna división de otra escuela aparece.
- **CA-12** — Dado el orden por defecto, cuando hay divisiones con `score: null`, entonces
  aparecen **al final** del listado, no al principio ni intercaladas.
- **CA-13** — Dado el ranking, cuando se compara la columna "Tasa de entrega" de una
  división con la misma columna en `/directivo/divisions`, entonces los dos valores son
  idénticos (RN-11).
- **CA-14** — Dado `?division=<id de mi escuela>`, entonces se muestra además el desglose
  por materia de esa división, con el mismo score calculado por materia.
- **CA-15** — Dado `?division=<id de OTRA escuela>`, entonces se responde 403.
- **CA-16** — Dado `?division=no-es-un-objectid`, entonces se responde **404** (no 500).
- **CA-17** — Dado `?division=<ObjectId válido inexistente>`, entonces se responde 404.
- **CA-18** — Dado `?sort=score-asc`, entonces el orden se invierte y las `null` **siguen**
  al final (no pasan al principio).
- **CA-19** — Dado `?search=<texto sin coincidencias>`, entonces se responde 200 con el
  estado vacío, sin barras ni tabla vacía.
- **CA-20** — Dada una escuela con más de 25 divisiones, cuando se pagina, entonces los
  links conservan `search` y `sort` (mismo contrato que `partials/pagination.ejs`, ya
  cubierto por `tests/smoke/specs.js:2022-2028` para otra vista).
- **CA-21** — Dada una división con `disponibles < 3`, entonces la fila muestra el texto
  "N de 3 señales" junto al score.
- **CA-22** — Dado el HTML de la vista, entonces no contiene `NaN`, `Infinity` ni
  `undefined` aunque existan divisiones sin actividades y sin notas.
- **CA-23** — Dado un usuario `teacher`/`student`/`preceptor`, cuando abre
  `/directivo/risk`, entonces recibe 403.
- **CA-24** — Dado que el superadmin apagó `directivo_risk` para el rol `directivo` en esa
  escuela, entonces `GET /directivo/risk` responde 403 y la solapa "Riesgo" desaparece del
  nav.
- **CA-25** — Dado un directivo **sin escuela**, entonces ve `directivo/no-school` (200).
- **CA-26** — Dada la vista, entonces incluye el texto fijo de RN-10 aclarando que el score
  no evalúa personas.

**Dashboard:**

- **CA-27** — Dado que hay al menos una división con etiqueta `medio` o `alto`, cuando el
  directivo abre `/directivo`, entonces ve un bloque con hasta 3 divisiones ordenadas por
  score y un link a `/directivo/risk`.
- **CA-28** — Dado que **todas** las divisiones son `bajo` o `sin-datos`, entonces el bloque
  no se muestra (no se dibuja un bloque vacío que parezca un error).
- **CA-29** — Dado que la escuela apagó `directivo_risk` para ese rol, entonces el bloque
  **no** se renderiza en el dashboard y no aparece ningún link a `/directivo/risk`.

**Listado de divisiones:**

- **CA-30** — Dado `/directivo/divisions`, entonces cada fila muestra además una columna
  "Riesgo" con la etiqueta y el score, y **el resto de las columnas conserva exactamente
  los valores que mostraba antes de la refactorización a `getDivisionMetrics()`**.
- **CA-31** — Dado `/directivo/divisions?sort=name|rate-asc|rate-desc|alumnos`, entonces los
  cuatro órdenes existentes siguen funcionando igual que antes.

## Errores posibles

| CODIGO | HTTP | Mensaje en español | Cuándo |
|---|---|---|---|
| — (comportamiento existente) | 403 | «Acceso denegado» | Rol sin acceso al panel (`middleware/directivo.js:6`) o sección `directivo_risk` denegada (`middleware/sections.js:20`). Texto plano, igual que el resto del panel. |
| `DIVISION_NOT_FOUND` | 404 | «División no encontrada» | `?division=` con ObjectId malformado o inexistente. Mismo texto que `routes/directivo.js:1042`. |
| `CROSS_SCHOOL_ACCESS` | 403 | «Acceso denegado» | `?division=` apunta a una división de otra escuela. Mismo texto que `:1044`. |
| `SERVER_ERROR` | 500 | «Error del servidor» | Excepción no prevista. Se conserva el `res.status(500).send('Error del servidor')` del resto del panel. |

Los códigos `SCREAMING_SNAKE` se registran acá como contrato para los tests y para el
`logger`; las respuestas HTML del panel siguen enviando el texto plano actual, que ya está
asserteado por smoke tests existentes. Cambiar ese texto es un refactor aparte.

## Tests necesarios

**Unitarios de la fórmula** — `tests/unit/riskScore.test.js` con `node --test` (el proyecto
ya usa ese runner: ver `"test:images": "node --test tests/images/*.test.js"` en
`package.json:17`). Es el primer test unitario de lógica de negocio del repo y **tiene que
existir**: una fórmula ponderada con renormalización no se valida con un smoke HTTP.
Cubren CA-01 a CA-10, más:
- tabla de casos borde: todos los `null`, todos los ceros, todos los máximos;
- propiedad: para 1000 entradas aleatorias válidas, `0 ≤ score ≤ 100` y la etiqueta es una
  de las cuatro (CA-09).

**Smoke HTTP (`tests/smoke/specs.js`)**, junto al bloque directivo existente:
1. `directivo-risk-view` — GET 200; contiene la palabra "Riesgo" y el texto de RN-10;
   `?sort=score-asc` 200; `?search=zzzznoexistezzz` 200 con estado vacío. (CA-11, CA-18,
   CA-19, CA-26)
2. `directivo-risk-drilldown` — `?division=<state.divisionId>` 200 y lista materias;
   `?division=000000000000000000000000` → 404; `?division=no-es-un-objectid` → **404**
   (este último es el que atrapa la deuda de `agente.md:823` en la ruta nueva).
   (CA-14, CA-16, CA-17)
3. `directivo-risk-no-nan` — el HTML no contiene `NaN` ni `Infinity`. (CA-22)
4. `directivo-risk-forbidden` — un `teacher` recibe 403. (CA-23)
5. `directivo-risk-section-can-be-denied` — patrón `try/finally` de
   `tests/smoke/specs.js:930-960`: el superadmin apaga `directivo_risk`, se verifica 403,
   y se vuelve a habilitar. (CA-24)
6. `directivo-risk-matches-divisions` — cruzado: se toma la primera división del ranking y
   se verifica que su tasa aparece con el mismo valor en `/directivo/divisions?search=<nombre>`.
   Es el test que protege RN-11. (CA-13)
7. **Regresión**: `directivo-divisions-list` (`:2043-2058`) tiene que seguir verde tras la
   extracción a `getDivisionMetrics()`. Es el guardián de CA-30/CA-31.

**Verificación manual documentada:** comparar el listado `/directivo/divisions` completo
antes y después de la extracción (captura de los 39 renglones de la escuela real) — ningún
número puede moverse.

## Dependencias

- **`directivo-graficos.spec.md`** — los partials `bar-list` y `legend`. **Bloqueante**:
  esta spec no se implementa antes que la fase 1 de aquella.
- `services/divisionDetail.js` — reutilizado para el drill-down por materia (ya devuelve
  `tasa`, `activities`, `vencidasSinCalificar` y alumnos por materia, `:61-80`). Solo falta
  sumarle el promedio por materia, con un aggregate acotado a los cursos de esa división.
- `routes/directivo.js` — ruta nueva, extracción en `/divisions`, bloque en `/`.
- `config/sections.js` + `views/partials/directivo-nav.ejs` — solapa nueva.
- `views/directivo/dashboard.ejs` — bloque nuevo.
- **Consumidor:** `directivo-informe-impresion.spec.md` incluye el ranking en el informe.

## Riesgos de refactorización

1. **Extraer las agregaciones de `/divisions` puede mover un número sin que nadie lo note.**
   Es el riesgo más caro de esta spec, porque esos valores ya se leen todos los días.
   Mitigación: la extracción es un **commit propio, sin cambios de comportamiento**, y se
   valida comparando el listado completo antes/después (CA-30 + verificación manual).
2. **Costo de las queries en el dashboard.** El bloque top-3 obliga a correr en `/directivo`
   las mismas agregaciones que hoy solo corre `/directivo/divisions` (lookup de cursos +
   actividades por división, aggregate de entregas sobre todas las actividades de la
   escuela, aggregate de notas). En una escuela con ~419 materias eso **puede duplicar el
   tiempo del dashboard**. Mitigación: medir el tiempo de `/directivo` antes y después; si
   sube de forma perceptible, la salida es cargar el bloque con un `fetch` diferido a un
   endpoint propio, o directamente dejar el bloque solo en `/directivo/risk`. Queda como
   decisión abierta, no bloquea el resto.
3. **La fórmula es una opinión.** Los pesos son defendibles pero no son una verdad
   matemática. Mitigación: están en un solo lugar (`PESOS` en el service), documentados, y
   la tabla de señales desglosadas permite al directivo desconfiar del score y mirar los
   componentes. Si en el uso real el ranking "se siente mal", se ajustan los pesos sin
   tocar nada más.
4. **Lectura política del ranking.** Un listado ordenado de divisiones "en riesgo" se puede
   leer como un ranking de docentes. Mitigación: RN-10 (texto fijo + solapa apagable).
   Conviene que el usuario lo apruebe explícitamente antes de mostrarlo a una escuela.
5. **`MIN_NOTAS = 10` puede dejar sin señal de rendimiento a media escuela en marzo.**
   Es el comportamiento correcto (mejor "sin datos" que un promedio de 3 notas), pero al
   principio del ciclo lectivo la pantalla va a estar llena de "2 de 3 señales". Está
   contemplado en RN-07; no es un bug.
6. **Sin cambios en la base de datos.** No hace falta aviso previo de BD para este lote.

## Plan de migración

1. **`services/riskScore.js`** con `computeRisk` puro + sus constantes, y
   **`tests/unit/riskScore.test.js`**. Mergeable solo: nadie lo usa todavía y queda testeado.
2. **`services/directivoMetrics.js`**: extracción literal de las agregaciones de
   `routes/directivo.js:934-1007`, y `GET /divisions` pasa a consumirlo. **Commit sin
   cambios de comportamiento**; se valida con `directivo-divisions-list` y con la
   comparación manual del listado.
3. **`config/sections.js`** + **`views/partials/directivo-nav.ejs`**: solapa "Riesgo".
4. **`routes/directivo.js`**: `GET /risk` + **`views/directivo/risk.ejs`** (usa los partials
   de gráficos, que ya tienen que estar mergeados).
5. **Columna "Riesgo"** en `views/directivo/divisions.ejs` (ya tiene las métricas: solo
   agrega la llamada a `computeRisk`).
6. **Bloque top-3** en `GET /directivo` + `views/directivo/dashboard.ejs`, con la guarda
   `can('directivo_risk')`. **Medir el tiempo de respuesta del dashboard antes y después.**
7. **Smoke tests** (los 6 nuevos) y verificar que los del panel directivo siguen verdes.
8. **`agente.md`**: changelog con la fórmula, los pesos y su fundamento — para que dentro de
   seis meses nadie los cambie a ojo.

**Rollback**: revertir los pasos 3-6 deja el panel exactamente como está hoy; los pasos 1 y
2 pueden quedar en el repo sin efecto (el service extraído es equivalente al código viejo).
