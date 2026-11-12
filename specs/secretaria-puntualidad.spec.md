# Secretaria — puntualidad del docente (fase 2 de "Docentes del día")

> **Estado:** APROBADA por Walter el 2026-11-11 ("está excelente"). Las preguntas abiertas se
> resolvieron con las propuestas del arquitecto (ver el final).
> Extiende `specs/secretaria-docentes-del-dia.spec.md`. Base: rama `feat/secretaria`
> (rol Secretaria + horas debajo de cada columna), todavía sin push.

## Problema

En "Docentes del día", Walter quiere que cada fila se marque con un **contorno de color**
según si el docente llegó a tiempo o tarde. Para eso la plataforma tiene que saber **a qué
hora tenía que llegar**, y hoy no lo sabe: el horario de clases de cada materia no existe
(lo dice `models/Horario.js`, y la spec de la fase 1 lo dejó fuera de alcance a propósito).

## Decisiones de Walter (2026-11-11)

| Pregunta | Respuesta |
|---|---|
| ¿Contra qué hora se compara? | **El horario de cada materia**: qué día y en qué módulo se da, sobre la grilla de módulos que ya existe |
| ¿Qué cuenta como "ingresó"? | **Cualquiera de las dos**: entrar a la plataforma o entrar a la sala en vivo, la que ocurra primero |
| Sin ningún registro un día con clase | **Sin color** |
| Tolerancia | **10 minutos** |

## Alcance

1. **Horario de clases por materia**: cada materia guarda en qué días y en qué módulos de la
   grilla de la escuela se dicta.
2. **Una pantalla para cargarlo** (ver pregunta abierta 1 sobre quién lo carga).
3. **Puntualidad del día por docente** y el contorno de color de su fila en la vista Lista, y
   el mismo color en la Línea del día.
4. En la Línea del día, **el inicio de cada clase** como marca de fondo, así se ve la distancia
   entre "le tocaba" y "llegó".

### Fuera de alcance

- Puntualidad **por clase** (la de 8:00, la de 11:00…). Ver D2: con los datos que hay, solo
  se puede medir con justicia la **primera** clase del día.
- Rojo / "faltó": por decisión de Walter, sin registro = sin color.
- Licencias, feriados, paros y jornadas: no se cargan. No hace falta, porque un día sin
  registro queda sin color.

## Decisiones de diseño

### D1 — El horario se guarda en la materia, sobre la grilla existente

`Course.horarioClases: [{ dia, turno, orden }]`

- `dia`: 1 = lunes … 6 = sábado, igual que `Horario.dias`.
- `turno` + `orden`: identifican una franja **de clase** de la grilla de la escuela, igual que
  hace `Reserva` (`turno` es el id estable del turno; `orden` es "3ª hora").
- Un bloque de varias horas seguidas se guarda como varias entradas (2ª y 3ª hora).
- **La hora de inicio NO se copia** a la materia: se lee de la grilla al momento de evaluar.
  Si el administrativo corre la 1ª hora de 7:30 a 7:40, todas las materias se actualizan solas.
- Si la escuela no tiene grilla cargada (`Horario` vacío), la pantalla de carga avisa y
  manda a cargarla primero. La puntualidad queda sin color, sin romper nada.

### D2 — Se mide la llegada del día contra la primera clase del día

- **Le tocaba** = el inicio de la **primera** franja del día entre todas sus materias del
  alcance que tienen clase ese día de la semana.
- **Llegó** = lo primero que haya ocurrido de:
  - su primer ingreso a la plataforma del día (`IngresoDiario.primeraVez`);
  - su primera entrada a una sala en vivo de una materia del alcance (`RoomPresence.firstSeenAt`).
- **Por qué solo la primera clase**: el ingreso a la plataforma se registra **una vez por
  día**. Si a las 7:30 entró para la 1ª hora, no hay forma de saber si "llegó" a la de las
  15:00. Evaluar las clases siguientes con ese dato las daría todas por puntuales. Es una
  limitación del dato, y se dice en la ayuda de la pantalla.

### D3 — Los colores (con la tolerancia elegida)

| Situación | Contorno | Texto chico debajo del nombre |
|---|---|---|
| No tiene clase ese día (o su materia no tiene horario cargado) | sin color | — |
| Tiene clase y **no hay ningún registro** | sin color | "Sin registro en su horario" |
| Llegó **antes** o hasta **10 min** después del inicio | **verde** | "Llegó 07:42 · a tiempo" |
| Llegó **más de 10 min** después | **naranja fuerte** | "Llegó 07:55 · 15 min tarde" |

- El color **nunca va solo**: siempre lo acompaña el texto, para quien no distingue colores
  y para que quede claro qué se midió.
- El texto dice lo que se ve en la plataforma ("llegó 07:55"), no un juicio.
- Con tolerancia de 10 minutos **no queda un "naranja suave"**: ver pregunta abierta 3.

### D4 — "Contorno de la fila"

Una línea de color de 2 px alrededor de la fila (por `box-shadow` en las celdas, porque el
`border` de un `<tr>` no se dibuja igual en todos los navegadores). En celular, donde la
tabla se desplaza, va además una barra de color a la izquierda del nombre.

## Modelo

### `Course` (campo nuevo, sin migración)

```js
horarioClases: {
  type: [{
    dia:    { type: Number, min: 1, max: 6, required: true },
    turno:  { type: String, required: true },
    orden:  { type: Number, required: true },
  }],
  default: [],
}
```

Las materias existentes quedan con `[]` = sin horario = sin color. No hay que tocar ningún
documento.

