# "Actividades Diarias" — la solapa de seguimiento del panel Directivo

> **Estado: APROBADA por el usuario el 2026-08-17** (plan aprobado antes de escribir código).
>
> Nace de un pedido explícito: *"me gusta la manera que manejaste el calendario en el rol de
> preceptor, quiero una nueva solapa en el rol de directivo"*. No reemplaza a la del preceptor:
> son dos preguntas distintas sobre el mismo hecho.
>
> **Ocho decisiones cerradas con el usuario ese día** — no reabrirlas sin él:
>
> 1. **Una fila por curso × materia**, tabla plana. No agrupada, no desplegable.
> 2. **La fecha es elegible**: creación (`createdAt`) o entrega (`dueDate`), con un selector.
> 3. **"Entregado" mide al DOCENTE**, no al alumno: que haya cargado al menos una actividad.
> 4. **Tabla única con selector de estado** (Todos / Solo pendientes / Solo con actividad), no
>    dos bloques separados.
> 5. **"Semanal" = lunes a viernes** de la semana en curso (la semana escolar).
> 6. **Solo el contador** de actividades por fila. Sin panel de detalle con los títulos.
> 7. **Sin exportación** por ahora.
> 8. **Configurable por rol** desde `/superadmin/roles`.
>
> Consecuencia directa: **no hay campo nuevo, ni colección nueva, ni migración, ni índice nuevo.**
> Todo se apoya en `createdAt` y `dueDate`, que ya existen en `models/Activity.js`.

## Trampa de terminología (leer antes de tocar el código)

En este código los nombres están cruzados respecto del habla de la escuela:

| Se dice | Modelo | Ejemplo |
|---|---|---|
| "curso" (1°A, 2°3°) | **`Division`** | `Division.name = '1°1°'` |
| "materia" | **`Course`** | `Course.name = 'Matemática'` |

`Course.division → Division`, `Course.owner → User` (docente titular). El modelo `Subject`
**no participa** — el comentario de `models/Subject.js:16-18` habla de un campo `Course.subject`
que no existe en el schema actual.

Por eso **una fila de esta tabla es un `Course`**: ya trae adentro su curso y su docente. El
"curso × materia" que pidió el usuario no necesita ningún cruce: es la lista de `Course`.

## Objetivo

Que dirección pueda responder, en una pantalla y para el rango de fechas que quiera:
**¿qué docentes dejaron actividad y cuáles no?**

El preceptor ya tiene algo parecido (`/preceptor/actividades`), pero contesta otra pregunta:
está acotado a **un** curso, a **un** mes, se navega mes a mes y no filtra por estado. Sirve para
"¿qué pasó el martes en 3°2°?". Esta solapa sirve para "¿quién no cargó nada esta semana?".

## Responsabilidades

- Definir qué significa **"la materia tiene actividad en el rango"** y en qué zona horaria se decide.
- Definir el **denominador**: sobre qué universo de materias se calcula el pendiente.
- Definir los **atajos de rango** (Hoy, Semanal) y qué significan exactamente.
- Definir el **alcance** del directivo sobre esta pantalla.

## No responsabilidades

- **No** mide entregas de alumnos. "Entregado" acá es *el docente entregó la consigna*, no *el
  alumno entregó el trabajo*. La tasa de entrega de alumnos ya vive en `/directivo/courses`.
- **No** decide qué materias *deberían* haber cargado actividad. El sistema no tiene horario
  escolar: no sabe qué materias tienen clase un martes. Una materia sin clase ese día figura
  igual como "Pendiente". Es la misma limitación que ya declara la solapa del preceptor, y la
  pantalla no debe sugerir lo contrario.
- **No** toca la asistencia. Que una materia no haya cargado actividad no dice nada sobre si
  hubo clase.
- **No** agrega permisos de escritura. La solapa es de **solo lectura**: ni un POST.
- **No** modifica `/preceptor/actividades`, que queda intacta.

## Entidades/Schemas

Ninguna colección nueva. Ningún campo nuevo. Ningún índice nuevo.

| Archivo | Qué se usa |
|---|---|
| `models/Activity.js` | `course`, `createdAt` (de `timestamps`), `dueDate` (nullable, default `null`) |
| `models/Course.js` | `name`, `school`, `division`, `owner` |
| `models/Division.js` | `name`, `school` |
| `models/User.js` | `name`, `active` (para el aviso de docente deshabilitado) |

