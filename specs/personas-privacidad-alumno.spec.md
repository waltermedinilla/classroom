# El alumno no ve el DNI de sus compañeros

Estado: **APROBADA por el usuario el 2026-09-29**, con P1 = A, P2 = B y P3 = C (ver *Decisiones del usuario* al final) · Módulo: `courses` · Rol: alumno

## Problema

Palabras del usuario:

> *"en el rol de alumno, cuando va a ver dentro de una materia en la solapa personas, un
> alumno puede ver la información de los otros chicos, de los cuales, eso es un problema de
> seguridad, porque puede ingresar teniendo el correo y el dni, quiero que al alumno, solo
> le figure el correo electrónico, y el nombre de los demás participantes"*

La solapa **Personas** de `GET /courses/:id` le muestra a **cualquier alumno matriculado** el
DNI de cada compañero, junto a su nombre y su correo (`views/course.ejs:272`).

## Diagnóstico (auditado antes de escribir)

### Por qué el DNI es una credencial y no un dato más

**La contraseña inicial de las cuentas ES el DNI.** No es una suposición, está en el código:

| Camino | Dónde | Contraseña que pone |
|---|---|---|
| Importación de docentes | `routes/admin.js:1497` | `t.dni` |
| Importación masiva (docentes y alumnos) | `routes/admin.js:1602`, `:1620` | `d.dni` / `a.dni` |
| Importación de alumnos | `routes/admin.js:1678` | `s.dni` |
| **Reseteo de contraseña** del admin | `routes/admin.js:605` | `target.dni` (o `Classroom1234` si no tiene) |

Nada obliga a cambiarla en el primer ingreso. Entonces **correo + DNI = entrar a la cuenta**
de cualquier compañero que no haya cambiado su clave, y de cualquiera a quien el admin le
haya reseteado la contraseña. La solapa Personas entrega los dos datos juntos, en una sola
pantalla, para los ~30 alumnos de cada materia.

### Por dónde sale hoy el DNI hacia un alumno

| Lugar | Llega al alumno | Veredicto |
|---|---|---|
| `GET /courses/:id` — populate `'name email dni active avatar'` (`routes/courses.js:645`) y la vista lo imprime (`views/course.ejs:272`) | **Sí** | ❌ **el agujero** |
| `GET /courses/:id/data` — populate `'name email'` (`routes/courses.js:878`) | Sí, pero sin DNI | ✅ ya está bien |
| `GET /courses/:id/gradebook`, `/export-students`, `/activities/:id/export-grades`, `/activities/:id/submissions` | No: `canManage()` → 403 | ✅ |
| Sala en vivo: `cursoDeLaSala` trae `dni` (`routes/rooms.js:147`), pero al alumno solo le viaja `nombre`/`inicial` (`presenceSummary`, `services/liveRoom.js:366`); el DNI solo va al CSV de asistencia de `cargarSesion`, del gestor | No | ✅ (ver *Fuera de alcance*, punto 3) |
| `/superadmin/messages/users` busca por DNI | No: `requireSuperAdmin` | ✅ |

⚠️ **El arreglo tiene que ser en el servidor, no en la vista.** Envolver la línea 272 en un
`if` alcanzaría para la pantalla, pero dejaría el dato cargado en el objeto que se le pasa
al template, a un `<%= %>` de distancia de volver a salir. Es la misma lección de
`fuga_datos_api_curso`: el dato que no tiene que llegar, no se trae.

### Quién mira la solapa Personas

`GET /courses/:id` exige `canView()` (`services/cursoPermisos.js:89`): o **gestiona** la
materia (`puedeGestionar`: docente titular/suplente, admin de la escuela, superadmin), o es
**alumno matriculado**. No hay un tercer caso. Por eso la regla se puede escribir como
*"quien no gestiona"* sin dejar afuera a nadie.

## Decisiones propuestas

