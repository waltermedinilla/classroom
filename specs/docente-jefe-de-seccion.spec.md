# Docente jefe de sección

Estado: **APROBADA por el usuario el 2026-09-24.** Sale de la **opción A**: la jefatura depende de
figurar en `Section.heads`, no del rol. El usuario cerró **P1 = A** (el Docente jefe configura sus
secciones igual que el rol `jefe`) y aceptó **DA-1 a DA-7** con la recomendación del arquitecto
(ver § Objetivo › Decisiones). No quedan decisiones pendientes. Módulos: `jefatura` y `sections`.
Roles: `teacher` (el camino nuevo); `jefe`, `admin` y `superadmin`, sin cambios de fondo.

> **No toca ningún schema ni ningún dato de producción.** `models/User.js` y `models/Section.js`
> conservan sus campos; en `Section.js` solo cambian los comentarios. **Sí cambia permisos en
> producción el día del despliegue**: todo docente que HOY figure en `heads` empieza a entrar a
> `/jefatura`. Por eso el paso 0 del Plan de migración es una consulta de solo lectura que el
> usuario tiene que ver antes del push.
>
> Flujo SDD: arquitecto → **spec aprobada** → tester → implementador → revisor.

---

## Objetivo

Que una persona que es **Docente** y además está **a cargo de una o más secciones** pueda hacer
las dos cosas con una sola cuenta y un solo rol:

1. dar sus clases como siempre: `/` la lleva a `/courses` y ahí están sus materias, sus salas y su
   perfil. Para el resto del sistema sigue siendo docente;
2. entrar al panel de **Jefatura** desde el menú, **acotado solo a sus secciones**.

Todo esto sin tocar el schema de `User`, sin multirrol general y sin cambiar en nada el
funcionamiento del rol `jefe`.

### El caso que la motiva

María Angélica Anachuri (usuario `6a2874d9279adb97e277e8e9`, escuela `6a2229fce256f3bb84930a9d`)
es titular de 4 materias y figura en `heads` de la sección **"CONSTRUCCIONES 1"**. Ninguno de los
dos roles posibles le sirve:

| Si tiene rol… | qué pasa | dónde |
|---|---|---|
| `teacher` | `/jefatura` le da 403 aunque figure en `heads` | `middleware/jefatura.js:24` y `:31-36` |
| `teacher` | el editor no la ofrece como jefa y **guardar la sección la expulsa sin avisar** | `routes/sections.js:148`, `views/admin/section-form.ejs:160-163` y `:364` |
| `jefe` | `/` la manda a `/jefatura` | `server.js:702` |
| `jefe` | ya no puede ser titular de materias nuevas | `routes/admin.js:762-763` (`resolveCourseTeacher`) y `:462-463` |
| `jefe` | desaparece de los selectores de docente del admin y de los co-docentes | `routes/admin.js:798`, `:813`, `:862`; `routes/courses.js:688` |
| `jefe` | desaparece de «Docentes» del directivo, y su ficha da 404 «El usuario no es docente» | `routes/directivo.js:361`, `:627`, `:842` |

### Dos precisiones al diagnóstico que acompañó el pedido

Las dos llevan al mismo arreglo, pero conviene dejarlas escritas bien:

1. **`server.js:702` redirige desde `/`, no desde `/courses`.** Con rol `jefe`, sus materias
   siguen apareciendo en `/courses` desde «Mis clases» del menú (`views/partials/header.ejs:389-396`).
   `GET /courses` lista por `owner`/`coTeachers` y no mira el rol (`routes/courses.js:59`). Con
   `jefe` no pierde las clases: pierde **ser docente para el resto del sistema** (la tabla de
   arriba).
2. **La expulsión silenciosa no ocurre en `routes/sections.js:207`.** Si el id de María llegara en
   `headIds`, `:211-213` respondería **400**, no la descartaría en silencio. Ocurre antes, en la
   vista. La lista de candidatos es solo `role: 'jefe'` (`:148`), así que su checkbox nunca se
   pinta (`section-form.ejs:160-163`), el POST sale sin ella (`:364`) y el servidor guarda `heads`
   sin ella con **200**. Hay dos variantes peores:
   - si la escuela no tiene **ningún** usuario con rol `jefe`, el formulario no pinta ni un solo
     checkbox (`:150-157`) y guardar **vacía `heads` entera**;
   - la vista de solo lectura del jefe (`:131`) filtra los jefes actuales contra los candidatos,
     así que un co-jefe docente **no figura** como a cargo.

### Decisiones

| # | decisión | de quién | dónde se aplica |
|---|---|---|---|
| **D1** | **Opción A.** La jefatura de un Docente depende de figurar en `Section.heads`. El Docente jefe de al menos una sección entra a `/jefatura` **solo** con sus secciones (nunca `scopeAll`) y conserva intacta su vista de Docente. El editor de Secciones acepta docentes como jefes. El rol `jefe` sigue existiendo y funcionando igual. No reemplaza a `identidad-multiescuela.spec.md`. | **usuario** | toda la spec |
| **D2** | Solo el rol `teacher` gana acceso por figurar en `heads`. `jefe` sigue entrando por rol; `preceptor`, `soe` y `student` no entran nunca aunque figuren. | arquitecto (dentro de D1) | RN-02 |
| **D3** | La pertenencia se consulta **por request, sin caché**, y **solo cuando hace falta**: 0 consultas para los demás roles y para toda respuesta que no pinta una página (poll de la sala, JSON, redirects). | arquitecto | RN-14 a RN-17 |
| **D4** | Guardar una sección **nunca** quita a un jefe que el admin no destildó. Los jefes que ya estaban se conservan sin volver a validarlos. Los que ya no existen o son de otra escuela se quitan **con aviso** y quedan en la auditoría. | arquitecto (lo pidió el usuario) | RN-20 a RN-24, RN-26 |

### Decisiones del usuario (2026-09-24)

**P1 = A. El Docente jefe configura sus secciones en `/admin/secciones` igual que el rol `jefe`.**
Edita el nombre y el contenido de las suyas. No crea, no borra y no toca los jefes
(`routes/sections.js:17-29`). Como el `jefe`, puede sumar **cualquier** curso o materia de su
escuela, con control posterior por auditoría (`section.edit`). La solapa «Secciones» del nav de
jefatura aparece igual. La escuela que no lo quiera se la apaga al rol Docente desde
`/superadmin/roles` (celda Docente × Secciones, RN-13) sin tocar código. Se aplica en RN-13c,
RN-18, CU-03 y CA-30 a CA-35.

*Descartada:* **C**, que el Docente jefe viera su panel sin configurar nada y el contenido lo armara
solo el admin.

**DA-1 a DA-7, aceptadas con la recomendación del arquitecto.** Quedan como decisiones tomadas:

- **DA-1. Candidatos solo activos.** Hoy el editor también lista a los `jefe` deshabilitados y deja
  asignarlos. Con esta spec se ofrecen solo cuentas **activas**, con el mismo criterio que los
  selectores de docente (`routes/admin.js:796-798`: «los deshabilitados no se ofrecen»). A un jefe
  deshabilitado que **ya** está a cargo se lo sigue mostrando y conservando (RN-20). Es un cambio
  chico de comportamiento para el rol `jefe`.
- **DA-2. Pasar de `jefe` a `teacher` conserva la jefatura.** Es consecuencia directa de D1: el
  cambio de rol no toca `heads`, y como Docente sigue a cargo. Si el admin lo hacía justamente
  para sacarle la jefatura, ahora tiene que destildarlo de la sección. **Se acepta así.** Como
  mejora aparte, fuera de esta spec, queda mostrar en la ficha del usuario (`/admin/users/:id`)
  «A cargo de: …». *Descartada:* quitarlo de `heads` en cada cambio de rol, que toca los tres
  caminos de cambio de rol y la importación. Es más superficie para un caso raro.
- **DA-3. Solo `jefe` y `teacher` pueden quedar a cargo.** Un `preceptor` a cargo necesitaría que
  el preceptor también ganara la jefatura por `heads`. Eso es multirrol y corresponde a
  `identidad-multiescuela.spec.md`. `directivo`, `admin` y `superadmin` ya ven todas las secciones
  por su rol: ponerlos a cargo solo ensuciaría la columna «A cargo de».
- **DA-4. Mientras dura una suplantación no se pinta el enlace**, igual que el «Mis secciones» del
  jefe (`header.ejs:382`). Para verificar como María hay que escribir la URL `/jefatura`.
- **DA-5. La auditoría de `section.create` y `section.edit` pasa a nombrar a los jefes agregados y
  quitados.** Hoy registra solo el conteo. Es lo que permite contestar después «¿quién sacó a María
  de la sección?». No agrega acciones nuevas al catálogo.