## Arquitectura

### `services/actividadesDelDia.js` — se extiende, no se duplica

La regla "qué cuenta como actividad" ya vive en ese archivo (RN-05 de
`specs/actividades-en-clase.spec.md`). Meter una copia en un servicio nuevo es exactamente cómo
las dos pantallas empiezan a contestar distinto sobre el mismo hecho. Se agrega ahí:

**Puras** (sin base, testeables con `npm run test:unit`):

| Función | Devuelve |
|---|---|
| `rangoValido(desde, hasta)` | `true` si ambos son `YYYY-MM-DD`, `desde <= hasta` y el span ≤ 366 días |
| `rangoDeHoy()` | `{ desde, hasta }`, ambos = `live.diaEscolar()` |
| `rangoDeSemana()` | lunes→viernes de la semana del día escolar en curso |
| `ventanaDeRango(desde, hasta)` | ventana UTC holgada (±1 día) para el `$match` |
| `campoValido(c)` | `c` ∈ `{'creacion', 'entrega'}` |
| `CAMPOS` | `{ creacion: 'createdAt', entrega: 'dueDate' }` |

**Con base:**

`rangoDeEscuela({ school, desde, hasta, campo, divisionId })` → una fila por materia:

```
{ courseId, materia, divisionId, division, docente, docenteActivo, actividades, ultima }
```

Dos pasos:

1. **Denominador** — `Course.find({ school, ...(divisionId && { division }) })` con `division` y
   `owner` populados. Es el universo de filas: **una materia sin ninguna actividad tiene que
   aparecer**, porque justamente es la que dirección busca.
2. **Numerador** — un `Activity.aggregate` con el mismo truco de dos `$group` que
   `mesDeDivision`: el primero agrupa por (materia, día) para poder recortar el rango sobre el día
   ya formateado en la zona de la escuela; el segundo colapsa a totales por materia.

El merge deja `actividades: 0` en las materias sin entrada.

### `config/sections.js` — entrada nueva

```js
{ key: 'directivo_actividades', panel: 'directivo', label: 'Actividades Diarias', icon: 'event_note', path: '/directivo/actividades-diarias', roles: ['directivo', 'admin', 'superadmin'] },
```

Sin `locked`: la INVARIANTE de las líneas 38-40 de ese archivo solo aplica a los `*_dashboard`,
que son destino del redirect de `/`. Apagar esta solapa no deja a nadie afuera del panel.

La key se persiste sola en `School.rolePermissions` (`Schema.Types.Mixed`): **no hay migración**.
`views/superadmin/roles.ejs` se genera del catálogo, así que no se toca.

### Vistas

| Archivo | Qué es |
|---|---|
| `views/directivo/actividades-diarias.ejs` | La pantalla. Calcada de `views/directivo/courses.ejs`. |
| `views/partials/directivo-nav.ejs` | Un bloque `puede('directivo_actividades')` más. |

## Entradas

`GET /directivo/actividades-diarias`

| Param | Valores | Default |
|---|---|---|
| `preset` | `hoy` \| `semana` | — (si viene, pisa a `desde`/`hasta`) |
| `desde` | `YYYY-MM-DD` | hoy escolar |
| `hasta` | `YYYY-MM-DD` | hoy escolar |
| `campo` | `creacion` \| `entrega` | `creacion` |
| `division` | ObjectId de `Division` | todas las del colegio |
| `estado` | `entregado` \| `pendiente` | todas |
| `page` | entero ≥ 1 | 1 |

Cubierta por `requireAuth, requireDirectivo, sectionGuard('directivo')`, que ya están montados en
el router (`routes/directivo.js:24`). No se agrega middleware.

## Salidas

Solo HTML. **No hay endpoint JSON**: a diferencia de la del preceptor, esta pantalla no tiene
panel lateral que cargar por `fetch` — se resuelve entera en el render.

## Reglas de negocio

- **RN-01 — "Tiene actividad en el rango" = existe al menos un `Activity` de esa materia cuyo
  campo elegido cae dentro de `[desde, hasta]`, inclusive en ambos extremos.** Es la RN-05 del
  spec del preceptor, extendida: ahí el campo era siempre `createdAt`; acá lo elige el usuario.
