# Una persona, varias escuelas, varios roles

Estado: **propuesta, sin aprobar** (2026-08-28) · Alcance: transversal · Pedido del usuario

## Problema

El sistema asume, en todos lados, que **una persona es una sola cosa en un solo lugar**:

```js
// models/User.js
role:   { type: String, enum: ROLES, default: 'student' },   // UNO
school: { type: ObjectId, ref: 'School', default: null },    // UNA
```

La realidad de la escuela argentina no es esa. Una profesora da Matemática en San José y
Física en Arboit. Un preceptor de una escuela es docente en otra. Alguien es directivo en un
lado y docente en el otro.

Hoy la única salida es **crear dos cuentas para la misma persona**: dos contraseñas, dos
perfiles, dos avatares, dos veces la misma foto, y entrar y salir para ver una escuela u otra.
Y hay una huella en el código de que esto se dio por sentado desde el principio: el índice
único del DNI es `{ school, dni }` (`models/User.js:128`), es decir **el mismo DNI puede
repetirse mientras sean escuelas distintas**. La duplicación no es un accidente: está
habilitada por diseño.

## El tamaño real del problema, medido

| Qué | Cuánto |
|---|---|
| Lugares que leen `user.role` | **66** |
| Lugares que leen `user.school` | **117** |
| Archivos distintos involucrados | **33** |
| Qué lleva el JWT adentro | **solo `{ userId }`** (`routes/auth.js:57`) |
| Índice único del DNI | `{ school, dni }`, parcial |
| Cómo decide un curso si sos de su escuela | `this.school === user.school` (`models/Course.js:120` y `:152`) |

Esos 183 usos son la razón por la que esto parece imposible. **No lo es**, y la clave está en
la fila del JWT: el token **no lleva el rol ni la escuela adentro**, solo el id de la persona.
Todo lo demás se resuelve por request contra la base. Eso deja la puerta abierta a lo que sigue.

## La idea que hace viable el refactor

> **`user.role` y `user.school` dejan de ser datos guardados y pasan a ser el CONTEXTO ACTIVO,
> calculado en cada request.**

Si `checkUser` deja en `res.locals.user` un objeto que sigue teniendo `role` y `school` —solo
que ahora salen de la membresía activa en vez del documento—, **los 183 usos siguen andando
sin tocarse**. El refactor deja de ser "reescribir 33 archivos" y pasa a ser "cambiar de dónde
salen dos campos, y agregar las pantallas para elegir".

Y el precedente ya existe en la casa, dos veces: el alcance del rol `jefe` **no vive en
`User.role`** sino en `Section.heads`, y el del preceptor vive en `User.assignedDivisions`.
Sacar el alcance del documento del usuario no es un invento nuevo acá.

## Las tres opciones

### A. Seguir duplicando cuentas (lo de hoy)
Cero trabajo. La persona mantiene dos identidades, dos contraseñas, y nunca ve sus dos
escuelas juntas. **Se rompe del todo cuando cada escuela tenga su dominio**: va a tener que
recordar con qué cuenta entra a cuál.

### B. Un array en el usuario: `User.roles: [{ school, role }]`
Sin colección nueva. Pero cada `User.find({ school: X })` —y hay 117— pasa a ser
`User.find({ 'roles.school': X })`, los índices sobre arrays son más caros, y no hay dónde
colgar los datos propios de una membresía (fecha de alta, si está activa en esa escuela, las
divisiones que tiene asignadas *en esa escuela*).

### C. Colección `Membership` ⭐ **recomendada**

```js
// models/Membership.js
{
  user:   ObjectId,   // ref User
  school: ObjectId,   // ref School
  role:   String,     // enum ROLES
  active: Boolean,    // de baja en ESTA escuela sin tocar las otras
  assignedDivisions: [ObjectId],   // el alcance del preceptor, por escuela
  allDivisions: Boolean,
}
// índice único { user, school, role }
```

`User` se queda con lo que es de la **persona**: nombre, email, DNI, contraseña, avatar,
teléfono, bio. Todo lo que es del **vínculo** se muda a `Membership`. Una persona con dos
escuelas tiene una cuenta y dos membresías. Alguien que es docente *y* preceptor en la misma
escuela tiene dos membresías con la misma escuela y distinto rol.

## Cómo se elige el contexto activo

Por orden de prioridad:

1. **Si tiene una sola membresía** (el caso del 99% hoy): esa, sin preguntar. Nadie nota que
   el sistema cambió.
2. **El dominio, cuando lo haya**, ACOTA pero no siempre alcanza. Entrar por
   `arboit.conecta.net` descarta las membresías de las otras escuelas; si en Arboit tiene una
   sola, listo. Ver `specs/dominios-por-escuela.spec.md`.
3. **Si le quedan varias, selector**: después del login — *"¿Con qué rol querés entrar?"* — y
   un cambiador siempre visible en el encabezado, que diga en qué contexto está parado:
   **"Docente · San José ▾"**. Dos clics para cambiar, nunca volver a loguearse.

