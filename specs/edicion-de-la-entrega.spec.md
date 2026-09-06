# El alumno corrige su entrega antes de que la corrijan

Estado: **aprobada** (2026-09-04) · Módulo: `activities` · Rol: alumno (y el docente que decide)

## Problema

Palabras del usuario:

> *"el alumno cuando quiere entregar un trabajo, si por error se equivoca le queda
> deshabilitado, quiero que el alumno en caso de que esté por entregar una actividad y la
> misma todavía no haya sido corregida por el docente o tampoco se encuentre vencida, el
> alumno puede editar su entrega incluyendo archivos o eliminándolos."*

Son **dos problemas encadenados**, y el segundo es el que muerde aunque se arregle el primero.

### 1. La entrega se cierra sola con la primera equivocación

`POST /activities/:id/submit` bloquea el reenvío cuando ya hay una `Submission` y la
actividad no tiene `allowResubmission`:

```js
const existing = await Submission.findOne({ activity: req.params.id, student: userId });
if (existing && !activity.allowResubmission) {
  return res.status(403).json({ error: 'Esta actividad no permite modificar la entrega una vez enviada.' });
}
```

`allowResubmission` es un checkbox del docente **apagado por defecto**, en la barra lateral
de la pantalla de crear actividad, debajo de todo. Medido sobre el espejo local el
2026-09-04:

| medición | valor |
|---|---|
| actividades | **697** |
| con `allowResubmission: true` | **102** (14,6 %) |
| entregas | **1852** |
| entregas congeladas hoy por el flag apagado | **1350** (72,9 %) |

O sea: en 7 de cada 10 entregas el alumno tiene **un solo intento**, y no porque el docente
lo haya decidido —el default lo decidió por él— sino porque el checkbox está apagado y nadie
lo mira. El alumno que sube el archivo equivocado, o el borrador en vez del final, se queda
con eso puesto y no tiene ninguna salida por pantalla.

### 2. Aun con la edición habilitada, reenviar **borra** lo anterior

Este es el problema que sobrevive al primero, y es el que el pedido nombra al decir
*"incluyendo archivos o eliminándolos"*. En el submit de hoy:

```js
if (newFiles.length > 0) {
  if (existing) existing.files.forEach(f => fs.unlinkSync(path.join(ENTREGAS_BASE, f.storagePath)));
  filesToSave = newFiles;          // ← reemplaza TODO
} else {
  filesToSave = existing?.files || [];
}
```

La entrega es **todo o nada**. El alumno que entregó tres archivos y quiere agregar el
cuarto pierde los tres: tiene que volver a subirlos. Y el que quiere sacar **uno solo** no
tiene cómo — no hay ninguna X sobre los archivos ya entregados, ni ruta que borre uno.

No es un caso de borde: **751 entregas (40,6 %) tienen dos o más archivos**, y el máximo
observado es 19.

| archivos por entrega | 0 | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|---|
| entregas | 333 | 768 | 399 | 146 | 89 | 62 | 55 |

**Lo que ya está bien y no se toca:** el plazo (`allowLateSubmissions`) y su barra de control
del docente; la pre-subida con progreso y reintentos (`SubidaDiag`); el reparto entre la ruta
de documentos y la de fotos; el chip `Entregada` de la tarjeta; y que la actividad vencida
siga mostrando su material (v1.0.74).

## Decisiones tomadas

Las cuatro las decidió el usuario el 2026-09-04, antes de escribir esta spec.

| # | decisión | |
|---|---|---|
| **D1** | **El checkbox del docente se queda**, con su etiqueta actual, pero pasa a venir **marcado**. Y una migración lo enciende en las actividades ya creadas cuya entrega sigue abierta. | El docente conserva el control para la evaluación que quiere congelar; lo que cambia es de qué lado está el default. |
| **D2** | ~~Corregida = nota puesta _o_ devolución escrita.~~ → **Corregida = la NOTA, y solo la nota.** | **Corregida el mismo día, ver *La corrección del 04/09* más abajo.** La devolución escrita sin nota es el pedido de rehacer: cerrar ahí le traba al alumno lo que el docente le está pidiendo que haga. |
| **D3** | **El alumno puede retirar su entrega.** Vaciarla la borra y la actividad vuelve a figurar como pendiente. | Con una salvedad de diseño: se retira **a propósito**, por un botón con confirmación, no por accidente al quitar el último archivo (ver *Retirar*). |
| **D4** | La regla nueva manda **sobre** el flag: aunque el checkbox esté marcado, corregida o vencida cierran igual. | Palabras del usuario: *"ten en cuenta que el docente no haya corregido antes o no hayan vencido"*. |
| **D5** | **El docente puede reabrirle la entrega a un alumno** (*"Permitir que lo rehaga"*), y esa reapertura le gana a todo. | Agregada el 2026-09-04 junto con la corrección de D2. Es la salida para el docente que ya puso nota y quiere que el trabajo se rehaga igual, y para el que corrigió por error. |