- **RN-02 — El día se decide en la zona horaria de la escuela**, con `live.diaEscolar` y
  `live.TZ`. **Ni un `Intl.DateTimeFormat` nuevo en el servicio.** Producción corre en UTC: una
  actividad cargada 21:30 de Buenos Aires es del día siguiente en UTC y caería en el rango
  equivocado. `services/liveRoom.js` es el único dueño de la zona de la escuela.
- **RN-03 — En modo "entrega", las actividades sin fecha límite no cuentan.** `dueDate` es
  nullable y su default es `null`: una actividad sin vencimiento no cae en ningún rango. No es un
  bug, es la respuesta correcta a "¿qué vence esta semana?" — pero se avisa en pantalla, porque
  el mismo docente puede figurar "Entregado" en creación y "Pendiente" en entrega.
- **RN-04 — El denominador son TODAS las materias del alcance**, tengan o no actividades.
  Entregadas + pendientes = total, siempre. Contar solo las que tienen actividad convertiría la
  pantalla en la lista de los que sí cumplieron, que es justo la mitad que no se busca.
- **RN-05 — El alcance del directivo es su escuela, completa.** A diferencia del preceptor, no
  hay `assignedDivisions`: `res.locals.user.school` es el único filtro obligatorio. Sin escuela
  se cae en `directivo/no-school`, como el resto del panel.
- **RN-06 — El filtro `division` acota, no habilita.** Es una comodidad de lectura. Un id de otra
  escuela no muestra nada porque el `$match` por `school` va siempre primero, no porque se lo
  valide aparte.
- **RN-07 — La solapa es de solo lectura.** Ni un POST. Dirección mira producción docente; no
  crea, edita ni borra actividades de nadie.
- **RN-08 — El rango se valida antes de tocar la base.** Un `desde`/`hasta` inválido o dado vuelta
  cae al default (hoy) en vez de romper: son parámetros de URL y llegan sucios. El techo de 366
  días evita que alguien pida diez años y cuelgue el aggregate.

## Casos de uso

1. **El lunes a la mañana.** El directivo abre la solapa, toca "Semanal", filtra por
   *Solo pendientes* y tiene la lista de qué docentes no cargaron nada en la semana.
2. **El control del día.** Entra y la pantalla ya abre en "Hoy": ve cuántas materias cargaron
   actividad hoy sin tocar un filtro.
3. **La reunión de departamento.** Filtra por división 3°2° y un rango de un mes: ve materia por
   materia cuántas actividades hubo y cuándo fue la última.
4. **Qué vence esta semana.** Cambia el campo a *fecha de entrega* con el rango semanal: en vez de
   qué cargó el docente, ve qué tiene que entregar el alumno.

## Criterios de aceptación

- **CA-01** El directivo ve "Actividades Diarias" en su nav.
- **CA-02** La pantalla abre en **Hoy** sin necesidad de tocar ningún filtro, y lista **todas** las
  materias de la escuela.
- **CA-03** Cada fila muestra curso, materia, docente, estado y cantidad de actividades.
- **CA-04** Una materia con al menos una actividad en el rango figura **Entregado**; una sin
  ninguna, **Pendiente**.
- **CA-05** Entregadas + pendientes es siempre igual al total de materias del alcance (RN-04).
- **CA-06** "Hoy" carga `desde = hasta = ` día escolar en curso.
- **CA-07** "Semanal" carga el lunes y el viernes de la semana en curso. Un domingo **no** salta a
  la semana siguiente.
- **CA-08** Un `desde`/`hasta` manual filtra por ese rango, extremos incluidos.
- **CA-09** Cambiar el campo a *fecha de entrega* cambia el resultado, y aparece el aviso de que
  las actividades sin fecha límite no se cuentan.
- **CA-10** El filtro de división acota la lista a las materias de esa división.
- **CA-11** El filtro de estado *Solo pendientes* deja solo las de 0 actividades, y los totales de
  arriba **siguen mostrando el set completo** (no se recalculan sobre lo filtrado).
