# Fusión de cuentas duplicadas (mismo DNI, misma escuela)

> **Estado: FASES 0 y 1a IMPLEMENTADAS Y VERIFICADAS el 2026-09-12** contra una copia de
> producción. Las 4 decisiones están tomadas (RN-05, RN-12, RN-13 y RN-14, todas del
> 2026-09-12). **Pendientes: Fase 1b (el aviso), 2, 3 y 4.**
>
> Resultado de la 1a: la pantalla pasó de ver **3 grupos de 59** a ver los **41** que están sin
> resolver, y el botón masivo de resolver **1** a resolver **26**, sin borrar una sola cuenta.
>
> Flujo SDD: arquitecto → **spec aprobada** → tester → implementador → revisor.
>
> Todo lo que sigue está medido sobre un `mongodump` real de producción (v1.0.99, 233.839
> documentos) restaurado en una base aparte, no estimado. Ver [[fusion-mellizas-alcance]].

## El problema, con números

Hay **59 grupos** de personas cargadas dos veces con el mismo DNI en la misma escuela: 52 de
alumno+alumno y 7 con un docente. La herramienta que existe hoy (`/superadmin/otros`, arreglos
`dni-duplicado-en-curso` y `docentes-dni-duplicado`) **muestra 3**, y su botón masivo puede
resolver **1**.

| | |
|---|---|
| Grupos reales | **59** |
| Los que muestra la pantalla | **3** |
| Los que el botón masivo resuelve | **1** |

**La causa no está en la fusión sino en la detección**: `calcularDniDuplicados()` agrupa por
división y exige que **las dos** cuentas estén en materias de la MISMA división. Y en 41 de los
52 pares de alumnos la cuenta sobrante tiene **cero materias** — por eso es invisible. El
arreglo de docentes no tiene ese problema (agrupa por escuela+DNI) y muestra 0 por otro motivo:
descarta los grupos donde solo una cuenta está "viva", y los 7 pares de docentes ya están
medio resueltos a mano.

### La forma del duplicado

| Forma | Pares de alumnos |
|---|---|
| Una cuenta con todo, la otra **sin nada propio** | **41** |
| Las dos con trabajo propio (pero en 8 de ellos la segunda tiene 1 o 2 registros sueltos) | 11 |
| Ninguna usada nunca | 0 |

El patrón: la cuenta en **MAYÚSCULAS con el correo de la familia** viene del padrón y nunca se
matriculó; la de **minúsculas con el gmail del chico** es la que se usa. Solo **1** de las 41
sobrantes tiene el correo institucional, así que la hipótesis vieja —"una tiene el
institucional y la otra el personal"— no describe estos datos.

⭐ **De las 41 cuentas vacías, 14 se conectaron alguna vez.** Entraron y no vieron nada, porque
no tienen materias. Es un "no me aparecen mis materias" que todavía nadie reportó, y es el dato
que separa las que se pueden deshabilitar a ciegas (27) de las que hay que mirar (14).

## Lo que la fusión mueve y lo que no

`fusionarAlumnos()` mueve: materias del curso (heredando la fecha de inscripción), entregas,
notas, acuses de lectura, comentarios en novedades y sugerencias. Con su regla de choque ya
resuelta para las tres colecciones que tienen índice único por actividad.

**No mueve**: `AttendanceMark`, `MessageRecipient`, `Message`, `RoomMessage`, `RoomPresence`,
`SoeCase`, `SoeRequest`, `ContactVerification`. Y lo que sí mueve es **solo de las materias de
esa división**.

Corrida sobre datos reales (DNI 52287874), dejó atrás en la cuenta dada de baja: **2 marcas de
asistencia, 1 fila de bandeja, 66 mensajes de sala**, más 1 nota y 2 acuses que chocaban.

### Los choques que tendría una fusión que moviera todo

Medido sobre los 52 grupos de alumnos:

| Colección | Grupos donde choca el índice único |
|---|---|
| `messagerecipients` **{message,user}** | **51 de 52** |
| `activityviews` {activity,student} | 8 |
| `attendancemarks` {session,student} | 2 |
| `submissions` {activity,student} | 1 |