- **DA-6. Aparecen celdas nuevas en `/superadmin/roles` para el rol Docente**: Jefatura › Docentes
  (configurable), Jefatura › Actividades (con candado) y Administración › Secciones
  (configurable).
- **DA-7. Mecanismo del menú.** La página se marca **al renderizar**: se envuelve `res.render`
  (RN-15). Es un patrón nuevo en el proyecto (hoy no hay ningún `res.render` envuelto) y tiene
  alternativas descartadas con sus números (§ Costo). Aprobado por el usuario. El revisor igual
  tiene que verificar los cuatro puntos del riesgo 4.

---

## Responsabilidades

Esta spec es dueña de:

- la **definición de Docente jefe** (RN-01) y de la clasificación de roles frente a la jefatura, en
  un módulo puro nuevo: **`services/jefaturaAcceso.js`**;
- lo que hacen `requireJefe` y `loadJefaturaScope` (`middleware/jefatura.js`) cuando el que pide
  es un `teacher`;
- la **marca `res.locals.esJefeDeSeccion`** y el middleware que la calcula al renderizar;
- el ítem **«Mis secciones»** del menú lateral para el Docente jefe (`views/partials/header.ejs`);
- el campo `roles` de `jefe_dashboard`, `jefe_teachers` y `admin_sections` en
  `config/sections.js`;
- la entrada del `teacher` a `/admin/secciones` (P1 = A) en `routes/sections.js`;
- en el editor del admin: **qué candidatos se ofrecen**, **cómo se guardan los jefes** y **qué se
  avisa**, repartido entre `routes/sections.js`, `views/admin/section-form.ejs` y
  `views/admin/sections.ejs`;
- el detalle ampliado de `section.create` y `section.edit` en la auditoría.

## No responsabilidades

- **No toca `models/User.js`**: no hay `assignedSections`, ni `roles: []`, ni flag. La relación
  sigue viviendo en `Section.heads` (`models/Section.js:55-60`).
- **No es el multirrol general.** Eso es `specs/identidad-multiescuela.spec.md`, con su D2 todavía
  pendiente (ver § Dependencias › Convivencia).
- **No cambia el rol `jefe`**: su redirect de `/` a `/jefatura`, su pantalla «Todavía no tenés
  secciones a cargo», sus solapas y lo que puede hacer en `/admin/secciones` quedan igual.
- **No agrega escrituras a `/jefatura`.** El panel sigue siendo de solo lectura
  (`routes/jefatura.js:8-14`), también para el Docente jefe.
- **No da a un `preceptor`, `soe` o `student` ninguna jefatura**, aunque figure en `heads` (DA-3).
- **No toca los caminos de cambio de rol ni de escuela** (`routes/admin.js:522-558`,
  `routes/superadmin.js:475-507`, `:513-545`, `:551-582`). No quitan ni agregan a nadie en `heads`
  (DA-2).
- **No cambia el redirect de `/`** para `teacher`: sigue yendo a `/courses` (`server.js:712`).
- **No cambia el caché del documento de usuario** (`middleware/cache.js`). El cambio de **rol**
  sigue tardando hasta 45 s en el otro worker, como hoy.
- **No avisa a la docente** cuando la ponen o la sacan de una sección.
- **No toca la fusión de cuentas** (`fusion-de-cuentas.spec.md`). Ver Riesgos.
- **No agrega acciones a `config/audit-actions.js`**: solo amplía el detalle de dos que ya existen.
- **No toca `middleware/sections.js`, `middleware/auth.js` ni `routes/jefatura.js`.** Las rutas del
  panel no cambian: cambia la cadena que las protege.

---

## Entidades/Schemas

### Sin cambios de schema

`users` y `sections` quedan con los mismos campos e índices. Lo que cambia es **qué puede haber
adentro** de `Section.heads`:

| antes | después |
|---|---|
| usuarios de la escuela con rol `jefe` (validado solo en el editor del admin) | usuarios de la escuela con rol `jefe` **o `teacher`**, activos **en el momento de agregarlos**. Los que ya estaban se conservan aunque después cambien de rol o se deshabiliten (RN-22, RN-28) |

Hay que actualizar dos comentarios que dejan de ser ciertos:

- `models/Section.js:4-5` y `:62-64` dicen «a cargo de uno o más Jefes de Sección (rol `jefe`)» y
  «Solo se aceptan usuarios con role 'jefe' … eso lo valida routes/admin.js». Además de la regla,
  el archivo está mal: la validación vive en `routes/sections.js`.
- `models/User.js:6-9` describe el rol `jefe` como el único camino a la jefatura.

### `services/jefaturaAcceso.js` — módulo nuevo, funciones puras

No toca la base ni el reloj: todo le llega por parámetro. Lo usan el middleware, el router de
secciones y los tests unitarios, con el mismo patrón que `services/soeAcceso.js`.

```js
// Constantes
ROLES_JEFATURA_SIN_LIMITE  = ['directivo', 'admin', 'superadmin'] // = middleware/jefatura.js:29 (se muda acá)
ROLES_JEFATURA_POR_ROL     = ['jefe']                             // entran por rol
ROLES_JEFATURA_POR_SECCION = ['teacher']                          // entran SOLO si figuran en heads (D2)
ROLES_ELEGIBLES_JEFE       = ['jefe', 'teacher']                  // lo que el admin puede AGREGAR a heads (DA-3)

// Puras
modoJefatura(role)
  → 'sin-limite' | 'por-rol' | 'por-seccion' | null

decidirAccesoJefatura(user, cantidadSecciones)
  → { entra: boolean, scopeAll: boolean }
  // user null                                 → { entra: false, scopeAll: false }
  // 'sin-limite'                              → { entra: true,  scopeAll: true  }
  // 'por-rol'                                 → { entra: true,  scopeAll: false }   (aunque sean 0: pantalla sin alcance)
  // 'por-seccion', con escuela y cantidad ≥ 1 → { entra: true,  scopeAll: false }
  // 'por-seccion', sin escuela o cantidad 0   → { entra: false, scopeAll: false }
  // null                                      → { entra: false, scopeAll: false }
  // scopeAll es true SOLO en 'sin-limite'. Nunca para 'por-seccion', con ningún argumento.

esElegibleComoJefe(usuario, school)
  → boolean   // usuario existe ∧ String(usuario.school) === String(school)
              // ∧ usuario.active !== false ∧ ROLES_ELEGIBLES_JEFE.includes(usuario.role)

resolverHeads({ pedidos, actuales, usuarios, school })
  → { heads, agregados, quitados, descartados, rechazados }
  // pedidos:   body.headIds (cualquier cosa: se valida acá)
  // actuales:  existing.heads (ObjectId[] o string[]); [] al crear
  // usuarios:  Map id → { _id, name, role, school, active } con TODOS los ids de pedidos ∪ actuales
  //            que existen (una sola query; los que faltan en el Map no existen)
  // Regla completa en RN-22.
```

### `middleware/jefatura.js` — lo que cambia

```js
// Se mantienen los nombres exportados. ROLES_CON_ACCESO pasa a ser la unión de
// sin-limite + por-rol + por-sección, y ROLES_SIN_LIMITE se reexporta desde el servicio.

pertenenciaJefatura(req, res, SectionModel = Section) → Promise<boolean>
  // Memo POR REQUEST: la primera llamada consulta
  //   SectionModel.exists({ school: user.school, heads: user._id })
  // y guarda la promesa en el req. Las siguientes devuelven la misma promesa.
  // Deja el resultado en res.locals.esJefeDeSeccion. Si la consulta falla, rechaza
  // (quien llama decide: el guard responde 500, el menú pinta sin el enlace).

marcarDocenteJefe(SectionModel = Section) → middleware
  // Global. Ver RN-15.
```

`loadJefaturaScope` no suma queries: la de `Section.find` que ya hace (`:65-68`) define también la
pertenencia. Cuando el usuario es `teacher`, **carga el memo** con `secciones.length > 0` y deja
`res.locals.esJefeDeSeccion` en ese valor.

### `config/sections.js` — tres renglones

```js
{ key: 'admin_sections', …, roles: ['admin', 'superadmin', 'jefe', 'teacher'] },            // P1 = A
{ key: 'jefe_dashboard', …, roles: ['jefe', 'teacher', 'directivo', 'admin', 'superadmin'], locked: true },
{ key: 'jefe_teachers',  …, roles: ['jefe', 'teacher', 'directivo', 'admin', 'superadmin'] },
```

