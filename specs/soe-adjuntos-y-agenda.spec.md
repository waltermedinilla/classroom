# SOE — Material del legajo (archivos y enlaces) y agenda de citaciones

Estado: **implementada** (2026-08-30) · Módulo: `soe` ·
Extiende `specs/soe-orientacion.spec.md` y `specs/soe-derivacion-y-linea-de-tiempo.spec.md`

## Problema

Pedido del usuario, 2026-08-30:

> *"Quiero que cada actuación, en el rol de SOE, permita adjuntar archivos, enlaces, o demás
> material para acompañar el trayecto del alumno. Si hay una derivación, si vuelve de esa
> derivación, que permita ver algún certificado o receta en caso de que lo haya cargado el
> doctor, el SOE o el alumno. Quiero que quede un registro completo sobre lo que se hace, que
> permita también consignar un calendario si hay que citar a los padres."*

Tres agujeros concretos:

1. **El legajo es TEXTO y nada más.** El certificado que trajo la madre, la receta del
   neurólogo, el informe del hospital y el estudio de la fonoaudióloga viven en una carpeta de
   cartón o en el celular de alguien. El legajo dice *"trajo un certificado"* y no lo puede
   mostrar. Cuando al año siguiente otra persona lee el legajo, esa frase no vale nada. Es el
   mismo problema que la spec madre identificó con las devoluciones de las derivaciones —"el
   chico va al hospital, alguien cuenta algo en un pasillo, y tres meses después nadie se
   acuerda"— pero con el papel en la mano.

2. **La vuelta de la derivación no tiene dónde apoyarse.** La devolución existe como campo de
   texto desde la v1, pero el papel que la respalda no. Justo el momento en que el chico VUELVE
   del servicio externo con algo escrito es el que menos soporte tenía.

3. **Citar a la familia no deja rastro.** El gabinete llama por teléfono, lo anota en un
   cuaderno, y el día que la madre no aparece no queda nada: ni que se la citó, ni para cuándo,
   ni que faltó. Al mes siguiente se vuelve a empezar, y a fin de año nadie puede decir cuántas
   veces se convocó a esa familia.

Las dos specs anteriores habían dejado los adjuntos **fuera de alcance a propósito**, con este
motivo textual: *"los adjuntos de hoy se sirven por URL adivinable desde disco"*. Esa objeción
era correcta y es la que esta spec levanta: acá los archivos **no se sirven por URL adivinable**
(ver D2).

## Alcance

1. **Material en cualquier actuación**: archivos y enlaces colgados de una entrada del
   seguimiento, una derivación, una devolución, una citación, o del legajo en general.
2. **Ruta de descarga con permiso revalidado**, fuera de `/public`.
3. **Citaciones** como una actuación más del legajo: a quién, cuándo, para qué, dónde, cómo se
   avisó, y qué terminó pasando.
4. **Agenda** (`/soe/agenda`): un calendario mensual con las citaciones, los repasos de legajo
   y los seguimientos de las derivaciones.
5. **Panel "Material y documentación"** en la ficha: el índice de todos los papeles del legajo.

### Fuera de alcance (decidido, no olvidado)

- **Que el alumno o la familia suban el papel ellos mismos.** El pedido dice *"en caso de que
  lo haya cargado el doctor, el SOE o el alumno"*. Lo que se implementa es el campo `origen`,
  que registra **quién produjo o trajo** cada papel (`profesional`, `familia`, `alumno`,
  `gabinete`, `escuela`) — así el legajo dice la verdad sobre de dónde salió. Una pantalla del
  ALUMNO para subir al legajo es otra cosa: le abriría al menor una puerta de escritura al
  documento más sensible de la plataforma, con su propia decisión de qué ve de vuelta. Es una
  decisión de producto y va aparte. Ver D5.
- **Notificación a la familia de la citación.** La plataforma no tiene canal con las familias
  (no hay usuarios "familia"). El campo `medio` registra cómo se avisó, que es lo que hoy se
  pierde.
- **Antivirus sobre lo subido.** No hay motor disponible en el VPS y el que sube es un rol de
  confianza. La defensa es la lista blanca cerrada de extensiones más `nosniff`.
