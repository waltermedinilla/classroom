# Jefe de Taller

> **Estado:** Walter cerró **P1 a P4** el 2026-11-22 (ver § Preguntas, ya resueltas). **Falta su
> "Comienza"** para arrancar F1.
> Flujo SDD: arquitecto → **spec aprobada** → tester → implementador → revisor.
> Se entrega por fases (F1 a F4). Cada fase se sube y se prueba por separado.

## Pedido

> "Puedes continuar con el rol de Jefe de Taller"

Respuestas de Walter (2026-11-22):

| Pregunta | Respuesta |
|---|---|
| ¿Qué hace? | **Supervisar los talleres**, **controlar a los MEP**, **gestionar el pañol** y **rotación de grupos**. Agregó: *"Puede revisar también qué subió cada jefe de Taller."* |
| ¿Qué le toca? | **Todos los talleres** de la escuela: un solo alcance, sin asignación por persona. |

## Contexto: lo que ya existe y se reutiliza

| Pieza | Qué es hoy | Para qué sirve acá |
|---|---|---|
| `Section` (`models/Section.js`) | Secciones de taller ("CONSTRUCCIONES 1"), con `divisions`, `courses` y `heads`, que son los **Jefes de Sección** | Ver P1 y P2 |
| Rol `jefe` y Docente jefe (`specs/docente-jefe-de-seccion.spec.md`) | Ve, sin tocar, las actividades de las materias de sus secciones (`/jefatura`) | La supervisión (F1) usa las mismas consultas con otro alcance |
| Panel Secretaría (`/secretaria`) | Docentes del día, ficha del docente, horario del curso y comparación con el oficial | El control de los MEP (F2) reutiliza los mismos servicios, filtrados a talleres |
| `HorarioOficial` (fase 4 de Secretaria) | El horario oficial importado, con docente por renglón | F2: los horarios oficiales de los talleres |
| Recursos y reservas (`Recurso`, `Reserva`) | Reserva de aulas y equipamiento **por módulo** | **No** alcanza para el pañol: no lleva stock, no presta a alumnos y no registra devoluciones. El pañol (F3) es un módulo nuevo y deja reservas como está |

## Decisiones de diseño

### D1 — Un rol nuevo: `jefetaller`, "Jefe de Taller"

- `ROLES` suma `'jefetaller'` entre `jefe` y `soe`.
- Al entrar, `GET /` lo lleva a **`/taller`**.
- Panel nuevo **`taller`** en `config/sections.js`, con sus secciones para que el admin pueda
  apagarlas (ver la tabla de F1 a F4). Directivo, admin y superadmin también ven el panel.
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

En F1 y F2 el Jefe de Taller **no escribe** actividades, entregas, notas ni asistencia: igual
que el Jefe de Sección. Sí puede anotar sobre un MEP (la nota del día, como la Secretaria).
Escribe solo en sus módulos propios: el pañol (F3) y la rotación (F4).

---

## F1 — Rol, materias de taller y supervisión

### Pantallas

| Ruta | Qué muestra |
|---|---|
| `GET /taller` | **Resumen del día**: materias de taller que tienen clase hoy según la grilla (`horarioClases`), si el MEP entró a la plataforma, si publicó algo esta semana, y la asistencia de la división ese día (presentes y ausentes del preceptor) |
| `GET /taller/actividades` | Las actividades de **todas** las materias de taller, de solo lectura, con los mismos filtros y paginación que `/jefatura` (`scopeCourseIds` = materias de taller) |
| `GET /taller/actividades/:id` | El detalle de una actividad, como `/jefatura/actividades/:id` |
| `GET /taller/jefes` | **Qué subió cada Jefe de Sección y cada MEP a su cargo** (P1). Una tarjeta por Jefe de Sección (`Section.heads`) con lo que publicó en el período (actividades, anuncios y materiales) y, adentro, sus MEP: los docentes de las materias de taller de sus Secciones, con lo que publicó cada uno. Se elige el período (semana, mes o fechas) |
| `GET /taller/jefes/:id` | El detalle de un Jefe de Sección o de un MEP: la lista de lo que subió, con enlace a cada actividad (de solo lectura) |
| `GET /taller/materias` | Marcar y desmarcar las materias de taller (D2). Lo usan el admin y el Jefe de Taller. Audita `taller.materias` |