Con un comentario al lado: **para `teacher` el acceso base es condicional** (figurar en `heads`).
Es la segunda excepción documentada a «figura en `roles` → entra», junto a la del SOE
(`config/sections.js:116-120`).

---

## Entradas

| de dónde | qué |
|---|---|
| `sections` (base) | `school` y `heads`, leídos en el request. Nunca desde un caché |
| `res.locals.user` | `_id`, `role` y `school`. Salen del caché de 45 s: **el rol** puede venir con hasta 45 s de atraso en el otro worker. **La pertenencia a `heads` no**: no pasa por ese caché |
| `res.locals.school.rolePermissions` | las solapas que la escuela le denegó al rol Docente (`isDenied`) |
| `res.locals.impersonating` | si hay suplantación, el menú no pinta el enlace (DA-4) |
| `POST /admin/secciones/create` y `POST /admin/secciones/:id/edit` | `name`, `divisionIds`, `courseIds` y `headIds`. `headIds` se lee **solo** si quien guarda es admin o superadmin, como hoy (`routes/sections.js:260`) |
| `GET /jefatura`, `/jefatura/docentes`, `/jefatura/actividades/:id` y `/jefatura/docentes/:id` | sin cambios en la entrada |

## Salidas

| a dónde | qué |
|---|---|
| Menú lateral (HTML de toda página que renderiza un Docente jefe) | ítem «Mis secciones», con `href="/jefatura"` y el icono `groups` |
| `/jefatura/*` | 200 con su alcance, o **403 «Acceso denegado»** para el `teacher` que no está a cargo de nada |
| `/admin/secciones/*` | lo mismo que ve el rol `jefe`, o 403 para el `teacher` que no está a cargo de nada |
| Formulario de sección del admin | candidatos `jefe` + `teacher` activos, **más los jefes actuales**; rol en español, motivo si ya no es elegible, y el aviso de los descartados |
| Grilla `/admin/secciones` | el rol junto a cada jefe que no es `jefe` («· Docente») |
| JSON de `create` y `edit` | lo de hoy **más** `jefes: { agregados: [nombre], quitados: [nombre], descartados: n }` |
| JSON de un 400 por jefe inválido | `{ error, code: 'HEAD_NOT_ELIGIBLE', rechazados: [{ id, nombre }] }`. `nombre` es `null` si el id no es un usuario de la escuela |
| Auditoría | `section.create` y `section.edit`: el detalle suma `jefesAgregados`, `jefesQuitados` y `jefesDescartados` (RN-26) |
| Logs | `logRechazo(res, 403, 'docente sin secciones a cargo')`, y un `warn` si falla la consulta del menú (RN-16) |
| `sections.heads` | puede contener usuarios `teacher` |

---

## Reglas de negocio

### A. Quién es Docente jefe

- **RN-01. Definición.** Un usuario es **Docente jefe** ⇔ `role === 'teacher'` ∧ tiene `school` ∧
  existe al menos una `Section` con `{ school: user.school, heads: user._id }`. Se decide leyendo
  `sections` en el request, **nunca** desde un campo de `User` ni desde un caché. Agregar o quitar
  a alguien de `heads` tiene efecto en el request siguiente, igual que hoy para el rol `jefe`
  (`models/Section.js:55-60`, smoke `jefatura-ve-solo-su-seccion`). La consulta va por el índice
  `{ heads: 1 }` (`models/Section.js:77`).

- **RN-02. Quién entra a `/jefatura` y con qué alcance** (`decidirAccesoJefatura`):

  | modo | roles | entra | alcance |
  |---|---|---|---|
  | sin límite | `directivo`, `admin`, `superadmin` | siempre | todas las secciones de su escuela (`scopeAll`). **Sin cambios** |
  | por rol | `jefe` | siempre; sin secciones ve «Todavía no tenés secciones a cargo» | sus secciones. **Sin cambios** |
  | **por sección** | **`teacher`** | **solo si es Docente jefe (RN-01)** | **sus secciones; `scopeAll` nunca** |
  | ninguno | `preceptor`, `soe`, `student` y cualquier otro | nunca (403), aunque figure en `heads` | — |

- **RN-03. El fail-closed se mantiene, con un matiz para el Docente.** Alcance vacío sigue
  significando «no ve nada» (`middleware/jefatura.js:11-14`). Para el `teacher` sin ninguna
  sección, la respuesta es **403**, no la pantalla «Todavía no tenés secciones a cargo». Esa
  pantalla le habla a un jefe que espera que le asignen algo. Mostrársela a cualquier docente que
  escriba la URL le haría creer que le falta una asignación. Si el Docente jefe tiene secciones
  **sin contenido**, en cambio, ve 200 con la pantalla de secciones vacías (`motivo:
  'secciones-vacias'`, `routes/jefatura.js:56-61`): es jefe, y lo vacío es la sección.

- **RN-04. La escuela filtra siempre.** Figurar en `heads` de una sección de **otra** escuela no
  cuenta, igual que hoy (`middleware/jefatura.js:57-63`). Un `teacher` sin escuela recibe 403.

- **RN-05. Dónde se decide, en `/jefatura`.** `requireJefe` deja pasar al `teacher` **como
  candidato**. La decisión final la toma `loadJefaturaScope` con la query que ya hace, pasándole
  el resultado a `decidirAccesoJefatura`. Si `entra` es false, responde 403 y no llama a `next()`.
  **No se suma ninguna query en `/jefatura`.** La cadena de `routes/jefatura.js:48`
  (`requireAuth → requireJefe → sectionGuard('jefatura') → loadJefaturaScope`) queda igual y en
  ese orden. Toda ruta que se agregue a ese router hereda la barrera.

- **RN-06. Rechazo con rastro.** El 403 del `teacher` sin secciones se registra con
  `logRechazo(res, 403, 'docente sin secciones a cargo')` (`middleware/route-log.js:59`). Así un
  «no me deja entrar a Jefatura» se diagnostica desde el log.

### B. Su vista de Docente no cambia

- **RN-07.** `/` sigue llevando al `teacher` a `/courses` (`server.js:712`), sea Docente jefe o
  no. No hay redirect a `/jefatura`.
- **RN-08.** Sigue siendo `teacher` para todo lo demás: titular y co-docente de materias, los
  selectores de docente del admin, el panel del directivo, la sala en vivo y el cartel «Docente» del
  encabezado. Ninguna de esas pantallas se toca.
- **RN-09.** Ser jefe no le agrega nada en sus materias: `Course.canManage` y
  `services/cursoPermisos.js` no cambian. Ser docente tampoco le agrega nada en `/jefatura`, que
  sigue siendo de solo lectura.
- **RN-10. Su alcance de jefatura no crece por lo que dicta.** Una materia suya que está **fuera**
  de sus secciones no aparece en `/jefatura`, y su `:id` responde 403 ahí. En `/courses` la sigue
  viendo como siempre.

### C. El menú

- **RN-11. «Mis secciones» en el menú lateral.** En el menú de `views/partials/header.ejs`, después
  de «Reservas» (`:354-359`), se pinta el ítem «Mis secciones» (icono `groups`, `href="/jefatura"`)
  cuando se cumplen **las cuatro** condiciones:
  `user.role === 'teacher'` ∧ `esJefeDeSeccion === true` ∧ `!impersonating` ∧
  `can('jefe_dashboard')`. «Clases» sigue arriba y sigue llevando a `/`. Así se vuelve de
  `/jefatura` a las clases.
- **RN-12.** Mientras dura una suplantación, el ítem no se pinta (DA-4), igual que para el jefe
  (`header.ejs:382`). La URL sigue respondiendo según RN-02.
- **RN-13. Solapas por rol.** `teacher` se suma a `roles` de `jefe_dashboard`, `jefe_teachers` y
  `admin_sections` (P1 = A). Tiene cuatro consecuencias, y las cuatro son parte de la regla:
  - **a)** `can('jefe_dashboard')` pasa a dar true para **todo** docente. Por eso **ningún enlace a
    la jefatura puede depender solo de `can()`**. El menú lateral lo combina con
    `esJefeDeSeccion` (RN-11). El nav de jefatura (`jefatura-nav.ejs`) y la vista de secciones
    solo los ve quien ya pasó el 403 de RN-02 o RN-18.
  - **b)** Si la escuela le deniega `jefe_teachers` al **rol Docente** en `/superadmin/roles`, el
    Docente jefe pierde la solapa «Docentes» (403 y oculta) y el `jefe` no se entera. Cada rol se
    configura por separado. `jefe_dashboard` es `locked`: no se puede denegar, igual que para el
    `jefe`.
  - **c)** Lo mismo con `admin_sections` y la solapa «Secciones» (P1 = A).
  - **d)** `/superadmin/roles` muestra celdas nuevas en la columna Docente (DA-6).