## La corrección del 04/09 (mismo día): corregir no puede trabar al alumno

Reporte del usuario, horas después de la primera implementación:

> *"pero ahora como tengo que corregir, arreglar esto"*

**El error era D2.** La devolución escrita sin nota cerraba la edición, y en la práctica del
aula esa devolución es **el pedido de rehacer**: *"te faltó el punto 3, rehacelo y te subo la
nota"*. La regla le cerraba al alumno exactamente la puerta que el docente le estaba abriendo.
Y si el docente ya había puesto nota, no había forma de devolverle la posibilidad.

Dos cambios, los dos pedidos por el usuario:

1. **Corregida = la NOTA, y solo la nota.** Si falta la nota, la corrección no terminó: la
   devolución escrita deja la entrega abierta. (Los 6 casos de devolución sin nota que había
   en la base pasan a ser editables, que es lo correcto.)
2. **`Permitir que lo rehaga`**, un botón en la fila del alumno, en la tabla de notas de la
   actividad. Marca `submission.reopenedAt` y **le gana a los tres motivos de bloqueo**: la
   nota puesta, el plazo vencido y el check destildado.

**Por qué la reapertura le gana hasta al plazo.** Es una autorización explícita, sobre *ese*
alumno, posterior a todo lo demás. Si el docente apretó el botón y el plazo se lo impidiera,
el sistema le estaría contestando que no a algo que acaba de decir que sí. El plazo sigue
mandando para todos los demás.

**Cómo se apaga.** Sola, cuando el docente le vuelve a poner **nota**: rehizo, lo corregí de
nuevo, se cerró. O a mano, con el mismo botón, que pasa a decir *"Puede rehacerla · cerrar"*.
Si no se apagara, la primera reapertura le dejaría la puerta abierta para siempre.

El alumno ve un aviso verde —*"El docente te habilitó a rehacer esta entrega"*— porque si no
no tiene forma de enterarse de que la puerta que estaba cerrada se volvió a abrir.

## Alcance

### Lo que el alumno ve

Mientras la entrega esté abierta (D4), la sección **Mi entrega** del modal de la actividad
pasa de ser un formulario de reenvío a ser un **editor de lo que ya entregó**:

- sus archivos entregados aparecen en el mismo grid que los recién subidos, cada uno con su
  **X** para quitarlo;
- la X **no borra nada en el acto**: tacha la tarjeta, la marca *"se elimina al guardar"* y
  ofrece **Deshacer**. El archivo se borra recién al confirmar los cambios;
- puede subir archivos nuevos **sin perder los anteriores**;
- puede editar el comentario;
- el botón dice **Guardar cambios** en vez de *Reenviar*, y desaparece el
  `confirm('¿Querés reemplazar tu entrega anterior?...')`, que ya no describe lo que pasa;
- abajo, separado, **Retirar entrega** (D3).

Cuando la entrega **no** es editable, el cartel dice el motivo exacto en vez del genérico de
hoy:

| motivo | texto |
|---|---|
| `corregida` | *"El docente ya corrigió tu entrega. Solo podés visualizarla."* |
| `vencida` | *"El plazo de entrega venció. Solo podés visualizarla."* |
| `congelada` | *"El docente no permite modificar la entrega una vez enviada."* (el de hoy) |

### Lo que el docente ve

Nada nuevo que aprender. El checkbox sigue donde está, con la misma etiqueta, pero el texto
de ayuda deja de mentir por omisión:

> **Edición del alumno**
> ☑ Permitir que el alumno edite su entrega después de enviarla
> *Se cierra sola cuando le ponés nota o devolución, o cuando vence el plazo. Sin marcar: una
> vez entregada, el alumno solo puede visualizarla.*

