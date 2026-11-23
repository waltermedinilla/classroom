# Jefe de Taller

> **Estado:** APROBADA por Walter el 2026-11-22 ("sí, adelante con la spec"), con P1 a P4
> cerradas (ver § Preguntas). **F1 implementada** (1.0.135).
> **2026-11-23:** Walter pidió *"generá la spec F2 y F4, la F3 eliminala, terminá la spec y
> comenzá inmediatamente"*. **El pañol (F3) sale de la spec** y con él el rol `panolero`.
> F2 y F4 quedan escritas acá y se implementan en la misma entrega.
> Flujo SDD: arquitecto → **spec aprobada** → tester → implementador → revisor.

## Pedido

> "Puedes continuar con el rol de Jefe de Taller"

Respuestas de Walter (2026-11-22):

| Pregunta | Respuesta |
|---|---|
| ¿Qué hace? | **Supervisar los talleres**, **controlar a los MEP** y **rotación de grupos**. Agregó: *"Puede revisar también qué subió cada jefe de Taller."* (El pañol estaba en la respuesta y se sacó el 2026-11-23.) |
| ¿Qué le toca? | **Todos los talleres** de la escuela: un solo alcance, sin asignación por persona. |

## Contexto: lo que ya existe y se reutiliza

| Pieza | Qué es hoy | Para qué sirve acá |
|---|---|---|
| `Section` (`models/Section.js`) | Secciones de taller ("CONSTRUCCIONES 1"), con `divisions`, `courses` y `heads`, que son los **Jefes de Sección** | Ver P1 y P2 |
| Rol `jefe` y Docente jefe (`specs/docente-jefe-de-seccion.spec.md`) | Ve, sin tocar, las actividades de las materias de sus secciones (`/jefatura`) | La supervisión (F1) usa las mismas consultas con otro alcance |
| Panel Secretaría (`/secretaria`) | Docentes del día, ficha del docente, notas del día, horario del curso y comparación con el oficial | El control de los MEP (F2) reutiliza `filasDelDia`, `NotaDocenteDia` y `compararCurso`, filtrados a talleres |
| `HorarioOficial` (fase 4 de Secretaria) | El horario oficial importado, con docente por renglón | F2: los renglones oficiales de los talleres |
| `Course.students` | Los alumnos inscriptos en cada materia | F4: los alumnos de una división son los inscriptos en sus materias |

## Decisiones de diseño

### D1 — Un rol nuevo: `jefetaller`, "Jefe de Taller"