### D. El costo

- **RN-14. A lo sumo una consulta de pertenencia por request, y solo donde hace falta.** El memo
  del request (`pertenenciaJefatura`) la comparten el guard y el menú.

  | request | consultas de pertenencia nuevas |
  |---|---|
  | cualquier rol distinto de `teacher` | **0** |
  | `teacher` que recibe algo que no es una página: JSON, **poll de la sala**, subida, archivo, redirect, 304 | **0** |
  | `teacher` en `/jefatura/*` | **0**: la resuelve la query que `loadJefaturaScope` ya hace |
  | `teacher` en `/admin/secciones/*` | **1**, en el guard. El menú de esa misma página la reusa |
  | `teacher` en cualquier otra página HTML | **1**, al renderizar |

- **RN-15. El mecanismo.** Hay un middleware global, `marcarDocenteJefe`, montado en `server.js`
  después del que publica `res.locals.can` (`:463-472`) y antes de las rutas. Hace esto:
  - si el usuario no es `teacher` o no tiene escuela: `res.locals.esJefeDeSeccion = false`,
    `next()`, y no envuelve nada;
  - si es `teacher` con escuela: deja `res.locals.esJefeDeSeccion = false` y **envuelve
    `res.render`**. Antes de llamar al `render` original, espera `pertenenciaJefatura(req, res)`,
    que resuelve el memo si no estaba resuelto, y recién ahí renderiza con los mismos argumentos.
    El `render` original se llama **una sola vez**. Sus errores siguen yendo a `next(err)`, como
    hace Express.
- **RN-16. Falla cerrada para el menú, nunca un 500.** Si la consulta falla al renderizar, la
  página se pinta igual con `esJefeDeSeccion = false` (sin el enlace) y se loguea un `warn`. El
  acceso a `/jefatura` no depende de esto: lo decide RN-05 con su propia query.
- **RN-17. Sin caché entre requests.** Ni por worker ni compartido. Un caché de pertenencia
  dejaría el menú desactualizado hasta su vencimiento, y su invalidación tendría el mismo problema
  de los dos workers que ya documenta `middleware/cache.js:3-11`.

#### Costo estimado, y qué hay que medir

⚠️ **No se midió en esta sesión**: no hubo acceso a una consola ni a la base. Lo que sigue sale
del código. La medición queda como tarea **T-0** del implementador, con los comandos exactos.

- **La consulta.** `{ school, heads: user }` usa el índice `heads_1`. Examina tantas claves y
  documentos como secciones tenga a cargo ese usuario: **cero para casi todos los docentes** y una
  o dos para un Docente jefe. La colección `sections` es chica: una sección por recorte
  institucional.
- **Contra qué se compara.** El middleware del sobre (`server.js:613-643`) ya hace **dos
  `countDocuments` en cada request de cada usuario logueado**, poll de la sala incluido. Esta spec
  suma **como mucho una** consulta por **página** de un **docente**, y **ninguna** por poll.
- **Alternativas descartadas:**
  - **Consultar en cada request del docente.** La sala manda un poll cada 4 s por persona
    (`specs/sala-en-vivo-escala.spec.md`). Con el objetivo de diseño de 30 salas, son
    ~30 × 15/min ≈ **7,5 consultas por segundo** que no pintan ningún menú.
  - **Caché con TTL.** Rompe RN-17 y el «request siguiente» del menú.
  - **Calcularla solo en `GET /courses`.** El menú aparecería en una pantalla sí y en otra no.
- **T-0: medir antes de mergear y dejar los dos números en el PR:**
  1. `db.sections.find({ school: ObjectId('<E>'), heads: ObjectId('<U>') }, { _id: 1 }).limit(1).explain('executionStats')`
     tiene que mostrar `IXSCAN` sobre `heads_1`, `totalDocsExamined` ≤ secciones de U y
     `executionTimeMillis` de 0 o 1.
  2. De `logs/combined.log` de un día de clase: cuántas líneas `GET … 200` tienen como `usuario` a
     un `teacher`. El poll con 200 no se registra (`middleware/request-log.js:27-34`), así que el
     número es la **cota superior** de consultas nuevas por día.

### E. `/admin/secciones` para el Docente jefe (P1 = A, decidido el 2026-09-24)

- **RN-18.** El Docente jefe entra a `/admin/secciones` **con las mismas
  reglas que el rol `jefe`**:
  - ve **solo** sus secciones (`routes/sections.js:116`);
  - edita el nombre y el contenido de las suyas. Sus `heads` se conservan con `headsFijos`
    (`:197-205`, `:257-260`): lo que mande en `headIds` **no se mira**;
  - no crea, no borra, no abre ni edita una sección ajena. Recibe 403 con `soloAdmin`, como el jefe
    (`:159`, `:180`, `:220`, `:255`, `:295`);
  - puede elegir cualquier curso o materia de su escuela, igual que el jefe (`:26-29`), y queda en
    la auditoría;
  - **el guard** (`requireAccesoSecciones`, `:48-53`) admite al `teacher` **solo si
    `pertenenciaJefatura` da true**. Si no, 403, a diferencia del `jefe` sin secciones, que ve 200
    con «Todavía no tenés ninguna sección a cargo». Es el mismo criterio que RN-03. Los POST
    rechazados contestan JSON, como hoy `soloAdmin`;
  - la vista usa el nav de jefatura, porque `puedeAdministrar` es false (`sections.ejs:36-40`).

### F. El editor de secciones del admin

- **RN-19. Quiénes pueden quedar a cargo:** `ROLES_ELEGIBLES_JEFE = ['jefe', 'teacher']` (DA-3).
- **RN-20. Qué candidatos ofrece el formulario** (crear y editar; solo lo ve el admin o el
  superadmin):
  - los usuarios **de la escuela** con rol elegible y `active !== false` (DA-1);
  - **más todos los jefes actuales de la sección que existan y sean de la escuela, sea cual sea su
    rol o su estado.** Es la regla que cierra la trampa: un jefe actual **siempre** se pinta,
    tildado;
  - el orden: primero los jefes actuales, después el resto por nombre;
  - cada fila muestra el rol en español (`res.locals.roleNames`). Si un jefe actual ya no sería
    elegible, además lo dice: «cuenta deshabilitada», o «con el rol Preceptor no puede entrar a
    Jefatura» (con el rol que corresponda);
  - arriba de la lista hay un **filtro por nombre o correo**, que corre en el navegador como el
    buscador del árbol de contenido. La lista pasa de unos pocos jefes a todos los docentes de la
    escuela;
  - el texto de ayuda deja de decir «Solo aparecen los usuarios con el rol Jefe de Sección»
    (`section-form.ejs:117-119`) y dice «Aparecen los Docentes y los Jefes de Sección de la
    escuela». El aviso de «no hay ningún Jefe de Sección» (`:150-157`) se pinta solo si **no hay
    ningún candidato**. **Nunca** si la sección tiene jefes actuales.
- **RN-21. Jefes actuales que ya no existen o son de otra escuela.** No se pintan con nombre ni
  correo. El admin no ve datos de otra institución (D3 de `identidad-multiescuela.spec.md`). En su
  lugar, el formulario muestra un aviso con la cantidad: «N persona(s) que estaban a cargo ya no
  pertenecen a esta escuela. Al guardar, se quitan de la sección.»
- **RN-22. Regla de guardado del admin** (`resolverHeads`), en este orden:
  1. `headIds` se deduplica. Si no es un array, cuenta como `[]`.
  2. Un id que **ya estaba** en `heads`, existe y es de la escuela → **se conserva**, sin volver a
     validar el rol ni el estado.
  3. Un id **nuevo** → se acepta solo si `esElegibleComoJefe`: es de la escuela, está activo y
     tiene rol elegible. Queda en `agregados`.
  4. Cualquier otro id nuevo (malformado, inexistente, de otra escuela, deshabilitado o con rol no
     elegible) va a `rechazados`. Si `rechazados` no está vacío, la respuesta es **400
     `HEAD_NOT_ELIGIBLE`** y **no se guarda nada**, ni el nombre ni el contenido. Es el mismo
     «todo o nada» de hoy (`routes/sections.js:211-213`).
  5. Un jefe actual que existe, es de la escuela y **no vino** en `headIds` → **se quita**: el admin
     lo destildó. Queda en `quitados`.
  6. Un jefe actual que **no existe** o es **de otra escuela** se quita, **haya venido o no** en
     `headIds`. Suma en `descartados` y el formulario ya lo había avisado (RN-21).
  7. El orden de `heads` guardado es el de `headIds`.