El de la bandeja es la norma y no la excepción: los envíos van por rol y escuela, así que las
dos mellizas recibieron el mismo mensaje. Un `updateMany` a ciegas falla con E11000 en casi
todos los grupos.

## RN — Reglas de negocio

**RN-01. La detección agrupa por escuela + DNI normalizado, no por división.** Compartir curso
deja de ser condición para ver el duplicado. Se conserva el agrupamiento por división como
INFORMACIÓN de la ficha (en qué curso se pisan), no como filtro.

**RN-02. Una cuenta sin materias no se "saca del curso": se deshabilita.** La acción masiva de
hoy (`sacar`) no haría nada con las 41 sobrantes, porque no están en ningún curso.

**RN-03. Las cuentas vacías que SÍ se conectaron no entran en la acción masiva.** Se muestran
aparte: alguien las usó, y hay que avisarle con qué cuenta entrar. Las 27 que nunca se
conectaron sí son resolución automática.

**RN-04. En asistencia, fusionar es elegir y borrar, no mover.** Las dos cuentas tienen marca
en la MISMA toma; la de la melliza es un `ausente` con `source: 'cierre'`, que **no lo decidió
nadie** (ver [[asistencias-fantasma]]). Gana la decisión humana —`preceptor` > `alumno` >
`cierre`— y la otra marca **se elimina**, porque conservarla deja la fila duplicada en la
planilla mensual para siempre. Es la regla OPUESTA a la de las entregas, donde no se destruye
nada.

**RN-05. La bandeja se fusiona, y no se borra ninguna fila.** Decidido por el usuario el
2026-09-12 ("fusionar"). Las filas que **no** chocan pasan a la cuenta conservada; las que
chocan contra el índice único `{ message, user }` **se quedan donde están**, igual que hace hoy
el código con entregas, notas y acuses.

⭐ El motivo por el que eso no pierde nada: una fila que choca es, por definición, **el mismo
envío que la persona ya tiene en la cuenta buena** —chocan porque el mensaje le llegó a las dos
cuentas—, así que dejarla no le esconde ningún mensaje. Por eso acá no hace falta elegir "la más
rica y borro la otra", que era la versión anterior de esta regla y contradecía RN-12.

Consecuencia que hay que aceptar y no tapar: en los 51 grupos donde choca, la cuenta
deshabilitada se queda con esa fila y con su acuse de lectura sin leer. No la va a leer nadie, y
está bien: es una copia.

**RN-06. Dos legajos del SOE no se fusionan solos.** Los arrays con fecha (`entries`,
`referrals`, `citaciones`, `adjuntos` — que guardan `path`, así que no hay archivos que mover)
se concatenan y se leen como una sola línea de tiempo, que es el diseño elegido. Los cuatro
textos libres (`motivo`, `fortalezas`, `dificultades`, `estrategias`) **no**: ahí la fusión se
frena y lo dice. Hoy el caso no existe (0 grupos con dos legajos), pero la regla tiene que
estar escrita antes de que aparezca.

**RN-07. `eliminar` se niega cuando la cuenta sobrante tiene legajo del SOE o entregas
propias.** `SoeCase.student` es `required` y no se borra en cascada: el legajo quedaría sin
dueño, imposible de abrir o cerrar. Ya implementado (Fase 0).

**RN-08. Ninguna pantalla se cae porque el alumno de un legajo no exista.** El legajo sobrevive
al alumno a propósito; la vista muestra el hueco ("Alumno dado de baja") en vez de esconderlo,
y sin enlace. Ya implementado (Fase 0).

**RN-09. Nada se mueve sin que la pantalla haya dicho antes qué se va a mover.** Mientras una
colección no se mueva, el resultado tiene que NOMBRARLA. Ya implementado a medias (Fase 0: el
cartel informa asistencias, bandeja y sala que quedaron atrás).

**RN-10. La fusión sigue sin transacción, y está bien.** El orden actual (transferir → tocar la
cuenta sobrante → el correo al final) deja, ante un corte, una transferencia parcial con las dos
cuentas vivas. Lo que falta no es atomicidad sino **rastro**: ver RN-11.

