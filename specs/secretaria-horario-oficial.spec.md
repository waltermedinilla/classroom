# Secretaria — comparar con el horario oficial (fase 4 de "Docentes del día")

> **Estado:** APROBADA por Walter el 2026-11-22. Respondió dos preguntas:
> **"Solo comparar"** y **"Docentes: por similitud y aviso"**.
> Extiende `specs/secretaria-horario-del-curso.spec.md` (D5 dejó lista la forma de la grilla
> para esta comparación).

## Problema

Walter pasó **39 capturas** de los horarios de la plataforma oficial, una por curso y
división, en la carpeta `Cursos`. Cada captura tiene curso, división, turno, carrera y, por
módulo y día, el horario, la materia y el docente. Quiere usarlas para **terminar el rol de
Secretaria**: que la secretaría pueda **controlar** lo cargado en la plataforma contra el
horario oficial.

## Decisiones de Walter (2026-11-22)

| Pregunta | Respuesta |
|---|---|
| ¿Qué hace la plataforma con los datos? | **Solo comparar.** No carga horarios, ni crea materias, ni crea docentes. La secretaria corrige a mano desde la grilla. |
| Docente con otro nombre o que no existe | **Por similitud y aviso.** Coincide sin importar mayúsculas ni acentos; si es parecido, se marca para confirmar; si no aparece, va a una lista. |

## Alcance

1. **Transcripción** de las 39 capturas a un JSON (`tipo: "horario-oficial"`), revisado imagen
   por imagen.
2. **Importar** ese JSON a la escuela: `GET/POST /secretaria/oficial`, solo para quien puede
   cargar horarios (secretaria, admin y superadmin).
3. **Comparar** en "Horario del curso", con un modo nuevo `?modo=comparar`.
4. **Resumen de la escuela** en `/secretaria/oficial`: cada curso del horario oficial con su
   división en la plataforma y su cantidad de diferencias.

### Fuera de alcance

- Cargar o corregir horarios automáticamente (decisión de Walter).
- Crear materias, cursos o cuentas de docentes.
- Leer las imágenes desde la plataforma: la transcripción es un paso aparte, hecho una vez.

## Decisiones de diseño

### D1 — Los datos van a la base, no al repositorio

El horario oficial tiene **nombres reales de docentes**. Por eso no se guarda en el código: se
importa a una colección nueva, `HorarioOficial`, con un documento por curso y división de la
escuela. Importar de nuevo **reemplaza** todo el horario oficial de la escuela (es una foto del
otro sistema, no una historia).

### D2 — Curso y división se emparejan por los números

Una captura dice "Curso 1°, División 01°". La división de la plataforma se busca por **los dos
primeros números de su nombre** ("1° 1°", "1°1", "1ro 1ra" valen todos [1, 1]). Si ninguna
división de la escuela coincide, el curso queda como **"sin división en la plataforma"** en el
resumen. No se compara, pero no se pierde.

### D3 — La comparación es por HORA, no por número de módulo

La "Hora" de la captura no coincide con el módulo de la plataforma: el mismo módulo cambia de
horario según el día (Ju 5 = 09:50 en 1° 3°), y los talleres ocupan bloques largos
(13:45-17:45). Por eso, cada renglón oficial (día, desde, hasta) se cruza con **los módulos de
la grilla de la escuela que se superponen con ese horario** ese día, en cualquier turno.

- Una superposición vale si cubre **al menos la mitad del módulo**. Así 08:25-09:10 cae en
  08:25-09:05 y no en el módulo siguiente.
- Si un renglón no se superpone con ningún módulo (por ejemplo, Educación Física de 08:00 a
  10:00 en un curso de la tarde), queda como `sinModulo`. Es informativo, no es una diferencia.

### D4 — Estados de cada renglón oficial

| Estado | Cuándo | Color |
|---|---|---|
| `coincide` | En esos módulos la plataforma tiene la misma materia (D5) con el mismo docente (D6) | verde |
| `docenteParecido` | Misma materia, y el docente es parecido (D6): hay que confirmar | ámbar |
| `otroDocente` | Misma materia, con otro docente | naranja |
| `otraMateria` | En esos módulos hay otra materia | naranja |
| `falta` | En esos módulos no hay nada cargado | rojo claro |
| `sinModulo` | D3 | gris |
| `sinMateria` | El renglón oficial no tiene materia (bloque de horas "oblig." sin nombre) | gris |

Además, cada clase de la plataforma que no cae en ningún renglón oficial de ese día es
**`sobra`** ("en la plataforma, no en el oficial").

Un renglón que cubre varios módulos toma el **peor** estado de sus módulos, en este orden:
falta → otraMateria → otroDocente → docenteParecido → coincide.

### D5 — Materia: mismo nombre normalizado o contenido