- **RN-23. Nada en silencio.** La respuesta JSON de `create` y `edit` suma
  `jefes: { agregados, quitados, descartados }` (nombres, nombres y cantidad), y lo mismo va a la
  auditoría (RN-26). Cuando edita un jefe o un Docente jefe, las tres quedan vacías: no toca
  `heads`.
- **RN-24. La vista de solo lectura muestra a todos los jefes actuales.** La que ven el jefe y el
  Docente jefe lista todos los `heads` que existen y son de la escuela, con su rol en español. Deja
  de filtrarlos contra los candidatos (arregla `section-form.ejs:131`).
- **RN-25. La grilla dice quién es quién.** En «A cargo de» (`sections.ejs:158-163`), junto a cada
  jefe cuyo rol no es `jefe` se agrega «· Docente», o el rol que tenga. Si su rol actual no entra a
  Jefatura (RN-02), además dice «(sin acceso)». Para eso el `populate` de `heads` (`:120`) suma
  `role`.

### G. Auditoría

- **RN-26.** No hay acciones nuevas. `/jefatura` sigue sin auditarse: son lecturas.
  `section.create` y `section.edit` agregan a su detalle `jefesAgregados` (nombres),
  `jefesQuitados` (nombres) y `jefesDescartados` (cantidad), **solo cuando no están vacíos**. El
  conteo `jefes` sigue como está (`routes/sections.js:230-233`, `:267-273`). La acción, la
  categoría y el icono no cambian.

### H. Cambios de rol y de escuela

- **RN-27. El acceso se recalcula en cada request con el rol vigente.** Ningún camino de cambio de
  rol toca `heads`, y eso no cambia:

  | rol nuevo de alguien que figura en `heads` | `/jefatura` |
  |---|---|
  | `teacher` | entra: es Docente jefe |
  | `jefe` | entra por rol, con sus secciones |
  | `directivo`, `admin` | entra con `scopeAll`, por rol, sin cambios |
  | `preceptor`, `soe`, `student` | **403**, aunque siga en `heads` |

- **RN-28. Figurar en `heads` con un rol que no entra no tiene efecto.** No da acceso a nada. El
  editor lo muestra (RN-20, RN-25) y el admin lo puede destildar. Si la persona vuelve a `teacher`
  o `jefe`, recupera la jefatura sin que nadie se la reasigne (DA-2).
- **RN-29. El caché del rol no cambia.** Un cambio de rol se ve al instante en el worker que lo
  atendió, y hasta 45 s después en el otro (`middleware/cache.js:3-11`). Pasa hoy con cualquier
  rol. Esta spec no agranda esa ventana, pero tampoco la cierra.
- **RN-30.** Mover a un Docente jefe de escuela (`POST /superadmin/users/:id/school`) le saca la
  jefatura en la escuela nueva. Aplica RN-04, sin tocar `heads`.

---

## Casos de uso

El vocabulario es el de `config/audit-actions.js`. `jefatura.view` **no es auditable** y va
nombrado solo para ubicarlo.

| # | acción | actor | qué pasa |
|---|---|---|---|
| **CU-01** | `section.create` / `section.edit` | admin | pone a un Docente a cargo de una sección. Lo encuentra con el filtro, lo tilda y guarda. La auditoría lo nombra en `jefesAgregados` |
| **CU-02** | `jefatura.view` | Docente jefe | entra a la plataforma y cae en `/courses`. En el menú lateral toca «Mis secciones» y ve las actividades, las entregas y los docentes de sus secciones |
| **CU-03** | `section.edit` | Docente jefe | configura el nombre y el contenido de su sección. Los jefes quedan como estaban |
| **CU-04** | `section.edit` | admin | edita una sección que tiene a un Docente jefe: le cambia el contenido y guarda. El Docente jefe **sigue a cargo** |
| **CU-05** | `section.edit` | admin | saca a un Docente jefe: lo destilda y guarda. En el request siguiente, `/jefatura` le da 403 y el menú ya no le muestra el enlace. La auditoría lo nombra en `jefesQuitados` |
| **CU-06** | `user.role_change` / `user.bulk_role` | admin / superadmin | le cambia el rol a un Docente jefe. Con `preceptor`, `soe` o `student` pierde la jefatura; con `jefe` la conserva por rol (RN-27) |
| **CU-07** | `user.school_change` | superadmin | lo mueve de escuela y pierde la jefatura de la escuela anterior (RN-30) |
| **CU-08** | — | Docente jefe | desde `/jefatura` vuelve a sus clases con «Clases» del menú (`/` → `/courses`) |

---

## Criterios de aceptación

**Datos de los criterios** (el tester los arma en el smoke):

- escuela **E**, la del admin de smoke;
- la división **DIN**, dentro de la sección **S**, y la división **DOUT**, fuera de S;
- **AIN** y **AOUT**: actividades de materias de DIN y DOUT;
- **docenteJefe**: `teacher`, activo, de E y en `heads` de S. Es titular de la materia **MP** en
  DOUT, con la actividad **AP**;
- **docenteSolo**: un `teacher` de E que no figura en ningún `heads`. Sirve el `scopedTeacher` del
  smoke;
- **jefe**: el `jefe` del smoke;
- **S2**: una sección ajena de E.

### A. Acceso a `/jefatura`

- **CA-01 (el caso de María).** Dado **docenteJefe** a cargo de S, cuando pide `GET /jefatura`,
  entonces recibe 200, la página incluye el título de AIN y **no** incluye el de AOUT ni el de AP.
- **CA-02.** Dado **docenteSolo**, cuando pide `GET /jefatura`, `GET /jefatura/docentes`,
  `GET /jefatura/actividades/<AIN>` y `GET /jefatura/docentes/<id de docenteJefe>`, entonces las
  cuatro responden **403** «Acceso denegado». Ninguna muestra el texto «Todavía no tenés secciones
  a cargo».
- **CA-03.** Dado un `teacher` de E que figura solo en `heads` de una sección de **otra** escuela
  (se siembra por Mongo), cuando pide `GET /jefatura`, entonces recibe 403.
- **CA-04.** Dado **docenteJefe**, cuando pide `GET /jefatura/actividades/<AOUT>`, entonces recibe
  403.
- **CA-05.** Dado **docenteJefe**, cuando pide `GET /jefatura/actividades/<AP>`, que es una
  actividad **suya** de una materia **suya** fuera de S, entonces recibe 403 (RN-10).
- **CA-06.** Dado **docenteJefe**, cuando pide `GET /jefatura/docentes/<id de un alumno de E>`,
  entonces recibe 403.
- **CA-07.** Dado un Docente jefe cuya única sección no tiene contenido (`divisions` y `courses`
  vacíos), cuando pide `GET /jefatura`, entonces recibe 200, la pantalla es la de secciones vacías
  y no lista actividades.
- **CA-08 (unitario).** Dado `decidirAccesoJefatura({ role: 'teacher', school: 'E' }, n)` con n
  = 0, 1 y 50, entonces `scopeAll` es false en los tres casos, y `entra` es false, true y true.
  Con `school: null` y n = 3, `entra` es false.
- **CA-09.** Dado **docenteJefe**, cuando el admin lo destilda de S y guarda, entonces el
  **siguiente** `GET /jefatura` de docenteJefe recibe 403, sin esperar nada.
- **CA-10.** Dado **docenteSolo**, cuando el admin lo agrega a S, entonces su **siguiente**
  `GET /jefatura` recibe 200.
- **CA-11 (unitario, con `logRechazo` espiado; o manual con el `X-Request-Id` y el log local).**
  Dado **docenteSolo**, cuando pide `GET /jefatura`, entonces se registra un rechazo 403 con
  `motivo: 'docente sin secciones a cargo'`.

### B. El rol `jefe` y los roles sin límite no cambian

- **CA-12.** Dado un `jefe` sin secciones, cuando pide `GET /jefatura`, entonces recibe **200**
  con «Todavía no tenés secciones a cargo», como hoy (smoke `jefatura-sin-seccion-no-ve-nada`).
- **CA-13.** Dado el escenario `jefatura-*` del smoke, cuando corre la suite, entonces **todos**
  sus specs pasan sin cambios, salvo `jefatura-rechaza-jefe-que-no-tiene-el-rol`, que se adecua
  (CA-49).
- **CA-14 (unitario).** Dado `decidirAccesoJefatura` con `directivo`, `admin` y `superadmin` y
  cualquier n, entonces devuelve `{ entra: true, scopeAll: true }`. Con `jefe` y n = 0, devuelve
  `{ entra: true, scopeAll: false }`.