> ⚠️ **Confirmado por el usuario el 2026-08-29: una persona puede ser docente Y preceptor en la
> MISMA escuela**, y directivo en otra. Consecuencia directa: **el dominio nunca puede elegir
> el contexto solo**. Entrar por el dominio de San José no desempata entre "Docente" y
> "Preceptor", que son dos alcances de datos distintos dentro de la misma escuela. El selector
> deja de ser un caso de borde para los pocos que trabajan en dos lugares y pasa a ser
> **parte del camino normal**. Hay que diseñarlo como pantalla de primera, no como excepción.

El contexto activo viaja en el JWT (`{ userId, membershipId }`), que se vuelve a firmar al
cambiar de contexto. Va firmado y no en una cookie suelta para que nadie se cambie de escuela
editando el navegador.

⭐ **Esto además resuelve la decisión D1 de la spec de dominios.** Ahí la pregunta era qué
hacer con un usuario de San José que entra por el dominio de Arboit. La respuesta deja de ser
"rechazarlo": es **activar su membresía de Arboit si la tiene, y rechazarlo solo si no tiene
ninguna**. Las dos features se resuelven entre sí.

## Lo que SÍ hay que tocar (la lista honesta)

La capa de compatibilidad salva la lectura. Lo que no salva es todo lo que **escribe** o
**lista**:

1. **Alta y edición de usuarios** (`/admin/users`, `/superadmin/users`): pasan a administrar
   membresías. "Cambiar rol" pasa a ser "cambiar el rol *en esta escuela*".
2. **Cambio de escuela del superadmin** (`POST /superadmin/users/:id/school`): hoy *mueve* a
   la persona. Pasa a ser *agregar* una membresía.
3. **La importación por Excel**: hoy crea usuarios con rol y escuela. Tiene que reconocer a
   una persona que ya existe (por DNI o email) y **sumarle una membresía** en vez de fallar
   por DNI duplicado o crear un clon.
4. **El índice único del DNI**: `{ school, dni }` → `{ dni }` único global. Es el cambio de
   base más delicado y necesita un informe previo: hay que ver qué DNIs están hoy repetidos
   entre escuelas y decidir uno por uno si son la misma persona o un error de tipeo.
5. **Login, impersonación y el caché de 45 segundos** del documento de usuario: los tres
   tocan el contexto y los tres tienen que invalidarlo al cambiar.
6. **Los listados por escuela**: `User.find({ school })` pasa a resolverse por membresías.
7. **La baja de una cuenta** ✅ *resuelto por D3*: hoy `active: false` apaga a la persona en
   todos lados. Pasan a existir dos bajas distintas y cada botón tiene su dueño: el admin da
   de baja **la membresía de su escuela**; solo el superadmin da de baja **a la persona**. Con
   la semántica de hoy, el admin de San José dejaría afuera de Arboit a alguien que ni ve.
8. **El reseteo de contraseña** (ver D3): sigue siendo atribución del admin, pero pasa a
   marcar la cuenta como "debe cambiar la contraseña al entrar". Hoy
   `POST /admin/users/:id/reset-password` asigna el DNI como clave y ahí queda.

## Migración de los 1.517 usuarios

**Fase 1 es invisible y reversible.** Un script crea **una membresía por usuario existente**,
copiando su `role`, su `school`, sus `assignedDivisions` y su `active`. Todos quedan con
exactamente una, así que el contexto activo es siempre el mismo y **el sistema se comporta
igual que hoy**. Los campos `User.role` y `User.school` **no se borran**: quedan como respaldo
para poder volver atrás sin restaurar un backup.

**La fusión de las cuentas duplicadas que ya existen es un paso aparte, manual y asistido.** El
script detecta candidatas (mismo DNI o mismo email en escuelas distintas) y **propone**; la
decisión de fusionar dos personas la toma un humano, porque un falso positivo mezcla los
legajos de dos chicos distintos.

## Las 6 trampas

1. **El caché de 45 segundos del documento de usuario.** Ya está documentado en
   `models/User.js`: un cambio de rol no se ve hasta que el caché expira. Con el contexto
   activo eso pasa de una molestia a un bug de seguridad: alguien que cambia de escuela podría
   seguir 45 segundos con el contexto anterior. **Cambiar de contexto tiene que invalidar el
   caché de esa persona, sí o sí.**
2. **El caché vive en cada worker de PM2, y son dos.** Misma familia que la trampa 3 de la
   spec de dominios: invalidar en el worker que atendió el cambio deja al otro con el contexto
   viejo, y qué pasa depende de a qué worker caiga cada request.
3. **`Course.school === user.school`** (`models/Course.js:120` y `:152`) sigue funcionando con
   la capa de compatibilidad, pero significa que **un docente solo ve los cursos del contexto
   en el que está parado**. Es correcto y es lo que queremos, pero hay que decirlo en la
   pantalla o el docente va a jurar que le desaparecieron los cursos de la otra escuela.
4. **El índice `{ school, dni }` no se puede cambiar en caliente.** Requiere `dropIndex` +
   `createIndex` sobre la base de producción, con la escuela trabajando. Va con aviso previo y
   ventana, como cualquier cambio de base.