Se normaliza el nombre (minúsculas, sin acentos, sin signos). Además, se quita el prefijo
"ciencias sociales:" y el "- inglés" de "Lengua Extranjera - Inglés".

Hay coincidencia cuando los nombres normalizados son iguales, o cuando uno contiene al otro
palabra por palabra ("Geografía" ↔ "Ciencias Sociales: Geografía").

### D6 — Docente: por similitud, con aviso

Se normaliza el nombre (mayúsculas, sin acentos) y se separa en palabras. La primera palabra
del oficial es el **apellido**.

- **Exacto:** las mismas palabras, en cualquier orden.
- **Parecido:** el apellido está en el nombre de la plataforma y comparte al menos otra
  palabra, o todas las palabras de uno están en el otro. Por ejemplo, "Muñoz Cintia" ↔
  "MUÑOZ CINTIA BEATRIZ". Se muestra en ámbar con "¿es la misma persona?".
- **Sin coincidencia:** nada de lo anterior.
- **Nunca alcanza con el nombre de pila.** Hay muchos "MARIA LAURA" y "MARIA BELEN" de
  apellidos distintos en el oficial.

El resumen de la escuela lista los **docentes del oficial que no están en la plataforma** (sin
coincidencia con ningún usuario docente de la escuela) y los **parecidos**, con el nombre de
la plataforma al lado.

### D7 — Alcance de la secretaria

La comparación del curso respeta el alcance, como toda la pantalla. El resumen de la escuela
muestra solo los cursos de su alcance; para admin y superadmin, todos.

## Pantallas

### `GET /secretaria/oficial`

- Para quien puede cargar horarios, un cuadro para **importar el JSON**: se elige el archivo y
  se manda.
- Para todos, la fecha de la última importación y una tabla con una fila por curso oficial:
  curso, turno, carrera, división de la plataforma (o "sin división"), renglones, coincidencias
  y diferencias, y un enlace a la comparación.
- Las dos listas de docentes de D6.

### `POST /secretaria/oficial` (JSON en el cuerpo)

- Valida el documento (`validarDocumento`) y reemplaza el horario oficial de la escuela.
- Audita `secretaria.oficial.importar` con la cantidad de cursos y renglones.
- Con errores, no toca nada y los devuelve todos juntos ("Curso 2° 05°, renglón 12: falta el
  horario").

### `GET /secretaria/curso?curso=<id>&modo=comparar`

Debajo de la grilla, una tabla por día con los renglones oficiales del curso (horario, materia,
docente oficial, lo que tiene la plataforma y el estado), y al final los renglones que sobran.
Si ese curso no tiene horario oficial importado, lo dice y enlaza a `/secretaria/oficial`.

## Criterios de aceptación (`tests/unit/secretariaHorarioOficial.test.js`)

- **HO-01** `validarDocumento` acepta el JSON transcripto real (39 cursos) y rechaza: otro
  `tipo`, un día fuera de 1..6, una hora mal escrita, o desde ≥ hasta.
- **HO-02** `numerosDeDivision`: "1° 1°", "1°1", "1ro 1ra", "1° 01°" → [1, 1]; un nombre sin
  dos números no empareja.
- **HO-03** `coincideDocente`: exacto sin importar acentos ni orden; "Muñoz Cintia" ↔ "MUÑOZ
  CINTIA BEATRIZ" es parecido; "NAVARRO MARIA LAURA" ↔ "VASQUEZ MARIA LAURA" no coincide.
- **HO-04** `coincideMateria`: "Ciencias Sociales: Geografía" ↔ "Geografía" y "Lengua
  Extranjera - Inglés" ↔ "Lengua Extranjera" coinciden; "Lengua" ↔ "Lengua Extranjera" no.
- **HO-05** `modulosQueCubre`: 08:25-09:10 cae en un solo módulo; 13:45-17:45 en todos los de
  la tarde de ese horario; 08:00-10:00 en un curso sin módulos a esa hora da vacío.
- **HO-06** `compararCurso` da cada estado de D4 con una grilla chica armada a mano, incluidos
  `sobra` y el peor estado de un bloque largo.
- **HO-07** Las vistas escapan todo lo que sale del JSON (nombres, materias, carrera).
- **HO-08** Solo secretaria, admin y superadmin pueden importar; directivo, no.

## Errores posibles

- JSON con un error de transcripción: el validador lo marca con curso y renglón.
- Una división de la plataforma con otro número: queda "sin división" y se ve en el resumen.
- Nombres de materias muy distintos entre los dos sistemas: se ven como `otraMateria`. Se
  pueden corregir en la plataforma, o se puede ampliar la normalización de D5.

## Plan de migración

Colección nueva `HorarioOficial`, con índice único `{school, curso, division}`. No toca datos
existentes.