- **CA-15.** Dado un `preceptor`, un `soe` y un `student` de E, los tres metidos en `heads` de S
  por Mongo, cuando piden `GET /jefatura`, entonces los tres reciben 403.

### C. Conserva su vista de Docente

- **CA-16.** Dado **docenteJefe**, cuando pide `GET /`, entonces recibe 302 con
  `Location: /courses`.
- **CA-17.** Dado **docenteJefe**, cuando pide `GET /courses`, entonces recibe 200 y la página
  lista MP.
- **CA-18.** Dado **docenteJefe**, cuando pide cualquier página, entonces el encabezado muestra el
  rol «Docente».
- **CA-19.** Dado **docenteJefe**, cuando el admin crea una materia con él como titular
  (`POST /admin/courses/create` con su `teacherId`), entonces recibe 201. Sigue siendo docente para
  `resolveCourseTeacher`.

### D. El menú

- **CA-20.** Dado **docenteJefe**, cuando pide `GET /courses`, entonces el menú lateral tiene
  `<a href="/jefatura" class="drawer-item">` con el texto «Mis secciones».
- **CA-21.** Dado **docenteSolo**, cuando pide `GET /courses`, entonces el HTML **no** contiene
  `href="/jefatura"`.
- **CA-22.** Dado **docenteJefe**, cuando pide `GET /jefatura`, entonces el nav del panel tiene
  `/jefatura`, `/jefatura/docentes` y `/admin/secciones`, y el menú lateral
  sigue teniendo «Clases» con `href="/"`.
- **CA-23.** Dado que la escuela E le denegó `jefe_teachers` al rol **Docente** en
  `/superadmin/roles`, cuando **docenteJefe** pide `GET /jefatura/docentes`, entonces recibe 403 y
  el nav de `GET /jefatura` no tiene `/jefatura/docentes`. En el mismo momento, el **jefe** sigue
  recibiendo 200 en `/jefatura/docentes`. Al final se repone la celda.
- **CA-24.** Dado un superadmin que suplanta a **docenteJefe**, cuando pide `GET /courses`,
  entonces el menú no tiene `href="/jefatura"`. Cuando pide `GET /jefatura`, recibe 200.

### E. El costo (unitarios, con un modelo `Section` falso que cuenta llamadas)

- **CA-25.** Dado `marcarDocenteJefe` y un request de rol `student`, `admin`, `jefe`, `preceptor`,
  `directivo` o `soe`, cuando la ruta responde con `res.render` o con `res.json`, entonces el
  modelo falso recibe **0** llamadas.
- **CA-26.** Dado un `teacher` con escuela, cuando la ruta responde con `res.json`,
  `res.redirect` o `res.send` (el poll de la sala responde JSON), entonces recibe **0** llamadas.
- **CA-27.** Dado un `teacher` con escuela, cuando la ruta responde con `res.render`, entonces el
  modelo recibe **exactamente 1** llamada, con el filtro `{ school, heads: _id }`, y la vista
  recibe `esJefeDeSeccion` con el valor que devolvió el modelo.
- **CA-28.** Dado un `teacher` en el que un guard ya llamó a `pertenenciaJefatura` en el mismo
  request, cuando la ruta renderiza, entonces el total de llamadas al modelo sigue siendo **1**.
- **CA-29.** Dado un `teacher` con un modelo que **rechaza** la consulta, cuando la ruta
  renderiza, entonces la vista se renderiza (el `render` original se llama una vez) con
  `esJefeDeSeccion = false`, y no hay error hacia `next`.

### F. `/admin/secciones` para el Docente jefe (P1 = A)

- **CA-30.** Dado **docenteJefe**, cuando pide `GET /admin/secciones`, entonces recibe 200, la
  página lista S, **no** lista S2 y **no** contiene «Nueva Sección».
- **CA-31.** Dado **docenteJefe**, cuando pide `GET /admin/secciones/<S2>/edit` y
  `POST /admin/secciones/<S2>/edit`, entonces las dos responden 403.
- **CA-32.** Dado **docenteJefe**, cuando pide `GET /admin/secciones/create`,
  `POST /admin/secciones/create` y `POST /admin/secciones/<S>/delete`, entonces las tres
  responden 403.
- **CA-33.** Dado **docenteJefe**, cuando manda `POST /admin/secciones/<S>/edit` con DOUT agregada
  y `headIds: [<id de docenteSolo>]`, entonces recibe 200, S incluye DOUT y **`heads` de S es
  exactamente el que tenía antes**. Su siguiente `GET /jefatura` lista AOUT. Después se restaura
  el contenido.
- **CA-34.** Dado **docenteSolo**, cuando pide `GET /admin/secciones`, entonces recibe **403**
  (no la pantalla vacía que ve el jefe). Cuando manda `POST /admin/secciones/<S>/edit` pidiendo
  JSON, recibe 403 con `{ error: 'Acceso denegado' }`.
- **CA-35.** Dado que E le denegó `admin_sections` al rol Docente, cuando **docenteJefe** pide
  `GET /admin/secciones`, entonces recibe 403 y el nav de `GET /jefatura` no tiene
  `/admin/secciones`. Al final se repone la celda.

### G. El editor del admin

- **CA-36.** Dado el admin, cuando pide `GET /admin/secciones/create`, entonces la lista de
  candidatos tiene un checkbox para **docenteSolo** y para **jefe**, cada uno con su rol en español.
  **No** tiene checkbox para un `preceptor`, un `student`, un `directivo` ni el `admin` de E, ni
  para un `teacher` deshabilitado de E, ni para un `teacher` de otra escuela.
- **CA-37.** Dado el admin, cuando manda `POST /admin/secciones/create` con
  `headIds: [<id de docenteSolo>]`, entonces recibe 201, `heads` lo contiene y
  `jefes.agregados` trae su nombre.
- **CA-38.** Dado el admin, cuando manda un `create` o un `edit` que en `headIds` agrega un
  `student` de E, un `teacher` deshabilitado de E o un `teacher` de otra escuela, entonces recibe
  **400** con `code: 'HEAD_NOT_ELIGIBLE'` y `rechazados` con ese id. La sección no cambia en
  ningún campo.
- **CA-39 (la trampa).** Dada S con `heads: [jefe, docenteJefe]`:
  - cuando el admin pide `GET /admin/secciones/<S>/edit`, entonces el HTML tiene el checkbox de
    `value="<id de docenteJefe>"` **tildado**;
  - y cuando reenvía el formulario tal cual (`headIds` = los tildados) con **otro contenido**,
    entonces recibe 200, `heads` sigue siendo `[jefe, docenteJefe]`, `jefes.quitados` viene vacío
    y el siguiente `GET /jefatura` de docenteJefe recibe 200.
- **CA-40.** Dada una escuela **sin ningún usuario con rol `jefe`** y una sección con un Docente
  jefe, cuando el admin abre la edición, entonces el checkbox del Docente jefe está tildado y el
  aviso «no hay ningún Jefe de Sección» **no** aparece. Guardar lo conserva. Es la variante peor de
  la trampa.
- **CA-41.** Dada S con docenteJefe a cargo y su rol pasado a `preceptor`, cuando el admin abre la
  edición, entonces su checkbox aparece tildado con el texto «con el rol Preceptor no puede entrar
  a Jefatura». Si reenvía el formulario tal cual, recibe 200 y sigue en `heads`. Lo mismo con la
  cuenta deshabilitada, y el texto «cuenta deshabilitada».
- **CA-42.** Dada S con un id en `heads` de un usuario de **otra** escuela y otro id de un usuario
  **inexistente** (los dos sembrados por Mongo), cuando el admin abre la edición, entonces el HTML
  no contiene el nombre ni el correo del usuario de la otra escuela, y muestra el aviso con la
  cantidad **2**. Cuando guarda, ninguno de los dos queda en `heads` y `jefes.descartados` es 2.
- **CA-43.** Dada S con `[jefe, docenteJefe]`, cuando el admin destilda a docenteJefe y guarda,
  entonces recibe 200, `heads` es `[jefe]`, `jefes.quitados` trae el nombre de docenteJefe, y el
  último registro `section.edit` de la auditoría tiene `jefesQuitados` con ese nombre.
- **CA-44.** Dado el jefe (rol `jefe`), cuando pide `GET /admin/secciones/<S>/edit` con S a cargo
  de `[jefe, docenteJefe]`, entonces la lista de solo lectura muestra **los dos** nombres.
- **CA-45.** Dado el admin, cuando pide `GET /admin/secciones`, entonces en la fila de S la columna
  «A cargo de» muestra el nombre de docenteJefe seguido de «· Docente».