**RN-11. Cada fusión registra el plan aplicado**, no solo contadores: los ids movidos por
colección. Es lo único que convierte "no hay deshacer" en "hay deshacer", y hoy la auditoría
guarda cuántos, no cuáles.

**RN-12. La cuenta sobrante se DESHABILITA. Nunca se elimina.** Decidido por el usuario el
2026-09-12. Vale para las 27 cuentas que nunca se usaron —donde eliminar hubiera sido
defendible, porque no hay nada que conservar— y con más razón para el resto.

Lo que se gana, y que no es solo prudencia:

- **Es reversible.** Un duplicado mal elegido se corrige volviendo a poner `active: true`; un
  borrado no se corrige con nada.
- **Deja de fabricar faltas sin borrar las que ya hay.** `rosterDeDivision()`
  ([services/attendance.js:183](services/attendance.js:183)) excluye las cuentas
  `active: false`, así que la melliza sale de la nómina de las tomas NUEVAS y deja de juntar un
  `ausente` por día. Las marcas viejas quedan hasta la Fase 3 (RN-04).
- **No deja referencias colgadas.** Es lo que hace que RN-07 deje de ser un caso especial:
  si nunca se borra una cuenta, ninguna colección queda apuntando a un usuario inexistente,
  ni las cuatro que la fusión todavía no mueve.
- **La cuenta sigue sin poder entrar**, verificado por el spec de smoke
  `alumnos-dup-fusion-elige-correo`, que intenta el login de la sobrante y lo espera
  rechazado (`[400, 401, 403]`).

⚠️ **Lo que NO resuelve: deshabilitar no libera el correo.** `User.email` es único global y la
cuenta deshabilitada se lo queda. Si alguna vez hay que pasar ese correo a la cuenta buena —el
caso es chico, 1 de las 41 sobrantes tiene el institucional— se hace con la elección de correo
que la fusión ya tiene (`emailId`), que lo **intercambia** entre las dos cuentas. No hace falta
eliminar nada para eso.

⚠️ **Y no toca `eliminar` como opción de la pantalla.** Sigue existiendo para el caso puntual
que alguien resuelva a mano, con las guardas de RN-07. Lo que RN-12 fija es **la acción masiva
y el valor por omisión**: ninguna resolución automática borra una cuenta.

**RN-13. Deshabilitar una cuenta que alguien usó tiene que avisarle, y el aviso va en DOS
lugares.** Decidido por el usuario el 2026-09-12 ("se avisa por la otra cuenta"). Son las 14
cuentas vacías con conexión registrada: pasan a entrar en la acción masiva, pero nunca en
silencio.

1. **Un mensaje a la cuenta que se conserva**, con el correo con el que tiene que entrar de
   ahora en más. Usa la mensajería que ya existe (`Message` + `MessageRecipient`).
2. ⭐ **El muro del login de la cuenta deshabilitada**, que es adonde la persona va a ir. Hoy
   [routes/auth.js:193](routes/auth.js:193) contesta `403 "Tu cuenta está deshabilitada.
   Contactá al administrador."` — con lo cual el aviso del punto 1 queda **justo en la bandeja
   que no puede abrir**, y el chico sale de ahí creyendo que perdió el acceso a la plataforma.
   Es el mismo patrón que ya nos costó caro: las dos pantallas contestaban bien y la persona
   igual no entraba (ver [[reset-contrasena-cuentas-mellizas]]).

Para que el login pueda decirlo, la fusión deja en la cuenta deshabilitada **a qué cuenta se
unificó** (un campo nuevo, tipo `mergedInto`), y el login usa ese dato para contestar "esta
cuenta se unificó con otra, entrá con …" en vez del texto genérico.

⚠️ **Sub-decisión chica, con un valor por omisión elegido**: el correo de destino se muestra
**enmascarado** (`d••••@gmail.com`). Quien llegó ahí ya probó que sabe la contraseña de esta
cuenta, así que casi seguro es el dueño, pero imprimir un segundo correo completo ante
cualquiera que acierte una contraseña es más de lo que hace falta para que la persona reconozca
cuál es su otra cuenta. Si preferís el correo completo, es un renglón.