- **Recompresión de las imágenes.** A propósito, y es una inversión de la regla de la casa:
  ver D4.
- **Exportar el legajo a PDF.** Sigue fuera, como en las dos specs anteriores.

---

## Decisiones de diseño

### D1 — Los adjuntos van en UN array plano con puntero a la actuación

`SoeCase.adjuntos[]`, cada uno con `ancla: { tipo, id }`, en vez de un array de adjuntos dentro
de `entries[]`, otro dentro de `referrals[]`, otro dentro de `devoluciones[]` y otro dentro de
`citaciones[]`. Tres motivos, en orden de importancia:

1. **La confidencialidad queda en UNA sola guarda.** Es el mismo argumento con el que
   `models/SoeCase.js` embebe todo en un documento: un array, un sanitizado, un lugar donde
   olvidarse de aplicarlo. Con cuatro arrays anidados habría cuatro.
2. **La ruta que sirve un archivo hace UNA búsqueda**: `legajo.adjuntos.id(x)`. Repartidos,
   habría que recorrer cuatro niveles para encontrar uno.
3. **"Todo el material del legajo en una pantalla"** es una lectura que el gabinete necesita
   —*"¿qué papeles tenemos de este chico?"*— y con el array plano sale sola.

⚠️ La clave de agrupación es `tipo:id` y **no el id pelado**: los ids de subdocumento son únicos
por array y no por documento, así que nada impide que una entrada y una citación compartan `_id`.
Con la clave por id, el acta de la citación aparecería colgada de la entrevista.

### D2 — Los archivos NO viven en `/public`, y esa es la decisión central

Un certificado de salud mental servido por `express.static` es un certificado que lee cualquiera
que tenga la URL —o que la adivine—, para siempre y sin dejar registro. Es exactamente la
objeción con la que las dos specs anteriores dejaron los adjuntos afuera.

Los archivos se guardan en `archivos/soe/{schoolId}/{caseId}/{nombre-en-disco}` y se sirven por
`GET /soe/legajo/:id/adjunto/:adjId`, que:

- revalida el **alcance del alumno** contra sus divisiones **actuales**, no contra el snapshot
  `SoeCase.division` (misma regla que toda ruta con `:studentId` del panel);
- exige **nivel completo** (`requireCompleto`), así que un `resumen` no lo abre ni con la URL;
- verifica que la ruta en disco caiga **dentro** de `SOE_BASE` (path traversal);
- manda `X-Content-Type-Options: nosniff` y `Cache-Control: private, no-store`;
- y **audita cada apertura**, también la del propio SOE (ver D3).

El nombre en disco no tiene relación con el que subió la persona: eso evita de raíz las
colisiones (`certificado.pdf` de dos alumnos) y el path traversal en el propio nombre. El
nombre visible viaja en `adjunto.nombre`.

### D3 — Abrir un adjunto se audita SIEMPRE; leer la ficha, no

Al revés que `soe.view_case`, que solo audita la lectura **ajena** (la del propio gabinete es su
trabajo diario y llenaría la auditoría de ruido).

Abrir un certificado médico es un hecho puntual y raro, no el trabajo diario: no genera ruido, y
es exactamente el evento que la escuela va a querer poder reconstruir si alguna vez hay una
pregunta sobre quién vio el papel de un chico.

### D4 — Las imágenes se guardan TAL CUAL, sin pasar por sharp

Es una **inversión deliberada** de la regla de la casa. Los otros seis caminos de imagen del
proyecto recomprimen a WebP (`middleware/image-upload.js`, `config/imagePresets.js`); éste no.

El motivo: acá la imagen es un **documento**, no una ilustración. Un certificado escaneado o
fotografiado es la constancia de algo, y recomprimirlo cambia el papel que la familia entregó.
El preset `adjunto` existe justamente porque *"acá la imagen no se MIRA, se LEE"* — este caso
lleva ese razonamiento hasta el final. El volumen lo permite: son unos pocos papeles por legajo,
no las fotos de 30 chicos en una sala en vivo.