### Reglas

- **RN-F1-1.** Todo lo de F1 se filtra por `school` y `esTaller: true`. Una materia de otra
  escuela o que no es de taller da 404, no 403, para no revelar que existe.
- **RN-F1-2.** Si la escuela no tiene ninguna materia de taller marcada, todas las pantallas
  muestran el aviso y un enlace a `/taller/materias`.
- **RN-F1-3.** El resumen del día usa la **misma** lógica de "tuvo clase / entró / publicó"
  que Docentes del día (`services/secretariaDia.js`). No se escribe una segunda versión.

---

## F2 — Control de los MEP

### Pantallas

| Ruta | Qué muestra |
|---|---|
| `GET /taller/docentes?dia=` | Docentes del día **solo de los MEP**: la misma vista y el mismo servicio que `/secretaria`, con los docentes limitados a los de materias de taller |
| `GET /taller/docentes/:id` | La ficha del MEP, igual a la de la Secretaria, con sus notas |
| `GET /taller/horario` | Los horarios de los talleres por curso, con el modo **Comparar** contra el horario oficial (fase 4 de Secretaria). Solo se muestran los renglones oficiales de materias de taller |

### Reglas

- **RN-F2-1.** Las notas del Jefe de Taller sobre un MEP se guardan en `NotaDocenteDia` con
  autor y rol. La Secretaria las ve y viceversa: es el mismo legajo del día.
- **RN-F2-2.** Para comparar se usa `services/secretariaHorarioOficial.js` tal cual. Un renglón
  oficial cuenta como de taller si su materia coincide (`coincideMateria`) con una materia de
  taller de esa división.

---

## F3 — Pañol

### Modelo nuevo

**`PanolItem`**: lo que hay en el pañol.

| Campo | Tipo | Notas |
|---|---|---|
| `school` | ObjectId | |
| `nombre` | String | Único por escuela |
| `tipo` | `'herramienta' \| 'maquina' \| 'insumo'` | Los insumos **se consumen**; herramientas y máquinas **se prestan y vuelven** |
| `seccion` | ObjectId (`Section`) o null | De qué taller es |
| `cantidad` | Number ≥ 0 | El stock total |
| `unidad` | String | 'u', 'm', 'kg'… |
| `minimo` | Number o null | Con el stock por debajo, se muestra el aviso "reponer" |
| `ubicacion`, `notas`, `codigo` | String | `codigo` es el número de inventario |
| `estado` | `'ok' \| 'reparacion' \| 'baja'` | En reparación o de baja no se presta |

**`PanolMovimiento`**: cada salida, devolución, consumo o ajuste. Funciona como libro diario:
**no se edita ni se borra**; un error se corrige con otro movimiento.

| Campo | Notas |
|---|---|
| `item`, `school`, `cantidad` | |
| `tipo` | `'prestamo' \| 'devolucion' \| 'consumo' \| 'ingreso' \| 'ajuste'` |
| `a` | A quién: un alumno (User), un docente (User) o una división entera |
| `prestamo` | En una devolución, el préstamo al que corresponde |
| `devolverAntes` | Fecha prevista de devolución (solo en préstamos) |
| `estadoAlVolver` | `'ok' \| 'danado' \| 'falta'` (solo en devoluciones) |
| `registradoPor`, `fecha`, `nota` | |

### Pantallas

