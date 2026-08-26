# Recursos y Reservas

Estado: **implementada** (2026-08-25) · Módulo: `recursos` · Primer módulo OPCIONAL por escuela

## Problema

La escuela tiene una sala de computación con 20 máquinas, un carro de 30 netbooks Novatech, un
laboratorio, un salón de actos. Hoy la plataforma no sabe que existen: el aula es un **texto
libre** (`Course.room`, `models/Course.js:11`) y el docente descubre que la sala está ocupada
empujando la puerta.

Y no todo docente puede usar cualquier recurso: entrar al laboratorio o llevarse el carro de
netbooks es algo que el personal administrativo autoriza.

## Alcance

1. **Horario escolar** por escuela, cargado por el administrativo: turnos y franjas.
2. **Recursos** con capacidad, y la distinción entre reservarlos **enteros** o **repartidos**.
3. **Calendario semanal** por recurso, consultable por quien da clase.
4. **Pedido** del docente — puntual, semanal o cada 15 días.
5. **Resolución** del administrativo, que puede editar la cantidad otorgada y dejar al docente
   autorizado para las próximas.
6. Cancelación (individual o de toda la serie) y "mis reservas".

### Fuera de alcance (decidido, no olvidado)

- **Calendario de feriados.** La expansión semanal crea reservas en feriados y actos; se cancelan
  a mano. Un calendario escolar de verdad es una feature aparte, y la piden también las
  actividades y la asistencia.
- **Unificar `Course.room`** (texto libre) con los recursos nuevos. Es la convergencia natural,
  pero tocar `Course` arrastra medio sistema.
- **Préstamo con devolución** (llaves, notebooks que salen del edificio).
- **Reserva por rango libre de horario** ("de 9:15 a 10:40"). Decisión del usuario: la grilla es
  de módulos. Ver D1.

---

## Decisiones de diseño

### D1 — Módulos, no rangos de hora

El día se divide en franjas con nombre ("3ª hora, de 9:30 a 10:10") y se reserva una franja, no un
intervalo. Dos motivos, y el segundo es el que manda:

- Es como habla la escuela. El docente dice "me toca 3ª hora", no "de 9:30 a 10:10".
- **Convierte "no pueden dos a la vez" en un índice único** en lugar de una consulta de
  solapamiento. Con dos workers de PM2, dos docentes que aprietan el mismo casillero en el mismo
  segundo se pisan si la guarda es un `if`; un índice no se puede engañar.

La grilla de la Escuela 4118, tal como la dictó el usuario: **7 módulos de 40′ y 2 recreos de 10′**
por turno, con el patrón *2 módulos · recreo · 2 módulos · recreo · 3 módulos*.

| Turno Mañana | | | Turno Tarde | |
|---|---|---|---|---|
| 1ª | 08:00–08:40 | | 1ª | 14:00–14:40 |
| 2ª | 08:40–09:20 | | 2ª | 14:40–15:20 |
| *Recreo* | *09:20–09:30* | | *Recreo* | *15:20–15:30* |
| 3ª | 09:30–10:10 | | 3ª | 15:30–16:10 |
| 4ª | 10:10–10:50 | | 4ª | 16:10–16:50 |
| *Recreo* | *10:50–11:00* | | *Recreo* | *16:50–17:00* |
| 5ª | 11:00–11:40 | | 5ª | 17:00–17:40 |
| 6ª | 11:40–12:20 | | 6ª | 17:40–18:20 |
| 7ª | 12:20–13:00 | | 7ª | 18:20–19:00 |

Los dos cierran **clavados** contra el rango del turno (7 × 40 + 2 × 10 = 5 h exactas). Eso es lo
que permite que la validación sea estricta —las franjas cubren el turno entero, sin huecos ni
sobrantes— en vez de perdonar diferencias: no hay holgura donde esconder un error de carga.

**Los recreos van EN la grilla**, como franjas `tipo: 'recreo'` con `orden: null`. No se reservan
nunca, y están por dos motivos reales: sin ellos el calendario salta de 2ª (termina 9:20) a 3ª
(arranca 9:30) y las dos filas se leen contiguas; y la validación de continuidad sería falsa justo
donde sirve.

### D2 — `divisible` parte el módulo en dos mecanismos

No es una preferencia de UI: decide **con qué se garantiza que nadie se pase del cupo**, y son dos
mecanismos incompatibles.

| | Sala de Computación | Netbooks Novatech |
|---|---|---|
| capacidad | 20 | 30 |
| `divisible` | **false** | **true** |
| `maxPorPedido` | — | **15** |
| guarda | índice único parcial | contador atómico |

