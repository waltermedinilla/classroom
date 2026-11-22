# Secretaria — horario del curso (fase 3 de "Docentes del día")

> **Estado:** APROBADA por Walter el 2026-11-22, con las tres propuestas de las preguntas abiertas.
> Extiende `specs/secretaria-docentes-del-dia.spec.md` y `specs/secretaria-puntualidad.spec.md`.
> Base: rama `feat/secretaria` (tres commits, todavía sin push; `origin/main` sigue en v1.0.112).

## Problema

Walter mostró la pantalla de horario de otro sistema: **por curso**, módulos en filas, días en
columnas y, en cada celda, el horario del módulo, la materia y el docente. Quiere algo así en
el panel de la Secretaria para **ver, controlar y cargar** el horario.

Hoy el horario se carga **materia por materia** (`/secretaria/horario`): para armar la semana
de un curso hay que abrir cada una de sus materias. La secretaría piensa el horario al revés:
"en 1° 1° el lunes a 1ª hora va Ciencias Naturales".

## Decisiones de Walter (2026-11-22)

| Pregunta | Respuesta |
|---|---|
| ¿Ver, controlar, cargar? | **Las tres**: ver la grilla, controlar con la puntualidad y cargar desde la grilla |
| Datos reales | Más adelante va a pasar los horarios de todos los cursos (capturas y datos) para cargarlos y **compararlos** con lo cargado. Esta fase no los incluye, pero el diseño tiene que dejar fácil esa comparación (D5) |
| ¿Grilla por docente? | **No** |

## Alcance

1. Solapa nueva **"Horario del curso"** (`/secretaria/curso`) en el panel de la Secretaria.
2. Grilla de la semana de un curso y un turno, como la del otro sistema.
3. **Modo control**: elegido un día, cada celda se colorea con la puntualidad del docente en esa clase.
4. **Modo carga**: tocar una celda y elegir qué materia del curso va ahí (o dejarla vacía).
5. **Avisos de choques**: un docente en dos cursos a la misma hora, o dos materias en la misma celda.

### Fuera de alcance

- Grilla por docente (decisión de Walter).
- Importar el horario desde la otra plataforma o desde Excel, y la comparación con esos datos:
  fase siguiente, cuando Walter pase los datos (D5 deja el terreno listo).
- Cambiar la grilla de módulos de la escuela (eso sigue en Recursos → Horario, del admin).

## Decisiones de diseño

### D1 — No hay datos nuevos: es otra forma de ver `Course.horarioClases`

La grilla del curso se arma con las materias del curso (`Course.division`) y su
`horarioClases` (fase 2). Cargar desde la grilla **escribe en el mismo campo**, así que la
solapa "Horario de materias" y la nueva muestran siempre lo mismo. No se agrega colección ni
campo.

### D2 — Una celda, una materia (con aviso, no con bloqueo)

Lo normal es una materia por celda. Pero hay casos reales de dos (talleres por grupos, dos
docentes de Educación Artística A y B en paralelo). Por eso:

- Desde la grilla, **elegir una materia para una celda reemplaza** lo que había en esa celda
  para ese curso (se quita de la otra materia y se pone en la nueva). Es lo que espera la
  secretaría cuando corrige.
- Si por la solapa "Horario de materias" alguien dejó dos materias en la misma celda, la grilla
  **las muestra a las dos** con un aviso ámbar "dos materias en este módulo". No se borra nada solo.

### D3 — El control por clase y su límite

Elegido un día (por defecto, hoy), cada celda de ese día muestra el estado de **esa clase**:

| Estado | Cuándo | Color de la celda |
|---|---|---|
| `aTiempo` | Hay llegada hasta 10 min después del inicio del módulo | verde |
| `tarde` | La llegada fue más de 10 min después | naranja |
| `sinDato` | No se puede medir esa clase (ver abajo) | sin color |
| `futura` | El módulo todavía no empezó | sin color, gris claro |

Qué cuenta como **llegada a esa clase**:

- **Primera clase del día del docente** (entre todos sus cursos): lo mismo que la fase 2, lo
  primero entre entrar a la plataforma y entrar a una sala en vivo.
- **Clases siguientes**: **solo la sala en vivo de esa materia**, con entrada desde 30 min antes
  del inicio del módulo hasta su fin. El ingreso a la plataforma se registra una vez por día y
  no dice nada de la clase de las 11:00. Si no entró a la sala de esa materia, la celda queda
  `sinDato`, **nunca naranja ni roja**.