| Ruta | Qué hace |
|---|---|
| `GET /taller/panol` | Inventario con stock disponible (total menos lo prestado), filtros por sección y tipo, y avisos de "reponer" y de "préstamos vencidos" |
| `POST /taller/panol/items` y `/items/:id` | Alta y edición de ítems |
| `POST /taller/panol/prestamos` | Registra una salida; puede llevar varios ítems a la misma persona |
| `POST /taller/panol/devoluciones` | Registra una vuelta, total o parcial, con el estado |
| `POST /taller/panol/consumos`, `/ingresos`, `/ajustes` | Insumos y correcciones |
| `GET /taller/panol/prestamos` | Lo que está afuera, quién lo tiene y desde cuándo |
| `GET /taller/panol/:id` | Historial del ítem |

### Reglas

- **RN-F3-1.** No se presta más de lo disponible. Se valida con una operación atómica sobre el
  disponible, como `SlotOcupacion` evita la doble reserva, para que dos préstamos simultáneos
  no dejen el stock negativo.
- **RN-F3-2.** Un ítem en reparación o de baja no se presta.
- **RN-F3-3.** Cada movimiento se audita (`taller.panol.*`).
- **RN-F3-4.** Registran el **Jefe de Taller** y el **Pañolero** (P3). El Pañolero es un rol
  nuevo, `panolero`, que **solo** entra al pañol: aterriza en `/taller/panol` y el resto del
  panel le da 403. Lo crea un admin o un superadmin, como cualquier usuario. Directivo y admin
  ven el pañol, pero no registran salvo que sean superadmin.

---

## F4 — Rotación de grupos

En los talleres, una división se parte en **grupos** que van pasando por las **estaciones**
(electricidad, carpintería, herrería…), cada una con su MEP, durante un período.

### Modelos nuevos

**`GrupoTaller`**: `school`, `division`, `nombre` ("Grupo A"), `alumnos[]` (User, rol
student, de esa división).

**`RotacionTaller`**: `school`, `division`, `nombre` ("1er cuatrimestre 2027"),
`estaciones[]`, `desde`, `hasta`, `cambiaCada` (ver P4) y `calendario`.
- Cada estación tiene `nombre`, `course` (la materia de taller), `meps[]` y `seccion`.
- El `calendario` es la lista de períodos; en cada uno, `{ grupo → estación }`.

### Pantallas

| Ruta | Qué hace |
|---|---|
| `GET/POST /taller/grupos/:divisionId` | Armar los grupos: repartir alumnos a mano o "en partes iguales" (al azar u ordenados por apellido) |
| `GET/POST /taller/rotaciones/...` | Crear la rotación. **"Generar"** arma el calendario circular (cada período, cada grupo pasa a la estación siguiente) y después se puede corregir a mano |
| `GET /taller/rotaciones/:id` | Grilla de períodos × grupos con la estación de cada uno; resalta el período actual |

### Reglas

- **RN-F4-1.** Un alumno está en un solo grupo por división.
- **RN-F4-2.** En el mismo período, dos grupos no pueden estar en la misma estación, salvo que
  la estación diga que admite más de uno.
- **RN-F4-3.** Lo ven también el MEP, en su materia ("esta semana tenés al Grupo B"), y el
  alumno, en su materia de taller ("esta semana: Electricidad, con Pérez"). Solo lo edita el
  Jefe de Taller.

---

## Preguntas (resueltas por Walter el 2026-11-22)

| | Respuesta | Qué cambia |
|---|---|---|
| **P1** "Qué subió cada jefe de Taller" | *"A los Jefes, y a los MEP que tiene a cargo."* | `/taller/jefes` muestra cada Jefe de Sección y, adentro, sus MEP, con lo que subió cada uno (F1). Hay un solo Jefe de Taller, el general |
| **P2** Cómo se reconoce un taller | **Marca y Secciones** | `Course.esTaller` para la materia; las Secciones agrupan por especialidad y las usa el pañol |
| **P3** Quién registra en el pañol | **Jefe de Taller y Pañolero** | Rol nuevo `panolero`, que solo entra al pañol (RN-F3-4). Entra en F3 |
| **P4** Cada cuánto rotan | **Se elige al crear la rotación** | `cambiaCada`: `'semana' \| 'quincena' \| 'mes' \| 'manual'` |