- **CA-46 (manual).** Dados más de 100 candidatos, cuando el admin escribe en el filtro parte del
  apellido de una persona, entonces quedan visibles solo las filas que coinciden, y las tildadas
  siguen tildadas al borrar el filtro.

### H. Cambios de rol

- **CA-47.** Dado **docenteJefe**, cuando el admin le cambia el rol a `preceptor`
  (`POST /admin/users/:id/role`) y después a `student`, entonces con cada rol su siguiente
  `GET /jefatura` y su siguiente `GET /admin/secciones` reciben 403, y `heads` de S no cambia.
  Localmente es un solo proceso: el caché se invalida en el acto.
- **CA-48.** Dado el mismo usuario, cuando se le devuelve el rol `teacher`, entonces su siguiente
  `GET /jefatura` recibe 200 sin que nadie toque S (RN-28). Cuando se lo pasa a `jefe`, también
  recibe 200 y `GET /` lo lleva a `/jefatura`.

### I. Regresión y matriz de roles

- **CA-49.** El smoke `jefatura-rechaza-jefe-que-no-tiene-el-rol` pasa a usar el id de un
  `student` y sigue esperando **400**. Se agrega su contracara: el mismo `edit` con el id de un
  `teacher` activo de E responde **200**. Después se restaura S.
- **CA-50.** `npm run test:roles` termina sin FUGA ni ROTO:
  - el `teacher` del chequeo, que no está a cargo de nada, recibe **403** en `jefe_dashboard`,
    `jefe_teachers` y `admin_sections`, anotado como excepción documentada;
  - un actor nuevo, **docente-jefe**, puesto en `heads` de la sección del chequeo, recibe **200**
    en esas tres, **403** en el resto de las solapas de `admin`, y `GET /` lo lleva a `/courses`.
- **CA-51.** `/superadmin/roles` muestra la celda Docente × Jefatura › Docentes **configurable**,
  Docente × Jefatura › Actividades **con candado** y Docente × Administración › Secciones
  **configurable**. Un POST de toggle a esas celdas configurables responde 200.
- **CA-52 (unitario, guarda).** `config/sections.js` tiene `teacher` en `roles` de
  `jefe_dashboard`, `jefe_teachers` y `admin_sections`, y
  `ROLES_JEFATURA_POR_SECCION` es exactamente `['teacher']`. Si alguien cambia uno sin el otro, el
  test falla.
- **CA-53 (T-0, manual).** El `explain` de la consulta de pertenencia muestra `IXSCAN` sobre
  `heads_1` y `totalDocsExamined` ≤ la cantidad de secciones a cargo del usuario. El PR trae ese
  número y la cota diaria de § Costo.

---

## Errores posibles

| CODIGO | HTTP | mensaje en español | cuándo |
|---|---|---|---|
| `ACCESS_DENIED` | 403 | «Acceso denegado» | Un `teacher` sin secciones a cargo en `/jefatura/*` (RN-03) o en `/admin/secciones/*` (RN-18). Un rol sin acceso (RN-02). Una actividad o un docente fuera del alcance. Una sección ajena. Crear o borrar sin ser admin. Una solapa denegada por la escuela |
| `HEAD_NOT_ELIGIBLE` | 400 | «Solo pueden quedar a cargo Docentes y Jefes de Sección de esta escuela, con la cuenta activa.» | El admin agrega en `headIds` un id malformado, inexistente, de otra escuela, deshabilitado o con un rol que no es `jefe` ni `teacher` (RN-22.4). Reemplaza al mensaje de `routes/sections.js:212` |
| `SECTION_NOT_FOUND` | 404 | «Sección no encontrada» | `:id` malformado o inexistente. Sin cambios |
| `SECTION_NAME_TAKEN` | 400 | «Ya existe una sección con ese nombre en esta escuela» | Nombre duplicado (`err.code === 11000`). Sin cambios |
| `NO_SCHOOL` | 400 | «Sin escuela asignada» | Admin sin escuela que intenta crear. Sin cambios |
| `SERVER_ERROR` | 500 | «Error del servidor» | Excepción no prevista, incluida la falla de la consulta de pertenencia **en un guard** (`/admin/secciones`). **Nunca** por la del menú (RN-16) |

Los códigos son el contrato para los tests. Hoy las respuestas de este módulo solo llevan
`error`. El único que además viaja en el JSON es `HEAD_NOT_ELIGIBLE`, en `code`, junto a
`rechazados`. Los 403 de `/jefatura` siguen siendo texto plano, como hoy
(`middleware/jefatura.js:33`).

---

## Tests necesarios

Cada test nuevo se verifica **en rojo** neutralizando el cambio antes de darlo por bueno. Al
terminar corren las tres suites: `test:unit`, `test:smoke` y `test:roles`.

**Unitarios.** Archivo nuevo, `tests/unit/jefaturaAcceso.test.js`, con `node --test`:

- `modoJefatura` y `decidirAccesoJefatura`: CA-08, CA-14, y todos los roles de `User.getRoles()`
  (que ninguno quede sin clasificar);
- `esElegibleComoJefe`: cada combinación de rol, estado y escuela;
- `resolverHeads`: los siete pasos de RN-22, incluidos los duplicados, un `headIds` que no es array
  y el orden;
- `marcarDocenteJefe` y `pertenenciaJefatura`, con un modelo `Section` falso y `req`/`res`
  mínimos: CA-25 a CA-29;
- `loadJefaturaScope` con un `teacher` sin secciones y `logRechazo` espiado: CA-11;
- la guarda del catálogo: CA-52.

**Smoke** (`tests/smoke/specs.js`):

- **Dónde van los specs nuevos: es obligatorio.** Un bloque `docente-jefe-*`, **después** de
  `jefatura-rol-no-autoasignable` y **antes** de `objectid-invalido-da-404`. `tools/cobertura-rutas.js:67-71`
  deja afuera de la cobertura lo que está entre `objectid-invalido-da-404` y `cleanup-jefatura`.
  El bloque reusa el escenario de jefatura (`state.seccionId`, `jefDivIn`, `jefDivOut`,
  `jefActIn`, `jefActOut`, `seccionAjenaId`);
- su propio `cleanup-docente-jefe`, **antes** de `cleanup-jefatura`: borra MP y a docenteJefe. La
  materia va primero: un titular con materias da 409;
- cubren CA-01 a CA-07, CA-09, CA-10, CA-12, CA-13, CA-15 a CA-24, CA-30 a CA-45 y CA-47 a
  CA-49. CA-03, CA-15 y CA-42 siembran por Mongo (`MONGODB_URI`), como ya hace el smoke de
  materias;
- se adecua `jefatura-rechaza-jefe-que-no-tiene-el-rol` (CA-49).

**Roles** (`tests/roles/check-roles.js`): la excepción documentada del `teacher` sin sección (junto
a la del SOE, `:214-236`) y el actor docente-jefe (CA-50).

**Manual:**

- CA-46: el filtro con la escuela real del espejo local;
- el formulario de sección a 375 px, sin scroll horizontal;
- CA-53 (T-0);
- después del despliegue, suplantando a María: `GET /jefatura` muestra CONSTRUCCIONES 1 y `/` la
  lleva a `/courses` (Plan de migración, paso 3).

---

## Dependencias

Archivos que toca la implementación:

| archivo | qué |
|---|---|
| `services/jefaturaAcceso.js` | **nuevo**: constantes y funciones puras |
| `middleware/jefatura.js` | `requireJefe` admite al `teacher` como candidato; `loadJefaturaScope` decide con `decidirAccesoJefatura`, carga el memo y registra el rechazo; se agregan `pertenenciaJefatura` y `marcarDocenteJefe` |
| `server.js` | monta `marcarDocenteJefe` después del middleware de `res.locals.can` y antes de las rutas. El redirect de `/` no cambia |
| `config/sections.js` | `teacher` en `roles` de las tres solapas, y el comentario de la excepción |
| `routes/sections.js` | guard para el `teacher` (P1 = A); `datosFormularioSeccion` con candidatos y jefes actuales; `armarSeccion` con `resolverHeads`; `populate` con `role`; respuesta y auditoría con `jefes` |
| `views/partials/header.ejs` | el ítem «Mis secciones» para el Docente jefe |
| `views/admin/section-form.ejs` | candidatos, rol, motivo, filtro, aviso de descartados, lista de solo lectura desde `heads` y nombres de los rechazados en el error |
| `views/admin/sections.ejs` | el rol junto a cada jefe en «A cargo de» |
| `models/Section.js`, `models/User.js` | **solo comentarios** |
| `tests/unit/jefaturaAcceso.test.js`, `tests/smoke/specs.js`, `tests/roles/check-roles.js` | ver § Tests necesarios |