**RN-14. Un grupo con trabajo propio en las DOS cuentas nunca entra en la acción masiva.**
Decidido por el usuario el 2026-09-12 ("los tres grupos los miro yo"). Hoy son 3
(DNI 52298568, 52297641 y 52287874) y la pantalla los ordena primero, que es lo que ya hace.
La ficha tiene que alcanzar para decidir sin abrir la base: por eso CA-02.

## Fases

### ✅ Fase 0 — cerrar el agujero (IMPLEMENTADA Y VERIFICADA el 2026-09-12)

Es un arreglo, no un cambio de alcance, y por eso no esperó la aprobación.

- `views/partials/soe-alumno-link.ejs` (nuevo) y sus 6 llamadores en `views/soe/`. **Verificado
  end-to-end**: `/soe` con un legajo huérfano daba **500** con la línea vieja y da **200** con
  el partial, entrando con el rol `soe` real de la escuela.
- `POST /admin/users/:id/delete` contesta **409** si el alumno tiene legajo (RN-07). Verificado
  contra el servidor: el alumno no se borra.
- `fusionarAlumnos()`: `eliminar` baja a `deshabilitar` si hay legajo, y el resultado informa
  las asistencias, la bandeja y los mensajes de sala que quedaron atrás (RN-09), también en el
  evento de auditoría (`sin_mover_asistencias`, `sin_mover_bandeja`, `sin_mover_sala`).
- `tests/unit/soeAlumnoLink.test.js`: 16 tests. El segundo bloque fija **la regla** —recorre las
  vistas del SOE y falla si aparece un `student._id` sin guarda—, así que cubre las pantallas
  que todavía no existen. Verificado que falla sin el arreglo.

### ✅ Fase 1a — que la pantalla los muestre (IMPLEMENTADA Y VERIFICADA el 2026-09-12)

Sin mover ni un dato más: cambió el agrupamiento y la acción masiva.

| | antes | ahora |
|---|---|---|
| Grupos que ve la pantalla | **3** | **41** (52 menos los 11 ya resueltos) |
| Los que resuelve el botón | **1** | **26** |
| Tiempo del diagnóstico | — | 174 ms |

De los 41: **26** los resuelve el botón, **11** esperan el aviso de RN-13 y **4** son disputados.
Verificado contra una copia de producción: apretar el botón deshabilitó 26 cuentas, los usuarios
totales quedaron en 1448 (**no se borró ninguna**, RN-12), y una segunda corrida no tiene nada
que hacer (idempotente).

- `services/fusionCuentas.js` (nuevo): la decisión, sin base de datos, con 22 tests en
  `tests/unit/fusionCuentas.test.js` escritos ANTES del módulo y derivados de estos CA.
- `calcularDniDuplicados()` agrupa por escuela+DNI, incluye a los alumnos **no matriculados**
  (los 41 invisibles), y el alcance de la transferencia pasó a ser la unión de las materias de
  todas las cuentas del grupo — antes un duplicado que cursaba en dos divisiones dejaba sin
  mover las entregas de la otra.
- Los grupos **ya resueltos** (sobrante deshabilitada y sin materias) salen del conteo, igual
  que en el arreglo de docentes. Eran 11 de 52.
- El botón masivo **deshabilita** en vez de "sacar del curso", que contra los datos reales no
  habría hecho nada: esas cuentas no están en ningún curso.
- Dos bugs que aparecieron al verificar y no se ven leyendo el código: `opcionesSobrante`
  ofrecía "solo se saca de los cursos" como opción por omisión para cuentas que no cursan nada
  (miraba todas las cuentas en vez de las sobrantes), y `.dupe-account:has(input:checked)`
  tenía el fondo en hex sin declarar el color del texto, así que en modo oscuro el nombre de
  la cuenta elegida era casi invisible.

**CA-01 ✅** · **CA-02 ✅** · **CA-03 ✅** · **CA-04 ✅** (los 26; los 11 con conexión esperan
1b) · **CA-05 ✅** · **CA-05b ✅**

### Fase 1b — el aviso (RN-13). PENDIENTE