Consecuencia práctica: un `.heic` que llegue **se guarda** (no hay sharp que falle al
decodificarlo) y se descarga. Pero `.heic`/`.heif` siguen **fuera del `accept=`** por la razón ya
documentada en `config/imagePresets.js`: Safari en iOS mira el `accept` para decidir qué manda, y
sin HEIC en la lista convierte la foto a JPG en el camino — que es lo que conviene, porque un
HEIC no se puede previsualizar desde la computadora del gabinete.

### D5 — `origen` es quién lo PRODUJO; `subidoPor` es quién lo cargó

Los dos se guardan porque son cosas distintas: el certificado lo firma el neurólogo
(`origen: 'profesional'`) y lo carga la psicopedagoga (`subidoPor`), porque la familia lo trajo
en papel al colegio.

Confundirlos haría que dentro de un año el legajo dijera que el certificado lo escribió la
escuela, que es lo contrario de lo que pasó. `alumno` y `familia` figuran en la lista aunque hoy
no tengan pantalla propia para subir nada: es el dato honesto sobre de dónde salió el papel, y
es la parte del pedido del usuario que sí se puede cumplir sin abrirle el legajo a un menor.

### D6 — Dar de baja un adjunto borra el archivo y DEJA el registro

`eliminadoEl` + `eliminadoPor`; el archivo se borra del disco. El renglón sigue en el legajo,
apagado y tachado.

Las dos mitades importan. **Borrar de verdad tiene que ser posible**: el día que alguien sube por
error el certificado de otro chico, hay que poder sacarlo. Y **el rastro tiene que quedar**: un
legajo del que se puede sacar material sin dejar huella no es un registro completo.

⚠️ Acá **no** rige la regla de "solo lo propio" que sí rige para las entradas del seguimiento, y
la diferencia es deliberada. Aquélla protege la firma profesional de lo que alguien escribió:
reescribir la entrevista que anotó otra persona borra su palabra. Esto es otra cosa —sacar un
papel de una carpeta— y el caso que lo justifica es concreto: quien esté de guardia ese día tiene
que poder sacarlo ya, no cuando vuelva de licencia la colega que lo subió.

### D7 — La citación se guarda como día de calendario + hora literal, nunca como instante

`dia: 'YYYY-MM-DD'` (String) y `hora: 'HH:MM'` (String), igual que `models/Reserva.js`.

Es la trampa de zona horaria del proyecto: producción corre en UTC, la escuela vive en UTC−3, y
un `new Date('2026-09-02T14:30')` interpretado en el servidor mueve la citación de las 14:30 a
las 11:30 —o al día anterior si es temprano— sin que nadie se entere. Con un día y una hora que
son TEXTO no hay nada que convertir y nada que se corra.

La única conversión que ocurre es la contraria —un `Date` guardado (`proximoRepaso`,
`proximoSeguimiento`) a su día de calendario— y la hace `diaEscolar()` de `services/liveRoom.js`,
que es el único dueño de la hora en todo el proyecto.

Para **ordenar** la línea de tiempo, el día se convierte al **mediodía UTC**: así el día del
calendario es el mismo en cualquier zona entre UTC−11 y UTC+11. La hora nunca se suma a esa
fecha; viaja aparte, como el texto literal que es.

### D8 — La citación FUTURA no entra a la línea de tiempo

Entra cuando su día llegó (`dia <= hoy`) o cuando se resolvió de alguna forma
(`realizada`, `ausente`, `reprogramada`, `cancelada`).

Una citación para dentro de tres semanas es **agenda**, no historia. Con el orden por defecto
("lo último arriba"), se sentaría por encima de todo lo que de verdad ocurrió y el hilo se leería
como si el futuro ya hubiera sucedido.

La **cancelada** sí entra aunque su día no haya llegado: cancelar es algo que pasó, y es
justamente lo que hay que poder leer el año que viene.

`construirLinea` recibe `hoy` como **parámetro** y no lo calcula: la función tiene que seguir sin
mirar el reloj (decisión D6 de la spec anterior). Sin el parámetro, ninguna pendiente entra — que
es el comportamiento seguro: nunca inventa que un encuentro ya ocurrió.

### D9 — Reprogramar CIERRA la citación y abre otra