- **D1 — La vara es `canManage()`, no el rol.** El que gestiona la materia sigue viendo lo
  que ve hoy (DNI incluido: lo necesita para identificar alumnos con el mismo nombre, y ya lo
  tiene en el export). El que no gestiona ve la versión reducida. Usar `user.role ===
  'student'` sería una segunda regla paralela a `canView`/`canManage`, y ese fue el origen
  de la fuga del 30/08.
- **D2 — Proyección en una función pura**, `personasVisibles(students, esGestor)`, en
  `services/` (patrón de `devoluciones.js`), para poder testearla sin Mongo. La ruta arma la
  lista y la pasa al template; la vista deja de leer campos sensibles de `course.students`.
- **D3 — Tampoco se trae de la base.** La query de `GET /:id` deja de pedir `dni` para el que
  no gestiona (populate en dos pasos: primero `name email avatar active`, y `dni` solo después
  de comprobar `canManage`). D2 es la red; D3 es no tener el dato en memoria.

## Reglas de negocio

- **RN-1** — Al que **no** gestiona la materia, cada compañero de la solapa Personas le llega
  con **exactamente** `_id`, `name`, `email` y `avatar` (P1 = A). Ningún otro campo.
- **RN-2** — El **DNI de un alumno no aparece en ninguna parte del HTML** que recibe otro
  alumno: ni visible, ni en atributos `data-*`, ni en un `<script>`.
- **RN-3** — El que gestiona la materia ve la solapa **igual que hoy**: DNI, estado
  deshabilitado, botones de habilitar/quitar (estos últimos, como hoy, solo si no es rol
  `teacher`).
- **RN-4** — La sección **Docentes** no cambia: nombre y correo del titular y los suplentes,
  para todos. Ya no muestra DNI.
- **RN-5** — Al que no gestiona, los compañeros con la cuenta deshabilitada (`active: false`)
  **no figuran** en la lista, y el contador (`people-count`) cuenta solo los que figuran
  (P2 = B). Al gestor el contador le sigue contando a todos, como hoy.
- **RN-5b** — El alumno que mira la lista se ve a sí mismo como a cualquier compañero: nombre,
  correo y foto, sin su DNI (su DNI lo ve en su perfil).
- **RN-6** — `GET /courses/:id/data` mantiene su populate `'name email'`: queda fijado por un
  test para que un cambio futuro no le sume el DNI.

## Criterios de aceptación

- **CA-01** — Dada una materia con dos alumnos A y B, ambos con DNI cargado, cuando A hace
  `GET /courses/:id`, entonces el HTML **no contiene** el DNI de B ni el texto `DNI:`.
  *(Es el caso real que reportó el usuario. El test tiene que fallar con el código actual.)*
- **CA-02** — Mismo escenario: el HTML que recibe A **sí contiene** el nombre y el correo de B.
- **CA-03** — Mismo escenario, cuando el **docente titular** hace `GET /courses/:id`, el HTML
  contiene `DNI: <dni de B>` (RN-3: al gestor no se le quita nada).
- **CA-04** — Ídem CA-03 con el **admin de la escuela**.
- **CA-05** — `personasVisibles([{ _id, name, email, dni, active: true, avatar, phone }], false)`
  devuelve objetos cuyas claves son **exactamente** `_id, name, email, avatar`.
  Una clave de más hace fallar el test: la lista es de permitidos, no de prohibidos.
- **CA-06** — `personasVisibles(lista, true)` devuelve los mismos campos que hoy usa la vista
  del gestor (`_id, name, email, dni, active, avatar`).
- **CA-07** — `personasVisibles` con alumnos sin DNI, sin avatar o con `students` vacío no
  tira error y devuelve lo que corresponde (lista vacía para vacío).
- **CA-08** — Cuando A hace `GET /courses/:id/data`, ningún elemento de `course.students`
  del JSON tiene la clave `dni` (RN-6).
- **CA-09** — Dado que B está deshabilitado (`active: false`), cuando A hace
  `GET /courses/:id`, entonces el HTML **no contiene** el nombre, el correo ni el `_id` de B,
  ni el texto `DESHABILITADO`, y el contador muestra un alumno menos que
  `course.students.length` (RN-5).