La columna **Entrega** de la tabla de notas ya muestra `Act: <fecha>` cuando la entrega fue
modificada después de la primera vez — eso ya existe y no hay que agregarlo.

### Fuera de alcance

- **No** cambia quién puede entregar por primera vez: la corrección solo cierra la edición de
  una entrega **que ya existe**. El docente que corrige en papel y carga la nota a mano sigue
  pudiendo recibir la entrega después (comportamiento de hoy, no hay pedido de cambiarlo).
- **No** toca el plazo ni las entregas tardías.
- **No** avisa al docente que una entrega se editó (más allá del `Act:` que ya está), ni le
  manda notificación.
- **No** guarda historial de versiones: la entrega tiene un estado, no una línea de tiempo.
  El archivo que el alumno elimina se borra del disco.
- **No** toca las actividades interactivas más de lo imprescindible (ver trampa 2).

## Regla única

Vive en **`public/js/edicionEntrega.js`**, cuarta hermana de `visibilidadActividad.js`,
`estadoActividad.js` y `pendienteActividad.js`, por el mismo motivo de siempre: **hoy la
misma pregunta está escrita a mano en cinco lugares** y ya divergieron una vez.

```js
EdicionEntrega.puedeEditar({ act, grade, hayEntrega, ahora })
// → { puede: true,  motivo: 'editable' }
// → { puede: false, motivo: 'vencida' | 'corregida' | 'congelada', texto: '…' }
```

El servidor la importa igual que a sus hermanas —`require('../public/js/edicionEntrega')`,
como hace `routes/activities.js:40` con `visibilidadActividad`— y le pasa el `grade` que saca
de `activity.grades`; el navegador le pasa `act.myGrade`, que ya viaja con `points` **y**
`feedback` y por eso alcanza sin pedirle nada nuevo al servidor. El `texto` del motivo sale
del módulo, no del HTML: así el cartel de la pantalla y el mensaje del 403 dicen lo mismo
porque **son** lo mismo.

**El orden ES la regla:**

```
sin entrega  >  reabierta  >  vencida  >  corregida  >  congelada  >  editable
```

| motivo | cuándo | por qué en ese orden |
|---|---|---|
| **sin entrega** | `hayEntrega === false` | No hay nada que editar: manda el plazo y nada más, exactamente como hoy. |
| **reabierta** | `submission.reopenedAt` | D5. Le gana a todo: es la autorización explícita del docente sobre este alumno, y es posterior a todo lo demás. |
| **vencida** | `act.dueDate` pasada **y** `!act.allowLateSubmissions` | Misma condición, carácter por carácter, que la que ya usan las tres rutas y el `isBlocked` del modal. |
| **corregida** | el `grade` del alumno tiene `points != null` **y** `manual !== false` | D2 corregida: **la nota y solo la nota**. El `manual !== false` es la trampa 2. |
| **congelada** | `act.allowResubmission === false` | D1: el docente lo destildó a propósito para esta actividad. |
| **editable** | todo lo demás | |

Tres precisiones que el código tiene que respetar y el test tiene que fijar:

1. **La devolución escrita no cierra nada.** Es el pedido de rehacer (ver *La corrección del
   04/09*). Un `grade` con `points: null` deja la entrega abierta, tenga o no comentario.
2. **`allowResubmission` se pregunta por `=== false`, no por falsy.** Un documento sin el
   campo (los históricos) se lee como *marcado*, que es lo que la migración deja escrito y lo
   que el default nuevo dice.
3. **`reabierta` no inventa una entrega.** Si el alumno no entregó, la reapertura no aplica:
   a ése lo habilita el plazo, no esto (y la ruta contesta 404).

## Los cinco lugares

La regla se pregunta hoy en cinco lugares, tres de ellos con la condición copiada a mano.
Los cinco pasan a llamar al módulo:

| # | dónde | hoy |
|---|---|---|
| 1 | `exigirAlumnoQuePuedeEntregar` (middleware, antes de multer) → `POST /:id/upload-submission-image` | condición inline |
| 2 | `POST /:id/upload-submission-file` | **la misma condición, escrita otra vez** |
| 3 | `POST /:id/submit` | **y otra vez** |
| 4 | `renderSubmissionSection()` → `canEdit` | `!isBlocked && (!submission \|\| allowResubmission)` |
| 5 | `renderRunnerSection()` → `locked` | `alreadyAnswered && !act.allowResubmission` |