No mueve la fecha de la misma. La citación a la que la familia no pudo venir y la del jueves
siguiente son **dos convocatorias distintas**, y pisar la fecha borraría del legajo que hubo una
primera. Es exactamente el dato que se quiere conservar cuando, tres meses después, hay que
reconstruir cuántas veces se llamó a esta familia.

Por eso `reprogramada` cuenta como estado **resuelto** y no como activo: si siguiera activa, el
legajo tendría dos citaciones vivas para el mismo encuentro.

### D10 — La citación vencida sin registrar es una alarma

Misma mecánica que la derivación sin respuesta: pasó el día, el estado sigue en
`programada`/`confirmada`, y nadie anotó qué pasó. Se resalta en la ficha, en la agenda y en el
resumen de `/soe`.

Es el agujero concreto del pedido: *aunque la familia no haya venido*, registrarlo es parte del
legajo — es lo que después permite decir cuántas veces se la convocó.

La citación de **hoy** todavía no pide nada: el día no terminó, y resaltar en rojo a las 8 de la
mañana la citación de las 11 sería mentir.

### D11 — El material del legajo no cuelga del hito de apertura

Un informe general cargado hoy aparecería dentro de la tarjeta de apertura, que está al fondo del
hilo por ser lo más viejo, y quedaría escondido justo el día que se subió.

Ese material vive en el panel **"Material y documentación"**, que es un índice y no una
cronología. Las dos lecturas conviven a propósito: el hilo muestra cada papel en su momento; el
panel contesta *"¿qué tenemos de este chico?"*.

### D12 — La devolución puede ser SOLO el papel

Antes, la devolución exigía texto. Con el certificado adjunto es habitual que no haya nada más
que decir que lo que dice el papel: obligar a escribir *"adjunto certificado"* para poder guardar
el certificado es fricción pura.

Y la alternativa —descartar el archivo en silencio porque el texto vino vacío— es **exactamente
el bug de las novedades de agosto** (`cb(null, false)` + `if (req.file)` sin `else`: publicaba sin
foto y contestaba 201). Cuando solo viene el papel, el texto se completa con *"Se recibió
documentación del servicio."*, que es más honesto que una cadena vacía y se lee bien en el hilo.

### D13 — Sin rate limiter en las subidas del panel, a propósito

El `uploadLimiter` del proyecto cuenta **por IP** (1800/hora) y la escuela entera sale por una
sola IP pública NAT. Aplicarlo acá significaría que una clase entregando trabajos prácticos puede
dejar al gabinete sin poder guardar un certificado médico — que es exactamente el modo de falla
que el proyecto ya pagó el 2026-07-28.

Lo que protege esta ruta: sesión autenticada, `requireEscrituraSoe` (rol `soe`, una o dos personas
por escuela), techo de 20 MB y lista blanca cerrada de extensiones.

### D14 — Décima lista de extensiones, deliberadamente distinta

`tests/unit/subidaPlanos.test.js` compara las nueve listas de la actividad, la entrega y la sala.
Ésta es una décima y **no** se unifica con ellas, porque el material es de otra naturaleza:

| | Las nueve | Ésta | Por qué |
|---|---|---|---|
| imágenes | por `EXT_IMAGENES` + sharp | por esta lista, sin sharp | D4 |
| `.zip` | sí | **no** | Un contenedor opaco no se puede leer dentro de un año sin descomprimirlo |
| `.dwg`, `.dxf` | sí | **no** | Son de las materias técnicas; no tienen nada que hacer en un legajo psicopedagógico |
| `.txt` | sí (sala) | sí, pero **nunca inline** | Texto plano subido y servido de vuelta: se descarga, no se muestra |
| ejecutables/HTML | no | no | La tercera pregunta obligatoria por formato nuevo |

---

## Modelo

### `models/SoeCase.js` — dos arrays nuevos