- **CA-12** La paginación conserva todos los filtros al cambiar de página.
- **CA-13** Un rango dado vuelta (`desde > hasta`) o mal escrito no rompe: cae en Hoy.
- **CA-14** Denegar `directivo_actividades` desde `/superadmin/roles` la saca del nav **y**
  devuelve 403 en `/directivo/actividades-diarias`. Reponerla la devuelve.
- **CA-15** Una actividad cargada 21:30 hora de Buenos Aires cuenta en el día en que se cargó, no
  en el siguiente.
- **CA-16** Un directivo sin escuela cae en `directivo/no-school`.
- **CA-17** A 375 px la tabla scrollea horizontalmente con la primera columna anclada, el drawer
  abre, y en modo oscuro no queda ninguna tarjeta blanca.

## Errores posibles

| Situación | Respuesta |
|---|---|
| `desde`/`hasta` mal escritos o dados vuelta | se ignoran y se usa el rango de hoy |
| Rango de más de 366 días | se ignora y se usa el rango de hoy |
| `campo` desconocido | se ignora y se usa `creacion` |
| `estado` desconocido | se ignora y se muestran todas |
| `division` con id mal formado | 400, vía `idMalo` (sin él sería un 500) |
| `division` de otra escuela | lista vacía (el `$match` por `school` va primero) |
| `page` fuera de rango | se recorta a la última página con resultados |
| Directivo sin escuela | `directivo/no-school` |
| Solapa denegada para el rol | 403, vía `sectionGuard('directivo')` |

## Tests necesarios

- **Unit** (`tests/unit/actividadesDelDia.test.js`): `rangoValido` (dado vuelta, formatos malos,
  `null`, span > 366), `rangoDeSemana` (lunes→viernes, borde domingo y sábado, cruce de mes y de
  año), `campoValido` y el mapeo `CAMPOS`.
- **Smoke** (`tests/smoke/specs.js`): la solapa carga; una materia con actividad de hoy sale
  Entregado y una sin actividad sale Pendiente; `estado=pendiente` filtra; `campo=entrega` cambia
  el resultado; un rango inválido cae en hoy en vez de romper.
- **Matriz de roles** (`tests/roles/check-roles.js`): la sección sale del catálogo, así que entra
  sola en el recorrido de los 8 roles. Sumarla a la lista de toggles del paso 6.

## Dependencias

- `services/liveRoom.js` — `TZ`, `diaEscolar`. Único dueño de la zona horaria.
- `services/actividadesDelDia.js` — donde vive la regla y donde se agrega lo nuevo.
- `middleware/directivo.js` — `requireDirectivo`, ya montado en el router.
- `middleware/sections.js` — `sectionGuard('directivo')`, ya montado en el router.
- `middleware/objectId.js` — `idMalo`, para el `division` de la query.
- `views/partials/pagination.ejs` — espera `queryParams`, `page`, `totalPages` en locals.

## Riesgos de refactorización

- **El `$in` es de toda la escuela, no de una división.** Es la diferencia de escala con la
  pantalla del preceptor: ahí son ~10 materias, acá pueden ser cientos. El `$match` se apoya en el
  prefijo `course` de los índices que ya existen (`{course:1, availableFrom:1}` para el modo
  creación, `{course:1, dueDate:1}` para el de entrega). **No se agrega índice**: construirlo es un
  cambio en la base de producción y va con aviso previo. Si con el uso real se nota,
  `{ course: 1, createdAt: -1 }` es el candidato — el mismo que ya dejó anotado el spec del
  preceptor.
- **`services/actividadesDelDia.js` deja de ser "del preceptor".** El archivo ahora sirve a dos
  paneles. El nombre le queda corto, pero renombrarlo obliga a tocar `routes/preceptor.js`, los
  tests y la spec vieja por una ganancia cosmética. Lo que sí importa es que la regla de qué
  cuenta como actividad siga siendo **una sola** en ese archivo: si alguna de las dos pantallas
  necesita una regla distinta, va como parámetro, no como copia.
- **`CAMPOS` mapea a nombres de campo de Mongo.** Se interpolan en el `$match` y en el
  `$dateToString`. La llave viene de la query string, así que **tiene que pasar por
  `campoValido` antes de tocar el aggregate** — no se arma el nombre del campo con lo que llegó.