- **CA-09b** — `personasVisibles(lista, false)` descarta los elementos con `active: false`;
  los que no tienen el campo `active` (cuentas viejas) **se muestran** (`active` por defecto
  es `true` en `models/User.js`).
- **CA-09c** — Mismo escenario que CA-09, cuando el docente titular hace `GET /courses/:id`,
  B figura con el cartel `DESHABILITADO` y el contador cuenta a todos (RN-3).
- **CA-10** — Las suites `test:unit`, `test:smoke` y `test:roles` siguen en verde.

## Errores posibles

Ninguno nuevo. Las respuestas de `GET /courses/:id` (403 `Acceso denegado`, 404 `Curso no
encontrado`) no cambian.

## Tests

- **Unit** — `tests/unit/personasVisibles.test.js`: CA-05, CA-06, CA-07, CA-09b. Verificar que falla
  pisando la función con una que devuelve el objeto entero.
- **Smoke** — en `tests/smoke/specs.js`, junto al flujo del curso: CA-01 a CA-04, CA-08, CA-09 y
  CA-09c, con **dos** alumnos matriculados (si A solo viera su propio DNI, el test no probaría
  la fuga entre compañeros).
- **Roles** — sin cambios esperados; confirmar que `check-roles` pasa.

## Fuera de alcance (pero hay que saberlo)

1. ⚠️ **`GET /register/lookup?dni=` es la puerta del otro lado.** Sin iniciar sesión, dado un
   DNI devuelve **nombre y correo** (`routes/auth.js:292`), y la usan `login.ejs` y
   `register.ejs`. Con la contraseña = DNI, **quien conozca un DNI** (no hace falta ser
   compañero) obtiene el correo y entra. El `authLimiter` de 15 pedidos cada 15 min frena el
   barrido masivo, no el ataque dirigido a un chico en particular. Esta spec cierra la fuga
   *dentro* de la plataforma; esta otra queda abierta. → **P3 = C: el usuario decidió dejarla
   como está** (2026-09-29). Queda registrada como riesgo aceptado.
2. **La causa de fondo es la contraseña = DNI sin cambio obligatorio.** Mientras exista, el
   DNI va a seguir siendo una credencial y cada pantalla que lo muestre será un agujero. El
   arreglo de fondo es *"obligar a cambiar la contraseña en el primer ingreso y después de un
   reseteo"*. Es una feature aparte, con su spec.
3. `cursoDeLaSala` (`routes/rooms.js:147`) trae el DNI al cache de la sala aunque solo lo use
   el CSV del gestor. Hoy no llega al alumno, así que no se toca: sacarlo obliga a repensar
   el cache de la sala (RN-1 de `sala-en-vivo-escala.spec.md`), que se cuidó mucho.
4. El correo de los compañeros **se sigue mostrando**, por pedido explícito del usuario.

## Decisiones del usuario (2026-09-29)

- **P1 = A** — La foto del compañero se mantiene: el alumno ve nombre, correo y foto.
- **P2 = B** — El compañero con la cuenta deshabilitada **no figura** en la lista del alumno,
  y el contador baja (RN-5, CA-09).
- **P3 = C** — `/register/lookup` se deja como está. Riesgo aceptado, ver *Fuera de alcance*,
  punto 1.

## Archivos que toca (estimado)

- `services/personasVisibles.js` — nuevo, función pura (D2).
- `routes/courses.js` — `GET /:id`: populate en dos pasos (D3) y pasar la lista al template.
- `views/course.ejs` — la card "Estudiantes" lee de la lista proyectada; el bloque del DNI y
  del estado deshabilitado solo para el gestor.
- `tests/unit/personasVisibles.test.js` — nuevo.
- `tests/smoke/specs.js` — casos CA-01..CA-04, CA-08 (y CA-09).
- `agente.md` — changelog.

Sin cambios de base de datos: no hay migración ni datos que tocar en producción.