```js
adjuntos: [{
  kind: 'archivo' | 'enlace',
  ancla: { tipo: 'legajo'|'entrada'|'derivacion'|'devolucion'|'citacion', id: ObjectId|null },
  titulo, categoria, origen, descripcion,
  fecha,                       // la DEL DOCUMENTO, no la de carga
  nombre, path, ext, size,     // kind: 'archivo'
  url,                         // kind: 'enlace' (solo http/https)
  subidoPor, createdAt,
  eliminadoEl, eliminadoPor,   // la baja deja rastro (D6)
}]

citaciones: [{
  dia,     // 'YYYY-MM-DD' — TEXTO (D7)
  hora,    // 'HH:MM' o '' — TEXTO
  a: 'familia'|'alumno'|'familia_y_alumno'|'docentes'|'equipo'|'externo',
  motivo, lugar, medio,
  estado: 'programada'|'confirmada'|'realizada'|'ausente'|'reprogramada'|'cancelada',
  notas,   // qué se conversó
  creadaPor, resueltaPor, resueltaEl,
}]
```

**Ninguno de los dos necesita migración**: un legajo viejo simplemente no los tiene, y todo el
código los lee con `|| []`.

Índice nuevo: `{ school: 1, 'citaciones.dia': 1 }`, para que la agenda pida un mes de toda la
escuela sin recorrer los legajos. ⚠️ Es lo único de esta feature que toca la base de producción.

### `services/soeAcceso.js`

`adjuntos` y `citaciones` entran en `CAMPOS_COMPLETO` y **no** en `CAMPOS_RESUMEN`. Un adjunto es
el certificado del neurólogo: es **más** sensible que el texto que lo describe, no menos. Y una
citación dice que a esta familia se la llamó al colegio, que es justo lo que el nivel `resumen`
—pensado para que un docente dé mejor la clase— no tiene por qué saber.

---

## Rutas — `routes/soe.js`

| Método | Ruta | Guarda |
|---|---|---|
| GET  | `/soe/agenda` | `requireCompleto` |
| GET  | `/soe/legajo/:id/adjunto/:adjId` | `requireCompleto` + alcance revalidado |
| POST | `/soe/legajo/:id/adjunto` | escritura |
| POST | `/soe/legajo/:id/adjunto/:adjId/eliminar` | escritura |
| POST | `/soe/legajo/:id/citacion` | escritura |
| POST | `/soe/legajo/:id/citacion/:citId` | escritura |

Y cuatro rutas existentes pasan a aceptar material: `/entrada`, `/derivacion`,
`/derivacion/:refId/devolucion` y las dos de citación.

⚠️ **El orden de la cadena ES la mitigación**: `cargarLegajo` (que valida el alcance) va **antes**
de multer en todas. Multer corre antes que el handler, así que con la validación adentro del
handler el archivo de alguien sin permiso ya estaría escrito en disco cuando se contesta 403. Es
el mismo razonamiento de `routes/rooms.js:589` y de `middleware/image-upload.js`.

Un archivo rechazado **nunca** se descarta en silencio ni aborta el cuerpo: se anota en
`req.adjuntoRechazado` con `cb(null, false)` y el handler lo convierte en un cartel con el motivo
concreto (formato / tamaño / vacío). Las dos formas mal de rechazar una subida ya se pagaron el
2026-08-24.

Y lo que escribió la persona **no se pierde** cuando el archivo rebota: se guarda la actuación y
el cartel dice que falta volver a subir el papel. Perder cuatro párrafos de una entrevista por un
PDF de 25 MB sería el peor de los dos males.

---

## Pantallas

1. **Ficha del legajo** (`views/soe/legajo.ejs`): campos de adjunto en los cinco formularios,
   chips de material en cada hito del hilo y en cada derivación/devolución/citación, panel
   **Citaciones** y panel **Material y documentación**.
2. **Agenda** (`views/soe/agenda.ejs`, nueva): calendario mensual + "los próximos días".
3. **Resumen** (`views/soe/index.ejs`): dos tarjetas nuevas (citaciones por delante / sin
   registrar) y una tabla de citaciones.
4. **Nav** (`views/partials/soe-nav.ejs`) y `config/sections.js`: solapa `soe_agenda`.

Los campos de adjunto viven en **un partial** (`views/partials/soe-adjunto-campos.ejs`) y no
copiados cinco veces: el olvido de actualizar una de las copias ES el bug — es literalmente lo que
pasó con las imágenes en agosto.

⚠️ Todo formulario que lo incluya lleva `enctype="multipart/form-data"`. Sin eso el navegador
manda solo el **nombre** del archivo y el servidor no recibe nada: sin error, sin cartel y sin
nada que investigar después.