**Exclusivo** (`models/Reserva.js`): reservarlo lo ocupa entero, un docente por módulo.

```js
{ recurso: 1, date: 1, turno: 1, modulo: 1 },
{ unique: true, partialFilterExpression: { status: 'confirmada', exclusiva: true } }
```

Las dos condiciones del filtro son necesarias y por motivos distintos: sin `status: 'confirmada'`
una reserva **cancelada** ocuparía el casillero para siempre; sin `exclusiva: true` la segunda
reserva legítima de netbooks sobre el mismo módulo chocaría contra la primera.

⚠️ `partialFilterExpression`, **nunca `sparse`**. `sparse` saltea el documento donde el campo está
*ausente*, no el que vale `null` o `false` — es exactamente el bug de `models/School.js:22` que
impedía crear una segunda escuela.

`Reserva.exclusiva` va **denormalizado** desde `Recurso.divisible`. No es comodidad: un índice
parcial de Mongo puede condicionar por un campo del propio documento, pero no puede ir a mirar otra
colección. Sin ese campo habría que elegir entre no tener índice o tenerlo para todos.

**Divisible** (`models/SlotOcupacion.js` + `services/recursos/cupo.js`): "no pasarse de 30" es una
**suma**, y una suma no cabe en un índice. La versión intuitiva es una carrera abierta:

```js
const usadas = await sumar(...);            // los dos workers leen 20
if (usadas + pedidas <= 30) await crear();  // los dos confirman 15 → 35 netbooks
```

La guarda es un `findOneAndUpdate` atómico sobre un contador por casillero:

```js
{ recurso, date, turno, modulo, ocupadas: { $lte: capacidad - unidades } }
$inc: { ocupadas: unidades }     // null = no hay cupo
```

Un documento, una operación: es lo único que Mongo garantiza atómico sin transacciones. El
casillero se crea al primer uso con un insert que puede chocar con el índice único; ese `E11000`
se reintenta **una vez** contra el camino del `$inc`, que para entonces ya lo encuentra.

### D3 — El contador es estado derivado, y nace con su antídoto

`ocupadas` tiene que **bajar** en cada camino de salida: cancelar, rechazar, editar la cantidad
otorgada, dar de baja el recurso, borrar un módulo del horario. Olvidar uno solo **filtra cupo para
siempre**: las netbooks figuran ocupadas y no las tiene nadie.

Por eso el diagnóstico `ocupacion-descuadrada` de `/superadmin/otros` existe desde el mismo commit
y no después: recalcula el contador sumando las reservas confirmadas y muestra las diferencias
**antes** de arreglarlas.

**La verdad vive en las reservas.** El contador es solo la forma de decidir rápido y sin carreras.

### D4 — El docente pide, el administrativo resuelve, y el calendario se autocompleta

```
Docente pide un módulo (y, si es divisible, cuántas unidades — tope maxPorPedido)
   │
   ├─ ¿ya autorizado para ESE recurso? → confirmada  (directo, pero igual pasa por el cupo)
   └─ no                               → pendiente   (le figura al admin, con badge en el nav)
                                             │
                     Admin resuelve, y en los divisibles PUEDE EDITAR la cantidad:
                       • "Aceptar"              → confirmada con lo que él deja
                       • "Aceptar y autorizar"  → + RecursoAutorizacion → de acá en más, directo
                       • "Rechazar"             → rechazada + motivo
```

El botón del medio es el que hace que el calendario **se autocomplete**: el primer pedido de cada
docente pasa por una persona, y después el docente carga solo. Aprobar reserva por reserva
convertiría al administrativo en un cuello de botella diario.

La autorización es **por recurso** y no un permiso global: entrar al laboratorio de química y pedir
el proyector del pasillo no son la misma decisión. Un recurso con `requiereAutorizacion: false` no
le pide permiso a nadie.

Se guardan **las dos cifras**, `unidadesPedidas` y `unidades`: si el docente pidió 15 y le dieron 8
tiene que verlo, y el administrativo tiene que poder responder por qué. `maxPorPedido` topea el
**pedido**, no el otorgamiento — el admin lo puede pasar hasta la capacidad, y queda auditado.

### D5 — Un pendiente NO bloquea el casillero

Ni el índice ni el contador miran los pendientes. Es deliberado: un pedido sin aprobar no puede
cerrarle la puerta a un docente ya autorizado.

La contracara son dos carreras que el administrativo se come **apretando "Aceptar"**, y las dos se
resuelven distinto:

- **Exclusivo** → `E11000`. Ese módulo ya es de otro y **no se va a liberar solo**, así que el
  pedido perdedor se **auto-rechaza** con el motivo. Dejarlo pendiente lo devolvería a la bandeja
  mañana, y pasado, para siempre: una fila que el administrativo no puede resolver y que solo le
  enseña a ignorar la bandeja.