Los 1 y 2 son la misma guarda escrita dos veces, y el 2 va **después** de multer: quien no
puede entregar igual alcanza a empujar 20 MB al disco antes del 403. Al unificar, el 2 pasa a
usar `exigirAlumnoQuePuedeEntregar` como el 1 — se arregla de paso.

## Contrato de la API

### `POST /activities/:id/submit` — un campo nuevo

```jsonc
{
  "text": "…",
  "uploadedFiles": [ { "storagePath": "…", "name": "…", "filename": "…", "mime": "…", "size": 0 } ],
  "keepFiles": ["1725…-a1b2.pdf", "1725…-c3d4.jpg"]   // ← NUEVO: filenames que se conservan
}
```

La lista final de archivos es:

```
(los de existing.files cuyo filename está en keepFiles, en su orden original)  +  uploadedFiles
```

y **los de `existing.files` que no estén en `keepFiles` se borran del disco**.

Tres reglas de borde, y las tres importan:

- **`keepFiles` ausente ≠ `keepFiles: []`.** Ausente = comportamiento viejo intacto (con
  archivos nuevos reemplaza todo, sin archivos nuevos conserva todo). Eso es lo que mantiene
  vivos el flujo `multipart` y los smoke tests que ya existen. `[]` = "no conservo ninguno",
  que es una orden explícita.
- **`keepFiles` solo puede nombrar archivos propios.** Se cruza contra `existing.files` por
  `filename`; cualquier otro nombre se ignora en silencio. El cliente no elige qué archivo
  existe, solo cuál de los suyos sobrevive.
- **La entrega no puede quedar vacía por esta ruta.** Sin archivos y sin texto → `400` con
  *"Tu entrega quedaría vacía. Si querés sacarla, usá «Retirar entrega»."* Retirar es una
  decisión, no un residuo (D3).

Respuesta: la de siempre, `{ submission }`.

### `POST /activities/:id/reopen-submission` — el docente reabre (nuevo)

Body: `{ studentId, reabrir? }` (`reabrir: false` vuelve a cerrar). Marca
`submission.reopenedAt` / `reopenedBy` y responde `{ ok: true, reopenedAt }`.

- Permiso: **el docente que gestiona la materia** (`course.canManage`). El alumno recibe 403.
- **NO pasa por `exigirAlumnoQuePuedeEntregar`**, y no es un olvido: esa guarda contesta 403
  justamente en el estado en el que esta ruta hace falta.
- Sin entrega del alumno: **404**. No se reabre lo que no existe.
- Auditoría: `submission.reopen`, con `accion: habilitó a rehacer | volvió a cerrar`.
- **`POST /:id/grade` la apaga** cuando el docente manda **nota** (no cuando manda solo
  devolución).

### `DELETE /activities/:id/submission` — retirar (nuevo)

Borra los archivos del disco y el documento `Submission`. Responde `{ ok: true }`.