---

## Criterios de aceptación

### Reglas puras — `tests/unit/soeAdjuntos.test.js` (nuevo)

1. Ninguna extensión ejecutable o interpretable como HTML entra (`.exe`, `.js`, `.html`, `.svg`,
   `.bat`, los macros de AutoCAD…).
2. Entran PDF, Word e imágenes: la foto del certificado es el caso más frecuente.
3. El `.zip` y los planos quedan afuera, a propósito.
4. `.heic`/`.heif` **no** están en el `accept` pero **sí** los acepta el servidor.
5. El `.txt` se puede subir pero **nunca** se sirve inline.
6. `normalizarEnlace` rechaza `javascript:`, `data:`, `file:` y `vbscript:`; sin esquema asume
   `https`.
7. `agruparPorAncla` deja cada papel bajo su actuación.
8. La clave de agrupación incluye el **tipo**, no solo el id.
9. El adjunto dado de baja sigue en la lista; `vigentes()` lo filtra.
10. Las cinco anclas tienen etiqueta.
11. El techo son 20 MB.
12. `pesoLegible` nunca imprime `NaN` ni `undefined`.

### Reglas puras — `tests/unit/soeAgenda.test.js` (nuevo)

13. Una hora inválida (`24:00`, `9:5`, `14.30`, un ISO entero) se descarta; `''` es legítimo.
14. Una citación activa cuyo día pasó pide atención.
15. La de **hoy** no pide nada todavía.
16. `reprogramada` cuenta como resuelta, no como activa.
17. La citación **futura** no entra a la línea de tiempo.
18. La **cancelada** sí, aunque su día no haya llegado.
19. Un legajo produce hasta tres clases de evento: citación, repaso y seguimiento.
20. Un `Date` guardado al mediodía UTC cae en **su** día, no en el anterior.
21. Un legajo **cerrado** no pide repaso, pero sus citaciones y seguimientos siguen saliendo.
22. La grilla del mes son semanas completas de 7 celdas.
23. Un evento de otro mes **no** se pinta.
24. "Lo que viene" incluye lo **vencido**, no solo lo futuro.
25. `CITACION_ACTIVA` y `CITACION_RESUELTA` parten el conjunto de estados sin superponerse.

### Reglas puras — `tests/unit/soeLinea.test.js` (adecuar)

26. La citación pasada entra al hilo; la futura no.
27. El día se ubica al mediodía UTC y la hora viaja aparte.
28. Motivo y "qué se conversó" son dos campos distintos del hito.
29. El certificado y la receta cuelgan del hito de la **devolución**.
30. Todo hito tiene `adjuntos` (array, aunque esté vacío); el de apertura, vacío siempre.

### Reglas puras — `tests/unit/soeAcceso.test.js` (adecuar)

31. En nivel `resumen`, ni el título de un adjunto ni el motivo de una citación aparecen en el
    JSON serializado del legajo sanitizado.
32. En `completo` sí, y un legajo viejo sin los arrays devuelve dos listas vacías.

### Servidor — `tests/smoke/` (flujo `soe-material-y-citaciones`)

33. El SOE sube un archivo a una devolución y lo ve en la ficha.
34. La ruta del archivo lo devuelve con `nosniff` y `Content-Disposition`.
35. Un archivo con extensión prohibida rebota con cartel, **y el texto de la actuación se guarda
    igual**.
36. Un enlace `javascript:` no queda guardado.
37. Otro rol (o el mismo SOE con un alumno fuera de alcance) recibe 403 en la ruta del archivo.
38. Dar de baja el adjunto lo saca del disco y deja el registro; la segunda descarga da 410.
39. Se crea una citación, se la marca `ausente`, y aparece en el hilo y en la agenda.
40. Reprogramar deja la vieja registrada y crea una nueva.
41. Reprogramar sin fecha no cambia nada.
42. `/soe/agenda` responde 200 al SOE y 403 a quien no tiene nivel completo.

### Matriz de roles — `tests/roles/check-roles.js`

43. `soe_agenda` se comporta como las otras solapas del panel: 403 para todos menos `soe` y
    `superadmin` mientras `School.soeAccess` esté en su default.