Es lo único que falta para que los 11 restantes entren en la acción masiva. El interruptor ya
existe: `AVISO_DE_FUSION_LISTO` en `services/dbFixes.js`, hoy en `false`, y el test de
`fusionCuentas` cubre los dos estados.

**CA-04b** y **CA-04c**, más el campo `mergedInto` en `User` y el mensaje del login.

### Fase 1 — criterios (referencia)

**CA-01** El diagnóstico agrupa por escuela + DNI normalizado y devuelve los 52 grupos de
alumnos con datos de producción.
**CA-02** Cada cuenta de la ficha muestra, además de entregas y notas: materias, asistencias,
bandeja, mensajes de sala, legajo sí/no y última conexión.
**CA-03** Lo que la fusión no mueve aparece rotulado "no se transfiere".
**CA-04** La acción masiva deshabilita las 41 sobrantes **sin materias**, y ninguna se elimina
(RN-12). Las 14 que se conectaron entran también, pero solo si se les puede avisar (CA-04b).
**CA-04b** Por cada una de esas 14, la cuenta conservada recibe un mensaje con el correo con el
que tiene que entrar, y la cuenta deshabilitada queda marcada con a qué cuenta se unificó
(RN-13).
**CA-04c** El login de una cuenta deshabilitada por una fusión dice que se unificó y con qué
correo (enmascarado), en vez del texto genérico "Contactá al administrador" (RN-13).
**CA-05** Una sobrante con materias en otra división nunca entra en la acción masiva.
**CA-05b** Un grupo con trabajo propio en las dos cuentas nunca entra en la acción masiva, y
aparece primero en la lista (RN-14).

### Fase 2 — simular antes de escribir

**CA-06** `POST /superadmin/otros/:id/fusionar` con `simular: true` devuelve lo que se movería,
lo que chocaría y lo que quedaría atrás, **sin escribir nada**.
**CA-07** Correr la simulación dos veces seguidas da el mismo resultado y deja la base igual.

### Fase 3 — mover el resto (RN-04, RN-05, RN-06)

**CA-08** Las asistencias se fusionan por toma con la precedencia de RN-04, y la planilla
mensual de la división deja de mostrar a la persona dos veces.
**CA-09** El legajo del SOE lee la asistencia completa después de la fusión.
**CA-10** La bandeja se fusiona con RN-05: **ningún** grupo falla con E11000 (hoy chocarían 51
de 52) y **ninguna fila se borra** — la cantidad total de `messagerecipients` antes y después de
una fusión es idéntica.
**CA-11** Los mensajes de sala y la presencia pasan a la cuenta conservada.
**CA-12** Dos legajos frenan la fusión con un mensaje que nombra los cuatro textos en conflicto.

### Fase 4 — rastro y cierre (RN-11)

**CA-13** Cada fusión deja un registro con los ids movidos por colección.
**CA-14** Existe cómo revertir una fusión a partir de ese registro.
**CA-15** Con 0 duplicados, el índice único `{ school, dni }` se crea sin error. Hoy **no
existe en la base** aunque el modelo lo declare, y no puede construirse mientras haya
duplicados (ver [[reset-contrasena-cuentas-mellizas]]).

## ✅ PREGUNTAS — las 4 contestadas el 2026-09-12

1. ~~Las 27 cuentas vacías que nunca se usaron: deshabilitar o eliminar?~~ →
   **Deshabilitar, y ninguna resolución automática elimina una cuenta.** → **RN-12**
2. ~~Las 14 cuentas vacías que sí se usaron: qué se le dice al chico?~~ →
   **Se le avisa por la otra cuenta.** Entran en la acción masiva, con aviso. → **RN-13**
3. ~~La bandeja: fusionar o dejarla quieta?~~ → **Fusionar**, sin borrar ninguna fila: las que
   chocan se quedan donde están, porque son copias del mismo envío. → **RN-05**
4. ~~Los 3 grupos disputados: regla o a mano?~~ → **Los mira el usuario uno por uno**, y nunca
   entran en la acción masiva. → **RN-14**

### Lo único que quedó abierto, y tiene valor por omisión elegido

- **El correo del aviso en el muro del login va enmascarado** (`d••••@gmail.com`). Ver RN-13: si
  se prefiere completo, es un renglón.