- Misma guarda que editar: no se puede retirar una entrega **corregida** ni **vencida**.
- El alumno confirma en un diálogo que nombra lo que pierde (*"Se van a borrar N archivos.
  Esto no se puede deshacer."*).
- La actividad vuelve a **Pendiente** en el acto (`mySubmission = null`), vuelve a
  *Próximas entregas* si tiene fecha futura, y el contador *"N entregaron"* del docente baja.
- Auditoría: `submission.withdraw`, con la cantidad de archivos borrados.

## Migración

`migrate-permitir-edicion.js`, con `--dry-run` primero, igual que sus hermanos.

Enciende `allowResubmission` **solo donde falta y la entrega sigue abierta**: sin fecha
límite, con fecha futura, o vencida con tardías habilitadas.

```js
{ allowResubmission: { $ne: true },
  $or: [ { dueDate: null }, { dueDate: { $exists: false } },
         { dueDate: { $gt: ahora } }, { allowLateSubmissions: true } ] }
```

Medido sobre el espejo local el 2026-09-04:

| | |
|---|---|
| actividades sin el flag | 595 |
| **de esas, con la entrega todavía abierta → las que toca la migración** | **133** |
| entregas bajo esas 133 | 221 |
| de esas, ya corregidas (siguen cerradas por D4) | 41 |
| **entregas que pasan a ser editables el día del deploy** | **180** |

No toca las 462 actividades ya vencidas con las tardías cerradas: la regla las cierra igual
por `vencida`, así que escribirles el flag sería ruido. La `updateMany` va con
`{ timestamps: false }` para no mover el `updatedAt` de 133 actividades por un cambio que no
es del docente.

> ⚠️ **Esta feature modifica la base de datos de producción.** No se pushea sin avisar antes.

## Criterios de aceptación

1. Un alumno que entregó **un** archivo sube **otro** y guarda: la entrega queda con **los
   dos**, y el primero **sigue en el disco**.
2. Ese mismo alumno quita el primero y guarda: la entrega queda con uno solo y **el archivo
   quitado ya no está en el disco**.
3. La X sobre un archivo ya entregado **no lo borra hasta guardar**, y **Deshacer** lo
   devuelve a la entrega.
4. Con el docente ya habiendo puesto **nota**, `POST /submit`, las dos rutas de subida y
   `DELETE /submission` responden **403** con el motivo `corregida`, y la pantalla muestra el
   cartel de corregida sin formulario.
5. Una **devolución escrita sin nota NO cierra** la edición: el alumno puede rehacer el
   trabajo que el docente le pidió rehacer.
6. Con el plazo vencido y las tardías cerradas: **403** con motivo `vencida`, aunque el
   checkbox esté marcado (D4).
7. Con el checkbox **destildado** por el docente: **403** con motivo `congelada`, y el alumno
   ve el cartel de hoy.
8. Una actividad creada **sin** tocar el checkbox nace con `allowResubmission: true`.
9. `keepFiles` que nombra el archivo de **otro** alumno no lo agrega a la entrega ni lo borra
   del disco.
10. `keepFiles` **ausente** deja el comportamiento viejo intacto: sin archivos nuevos, los
    viejos se conservan; con archivos nuevos, se reemplazan.
11. Guardar sin archivos y sin texto responde **400** y **no** borra la entrega.
12. **Retirar** borra el documento y los archivos, la actividad vuelve a *Pendiente* y a
    *Mis pendientes*, y el contador del docente baja en uno.
13. La pre-subida de un archivo a una entrega ya corregida se rechaza **antes** de multer (el
    archivo nunca toca el disco).
14. Los cinco lugares llaman a `EdicionEntrega.puedeEditar()`; no queda ninguna condición
    `existing && !activity.allowResubmission` escrita a mano.
15. Con la **nota puesta**, `Permitir que lo rehaga` deja al alumno volver a guardar, y el
    alumno ve el aviso de que lo habilitaron.
16. La reapertura le gana también al **plazo vencido** y al **check destildado**.
17. Volver a poner **nota** cierra la reapertura; mandar solo devolución **no** la cierra.
18. El **alumno** no puede reabrirse la entrega a sí mismo (403), y reabrirle a alguien que no
    entregó da 404.
19. El botón del docente llega a **4,5:1** de contraste en tema claro y en oscuro.

## Trampas

1. **El `else` del submit era la única defensa.** Hoy "no mandé archivos nuevos" es lo que
   hace que cambiar solo el texto no borre nada. Con `keepFiles` explícito esa defensa se
   apaga: un cliente con un bug que mande `keepFiles: []` borra la entrega entera y en el
   servidor todo se ve normal (200, sin error, sin rastro). Por eso **ausente ≠ vacío**, y por
   eso hay un test para cada uno de los dos casos por separado.
2. **La autocalificación no es corrección del docente.** Las actividades con
   `templateSnapshot` se autocalifican **al enviarlas**: escriben en `grades[]` con
   `manual: false`. Si la regla no preguntara por `manual`, el cuestionario quedaría cerrado
   en el mismo instante en que el alumno lo responde, y `allowResubmission` —que ahí sí
   significa *"puede volver a intentar"*— dejaría de servir para nada. Hoy en producción hay
   **0 actividades con plantilla**, así que el bug no lo vería nadie hasta la primera; es
   exactamente el tipo de cosa que aparece meses después sin que nadie la relacione.
3. **`corregida` y `Calificada` no son la misma pregunta, y es a propósito.** El chip de la
   tarjeta (`estadoActividad.js`) dice `Calificada` solo con `points != null`; esta regla
   cierra la edición también con la devolución sin nota (D2). O sea: puede haber una entrega
   **no editable** que en la tarjeta figure **Entregada**, no *Calificada*. Son seis casos
   hoy. No es una inconsistencia para "arreglar" unificando: una pregunta es *"¿qué le
   muestro?"* y la otra *"¿lo dejo tocar?"*.
4. **El módulo se carga en `course.ejs` ANTES de `course.js`.** Si va después,
   `EdicionEntrega` es `undefined` y la sección Mi entrega no dibuja nada. Va junto a sus tres
   hermanas (líneas 761-770), y hay un test que compara las posiciones de los `<script>`,
   igual que el de `estadoActividad`.
5. **El alumno con el modal abierto cuando el docente corrige.** Va a ver el botón *Guardar
   cambios* y recibir un 403 al apretarlo. No hay forma de evitarlo sin polling, y no vale la
   pena; lo que sí importa es que el 403 traiga el motivo real (`corregida`) y que la pantalla
   se repinte con el cartel correcto en vez de dejar el formulario puesto.
6. **`Math.abs(firstSubmittedAt - updatedAt) > 2000` es el criterio de "editada"** en dos
   pantallas (la del alumno y la columna Entrega del docente). Retirar y volver a entregar
   **reinicia** `firstSubmittedAt`: la entrega nueva figura como primera entrega, con su fecha
   nueva. Es correcto —es una entrega nueva— pero significa que retirar es también la forma de
   borrar el rastro de la fecha original. Queda en la auditoría (`submission.withdraw`), que
   es donde tiene que quedar.
7. **Quitar y volver a subir el mismo archivo genera un `filename` nuevo.** No hay
   deduplicación por contenido: si el alumno lo quita, guarda, y lo vuelve a subir, es otro
   archivo en disco. El anterior ya se borró, así que no hay fuga; pero `keepFiles` **nunca**
   puede nombrar un filename que ya no está en `existing.files`.
8. **La migración toca 133 documentos, no 595.** Y va con `timestamps: false`. Escribirle el
   flag a las 462 vencidas no cambiaría ningún comportamiento (la regla las cierra por
   `vencida`) pero les movería el `updatedAt` a todas el mismo día, que es la clase de rastro
   falso que después nadie sabe interpretar.

## Tests

Las tres suites de la casa (`npm run test:unit`, `test:smoke`, `test:roles`), y cada caso
verificado **fallando sin el arreglo**.

- **`tests/unit/edicionEntrega.test.js`** (nuevo)
  - la matriz completa de la regla: los cinco motivos × (con/sin entrega) × (nota / devolución
    / devolución borrada / autocalificada) × (plazo abierto / vencido / tardías);
  - `allowResubmission` ausente se lee como marcado, `false` como congelada;
  - el cableado: que `course.ejs` cargue el módulo **antes** de `course.js`;
  - el barrido de `routes/activities.js`: **cero** apariciones de la condición vieja escrita a
    mano (`!activity.allowResubmission` fuera del módulo).
    ⚠️ Ojo con la lección de `fuente_iconos`: el barrido del test **no** puede ser el mismo
    que arma la lista del código, o no protege nada.
- **`tests/smoke/specs.js`** → `edicion-de-la-entrega` (nuevo, de punta a punta)
  1. entregar con un archivo real → 2. agregar un segundo con `keepFiles` → los dos están y
  los dos se descargan → 3. quitar el primero → queda uno y el otro da 404 →
  4. guardar vacío → 400, la entrega sigue → 5. el docente pone devolución sin nota →
  editar da 403 `corregida` → 6. el docente la borra → editar vuelve a andar →
  7. retirar → `my-submission` en null y la actividad de vuelta en *Mis pendientes*.
- **Adecuar lo que ya existe**: `tests/smoke/specs.js:1180` crea la actividad del suite con
  `allowResubmission: '1'` *"porque el suite hace varios submits secuenciales"* — con el
  default nuevo deja de hacer falta, y **el comentario tiene que irse con el flag** o queda
  explicando algo que ya no pasa. Revisar también los specs de visibilidad y de pendientes,
  que entregan sobre actividades propias.
- **`tests/unit/estadoActividad.test.js`**: sumar el caso de la trampa 3 (no editable pero
  chip `Entregada`), para que quede fijado que la divergencia es deliberada.

## Archivos

| archivo | qué |
|---|---|
| `public/js/edicionEntrega.js` | **nuevo** — la regla única |
| `views/course.ejs` | carga el módulo antes de `course.js` |
| `public/js/course.js` | grid de archivos entregados con X + Deshacer, `keepFiles` en el submit, botón Retirar, carteles por motivo, `canEdit`/`locked` desde el módulo |
| `routes/activities.js` | `exigirAlumnoQuePuedeEntregar` usa el módulo y pasa a cubrir también `/upload-submission-file`; `keepFiles` y el 400 de entrega vacía en `/submit`; `DELETE /:id/submission` |
| `models/Activity.js` | `allowResubmission` → `default: true`, con el comentario de por qué cambió |
| `views/activities/new.ejs` | checkbox marcado por defecto + texto de ayuda nuevo |
| `config/audit-actions.js` | `submission.withdraw` (*"retiró su entrega"*, ícono `undo`, categoría `submission`) y la etiqueta de `submission.update`, que hoy dice *"reenvió su entrega"* y pasa a ser *"editó su entrega"* — ya no reenvía nada |
| `migrate-permitir-edicion.js` | **nuevo** — la migración, con `--dry-run` |
| `tests/unit/edicionEntrega.test.js` | **nuevo** |
| `tests/smoke/specs.js` | spec nuevo + adecuar los que dependían del flag |
| `agente.md` | changelog |

## Lo que apareció al implementar (2026-09-04)

Cinco cosas que la spec no tenía escritas y que el código necesitó. Ninguna cambia el
alcance; las cinco cambian detalles que conviene tener anotados.

1. **El 403 ahora dice `motivo`.** Además del texto, la respuesta trae la clave
   (`corregida` / `vencida` / `congelada`). La pantalla la usa para **repintarse** cuando la
   entrega se cierra con el modal abierto: sin eso, el alumno se queda mirando un formulario
   que ya no lleva a ninguna parte (trampa 5). El veredicto del servidor se le pasa
   **forzado** a `renderSubmissionSection()` en vez de falsearle el cache a la actividad, que
   sería inventar una corrección que nadie hizo.
2. **`myGrade` viaja con `manual`.** `GET /activities/course/:id` no lo mandaba, y sin él el
   navegador no puede distinguir una autocalificación de una corrección (trampa 2). El
   servidor decidiría bien igual, pero la pantalla mostraría un cartel que no corresponde.
3. **El 400 de entrega vacía no aplica a las interactivas.** Su entrega son las respuestas,
   que no son ni archivo ni texto: sin la excepción, un cuestionario resuelto se rechazaba
   por "vacío".
4. **`allowResubmission` ausente ya no se lee como destildado en NINGUNA punta.** Además del
   modelo, hubo que arreglar tres lugares que hacían `!!allowResubmission` sobre un campo que
   podía no venir: crear (le pasaba por encima al default nuevo), editar (guardar el modal de
   una actividad vieja le congelaba la entrega al alumno sin que el docente tocara el check) y
   el propio checkbox del modal, que aparecía destildado.
5. **La guarda única trajo la visibilidad de regalo.** `esVisibleParaAlumno` estaba solo en
   el submit; al unificar, las dos rutas de subida también la aplican. Antes se podía
   pre-subir un archivo a una actividad oculta o programada (no servía de nada — el submit
   rebotaba después — pero el archivo quedaba escrito en el disco).

Y una en los tests: **`activity-grade` parte el suite en dos.** Desde que corregir cierra la
entrega, los specs que entregan *después* de esa calificación no pueden usar la actividad del
suite. Hay una segunda actividad, `state.actSinCorregirId`, que no se corrige nunca: la usan
el spec de los planos DWG/DXF y el del 413. El del 413, además, tenía escrito en un comentario
que *"el 413 llega aunque la entrega estuviera cerrada"* — dejó de ser cierto justamente
porque la guarda se movió antes de multer, que era el objetivo.

## Lo que queda afuera y por qué

- **Historial de versiones de la entrega.** Sería lo correcto para una discusión sobre qué
  entregó el alumno y cuándo, pero multiplica el disco por la cantidad de ediciones y no hay
  pedido. Hoy el rastro es `firstSubmittedAt` + `updatedAt` + la auditoría.
- **Avisarle al docente que una entrega cambió.** Con la regla nueva, ninguna entrega puede
  cambiar después de que él la tocó, que es el caso que justificaba el aviso.
- **Bloqueo optimista entre docente y alumno.** Si el docente está corrigiendo en el mismo
  minuto en que el alumno guarda, gana el último. Es una carrera de segundos sobre un evento
  raro; la fecha `Act:` de la columna Entrega deja el rastro.