El texto de la celda siempre acompaña al color ("Llegó 08:05", "Sala 11:02") y la ayuda de la
pantalla explica el límite. Igual que en las fases anteriores: ningún texto dice "faltó".

Se reutiliza `services/secretariaPuntualidad.js`: la primera clase sale de `puntualidad()`
tal como está, y se agrega una función pura `puntualidadDeClase()` para las siguientes.

### D4 — Alcance

- La secretaria ve en el selector **solo los cursos de su alcance** (`loadPreceptorScope`,
  como todo el panel). Un `?curso=` fuera de alcance → se ignora y se muestra el primero.
- El aviso de choque de un docente (D6) mira **todas** las materias del docente en la escuela,
  también las de cursos fuera del alcance, porque el choque es real igual. Pero del otro curso
  muestra solo "tiene clase en otro curso a esta hora", **sin nombre del curso ni de la materia**
  si ese curso está fuera de su alcance.

### D5 — Pensado para la comparación de la fase siguiente

La grilla se arma con una función pura `grillaDelCurso({ grilla, materias, docentes })` que
devuelve `celdas[turno][orden][dia] = [{ materiaId, materia, docentes: [nombre] }]`. Cuando
Walter pase los horarios de la otra plataforma, se los convierte a esa misma forma y la
comparación es celda contra celda (`compararGrillas(a, b)` → celdas iguales, distintas,
faltantes). Esta fase **solo** deja la forma definida; la comparación no se implementa.

Por la misma razón, la grilla muestra lo que muestra el otro sistema y en el mismo orden:
horario del módulo, materia y docente en mayúsculas sostenidas.

### D6 — Choques

- **Docente en dos lugares**: el mismo docente (titular o co-docente) con dos clases en el mismo
  día, turno y módulo, en materias distintas. Aviso ámbar en la celda.
- **Dos materias en la celda** (D2). Aviso ámbar.
- Los avisos **no impiden guardar**: la secretaría puede estar a mitad de una corrección.

## Reglas de negocio

- **RH-01** — La grilla tiene una fila por módulo **de clase** del turno elegido (los recreos no
  se muestran) y una columna por día de `Horario.dias`.
- **RH-02** — Escribir una celda (`POST /secretaria/curso/:divisionId/celda`, body
  `{ dia, turno, orden, courseId | null }`):
  - valida la celda contra la grilla (mismo criterio que RP-01);
  - valida que `courseId` sea una materia **de ese curso**;
  - quita esa celda de todas las demás materias del curso y la agrega a la elegida (D2);
  - con `courseId: null`, vacía la celda;
  - todo en un solo `bulkWrite` sobre las materias del curso; audita `course.horario_clases`
    por cada materia que cambió.
- **RH-03** — Solo cargan `ROLES_QUE_CARGAN_HORARIO` (secretaria, admin, superadmin). El
  directivo ve la grilla y el control pero no carga, igual que en la fase 2.
- **RH-04** — El día de control acepta fechas pasadas y hoy; futura o mal formada → hoy (RN-09).
  La grilla muestra la semana, y el control pinta solo la columna del día elegido.
- **RH-05** — `puntualidadDeClase({ clase, fecha, presencias, esPrimera, llegadaDelDia, ahora })`
  pura: sala en vivo de esa materia con `firstSeenAt` en `[inicio − 30 min, fin]`.
- **RH-06** — Las horas se comparan en minutos del día con `live.hora` (como la fase 2), nunca
  armando un Date con "fecha + HH:MM".

## Pantallas

### `GET /secretaria/curso?curso=<divisionId>&turno=<id>&fecha=YYYY-MM-DD&modo=ver|cargar`

- Arriba: selector de **curso** (de su alcance), **turno** (los de la grilla), **día de control**
  con flechas y "Hoy", y el botón **Ver / Cargar** (Cargar solo si puede).
- La grilla: primera columna "Hora" con el número de módulo; en cada celda, el horario del módulo,
  la materia y el docente, como en el otro sistema. La columna del día de control resaltada.
- **Modo ver**: la columna del día lleva los colores de D3 y el texto chico ("Llegó 08:05",
  "Sala 11:02", "Sin dato de esta clase").
- **Modo cargar**: tocar una celda abre un selector con las materias del curso y "Vacío".
  Guarda al elegir; la celda se actualiza sin recargar. Los avisos de choque aparecen al momento.
- Sin grilla de la escuela: el mismo aviso que la fase 2.
- En celular: la grilla se desplaza en horizontal con la columna "Hora" fija.