- **Divisible** → el `$inc` no matchea. Acá **sí** hay algo que hacer: quedan `libres` unidades, y
  la pantalla le ofrece confirmar por ese número.

Ninguna de las dos es un 500. Un 500 ahí es la peor cara del módulo.

La bandeja muestra el cupo **al momento de mirarla**, no al del pedido: decidir sobre el número
viejo es decidir sobre algo que ya no existe.

### D6 — La repetición se materializa

"Todos los martes hasta el 30/11" y "cada 15 días" se expanden al pedir: **una `Reserva` por
fecha**, todas con el mismo `serie`. Guardar una regla y resolverla al vuelo rompería las dos cosas
que sostienen el modelo — el índice no puede vigilar una regla, y cancelar un solo martes obligaría
a inventar una lista de excepciones.

**La serie es parcial a propósito**: si pidió 30 martes y dos están tomados, se crean los otros 28
y se informan los 2. Cancelar el pedido entero por dos choques sería castigar al docente por algo
que no eligió, y obligarlo a cargar 28 fechas a mano.

Topes: horizonte de un año y 45 fechas por pedido. Nadie reserva el laboratorio hasta 2030 con un
clic.

### D7 — `date` es un String `'YYYY-MM-DD'`

Misma decisión, mismos tres motivos, que `models/AttendanceSession.js:29`:

1. **Producción corre en UTC.** Un `new Date()` a la medianoche local fecha la reserva del día
   siguiente, y el índice único dejaría entrar una segunda reserva "del mismo módulo".
2. Hace el índice único trivial: no hay que normalizar horas ni rangos.
3. Las comparaciones de rango del calendario son exactas y ordenan solas.

El día lo calcula siempre el servidor con `diaEscolar()` de `services/liveRoom.js`, el único dueño
de la hora del proyecto.

⚠️ **Mostrar un día tampoco puede correrlo**, y ahí `fmt` de `liveRoom.js` NO sirve: formatea
instantes en la zona de la escuela, y `new Date('2026-08-25')` es medianoche UTC → se ve como el 24
a las 21:00. Los helpers `diaCorto` / `diaLargo` / `diaNum` de `disponibilidad.js` arman el instante
en UTC y lo formatean en UTC: las dos mitades se cancelan y queda el día que dice el string. Es la
excepción que `tests/unit/zonaHoraria.test.js` admite explícitamente (una zona declarada a mano es
deliberada, no un olvido).

### D8 — Es el primer módulo OPCIONAL por escuela

`config/modulos.js` es el hermano de `config/sections.js` y responde otra pregunta:

| | pregunta | default |
|---|---|---|
| `config/sections.js` | ¿este **rol** ve esta solapa? | restrictivo y **fail-open** |
| `config/modulos.js` | ¿esta **escuela** tiene esto? | aditivo y **fail-closed** |

Vive en `School.modules`, **fuera de `settings`**, por el mismo motivo que `rolePermissions` y
`soeAccess`: `settings` lo edita el admin de la escuela desde `/admin/tasks`, y el admin no puede
ser quien se habilita a sí mismo un módulo. Lo prende el **superadmin** desde `/superadmin/schools`.

⚠️ **El `flag` de `config/sections.js` no alcanza.** Hoy se resuelve contra `res.locals[flag]`, que
sale de una variable de **entorno**, y el enforcement real es el montaje condicional del router.
Eso funciona para un flag global y no para uno por escuela: el montaje ocurre una vez al arrancar,
cuando todavía no hay request del que sacar la escuela. Por eso hacen falta las dos mitades:
`res.locals.<id>Enabled` (esconde la solapa) y `requireModulo('recursos')` (bloquea la ruta).

Y el `!!` no es cosmético: `can()` compara `=== false`, así que un `undefined` **no esconde nada**.

---

## Criterios de aceptación

Los cubren `tests/unit/horarioEscolar.test.js` (CA-01 a CA-06),
`tests/unit/disponibilidadReservas.test.js` (CA-07 a CA-14),
`tests/unit/cupoReservas.test.js` (CA-15 a CA-21) y 16 specs de smoke.