## Reglas de negocio

- **RP-01** — Una entrada de `horarioClases` solo se guarda si en la grilla de la escuela
  existe ese turno con una franja `tipo: 'clase'` de ese `orden`, y si `dia` está en
  `Horario.dias`. Si no, 400 con el motivo.
- **RP-02** — Sin duplicados (mismo día, turno y orden).
- **RP-03** — Si el administrativo **borra una franja** de la grilla, las materias que la
  usaban no se rompen: esa entrada se ignora al evaluar y la pantalla de carga la marca como
  "módulo que ya no existe".
- **RP-04** — La evaluación es una función pura: `puntualidad({ fecha, materias, grilla,
  ingreso, presencias, tolerancia })` → `{ estado: 'sinClase' | 'sinRegistro' | 'aTiempo' |
  'tarde', leTocaba, llego, minutos }`. Toda la zona horaria sale de `services/liveRoom.js`
  (`diaEscolar`, `hora`), como en la fase 1.
- **RP-05** — `minutos` = diferencia entera entre `llego` y `leTocaba`, en hora de la escuela.
  `aTiempo` si `minutos ≤ tolerancia` (incluye llegar antes). `tarde` si `minutos > tolerancia`.
- **RP-06** — Tolerancia: constante `TOLERANCIA_MIN = 10` en el servicio. No es configurable
  desde la pantalla en esta fase.
- **RP-07** — Días anteriores al registro de ingresos (RN-07 de la fase 1): la llegada sale
  solo de la sala en vivo.
- **RP-08** — Un docente con materias en dos turnos se evalúa solo por la primera clase del
  día (D2).

## Pantallas

### Carga del horario

Ver pregunta abierta 1. Propuesta: en la ficha de cada materia del admin, una grilla de
**días × módulos** con casillas, armada con la grilla de la escuela. Marcás "lunes 1ª y 2ª,
jueves 3ª" y guardás.

### "Docentes del día" (Lista)

- El contorno de color de la fila (D3, D4).
- Debajo del estado, el texto de puntualidad: "Llegó 07:42 · a tiempo" o "Llegó 07:55 · 15 min tarde",
  y la primera clase del día ("Le tocaba 1ª hora, 07:30").
- Un cuarto contador en el resumen: "Llegaron tarde".

### Línea del día y ficha del docente

- La fila lleva el mismo color.
- El inicio de cada clase del docente ese día se dibuja como una franja de fondo con su
  nombre de módulo, así se ve la distancia entre "le tocaba" y "llegó".

## Criterios de aceptación (unitarios, `tests/unit/secretariaPuntualidad.test.js`)

- **CP-01** Sin materias con clase ese día de la semana → `sinClase`.
- **CP-02** Con clase y sin ingreso ni sala → `sinRegistro`.
- **CP-03** Llegó 10 minutos antes → `aTiempo`, `minutos` negativo.
- **CP-04** Llegó justo 10 minutos después → `aTiempo` (el límite es inclusivo).
- **CP-05** Llegó 11 minutos después → `tarde`.
- **CP-06** Ingresó a la plataforma 08:00 y a la sala 07:35, clase 07:30 → cuenta la sala
  (lo primero que pasó) → `aTiempo`.
- **CP-07** Dos materias el mismo día, 1ª hora 07:30 y 4ª hora 09:50 → se compara contra 07:30.
- **CP-08** Una entrada que apunta a una franja borrada de la grilla se ignora (RP-03).
- **CP-09** Zona horaria: una llegada a las 23:30 UTC del día anterior no es "llegó a tiempo"
  al día siguiente.
- **CP-10** Día anterior al registro de ingresos: solo cuenta la sala (RP-07).
- **CP-11** Un docente sin horario cargado en ninguna materia → `sinClase`, nunca `sinRegistro`.

Más smoke: cargar el horario de una materia, ver el contorno en la lista y que una franja
inexistente dé 400.

## Errores posibles

| Caso | Respuesta |
|---|---|
| Franja que no existe en la grilla | 400 "Ese módulo no existe en el horario de la escuela" |
| Escuela sin grilla | La pantalla de carga avisa y enlaza a /admin/recursos/horario |
| Día fuera de `Horario.dias` | 400 |

## Dependencias y riesgos

- **La grilla de módulos** (`/admin/recursos/horario`) tiene que estar cargada. Hoy solo la
  usa el módulo de reservas de recursos; si la escuela no lo usa, puede estar vacía.
- **Cargar el horario de 595 materias a mano es mucho.** Ver pregunta abierta 2.
- Sigue valiendo D2 de la fase 1: el color mide la plataforma, no la presencia física. Un
  docente que llegó a horario al aula pero abrió la plataforma a media mañana sale en naranja.
  Por eso el texto dice "llegó 10:05" y no "llegó tarde a la escuela".

## Plan de migración

Aditivo: un campo nuevo en `Course` con default `[]`. Ningún índice nuevo. Ningún documento
existente se modifica.

## Preguntas abiertas — resueltas al aprobar (2026-11-11)

1. **Quién carga:** la secretaria (solo las materias de sus cursos), el admin y el superadmin.
   El directivo ve la pantalla pero no edita.
2. **Cómo:** en pantalla, solapa nueva **"Horario de materias"** (`/secretaria/horario`), una
   grilla de días × módulos por materia. Importar desde Excel queda para una fase siguiente.
3. **Sin naranja suave:** verde hasta 10 minutos, naranja fuerte desde 11.
4. **Días:** los de `Horario.dias` de la escuela (hoy, lunes a viernes).