5. **La contraseña pasa a ser una sola para todas las escuelas.** Es lo que hace útil el
   cambio, pero significa que el admin de una escuela que resetea la contraseña de alguien
   **le está cambiando la contraseña también en la otra escuela**. Hay que decidir si un admin
   puede resetear la clave de una persona que además pertenece a otra institución.
6. **El superadmin no tiene escuela** (`school: null`) y medio código lo trata como caso
   especial (`school && ...`). El contexto activo tiene que admitir "sin escuela" como un
   estado válido, no como una membresía que falta.

## Decisiones que necesito del usuario

**D1 — ¿Varios roles en la MISMA escuela?** ✅ **RESPONDIDA (2026-08-29): SÍ.** Docente *y*
preceptor en San José, y directivo en otra escuela. Por lo tanto el índice único es
`{ user, school, role }` —tres campos, no dos— y el selector de contexto pasa a ser parte del
camino normal (ver el aviso en "Cómo se elige el contexto activo").

**D2 — Con varios roles, ¿se ELIGE uno o se SUMAN?** Es la decisión que queda abierta y la más
cara si se elige mal:

- **(a) Uno activo por vez, con cambiador** ⭐ recomendada. `user.role` sigue siendo un string
  y **los 183 usos siguen intactos**. La persona ve las solapas de Docente, cambia a Preceptor
  en dos clics y ve las de Preceptor.
- **(b) Los roles se suman**: parada en San José ve las solapas de docente Y de preceptor a la
  vez. Se lee mejor, pero `user.role` deja de poder ser un string y **hay que reescribir los
  66 lugares que comparan el rol** convirtiéndolos en preguntas por capacidad
  (`puede('tomar_asistencia')` en vez de `role === 'preceptor'`). Es un refactor de otra
  escala, no un ajuste.

Con (a) hay una molestia que conviene anticipar: parada como Docente, esa persona **no ve las
solapas de Preceptor**, y la primera reacción va a ser "me sacaron permisos". El cambiador
tiene que estar a la vista y decir el contexto con todas las letras.

**D3 — El alcance del admin.** ✅ **RESPONDIDA (2026-08-29):** *"el admin puede solucionar
inconvenientes provenientes solamente de su escuela; los demás roles de otras escuelas no los
ve"*. De esa sola frase salen cuatro reglas:

1. El panel del admin muestra **únicamente la membresía de su escuela**. No lista ni insinúa
   que la persona trabaja en otro lado: eso sería filtrar información de otra institución.
2. **"Deshabilitar cuenta" pasa a deshabilitar la MEMBRESÍA**, no a la persona. Hoy
   `User.active = false` la apaga en todos lados; con esa semántica, el admin de San José
   dejaría afuera a alguien de Arboit sin enterarse. Dar de baja a la **persona** queda como
   atribución exclusiva del superadmin.
3. **El reseteo de contraseña sí lo puede hacer** —es la única forma de destrabar a alguien que
   quedó afuera—, pero la contraseña es de la persona y vale para todas sus escuelas: no hay
   forma técnica de que sea de a una. Para acotar el daño, el reseteo deja la cuenta marcada
   como **"debe cambiar la contraseña al entrar"**, así la clave provisoria vive minutos y la
   persona vuelve a tener una que solo ella conoce.
4. El admin **no puede cambiarle el rol en otra escuela** ni sacarle la membresía de Arboit,
   aunque la vea en la base. La única llave que tiene es sobre su propia escuela.

**D4 — Las cuentas duplicadas que ya existen: ¿las fusionamos o las dejamos?** Se puede
arrancar sin fusionar nada —las dos cuentas siguen funcionando— y fusionar de a poco, a mano.

## Orden de implementación

| Fase | Qué | Se nota? |
|---|---|---|
| 1 | `Membership` + migración 1:1 + capa de compatibilidad en `checkUser` | **No.** Todo igual |
| 2 | Selector de contexto y cambiador en el menú | Solo quien tenga más de una |
| 3 | Pantallas de administración de membresías + importación | Sí, en los paneles |
| 4 | Índice de DNI global + informe y fusión de duplicados | Sí, con ventana de base |
| 5 | Enganche con los dominios: el host elige la membresía | Sí |

Las fases 1 y 2 ya dan el valor grande —una persona, una contraseña, dos escuelas— y son las
menos riesgosas. La 4 es la única que toca la base de producción de verdad.

## Criterios de aceptación

1. Terminada la fase 1, **ninguna pantalla cambia** y las tres suites de tests siguen en verde.
2. Una persona con membresías en dos escuelas entra una sola vez y cambia de contexto sin
   volver a escribir la contraseña.
3. Parada en San José, ve **solo** cursos, alumnos y actividades de San José. Ni un dato de
   Arboit se filtra.
4. Cambiar de contexto invalida el caché en **los dos workers**.
5. La importación por Excel de una persona que ya existe en otra escuela le suma la membresía,
   no crea un duplicado ni falla.
6. El superadmin (sin escuela) sigue funcionando igual que hoy.
7. Se puede volver atrás de la fase 1 sin restaurar un backup: `User.role` y `User.school`
   siguen ahí.