- `ROLES` suma `'jefetaller'` **inmediatamente después de `directivo`** (2026-11-22: "tiene la
  misma importancia que un director").
- Al entrar, `GET /` lo lleva a **`/taller`**.
- Panel nuevo **`taller`** en `config/sections.js`, con sus secciones para que el admin pueda
  apagarlas (ver la tabla de F1, F2 y F4). Directivo, admin y superadmin también ven el panel.
- **Alcance: todos los talleres de la escuela** (decisión de Walter). No hay
  `assignedDivisions` ni selector de cursos para este rol.
- Para el resto del sistema no es docente. Si además da clases, es la misma situación que el
  Docente jefe; queda fuera de esta spec. Ver *Fuera de alcance*.

### D2 — Qué es "un taller" (ver P2)

Una **materia de taller** es una materia (`Course`) marcada con el campo nuevo
**`Course.esTaller: true`**.

- El admin las marca desde una pantalla nueva, `/taller/materias` (también la usa el Jefe de
  Taller).
- La pantalla sugiere tildadas las que, por el nombre, son talleres: "Prácticas de Taller…",
  "Operaciones Mecánicas/Constructivas…", "Talleres pre-profesionaliz.", "Prácticas
  Profesionalizantes", "Prácticas Mecánicas", y cualquier nombre que empiece con "Taller".
  Las sugerencias no se guardan solas: hay que confirmarlas.
- Un **MEP** (maestro de enseñanza práctica) es todo titular o co-docente de una materia de
  taller. No hace falta un rol aparte.

### D3 — Solo mira lo que no es suyo

El Jefe de Taller **no escribe** actividades, entregas, notas ni asistencia: igual que el Jefe
de Sección. Escribe solo en tres cosas: la marca `esTaller` (F1), **la nota del día sobre un
MEP** (F2) y **los grupos y las rotaciones** (F4).

---

## F1 — Rol, materias de taller y supervisión

### Pantallas

| Ruta | Qué muestra |
|---|---|
| `GET /taller` | **Resumen del día**: materias de taller que tienen clase hoy según la grilla (`horarioClases`), si el MEP entró a la plataforma, si publicó algo esta semana, y la asistencia de la división ese día (presentes y ausentes del preceptor) |
| `GET /jefatura` y `/jefatura/actividades/:id` | Las actividades de **todas** las materias de taller, de solo lectura. **Son las mismas pantallas de la jefatura**, con un modo de alcance nuevo, `por-taller` (`services/jefaturaAcceso.js`): para `jefetaller`, `scopeCourseIds` = materias con `esTaller` de la escuela. No se duplica código. `/jefatura/docentes` da, por lo mismo, la lista de MEP con su ficha |
| `GET /taller/jefes` | **Qué subió cada Jefe de Sección y cada MEP a su cargo** (P1). Una tarjeta por Jefe de Sección (`Section.heads`) con lo que publicó en el período (actividades, anuncios y materiales) y, adentro, sus MEP: los docentes de las materias de taller de sus Secciones, con lo que publicó cada uno. Se elige el período (semana, mes o fechas) |
| `GET /taller/jefes/:id` | El detalle de un Jefe de Sección o de un MEP: la lista de lo que subió, con enlace a cada actividad (de solo lectura) |
| `GET /taller/materias` | Marcar y desmarcar las materias de taller (D2). Lo usan el admin y el Jefe de Taller. Audita `taller.materias` |

### Agregado el 2026-11-22 (ya con F1 escrita)

> "quiero también que pueda visualizar lo que han hecho las diferentes secciones también, y que
> pueda visualizar por día, por semana o por mes. Es el jefe, tiene la misma importancia que un
> director."

| Ruta | Qué muestra |
|---|---|
| `GET /taller/secciones?periodo=&fecha=` | **Qué hizo cada Sección.** Una tabla comparativa y una tarjeta por Sección con: su jefe, sus talleres, cuántos MEP tiene, y las actividades, novedades y clases en vivo de sus materias de taller en el período. Cada tarjeta muestra también lo último publicado. "Talleres sin sección" junta los que no están en ninguna |

- **Período (también en `/taller/jefes`):** se elige **Día**, **Semana** (de lunes a domingo) o
  **Mes**, con anterior, siguiente, "Hoy" y un "Ir a" con fecha. Las fechas son en hora de
  Argentina y una fecha futura cae en hoy (`ventanaDelPeriodo`).
- **"La misma importancia que un director":** Walter eligió **"solo talleres, más visible"**. El
  alcance no cambia: sigue sin entrar al Panel Directivo y ve solo los talleres.
  - En todas las listas y selectores de roles va **inmediatamente después del Directivo**.
  - El Panel Directivo tiene un acceso directo a "Talleres".

### Reglas

- **RN-F1-1.** Todo lo de F1 se filtra por `school` y `esTaller: true`. Una materia de otra
  escuela o que no es de taller da 404, no 403, para no revelar que existe.
- **RN-F1-2.** Si la escuela no tiene ninguna materia de taller marcada, todas las pantallas
  muestran el aviso y un enlace a `/taller/materias`.
- **RN-F1-3.** El resumen del día usa la **misma** lógica de "tuvo clase / entró / publicó"
  que Docentes del día (`services/secretariaDia.js`). No se escribe una segunda versión.

---

## F2 — Control de los MEP

El Resumen del día (F1) ya muestra a los MEP **de un día**. F2 agrega lo que le falta a un jefe
para *controlar*: ver la **semana o el mes completo** de cada MEP de un vistazo, abrir la
**ficha** de uno y dejarle una **nota**, y comparar los **horarios de taller** contra el
horario oficial.

### Pantallas

| Ruta | Qué muestra |
|---|---|
| `GET /taller/docentes?periodo=semana\|mes&fecha=` | **Control de los MEP.** Una fila por MEP y una columna por día hábil del período (los días de la grilla de la escuela, `Horario.dias`; sin grilla, lunes a viernes), hasta hoy. Cada celda es el estado del día de "Docentes del día": **A** (con actividad, verde), **I** (solo ingresó, azul) o **—** (sin registro, gris). El borde dice la puntualidad (naranja = llegó tarde a su primera clase; verde = a tiempo). Un punto marca que ese día tiene nota. Los días en que la grilla no le pone clase se ven atenuados. Al final de la fila, los totales: días con clase, con actividad, solo ingreso, sin registro (de los días con clase) y llegadas tarde. Cada celda lleva a la ficha de ese día. `periodo=dia` redirige al Resumen del día |
| `GET /taller/docentes/:id?fecha=` | **La ficha del MEP**: estado del día, puntualidad, en la plataforma (de qué hora a qué hora), minutos en la sala en vivo, publicó y corrigió; lo que quedó registrado; y la **nota del día**. Enlace a sus actividades (`/jefatura/docentes/:id`) |
| `POST /taller/docentes/:id/nota` | Guarda, reemplaza o (vacía) borra la nota del día. Body `{ fecha, texto }`, responde JSON |
| `GET /taller/horario?curso=&modo=` | **Horarios de taller.** Sin curso: una tarjeta por curso con taller, con el resumen de la comparación contra el oficial (coinciden, diferencias, a confirmar). Con curso: la comparación renglón por renglón (la misma tabla de Secretaría), limitada a los talleres |

### Reglas

- **RN-F2-1.** Las notas se guardan en `NotaDocenteDia`, la **misma** colección de la
  Secretaria: una nota por docente y día, con autor. La Secretaria ve la del Jefe de Taller y al
  revés; el último que guarda la reemplaza y queda como autor. Es un solo legajo del día. El
  docente no la ve (RN-13 de Secretaria, sin cambios).
- **RN-F2-2.** Escribe notas **solo el Jefe de Taller** (y la Secretaria, desde su panel).
  Directivo, admin y superadmin entran a la ficha y leen. Audita `taller.nota_guardar` y
  `taller.nota_borrar`. No se anota un día futuro. Máximo 500 caracteres.
- **RN-F2-3.** La ficha, la nota y el control son **solo de MEP de talleres de la escuela**. Un
  id que no es MEP de un taller de su escuela da **404** (RN-F1-1).
- **RN-F2-4.** El control arma cada día con `filasDelDia` de `routes/secretaria.js`, igual que el
  Resumen (RN-F1-3). No hay una segunda versión de "tuvo clase / llegó tarde". Un mes son como
  mucho 23 días hábiles: se calcula por día y no se guarda nada.
- **RN-F2-5.** Para comparar se usa `services/secretariaHorarioOficial.js` tal cual
  (`compararCurso`). Un renglón oficial es **de taller** si su materia coincide
  (`coincideMateria`) con una materia de taller de esa división, o si el nombre oficial es de
  taller (`sugerirTaller`). Del lado de la plataforma entran solo las materias con `esTaller`.
  Así "No está cargado" y "No está en el oficial" hablan solo de talleres.
- **RN-F2-6.** La pantalla de horarios es de **solo lectura**. Para corregir un horario se usa
  Secretaría → Horario del curso (la carga sigue siendo de la Secretaria y el admin).

---

## F4 — Rotación de grupos

En los talleres, una división se parte en **grupos** que van pasando por las **estaciones**
(electricidad, carpintería, herrería…), cada una con su taller y su MEP, durante un período.

### Modelos nuevos

**`GruposTaller`** — un documento por división (`{ school, division }` único).

| Campo | Notas |
|---|---|
| `school`, `division` | |
| `grupos[]` | `{ _id, nombre, alumnos: [User] }`. El `_id` de cada grupo es fijo: las rotaciones lo usan |
| `actualizadoPor` | |

Guardar reemplaza la lista entera de una vez, así la regla "un alumno en un solo grupo" se valida
completa antes de escribir (RN-F4-1).

**`RotacionTaller`**

| Campo | Notas |
|---|---|
| `school`, `division`, `nombre` | "1er cuatrimestre 2027" |
| `desde`, `hasta` | `'YYYY-MM-DD'`, en hora de Argentina; `hasta` inclusive |
| `cambiaCada` | `'semana' \| 'quincena' \| 'mes' \| 'manual'` (P4) |
| `estaciones[]` | `{ _id, nombre, course (la materia de taller), admiteVarios: Boolean }`. Los MEP de la estación son los docentes de su materia: no se copian |
| `periodos[]` | `{ desde, hasta, asignacion: [{ grupo, estacion \| null }] }`. `null` = ese período el grupo no tiene estación |
| `creadoPor`, `actualizadoPor` | |

### Cómo se arman los períodos

- **Semana:** el primer período va de `desde` al domingo de esa semana; después, semanas de lunes
  a domingo; el último termina en `hasta`.
- **Quincena:** igual, de a dos semanas.
- **Mes:** el primero de `desde` a fin de mes; después, meses calendario; el último termina en
  `hasta`.
- **Manual:** se escriben las **fechas en que cambia** (una por renglón). Cada fecha empieza un
  período nuevo.
- Tope: 60 períodos.

### "Generar": la rotación circular

Con los grupos en su orden (G1…Gn) y las estaciones en su orden (E1…Em), en el período *p* el
grupo *i* va a la estación *(i + p) mod m*. Así, período a período, cada grupo pasa a la
estación siguiente. Si hay más grupos que estaciones, dos grupos caen juntos: se permite solo si
esa estación admite varios; si no, "Generar" avisa y no guarda. Si hay más estaciones que
grupos, alguna queda libre cada período. Después de generar, cada celda se puede corregir a mano.

### Pantallas

| Ruta | Qué hace |
|---|---|
| `GET /taller/rotacion` | Un renglón por curso con taller: cuántos grupos tiene, sus rotaciones (la vigente, resaltada) y los botones **Grupos** y **Nueva rotación** |
| `GET /taller/rotacion/grupos/:divisionId` y `POST` | **Armar los grupos.** La lista de alumnos de la división con un selector de grupo al lado de cada uno; nombre de cada grupo editable; botones para sumar o sacar grupos, y **"Repartir en partes iguales"** por apellido o al azar (se hace en la pantalla y se revisa antes de guardar). Audita `taller.grupos` |
| `GET /taller/rotacion/nueva?division=` y `POST /taller/rotacion` | **Crear la rotación**: nombre, desde, hasta, cada cuánto cambia (y las fechas, si es manual) y las estaciones: los talleres de la división con un tilde, el nombre de la estación (por defecto el del taller) y "admite más de un grupo". Al crear, genera el calendario circular. Audita `taller.rotacion_crear` |
| `GET /taller/rotacion/:id` | **La grilla**: una fila por período y una columna por grupo, con la estación (y su MEP) de cada uno. El período actual va resaltado. Quien edita ve un selector en cada celda, **Guardar**, **Volver a generar** y **Borrar** |
| `POST /taller/rotacion/:id/calendario` | Guarda las correcciones a mano. Audita `taller.rotacion_editar` |
| `POST /taller/rotacion/:id/generar` | Vuelve a armar el calendario circular (pierde las correcciones). Audita `taller.rotacion_editar` |
| `POST /taller/rotacion/:id/borrar` | Borra la rotación (con confirmación). Audita `taller.rotacion_borrar` |

### En la materia (RN-F4-4)

En la página de una materia de taller que es estación de una rotación vigente, debajo de la
cabecera, una franja:

- **MEP** (titular o co-docente): *"Rotación «1er cuatrimestre» · del 16/11 al 22/11: Grupo B
  (12 alumnos)"*. Si ningún grupo le toca: *"esta semana no tenés grupo"*.
- **Alumno**: *"Rotación de talleres · del 16/11 al 22/11 te toca **Electricidad**, con Pérez"*.
  Si su grupo no tiene estación ese período, lo dice. Si no está en ningún grupo, no se muestra.
- Los demás (directivo, preceptor…) no ven la franja.

### Reglas

- **RN-F4-1.** Un alumno está en **un solo grupo** por división. Solo entran alumnos inscriptos
  en alguna materia de esa división. Entre 1 y 12 grupos; nombres de 1 a 40 caracteres, sin
  repetir.
- **RN-F4-2.** En el mismo período, **dos grupos no pueden estar en la misma estación**, salvo
  que la estación admita más de uno.
- **RN-F4-3.** Editan grupos y rotaciones el **Jefe de Taller**, el **admin** y el
  **superadmin** (los mismos que marcan materias de taller). El directivo las ve, sin editar.
- **RN-F4-4.** El MEP y el alumno ven solo la franja de su materia (arriba). No entran al panel.
- **RN-F4-5.** Las estaciones son materias **de taller de esa división** y de la escuela; una
  rotación de otra escuela da 404.
- **RN-F4-6.** Un grupo borrado después de armar una rotación aparece en la grilla como "Grupo
  eliminado" hasta que se vuelve a generar o se corrige.
- **RN-F4-7.** `desde` ≤ `hasta`, y como mucho 400 días entre los dos.

---

## Preguntas (resueltas por Walter el 2026-11-22)

| | Respuesta | Qué cambia |
|---|---|---|
| **P1** "Qué subió cada jefe de Taller" | *"A los Jefes, y a los MEP que tiene a cargo."* | `/taller/jefes` muestra cada Jefe de Sección y, adentro, sus MEP, con lo que subió cada uno (F1). Hay un solo Jefe de Taller, el general |
| **P2** Cómo se reconoce un taller | **Marca y Secciones** | `Course.esTaller` para la materia; las Secciones agrupan por especialidad |
| **P3** Quién registra en el pañol | ~~Jefe de Taller y Pañolero~~ | **Sin efecto**: el pañol salió de la spec el 2026-11-23 |
| **P4** Cada cuánto rotan | **Se elige al crear la rotación** | `cambiaCada`: `'semana' \| 'quincena' \| 'mes' \| 'manual'` |

## Fuera de alcance

- **El pañol** (inventario, préstamos, rol `panolero`): Walter lo sacó el 2026-11-23.
- Que el Jefe de Taller sea a la vez docente con el mismo usuario. Si hace falta, se resuelve
  como el Docente jefe, en otra spec.
- Las notas o calificaciones de taller: siguen en la materia, como cualquier otra.
- Asignar Jefes de Taller por especialidad: Walter eligió un alcance único.
- Que la asistencia de la materia se tome por grupo: la rotación informa, no cambia la asistencia.

## Lugares a tocar por el rol nuevo (F1)

Es la misma checklist que usó la Secretaria (`specs/secretaria-docentes-del-dia.spec.md`).

| Archivo | Qué |
|---|---|
| `models/User.js` | `ROLES` |
| `models/Course.js` | `esTaller` (Boolean, default false, con índice `{ school, esTaller }`) |
| `routes/superadmin.js`, `routes/auth.js` | listas de roles y lista blanca de autoregistro (no se autoregistra) |
| `server.js` | redirect de `GET /` y `res.locals.roleNames` |
| `config/sections.js` | panel `taller` y sus secciones; `app_courses` y `app_profile` |
| `config/audit-actions.js` | `taller.materias` |
| `middleware/auth.js` | `IngresoDiario` (que su ingreso también cuente) |
| `routes/admin.js` y vistas de usuarios | alta con el rol nuevo; nombre y color del rol |
| `views/superadmin/*` | listas y nombres de roles |
| `tests/roles/check-roles.js` | `ROLES` y `LANDING` |

Archivos nuevos en F1: `routes/taller.js`, `services/tallerAlcance.js`, `views/taller/*`,
`views/partials/taller-nav.ejs`.

## Lugares a tocar en F2 y F4

| Archivo | Qué |
|---|---|
| `routes/taller.js` | F2: `/docentes`, `/docentes/:id`, `/docentes/:id/nota`, `/horario`; monta las rutas de F4 en `/rotacion` |
| `routes/tallerRotacion.js` (nuevo) | F4 |
| `services/tallerControl.js` (nuevo) | F2: días hábiles del período, la matriz MEP × día y sus totales, el filtro de renglones de taller |
| `services/tallerRotacion.js` (nuevo) | F4: períodos, calendario circular, validaciones, "qué le toca hoy" |
| `models/GruposTaller.js`, `models/RotacionTaller.js` (nuevos) | F4 |
| `config/sections.js` | `taller_docentes`, `taller_horario`, `taller_rotacion` |
| `config/audit-actions.js` | `taller.nota_guardar`, `taller.nota_borrar`, `taller.grupos`, `taller.rotacion_crear`, `taller.rotacion_editar`, `taller.rotacion_borrar` |
| `routes/backup.js` | `grupostallers` y `rotaciontallers` (`optional: true`) |
| `routes/courses.js`, `views/course.ejs`, `views/partials/rotacion-taller.ejs` (nuevo) | La franja de RN-F4-4 |
| `views/secretaria/_comparacion.ejs` | Acepta `enlaceOficial` (el Jefe de Taller no entra a `/secretaria/oficial`) |
| `views/partials/taller-nav.ejs`, `views/taller/*` | Solapas y pantallas nuevas |
| `models/NotaDocenteDia.js` | Solo el comentario: ahora también escribe el Jefe de Taller |

## Criterios de aceptación de F1 (`tests/unit/jefeTaller.test.js`)

- **JT-01** `jefetaller` está en `ROLES`, aterriza en `/taller` y tiene nombre y color en
  todas las listas de roles. El barrido de `test:roles` no encuentra ningún lugar sin él.
- **JT-02** `sugerirTaller(nombre)` marca los nombres de D2 y no marca "Lengua", "Matemática"
  ni "Educación Tecnológica".
- **JT-03** El alcance son las materias con `esTaller` de la escuela: el modo `por-taller` de la
  jefatura. Una actividad de otra escuela, o de una materia sin la marca, no se ve en
  `/jefatura/actividades/:id` (la regla de alcance que ya tiene la jefatura).
- **JT-04** El Jefe de Taller no puede escribir en actividades, entregas, notas ni asistencia.
  Todos esos POST le dan 403. En `routes/taller.js` las únicas escrituras son la marca
  `esTaller` y la nota del día (D3).
- **JT-05** `/taller/materias` lo usan el admin y el Jefe de Taller. El preceptor y el docente
  reciben 403. Cada cambio se audita.
- **JT-06** El resumen del día usa `services/secretariaDia.js`: no hay una segunda versión de
  "tuvo clase".
- **JT-07** `/taller/jefes` lista solo a los `heads` de las Secciones de su escuela, y bajo cada
  uno, solo los MEP de las materias de taller de **sus** Secciones. Un MEP que está en dos
  Secciones aparece en las dos.
- **JT-08** `ventanaDelPeriodo`: día, semana de lunes a domingo y mes; anterior y siguiente;
  nada futuro; hora de Argentina; diciembre → enero.
- **JT-09** `resumenPorSeccion` suma los talleres de cada Sección (por división o sueltos),
  ordena lo último publicado y junta en "Talleres sin sección" lo que no está en ninguna.
- **JT-10** En todas las listas de roles, el Jefe de Taller va justo después del Directivo.

## Criterios de aceptación de F2 (`tests/unit/jefeTallerF2.test.js`)

- **JT-11** `diasHabiles(ventana, diasGrilla, hoy)`: solo los días de la grilla (o lunes a
  viernes sin grilla), dentro del período y nunca después de hoy.
- **JT-12** `matrizControl` arma una fila por MEP con una celda por día (estado, puntualidad,
  nota, si tenía clase) y los totales: días con clase, con actividad, solo ingreso, sin registro
  **contando solo los días con clase**, y llegadas tarde. Un MEP sin fila un día (no existía o
  no tenía materias) queda con la celda vacía, no "sin registro".
- **JT-13** `esRenglonDeTaller` acepta el renglón oficial cuya materia coincide con un taller de
  la división o cuyo nombre es de taller, y rechaza "Lengua" y "Matemática".
  `filtrarOficialTaller` devuelve una copia del oficial con solo esos renglones.
- **JT-14** La nota: escribe solo `jefetaller` (`ROLES_ANOTAN_TALLER`); usa `NotaDocenteDia`
  con la clave `{ school, docente, fecha }`; audita `taller.nota_guardar` / `taller.nota_borrar`;
  rechaza fechas futuras con `esFutura` y valida con `textoDeNota`.
- **JT-15** La ficha, la nota y el control resuelven el MEP con `docentesDelAlcance` sobre los
  talleres de la escuela, y un id fuera de eso da 404.
- **JT-16** La pantalla de horarios usa `compararCurso` y la tabla `_comparacion.ejs` de
  Secretaría; la tabla no enlaza a `/secretaria/oficial` cuando se le pasa `enlaceOficial: null`.

## Criterios de aceptación de F4 (`tests/unit/jefeTallerF4.test.js`)

- **JT-20** `armarPeriodos`: semana (el primero hasta el domingo, después lunes a domingo, el
  último corta en `hasta`), quincena, mes (meses calendario, cambio de año) y manual (fechas
  ordenadas, sin repetir, solo las que caen dentro). Tope de 60.
- **JT-21** `generarCalendario`: en el período *p*, el grupo *i* va a la estación *(i+p) mod m*.
  Con más grupos que estaciones y ninguna que admita varios, devuelve error; si una admite
  varios, lo permite.
- **JT-22** `validarCalendario` rechaza dos grupos en la misma estación en un período (salvo
  `admiteVarios`), grupos o estaciones que no existen, y una cantidad de períodos distinta.
- **JT-23** `validarGrupos`: un alumno en un solo grupo, solo alumnos de la división, 1 a 12
  grupos, nombres de 1 a 40 caracteres sin repetir.
- **JT-24** `queLeToca`: para el alumno, la estación de su grupo en el período que contiene hoy
  (o `null` si no está en un grupo o no hay período); para el MEP, los grupos que tiene su
  materia en ese período.
- **JT-25** Las rutas de F4 escriben solo `GruposTaller` y `RotacionTaller`, editan solo
  `jefetaller`, `admin` y `superadmin`, auditan cada cambio, y filtran todo por `school`.
  Las colecciones nuevas están en el backup.

## Plan de migración

- **F1:** campo nuevo `Course.esTaller` con default false. No cambia nada de lo existente
  hasta que alguien marca materias. El rol nuevo no tiene usuarios hasta que un admin cree uno.
- **F2:** sin cambios de base. Usa `NotaDocenteDia`, que ya existe.
- **F4:** dos colecciones nuevas (`grupostallers`, `rotaciontallers`), sin tocar datos
  existentes. Las materias sin rotación no muestran la franja.