## Fuera de alcance

- Que el Jefe de Taller sea a la vez docente con el mismo usuario. Si hace falta, se resuelve
  como el Docente jefe, en otra spec.
- Las notas o calificaciones de taller: siguen en la materia, como cualquier otra.
- Compras o presupuesto del pañol.
- Asignar Jefes de Taller por especialidad: Walter eligió un alcance único.

## Lugares a tocar por el rol nuevo (F1)

Es la misma checklist que usó la Secretaria (`specs/secretaria-docentes-del-dia.spec.md`).

| Archivo | Qué |
|---|---|
| `models/User.js` | `ROLES` |
| `models/Course.js` | `esTaller` (Boolean, default false, con índice `{ school, esTaller }`) |
| `routes/superadmin.js`, `routes/auth.js` | listas de roles y lista blanca de autoregistro (no se autoregistra) |
| `server.js` | redirect de `GET /` y `res.locals.roleNames` |
| `config/sections.js` | panel `taller` y sus secciones; `app_courses` y `app_profile` |
| `config/audit-actions.js` | `taller.materias`, `taller.panol.*`, `taller.grupos`, `taller.rotacion` |
| (F3) todo lo anterior otra vez para `panolero` | rol, aterrizaje en `/taller/panol`, nombres y colores, `test:roles` |
| `middleware/auth.js` | `IngresoDiario` (que su ingreso también cuente) |
| `routes/admin.js` y vistas de usuarios | alta con el rol nuevo; nombre y color del rol |
| `views/superadmin/*` | listas y nombres de roles |
| `routes/backup.js` | las colecciones nuevas de F3 y F4 (`optional: true`) |
| `tests/roles/check-roles.js` | `ROLES` y `LANDING` |

Archivos nuevos en F1: `routes/taller.js`, `middleware/taller.js`, `services/tallerAlcance.js`,
`views/taller/*`, `views/partials/taller-nav.ejs`.

## Criterios de aceptación de F1 (`tests/unit/jefeTaller.test.js`)

- **JT-01** `jefetaller` está en `ROLES`, aterriza en `/taller` y tiene nombre y color en
  todas las listas de roles. El barrido de `test:roles` no encuentra ningún lugar sin él.
- **JT-02** `sugerirTaller(nombre)` marca los nombres de D2 y no marca "Lengua", "Matemática"
  ni "Educación Tecnológica".
- **JT-03** El alcance son las materias con `esTaller` de la escuela. Una de otra escuela, o
  una sin la marca, da 404 en `/taller/actividades/:id`.
- **JT-04** El Jefe de Taller no puede escribir en actividades, entregas, notas ni asistencia.
  Todos esos POST le dan 403.
- **JT-05** `/taller/materias` lo usan el admin y el Jefe de Taller. El preceptor y el docente
  reciben 403. Cada cambio se audita.
- **JT-06** El resumen del día usa `services/secretariaDia.js`: no hay una segunda versión de
  "tuvo clase".
- **JT-07** `/taller/jefes` lista solo a los `heads` de las Secciones de su escuela, y bajo cada
  uno, solo los MEP de las materias de taller de **sus** Secciones. Un MEP que está en dos
  Secciones aparece en las dos.

Los criterios de F2, F3 y F4 se escriben al empezar cada fase, con las respuestas de P1 a P4.

## Plan de migración

- **F1:** campo nuevo `Course.esTaller` con default false. No cambia nada de lo existente
  hasta que alguien marca materias. El rol nuevo no tiene usuarios hasta que un admin cree uno.
- **F3 y F4:** colecciones nuevas, sin tocar datos existentes.