| # | Criterio |
|---|---|
| CA-01 | La grilla generada reproduce exactamente los dos turnos de la escuela y cierra contra el rango |
| CA-02 | El horario que ofrece la pantalla pasa su propia validación |
| CA-03 | Un hueco, una superposición o un turno que no llega al final se rechazan, diciendo dónde |
| CA-04 | Los módulos se numeran 1,2,3… sin saltos; los recreos no llevan orden |
| CA-05 | `moduloDe` rechaza el módulo inventado y nunca devuelve un recreo |
| CA-06 | Las horas comparan como string: `'09:30' < '10:10'` |
| CA-07 | La aritmética de días cruza fin de mes, fin de año y bisiesto sin correrse |
| CA-08 | El día que se muestra es el día que dice el string, incluido el 1 de enero |
| CA-09 | Semanal cae siempre el mismo día; quincenal saltea una semana |
| CA-10 | La celda de un divisible dice cuántas quedan; la de un exclusivo, libre u ocupada |
| CA-11 | `maximoPedible` topea por `maxPorPedido` **y** por lo que queda libre |
| CA-12 | Un pendiente no ocupa cupo |
| CA-13 | Reservar en el pasado se rechaza |
| CA-14 | Una serie sin fecha final, o de más de un año, o de más de 45 fechas, se rechaza |
| CA-15 | Tomar y devolver dejan el contador exacto; devolver de más no lo pone en negativo |
| CA-16 | Pedir más que la capacidad no escribe nada |
| CA-17 | **Diez pedidos simultáneos de 4 sobre 30: entran exactamente 7 y el contador cierra** |
| CA-18 | Bajar lo otorgado libera; subir sin lugar no deja el cupo a medias |
| CA-19 | `recalcular` detecta un contador inflado, lo arregla, y no cuenta canceladas ni pendientes |
| CA-20 | El índice parcial rebota la segunda confirmada exclusiva y deja pasar las divisibles |
| CA-21 | Una reserva cancelada no bloquea el casillero para siempre |

⚠️ **Los tests de CA-17 van con `Promise.all`, no en secuencia.** Un test secuencial pasa igual con
la versión ingenua y no mide nada. Verificado: reemplazando `tomar()` por leer-comparar-crear,
caen exactamente los 4 tests de carrera y ninguno de los otros 17.

---

## Archivos

**Nuevos**: `config/modulos.js` · `middleware/modulos.js` · `models/Horario.js` ·
`models/Recurso.js` · `models/Reserva.js` · `models/SlotOcupacion.js` ·
`models/RecursoAutorizacion.js` · `services/recursos/{horario,disponibilidad,cupo,reservas}.js` ·
`routes/recursos.js` · `routes/reservas.js` · `views/admin/recursos/*` · `views/reservas/*` ·
`views/partials/recursos-styles.ejs`

**Modificados**: `models/School.js` (`modules`) · `server.js` (`.select()`, `res.locals`, montaje,
badge) · `config/sections.js` (2 solapas) · `config/audit-actions.js` (9 acciones, categoría
`recurso`) · `services/dbFixes.js` (diagnóstico `ocupacion-descuadrada`) ·
`routes/superadmin.js` + `views/superadmin/school-form.ejs` (el interruptor) ·
`views/partials/{admin-nav,header}.ejs` · `tests/roles/check-roles.js`

## Cosas a tener en cuenta

- **El doc de escuela va cacheado 45 s y el cache es por worker** (`middleware/cache.js`).
  `invalidateSchool()` limpia solo el worker que atendió el POST: con 2 workers de PM2, prender el
  módulo y no verlo al instante es lo esperado. La pantalla lo avisa.
- **`modules` hay que tenerlo en el `.select()` de `server.js`**, o `moduloActivo()` lee
  `undefined`, contesta que no —es fail-closed— y el módulo queda invisible sin que nadie lo haya
  apagado. Mismo caveat que `settings`, `rolePermissions` y `soeAccess`.
- **Cambiar `Recurso.divisible` no reescribe las reservas ya hechas**: cada una guarda su propio
  `exclusiva` y se rige por la regla que había cuando se creó. Es lo correcto, y la pantalla lo
  avisa antes de guardar en vez de dejar que se descubra después.
- **Borrar un módulo del horario deja huérfanas las reservas confirmadas que lo usaban.** No se
  bloquea —la escuela puede tener un motivo— pero el guardado pide confirmación y dice cuántas son.
- **Dar de baja un recurso es lógico** (`activo: false`), nunca borrado: "quién usó la sala en
  marzo" es justamente la pregunta que este módulo existe para contestar. Sus reservas futuras se
  cancelan por el camino normal, que es el que devuelve el cupo.
- **Los pedidos NO se auditan uno por uno**: con repetición semanal son cientos por cuatrimestre y
  taparían la pantalla de auditoría. Quién pidió y cuándo ya vive en la propia `Reserva`. Lo que se
  audita es lo que una **persona decide sobre otra**: aprobar, rechazar, autorizar, revocar.