**Se leen y no se modifican:** `routes/jefatura.js`, `middleware/sections.js`,
`middleware/route-log.js`, `middleware/cache.js`, `middleware/auth.js`, `routes/admin.js`,
`routes/superadmin.js`, `routes/roles.js` (valida con `isConfigurable`, que ya contempla la celda
nueva) y `config/audit-actions.js`.

**No depende** de ninguna spec en curso (`preceptor-progreso-alumnos`, `sonido-chat-sala`,
`correccion-de-entregas`, `sala-presencia-en-actividad`).

### Convivencia con `identidad-multiescuela.spec.md`

- **Con su fase 1 (Membership y capa de compatibilidad) no hay choque.** Allá, `user.role` y
  `user.school` pasan a ser el **contexto activo**. Esta spec lee exactamente esos dos campos más
  `user._id`, que sigue siendo la persona. `heads` sigue guardando ids de `User` (personas), y el
  filtro `{ school: <escuela activa>, heads: <persona> }` acota la jefatura a la escuela en la que
  está parada, sin tocar nada.
- **Con su D2 (pendiente) hay una tensión, y la dejo escrita.** Esa spec recomienda la opción (a),
  «un rol activo por vez, con cambiador». Esta spec, para **un solo par** (Docente y jefatura),
  **suma** sin selector, que es el espíritu de la opción (b). No choca en el código: `user.role`
  sigue siendo un string y las 66 comparaciones de rol quedan intactas, porque la jefatura del
  Docente **no es un rol**: es una **capacidad** que da `Section.heads`. Pero es un precedente de
  producto:
  - si D2 se resuelve por (a), esta spec queda como **excepción documentada**, y a la persona no
    le hace falta una membresía `jefe` además de la `teacher`;
  - si se resuelve por (b), esta es la primera «capacidad» y la absorbe el refactor.
- **Su D3** («el admin no ve lo de otra escuela») se respeta en RN-21.
- **Para cuando se implemente:** que `Section.heads` siga apuntando a personas (`User`) y no a
  membresías es una decisión que esa spec tiene que confirmar. Con membresías, un id de membresía
  en `heads` rompería el filtro de RN-01.

---

## Riesgos de refactorización

1. **`can('jefe_dashboard')` es true para todo docente** (RN-13a). El día que alguien agregue un
   atajo a la jefatura usando solo `can()`, se lo ofrece a todos los docentes. La URL les va a dar
   403, así que no es una fuga, pero sí una puerta que da a una pared. CA-21 es la red.
2. **La matriz de roles cambia de significado para `teacher`.** Sin la excepción de CA-50,
   `test:roles` reporta ROTO en tres solapas. No hay que «arreglarla» sacando `teacher` de `roles`:
   eso esconde el nav de jefatura al Docente jefe.
3. **`requireJefe` deja pasar al `teacher` y la barrera real está en `loadJefaturaScope`.** Si una
   ruta nueva de jefatura se monta fuera de `router.use(... loadJefaturaScope)`, un docente
   cualquiera entra con el alcance vacío. Todas las rutas del panel miran `scopeCourseIds`, así que
   vería la pantalla vacía y no datos, pero con 200. RN-05 exige que nada se monte fuera de esa
   cadena. CA-02 prueba las cuatro rutas.
4. **El `res.render` envuelto** (RN-15, DA-7):
   - tiene que pasar los argumentos tal cual, llamar al original **una sola vez** y no tragarse
     sus errores (Express los manda a `next(err)`);
   - una vista que se genere sin `res.render` (con `ejs.render` y `res.send`) queda sin el enlace.
     Falla cerrada e inofensiva, pero conviene saberlo;
   - si alguien «optimiza» y mueve la consulta a un middleware de todas las requests, vuelve el
     costo en el poll (§ Costo). CA-26 es la red.
5. **Conservar sin revalidar (RN-22.2) tienta a «limpiarse».** Alguien va a ver un preceptor en
   `heads` y va a querer que el servidor lo saque al guardar. Eso es exactamente la expulsión
   silenciosa que esta spec viene a cerrar. Se lo saca destildándolo, a la vista del admin.
6. **La fusión de cuentas no mueve `heads`** (`services/` no referencia `Section`). Si se fusionan
   dos cuentas mellizas y la que queda apagada era la que estaba a cargo, la que sobrevive pierde la
   jefatura sin aviso. Pasa también con el rol `jefe` hoy, y no lo introduce esta spec. Hay que
   anotarlo para la fase de la fusión que mueve referencias. En el paso 0 del Plan se verifica que
   el id de María en `heads` sea el de su cuenta activa.
7. **Árbol de trabajo sucio.** `tests/smoke/specs.js` y `config/audit-actions.js` tienen cambios
   ajenos sin commitear (git status del 2026-09-24). Esta spec no necesita tocar
   `audit-actions.js`. El smoke sí, y el commit tiene que llevarse **solo** el bloque
   `docente-jefe-*` y la adecuación de CA-49.
8. **Los comentarios que hoy dicen «solo `jefe`»** (`models/Section.js:62-64`,
   `routes/sections.js:146-147` y `:10-24`, `config/sections.js:48-51`,
   `views/admin/section-form.ejs:117-119`) son parte del cambio. Si quedan como están, el próximo
   que lea el editor va a «restaurar» el `{ role: 'jefe' }`.

---

## Plan de migración

**No hay migración ni backfill, y no se toca ningún dato.** El despliegue es solo código. María ya
figura en `heads` de CONSTRUCCIONES 1: en cuanto su rol sea `teacher`, entra.

**Paso 0: antes del push, una consulta de solo lectura sobre producción, que ve el usuario.** El
despliegue **cambia permisos**: todo `teacher` activo que hoy figure en `heads` de una sección de su
escuela empieza a entrar a `/jefatura`. Hay que ver la lista antes:

```js
db.sections.aggregate([
  { $unwind: '$heads' },
  { $lookup: { from: 'users', localField: 'heads', foreignField: '_id', as: 'u' } },
  { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
  { $match: { $or: [ { u: { $exists: false } }, { 'u.role': { $ne: 'jefe' } } ] } },
  { $project: { _id: 0, seccion: '$name', escuelaSeccion: '$school', usuario: '$heads',
                nombre: '$u.name', rol: '$u.role', activo: '$u.active', escuelaUsuario: '$u.school' } },
])
```

- **Lo esperado:** una fila, María (`teacher`) en CONSTRUCCIONES 1. Cualquier otra fila con
  `rol: 'teacher'`, `activo` distinto de false y la misma escuela es **otra persona que gana
  acceso** con el deploy, y el usuario la tiene que aprobar o destildar antes.
- **Filas sin `nombre`** (usuario inexistente) **o de otra escuela:** la primera vez que un admin
  guarde esa sección van a aparecer como «descartados» (RN-21). No hace falta tocarlas a mano.
- **Confirmar la cuenta de María:**
  `db.users.findOne({ _id: ObjectId('6a2874d9279adb97e277e8e9') }, { name: 1, role: 1, school: 1, active: 1, mergedInto: 1 })`.
  Tiene que dar `active` distinto de false y `mergedInto: null` (riesgo 6).
  - Si su rol hoy es **`teacher`**, no hay nada más que hacer.
  - Si hoy es **`jefe`**, el único paso es que el admin le cambie el rol a Docente desde
    `/admin/users`. Es una acción normal y auditada (`user.role_change`), no una migración, y
    gracias a RN-27 conserva la jefatura.

**Paso 1: deploy.** Se hace como siempre. Después, `/health` tiene que mostrar la versión nueva.

**Paso 2: verificación en producción, sin datos de prueba.** Un superadmin suplanta a María:

- `GET /` lleva a `/courses`, con sus 4 materias;
- `GET /jefatura` muestra las actividades de CONSTRUCCIONES 1;
- `GET /jefatura/actividades/<una de otra sección>` da 403.

Por DA-4, el enlace del menú no se ve mientras dura la suplantación. Después, que María confirme
que lo ve desde su cuenta.

**Paso 3: el admin de la escuela abre CONSTRUCCIONES 1 en el editor.** Tiene que ver a María
tildada, como Docente. Si guarda sin tocarla, María sigue a cargo (CA-39).

**Vuelta atrás:** revertir el commit. No hay datos que deshacer: `heads` no cambió de forma, y los
docentes que queden en `heads` pierden el acceso, como antes del deploy. Si hay que cortar solo la
configuración y no el panel, alcanza con denegar la celda Docente × Secciones en
`/superadmin/roles`. El panel en sí (`jefe_dashboard`) no se puede apagar por celda porque
está `locked`: para eso, revertir.