### Navegación

`views/partials/secretaria-nav.ejs` suma "Horario del curso". En `config/sections.js`, sección
`secretaria_curso`, roles `['secretaria', 'directivo', 'admin', 'superadmin']`.

## Criterios de aceptación

### Unitarios (`tests/unit/secretariaHorarioCurso.test.js`)

- **CH-01** `grillaDelCurso` arma una celda por materia en su día y módulo, con sus docentes.
- **CH-02** Dos materias en la misma celda → la celda trae las dos y la marca `doble`.
- **CH-03** Una entrada con módulo que ya no existe en la grilla no aparece (RP-03).
- **CH-04** `choques`: el mismo docente en otra materia, mismo día, turno y módulo → choque;
  en otro módulo → no.
- **CH-05** El choque con un curso fuera del alcance no expone curso ni materia (D4).
- **CH-06** `puntualidadDeClase` primera clase: usa la llegada del día (fase 2).
- **CH-07** Clase siguiente con sala de esa materia a los 5 min → `aTiempo`; a los 15 → `tarde`.
- **CH-08** Clase siguiente sin sala de esa materia, aunque haya ingresado a la plataforma → `sinDato`.
- **CH-09** Sala de **otra** materia a la misma hora → no cuenta (`sinDato`).
- **CH-10** Sala 40 min antes del inicio → no cuenta; 25 min antes → cuenta como `aTiempo`.
- **CH-11** Módulo que todavía no empezó (con `ahora`) → `futura`.
- **CH-12** `aplicarCelda`: reemplaza la celda en la materia anterior y la pone en la nueva; con
  `null` la vacía; no toca las demás celdas.
- **CH-13** Ningún texto dice "faltó".

### Smoke

- **CH-14** La secretaria ve `/secretaria/curso` de su curso; un `?curso=` ajeno no muestra ese curso.
- **CH-15** Cargar una celda con una materia del curso → 200 y aparece en `/secretaria/horario`
  (el mismo dato, D1). Con una materia de otro curso → 400. Módulo inexistente → 400.
- **CH-16** El directivo ve la grilla y recibe 403 al cargar; preceptor y docente, 403 en todo.

## Errores posibles

| Caso | Respuesta |
|---|---|
| Curso fuera del alcance al cargar | 403 |
| Materia que no es de ese curso | 400 "Esa materia no es de este curso" |
| Módulo o día fuera de la grilla | 400 (mismo texto que la fase 2) |
| Escuela sin grilla | Aviso en pantalla; cargar responde 400 |

## Dependencias y riesgos

- Depende de la fase 2 (`Course.horarioClases`), que todavía no está en producción: las tres
  fases se suben juntas.
- **El color por clase vale solo para la primera clase del día y para las clases con sala en
  vivo** (D3). Se dice en la ayuda; es una limitación del dato, no del diseño.
- El cálculo de choques necesita las materias de **todos** los docentes del curso en la escuela:
  una consulta extra por pantalla, acotada a esos docentes.

## Plan de migración

Nada: no hay campos, colecciones ni índices nuevos.

## Preguntas abiertas

1. **Ventana de la sala para las clases siguientes:** propongo desde 30 min antes del inicio
   hasta el fin del módulo. ¿Te parece bien?
2. **Docente en mayúsculas** como en el otro sistema, o como está cargado en la plataforma
   ("Pérez Silvia"). Propongo mayúsculas en la grilla, para que comparar con las capturas sea más fácil.
3. **¿Una celda puede tener dos materias desde la grilla?** Propongo que desde la grilla no (se
   reemplaza), y que si hace falta, se cargue desde "Horario de materias", con el aviso ámbar.

## Ajustes durante la implementación (2026-11-22)

- **Modo cargar:** al elegir la materia, la página se recarga (manteniendo el scroll) en vez de
  actualizar la celda en el lugar. Así la celda, los avisos de choque y la otra pantalla quedan
  siempre iguales, sin duplicar la lógica de la grilla en el navegador.
- **Llegada del día:** para la primera clase, cuenta la entrada a **cualquier** sala del docente
  ese día (no solo las del alcance), porque es su llegada a la plataforma, igual que el ingreso.
- **Varios docentes en una celda:** cada docente lleva su propio estado; el color de la celda es
  el mejor de ellos (`mejorEstado`).
- **CH-16 en smoke:** el directivo de la suite se borra antes de estos specs, así que su 403 al
  cargar se verificó con el arnés de rutas, no con smoke. En smoke quedan preceptor y docente.

