# Classroom Clone — Especificaciones del Proyecto

## Stack Tecnológico
- **Backend:** Node.js + Express.js
- **Base de datos:** MongoDB + Mongoose ODM
- **Autenticación:** JWT (cookie httpOnly)
- **Templating:** EJS
- **Frontend:** Vanilla JS + CSS Material Design
- **Archivos:** Multer (disk storage, `public/uploads/`; memory storage para imports)
- **Excel:** `xlsx` (lectura de archivos .xls/.xlsx para importación)

---

## Roles de Usuario
| Valor interno | Nombre mostrado | Descripción |
|---|---|---|
| `admin` | Administrador | Acceso total, panel de administración |
| `directivo` | Directivo | Directivo institucional |
| `teacher` | Docente | Puede ser dueño de cursos |
| `preceptor` | Preceptor | Panel propio en `/preceptor`, acotado a las divisiones que un admin le asigna. Ve materias, docentes y alumnos de esos cursos, y administra a los alumnos (alta, edición, baja lógica). **No es auto-asignable** |
| `soe` | SOE | Servicio de Orientación Escolar. Panel propio en `/soe`: legajo psicopedagógico por alumno (situación, seguimiento, derivaciones externas con sus devoluciones) más un panel de indicadores de solo lectura. Ve toda su escuela salvo que un admin le asigne divisiones. **Es el único rol que escribe legajos**; quién más los lee lo decide `School.soeAccess` (default: nadie) |
| `student` | Alumno | Puede unirse a cursos |

> Los valores internos en la BD son en inglés. La traducción al español se hace mediante `res.locals.roleNames` definido como middleware global en `server.js`. Nunca cambiar los valores internos del enum.

---

## Administrador Principal Protegido
- Email: `waltermedinilla@gmail.com`
- No puede ser eliminado ni cambiarle el rol desde el panel
- Constante `PROTECTED_ADMIN_EMAIL` en `routes/admin.js`

---

## Suplantación de Usuario (Impersonation)
El admin puede "ver como" cualquier otro usuario (excepto el admin protegido):
- **Cookie `token`**: sesión activa (puede ser la del usuario suplantado)
- **Cookie `adminToken`**: sesión real del admin, guardada durante la suplantación
- **`POST /admin/users/:id/impersonate`**: inicia la suplantación
- **`GET /exit-impersonate`**: restaura la sesión admin (ruta en `routes/auth.js`, sin auth)
- `res.locals.impersonating` contiene el admin real cuando se está suplantando
- El header muestra una barra naranja con "Estás viendo como [nombre]" y botón para salir

---

## Pantallas (Frontend)

### 1. Login (`/login`)
- Formulario: email + contraseña
- JS: `public/js/login.js` — fetch POST `/login`, redirect a `/`

### 2. Register (`/register`) — **CERRADA desde el 2026-08-23**
- **La pantalla ya no se sirve**: `GET /register` redirige a `/login` y `POST /register`
  contesta `403 { registroCerrado: true }`. Las cuentas las crea un administrador desde
  `/admin/users/create`. Ver `services/registroPublico.js` y el changelog del 2026-08-23.
- La vista (`views/register.ejs`), su JS (`public/js/register.js`) y el handler siguen en el
  repo detrás del flag `REGISTRO_ABIERTO`, para poder reabrirla sin reescribirla.
- Cuando estaba abierta: formulario de nombre, email, contraseña y rol (select — sin admin).

### 3. Dashboard / Tus Clases (`/courses`)
- Header con logo, avatar y menú de usuario
- Drawer lateral con navegación
- Sección "Creadas por ti" — tarjetas azules
- Sección "Unidas por ti" — tarjetas verdes
- Modal "Crear clase": nombre (req), sección, materia, aula
- Modal "Unirse a clase": código de 6 caracteres
- Alumno con 9 materias o más (`MAX_MATERIAS_ALUMNO` en `services/enrollment.js`): no ve «Unirme con un código» ni «Enviar solicitud para unirme»
- JS: `public/js/dashboard.js`

### 4. Curso (`/courses/:id`)
- Header del curso con degradado, nombre, sección, código (badge)
- Tab "Novedades": anuncios con imagen opcional
- Tab "Personas": lista de docente y alumnos
- JS: `public/js/course.js`
- Variables globales: `window.COURSE_ID`, `window.IS_OWNER`

### 5. Admin Dashboard (`/admin`)
- Nav horizontal: Resumen / Usuarios / Materias / Importar
- Grid de 5 tarjetas: usuarios totales, cursos, profesores, alumnos, materias
- Cards de acceso rápido a Usuarios y Materias

### 6. Admin Usuarios (`/admin/users`)
- Tabla con búsqueda por texto + filtro por rol
- Botón "Nuevo usuario"

### 7. Admin Crear Usuario (`/admin/users/create`)
- Formulario: nombre, email, contraseña, rol (incluye admin)

### 8. Admin Perfil Usuario (`/admin/users/:id`)
- Ver datos, cambiar rol, ver cursos del usuario
- Botón "Ver como este usuario" (suplantación)
- Botón "Eliminar usuario"
- El usuario `waltermedinilla@gmail.com` muestra candado y no tiene esos botones

### 9. Admin Materias (`/admin/subjects`)
- Grid de cards con color visual y cantidad de cursos asociados
- Buscador por nombre

### 10. Admin Detalle Materia (`/admin/subjects/:id`)
- Tabla de cursos que usan esa materia (docente, alumnos, código)
- Botones Editar y Eliminar

### 11. Admin Importar (`/admin/import`)
- **Auto-detecta** el tipo de archivo XLS subido
- **Reporte de Alumnos**: importa alumnos (usuario+contraseña=DNI), cursos por división, materias
- **Cargos**: importa docentes (email=`doc.DNI@esc4039.edu.ar`, contraseña=DNI), cursos por materia+división, materias, e inscripción de alumnos existentes
- Wizard de 3 pasos: subir → configurar → resultados

### 12. Superadmin Roles (`/superadmin/roles`)
- Grilla **roles × solapas**, una tabla por panel (Administración, Directivo, Preceptoría, General, Superadministración)
- Selector de escuela arriba: **la configuración es por escuela**
- Cada celda es un toggle que habilita/deshabilita esa solapa para ese rol. Apagarla la saca del menú **y** devuelve 403 en su URL y en las acciones que cuelgan de ella
- Celdas con candado: el rol superadministrador (nunca se restringe), las pantallas de inicio de cada panel (son el destino del redirect de `/`), y Backup/Otros (ya atadas al email del dueño). El motivo va en el `title`
- Botón "Restablecer" por rol: devuelve todos sus accesos por defecto de una sola vez
- Backend: `routes/roles.js` (`GET /`, `POST /toggle`, `POST /reset`) — montado antes del catch-all de `/superadmin`
- Catálogo de secciones: `config/sections.js`. Enforcement: `middleware/sections.js`. Persistencia: `School.rolePermissions` (solo las **denegadas**)

---

## Analítica de producto (PostHog)

Mide comportamiento de uso: pantallas más visitadas y retención, **tiempo activo real** por pantalla (no solo carga de página), clicks en CTAs instrumentados, profundidad de scroll y embudos básicos.

**Apagada por default.** Sin `POSTHOG_KEY` en el `.env`, `res.locals.posthogKey` queda vacío, `views/partials/analytics-init.ejs` no imprime nada, y `public/js/analytics.js` hace un no-op completo al cargar (verificado: sin la env var no existe `window.posthog` ni se genera ningún error de consola). Dev local y CI no dependen de esto para nada.

### Por qué esta configuración es más restrictiva que el default de PostHog
Esta es una plataforma escolar con **alumnos menores de edad**. Antes de tocar código se decidió:
- **Hosting: PostHog Cloud, región EU** (`POSTHOG_HOST=https://eu.i.posthog.com`), no self-hosted. El servidor de producción es una máquina compartida con otro proyecto no relacionado (ver `production_server` en memoria) — sumarle el stack de un PostHog self-hosted (ClickHouse+Kafka+Postgres+Redis) no se justificaba pudiendo usar el free tier de PostHog Cloud (1M eventos/mes, de sobra para una escuela) con residencia de datos en la UE.
- **Sin autocapture** (`views/partials/analytics-init.ejs`): el autocapture de PostHog manda el texto del elemento clickeado, y muchos botones de esta app tienen nombres reales adentro ("Ver perfil de Juan Pérez"). Los clicks que importan se instrumentan a mano.
- **Sin grabación de pantalla** (`disable_session_recording: true`), nunca. Ningún objetivo de medición la necesita.
- **Sin cookie de tracking** (`persistence: 'localStorage'`).
- **Sin nombre/email/DNI en ningún evento.** El `identify()` usa el `_id` de Mongo (ya opaco) más `role` y `school` como propiedades — nunca datos que identifiquen a la persona por sí solos.
- **Computadoras compartidas de la escuela**: `logout()` (`views/partials/footer.ejs`) llama a `posthog.reset()` antes de redirigir a `/login`, y `analytics.js` llama a `reset()` también al aterrizar en `/login` sin sesión activa (red de seguridad si el alumno anterior cerró la pestaña sin desloguearse) — sin esto, el próximo alumno que usa el mismo navegador heredaría la identidad del anterior hasta su propio login.

### Cómo se resuelve cada objetivo
| Objetivo | Cómo |
|---|---|
| Pantallas más visitadas / retención | `posthog.capture('$pageview', { screen_key })` manual (no el `capture_pageview` automático) — usa `res.locals.screenKey`, resuelto en `server.js` con `sectionForPath()`/`normalizePath()` de `config/sections.js`. Reportes nativos de Trends/Retention de PostHog |
| Tiempo activo real | `public/js/analytics.js`: heartbeat de 1s que solo suma si la pestaña está `visible` (Page Visibility API) **y** hubo interacción en los últimos 30s. Manda el acumulado cada 30s y al ocultarse la pestaña (evento `screen_time`, propiedad `seconds`) |
| Clicks en CTAs | Atributo `data-analytics="nombre_evento"` en cualquier botón/link + un listener delegado en `document` (evento `cta_click`). Primer lote instrumentado como referencia: modales del dashboard (`create_course_open/submit`, `join_by_code_open/submit`, `request_join_open/submit`), `login_submit`, `register_submit` |
| Profundidad de scroll | Umbrales 25/50/75/100%, un evento `scroll_depth` por umbral cruzado, throttled con `requestAnimationFrame` |
| Embudos | Sin código extra: se arman en el dashboard de PostHog a partir de la secuencia de eventos ya nombrados (ej. `$pageview screen_key=login` → `login_submit` → `$pageview screen_key=/courses`) |

### Setup pendiente (no se puede hacer desde acá)
1. Crear cuenta/proyecto en **PostHog Cloud, región EU** (`app.posthog.com` con la región EU seleccionada al crear el proyecto).
2. En la config del proyecto (dashboard de PostHog, no código): confirmar que **Session replay** y **Autocapture** estén desactivados a nivel proyecto — los flags del SDK (`disable_session_recording`, `autocapture: false`) ya lo fuerzan del lado del cliente, pero conviene que el proyecto tampoco los ofrezca por si alguien inicializa el SDK distinto en el futuro.
3. Copiar el **Project API Key** (empieza con `phc_`, es pública por diseño — no es un secreto, es análoga al Measurement ID de GA).
4. Sumar al `.env` de producción: `POSTHOG_KEY=phc_...` (y opcionalmente `POSTHOG_HOST` si no es la región EU por defecto).
5. `sudo -u walter pm2 reload classroom --update-env` (¡`reload`, no restart — ver la nota de Deploy Pipeline sobre env vars nuevas!).

Sin estos pasos manuales, todo el código ya está andando pero apagado — no hay riesgo de que se active por accidente.

### Instrumentar un CTA nuevo
Agregar `data-analytics="nombre_del_evento"` al `<button>`/`<a>` — no hace falta tocar `analytics.js`. Elegir nombres en snake_case, cortos y consistentes con el patrón `<acción>_<paso>` (ej. `create_course_submit`).

---

## Backend (API)

### Middleware
| Archivo | Export | Función |
|---|---|---|
| `middleware/auth.js` | `requireAuth` | Verifica JWT en cookie `token`, redirige a `/login` si inválido. Setea `req.userId` |
| `middleware/auth.js` | `checkUser` | Global; setea `res.locals.user`, `res.locals.impersonating`. Actualiza `User.lastSeen` (throttle **1 min**). Ese `lastSeen` es la única señal de "hay alguien trabajando": lo usan el monitor del superadmin y la ventana de mantenimiento |
| `middleware/admin.js` | `requireAdmin` | Retorna 403 si el rol no es `admin` **ni** `superadmin` (el superadmin también pasa) |
| `middleware/superadmin.js` | `requireSuperAdmin` | Retorna 403 si el rol no es exactamente `superadmin` |
| `middleware/sections.js` | `sectionGuard(panel)` | Se monta una vez por router; resuelve qué sección corresponde al path y devuelve 403 si la escuela se la deshabilitó a ese rol. Cubre GET, POST y sub-paths |
| `middleware/sections.js` | `requireSection(key)` | Guarda puntual para una sección concreta (ej. `/admin/audit`, que se monta fuera del router de admin) |

> `sectionGuard`/`requireSection` **solo pueden quitar** acceso, nunca darlo: corren después de los middlewares de rol, que siguen decidiendo el acceso base. Ver `config/sections.js` y la pantalla `/superadmin/roles`.

> El mapa de traducción `res.locals.roleNames` (rol → español) se define como middleware global directamente en `server.js`, no en `middleware/auth.js`.

### Modelos (MongoDB/Mongoose)

#### User
| Campo | Tipo | Detalle |
|---|---|---|
| `name` | String | Requerido, trim |
| `email` | String | Requerido, único, lowercase, trim |
| `password` | String | Requerido, minlength **5**, hasheado con bcrypt en pre-save |
| `role` | String | Enum: admin/directivo/teacher/preceptor/jefe/soe/student |
| `createdAt` | Date | Timestamps |

- Métodos: `comparePassword()`, `toJSON()` (sin password)
- Estático: `getRoles()`

#### Course
| Campo | Tipo | Detalle |
|---|---|---|
| `name` | String | Requerido, trim — nombre de la materia (ej: "Matemática") |
| `room` | String | Default `''` |
| `code` | String | Único, auto-generado (UUID 6 chars uppercase) en default |
| `division` | ObjectId (ref: Division) | **Requerido** — la división/curso (ej: "1°1°") |
| `school` | ObjectId (ref: School) | **Requerido** — escuela dueña del curso |
| `owner` | ObjectId (ref: User) | Requerido — docente del curso |
| `students` | [ObjectId (ref: User)] | Alumnos inscriptos |
| `header` | Object | `{ color, color2, image }` — personalización visual del encabezado |

> ⚠️ El modelo NO tiene campos `section` ni `subject`. La "sección" se modela como un documento `Division` (referenciado por `division`). El nombre de la materia vive en `name`. Al crear un `Course` siempre hay que proveer `division`, `school` y `owner` (los tres son requeridos) o el `create` lanza ValidationError.

#### Announcement
| Campo | Tipo | Detalle |
|---|---|---|
| `course` | ObjectId (ref: Course) | Requerido |
| `author` | ObjectId (ref: User) | Requerido |
| `text` | String | Requerido, trim |
| `image` | String | Null por defecto, ruta relativa `/uploads/...` |

#### Subject (Materia)
| Campo | Tipo | Detalle |
|---|---|---|
| `name` | String | Requerido, único, trim |
| `description` | String | Default `''` |
| `color` | String | Hex color, enum de 10 colores predefinidos, default `#1a73e8` |

> `Subject` es un catálogo de materias. `Course.subject` es un string libre que debería coincidir con un nombre de `Subject`, pero no hay FK estricta.

### Rutas

#### Auth (`routes/auth.js`)
| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/login` | Renderiza `login.ejs` |
| GET | `/register` | **CERRADA (2026-08-23)** — `302` a `/login`. Con `REGISTRO_ABIERTO`: renderiza `register.ejs` |
| POST | `/register` | **CERRADA (2026-08-23)** — `403 { registroCerrado: true }`. Con `REGISTRO_ABIERTO`: crea usuario, JWT cookie, JSON `{ user }` |
| POST | `/login` | Valida credenciales, JWT cookie, JSON `{ user }` |
| POST | `/logout` | Limpia cookies `token` y `adminToken` |
| GET | `/exit-impersonate` | Restaura la sesión admin desde `adminToken` |

#### Courses (`routes/courses.js`) — `requireAuth`
| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/courses` | Dashboard con cursos propios y unidos |
| POST | `/courses/create` | Crea curso, JSON `{ course }` |
| POST | `/courses/join` | Une por código, JSON `{ course }` |
| GET | `/courses/:id` | Vista de curso (solo owner/students) |
| GET | `/courses/:id/data` | JSON del curso |

#### Announcements (`routes/announcements.js`) — `requireAuth`
| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/announcements/course/:courseId` | Lista anuncios |
| POST | `/announcements/create` | Crea anuncio con imagen opcional (Multer) |

#### Admin (`routes/admin.js`) — `requireAuth` + `requireAdmin`
| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/admin` | Dashboard con estadísticas |
| GET/POST | `/admin/users` | Listado y creación de usuarios |
| GET | `/admin/users/:id` | Perfil del usuario |
| POST | `/admin/users/:id/role` | Cambia rol (protege email admin) |
| POST | `/admin/users/:id/delete` | Elimina usuario (protege email admin) |
| POST | `/admin/users/:id/impersonate` | Inicia suplantación |
| GET/POST | `/admin/subjects` | Listado y creación de materias |
| GET | `/admin/subjects/:id` | Detalle de materia |
| GET | `/admin/subjects/:id/edit` | Formulario de edición |
| POST | `/admin/subjects/:id/edit` | Guarda cambios |
| POST | `/admin/subjects/:id/delete` | Elimina materia |
| GET | `/admin/import` | Página del importador |
| POST | `/admin/import/upload` | Parsea XLS, auto-detecta tipo, devuelve JSON |
| POST | `/admin/import/execute` | Ejecuta la importación según tipo y opciones |

#### Secciones (`routes/sections.js`) — `requireAuth` + rol `admin`/`superadmin`/**`jefe`** + `requireSection('admin_sections')`
> Vive **fuera** de `routes/admin.js` aunque su path empiece con `/admin`, y se monta antes que él en `server.js`. Es lo que permite dejar entrar al Jefe de Sección sin aflojar el `requireAdmin` que cubre todo el panel. El jefe solo ve y edita las secciones donde figura en `Section.heads`.

| Método | Ruta | Comportamiento | Jefe |
|---|---|---|---|
| GET | `/admin/secciones` | Listado con buscador; para el jefe, filtrado por `heads` | ✅ |
| GET | `/admin/secciones/create` | Formulario de alta | ❌ 403 |
| POST | `/admin/secciones/create` | Crea la sección | ❌ 403 |
| GET | `/admin/secciones/:id/edit` | Formulario con el árbol de cursos y materias de la escuela | ✅ solo las suyas |
| POST | `/admin/secciones/:id/edit` | Guarda nombre y contenido. Para el jefe **ignora `headIds`** | ✅ solo las suyas |
| POST | `/admin/secciones/:id/delete` | Elimina la sección (no toca cursos ni materias) | ❌ 403 |

---

## Frontend (Archivos Públicos)

### CSS — `public/css/style.css`
Variables CSS para colores, sombras, radios. Componentes:
- Header fijo, avatar, menú usuario, drawer lateral
- Course cards, modales, tabs, announcement card, people cards
- Admin: stats grid, usuarios table, role badges, profile header
- Admin: admin-nav, admin-section-cards
- Subjects: subjects-grid, subject-card, subject-profile-header, color-picker
- Import: upload-zone, import-card, import-results-grid
- Impersonation: impersonation-bar
- Botones: `.btn-primary`, `.btn-outline`, `.btn-danger`
- Responsive: breakpoints 768px y 480px

### JavaScript
| Archivo | Funcionalidad |
|---|---|
| `login.js` | Submit login → POST `/login` → redirect |
| `register.js` | Submit register → POST `/register` → redirect. **Inerte desde el 2026-08-23**: la pantalla que lo carga ya no se sirve (registro cerrado) |
| `dashboard.js` | Modales create/join, escape key, click-outside-close |
| `course.js` | Tabs, formulario anuncio colapsable, post/load announcements |
| `adjuntosActividad.js` | Regla compartida navegador↔servidor: qué adjunto es una imagen (decide la ruta de subida y la miniatura) y qué URL puede guardarse como adjunto. La `require()` `routes/activities.js` |
| `visibilidadActividad.js` | Regla única de "¿el alumno ve esta actividad?" (`availableFrom` + el ojo del docente). También la `require()` el servidor |

---

## Vistas EJS (`views/`)

### Partials
| Archivo | Contenido |
|---|---|
| `partials/header.ejs` | Header fijo, menú usuario, drawer, barra de impersonación condicional |
| `partials/footer.ejs` | Scripts globales (drawer, menú, logout) |
| `partials/admin-nav.ejs` | Nav horizontal admin (Resumen/Usuarios/Materias/Importar). Recibe `{ activePage }` |

### Admin
| Vista | Ruta |
|---|---|
| `admin/dashboard.ejs` | `/admin` |
| `admin/users.ejs` | `/admin/users` |
| `admin/user-form.ejs` | `/admin/users/create` |
| `admin/user-profile.ejs` | `/admin/users/:id` |
| `admin/subjects.ejs` | `/admin/subjects` |
| `admin/subject-form.ejs` | `/admin/subjects/create` y `/admin/subjects/:id/edit` |
| `admin/subject-detail.ejs` | `/admin/subjects/:id` |
| `admin/import.ejs` | `/admin/import` |

---

## Importación desde Excel

### Reporte de Alumnos
- **Detección**: la fila de headers contiene `cuil` o `alumno`
- **Fila 0**: título; **Fila 1**: headers; **Filas 2+**: datos
- **Columnas clave**: [0] CUIL, [1] Documento, [4] Alumno (formato `APELLIDO, Nombre`), [5] Curso, [10] Email familiares, [11] Email contacto
- **Nombre**: se invierte el formato `APELLIDO, NOMBRE` → `Nombre Apellido`
- **Email**: prioriza col [11], luego primera línea de col [10]
- **Contraseña inicial**: número de DNI (col [1] sin "DNI ")

### Cargos Docentes
- **Detección**: la fila de headers contiene `división` o `materia`
- **Fila 0**: headers; **Filas 1+**: datos
- **Columnas clave**: [5] División, [6] Materia, [7] Turno, [9] Persona (formato `XX-XXXXXXXX-X APELLIDO NOMBRE`)
- **Email docente**: `doc.{DNI}@esc4039.edu.ar`
- **Contraseña inicial**: número de DNI extraído del CUIL
- **Por cada par División+Materia** se crea un Course donde `name=materia`, `section=división`

---

## Regla de trabajo: los tests se actualizan con cada cambio

> **Pedido del usuario (2026-08-13): todos los tests deben adecuarse a las actualizaciones que
> vayamos generando.** No es un paso opcional ni "para después": un cambio de comportamiento
> está terminado cuando la suite lo refleja y queda en verde.

Qué implica, en concreto:

1. **Test nuevo para cada bug arreglado o feature agregada.** Si el bug lo reportó alguien de la
   escuela, el test tiene que reproducir *ese* caso y decirlo en un comentario, para que dentro
   de seis meses se entienda qué protege.
2. **Adecuar los tests existentes** que el cambio deja desactualizados. Un test que ya no describe
   el comportamiento correcto se **corrige**; no se borra ni se saltea.
3. **Comprobar que el test falla sin el arreglo.** Es la única forma de saber que sirve de red.
4. **Correr las tres suites y reportar los números**: `npm run test:unit`, `npm run test:smoke`,
   `npm run test:roles`.

Para que la lógica sea testeable, sacarla del DOM o de la ruta y ponerla en una función pura
(`services/*.js`, o un `public/js/*.js` que exporte con
`if (typeof module !== 'undefined' && module.exports)` para servir al navegador y a `node --test`).
El par `public/js/devoluciones.js` + `tests/unit/devoluciones.test.js` es el ejemplo a copiar.

⚠️ Correr smoke y roles seguidos choca con el **rate limit** (429 en la limpieza final de roles,
que deja usuarios de prueba sin borrar). Espaciar las corridas o limpiar a mano.

---

## Notas / Issues Conocidos
1. `GET /courses/create` existe en la ruta pero usa modal en dashboard — no tiene vista propia
2. Archivos subidos a disco local (`public/archivos/` para adjuntos del docente y novedades; `archivos/entregas/` fuera de `public` para entregas de alumnos), sin cloud storage
3. **Sin recuperación de contraseña ni verificación de email.** Sube de prioridad desde el 2026-08-23: cerrado el registro público, cada olvido de contraseña es un pedido manual al admin. No hay ninguna librería de mail instalada en el proyecto.
4. La relación materia↔curso es por coincidencia de texto (`Subject.name` === `Course.name`), no hay FK. Renombrar una materia rompe la asociación. Mejora futura: `Course.subject` como ObjectId ref
5. Rate limiting (`express-rate-limit`) y Helmet **ya están activos** (ver `server.js`)
6. **Cache por-worker** de usuario y escuela (TTL 45s, ver `middleware/cache.js`): reduce load en Mongo pero no se comparte entre workers de PM2 cluster. Cambios de rol/estado/escuela pueden tardar hasta 45s en aplicar en OTRO worker. Ver mitigaciones en el changelog 2026-07-21.
8. **Vistas que asumen `user` no nulo.** `res.locals.user` puede ser null aun detrás de `requireAuth`: la cuenta borrada con cookie viva ya la ataja `req.userMissing` (changelog 2026-08-11), pero queda el camino de una consulta a Mongo que falle dentro de `checkUser` — ahí el usuario queda en null a propósito, para no desloguear a toda la escuela por un problema de base. `views/dashboard.ejs` y `views/partials/header.ejs` ya se protegen. **Siguen sin guarda**: `views/profile.ejs` (22 usos), `views/course.ejs` (5) y `views/admin/user-profile.ejs` (2). No se tocaron porque las tres son inalcanzables con `user` en null: sus rutas consultan Mongo ANTES de renderizar, así que una base caída las hace fallar antes de llegar a la vista. Si alguna vez una de esas rutas puede renderizar sin haber consultado, hay que ponerles la guarda primero.
8. **`public/js/course.js` es compartido por docente y alumno**, pero `views/course.ejs` renderea DOM distinto según el rol (`<% if (course.isTeacher(user._id)) %>`). Todo `document.getElementById(...)` en el **nivel superior** del script debe usar `?.` — si el elemento no existe para ese rol, el `TypeError` corta la ejecución del archivo entero y deja sin inicializar todos los `const`/`let` de más abajo (falla silenciosa, solo visible en la consola del navegador). Ya pasó una vez: ver changelog 2026-07-28 "course.js abortaba entero para el alumno".
9. ~~El smoke test `directivo-sees-courses-with-metrics` falla contra una BD espejada de producción por paginación.~~ **Arreglado el 2026-07-28**: el test ahora busca el curso con `?search=` en vez de esperarlo en la primera página. La suite quedó en **97/97**.
10. ~~Las cuatro rutas de detalle del panel directivo devuelven **500 en vez de 404 cuando el `:id` no es un ObjectId válido**, y los GET de `routes/admin.js` directamente **dejan el request colgado**.~~ **Arreglado el 2026-08-14** con `idMalo()` de `middleware/objectId.js` en las 40 rutas con parámetro de `admin.js`, `superadmin.js` y `directivo.js` — ver el changelog de ese día. Lo cubre el smoke `objectid-invalido-da-404`.
    - **Barrido completo el mismo día**: no queda ninguna ruta `:id` sin guarda en toda la app. **Al agregar una ruta con `:id` nueva, la guarda va en la primera línea del handler** — el smoke no la va a reclamar sola, porque su lista de rutas está escrita a mano.
    - Dos parámetros que NO llevan guarda a propósito, porque no son ObjectId: el `:id` de `routes/dbFixes.js` (es la clave del arreglo, la valida `getFix()`) y el `:token` de `routes/auth.js`. Tampoco la llevan `:filename` ni `:fecha`.
11. En el listado de divisiones, **la suma de la columna "Alumnos" supera el total de alumnos de la escuela**. No es un error: los alumnos se cuentan únicos *dentro* de cada división, y un alumno puede cursar materias de más de una.
12. ~~El superadmin entrando a `/admin` ve tres solapas que no llevan a ningún lado (Tema, Tareas y Plantillas, que son POR ESCUELA y él no tiene escuela).~~ **Arreglado el 2026-08-07** con el campo `needsSchool` de `config/sections.js` — ver el changelog de ese día. Las rutas siguen contestando lo mismo si se escribe la URL a mano: lo que cambió es que el nav ya no ofrece la puerta.
13. **Variables CSS que se usan pero nunca se declaran.** `--background` y `--text-primary, #1a1a2e` se arreglaron el 2026-08-08 (ver el changelog), pero quedan: `--text-primary` sin fallback (47 usos), `--surface-variant` (10), `--divider` (8), y `--hover-bg`, `--success` y `--surface-2` (1 cada una). Para chequear el estado: `grep -rhoE '\bvar\(--[a-zA-Z0-9_-]+' public views | sed 's/var(//' | sort -u` contra los `--nombre:` declarados en `style.css`. Ojo con los falsos positivos: `--card-color` y `--stat-color` **sí** se definen, pero inline en el atributo `style` de la vista. La regla práctica: una `var()` sin declarar en una propiedad **heredada** (`color`) hace que el elemento herede la del padre y suele pasar desapercibida; en una **no heredada** o en un atajo (`background`, `border`) invalida la declaración entera y se pierde el estilo. Por eso `--divider` dentro de `border: 1px solid var(--divider)` deja el borde en `none` — pasa hoy en la textarea de entrega del alumno (`public/js/course.js:1946`).

---

## Auditoría transversal del 2026-08-23 — lo que le falta al proyecto

Barrido completo pedido por el usuario. Todo lo de acá está **verificado en el repo**, no
inferido. Lo funcional que ya figura en el Roadmap no se repite.

### Riesgo, por orden
1. **4 planillas con datos reales de alumnos y docentes están commiteadas**:
   `Basealumnos-materias-docentes.xls`, `Reporte de alumnos, Esc. 4118 (2).xls`,
   `Cargos 4118 202606.xls`, `Servicios 4118 202606.xls`, más
   `public/uploads/activities/1779380808445-v1lnzo8v43.xls`. El `.gitignore` **dice** que las
   planillas con DNI nunca van al repo, pero solo nombra `issues.txt` y `Escuela_4118.xlsx`:
   las otras entraron antes de esa regla y siguen en el índice **y en toda la historia**.
   Son datos de menores. Sacarlas exige reescribir historia sobre `main` → decisión del dueño.
   (El `.git` pesa 507 MB por estos mismos binarios.)
2. **`public/archivos/` se sirve con `express.static('public')` sin guarda** (`server.js`):
   adjuntos del docente y fotos de novedades quedan públicos para cualquiera con la URL. Las
   **entregas del alumno sí están protegidas** (`GET /activities/submission-file/:filename`
   verifica alumno o docente). Es la misma ruta con guarda que ya está pendiente para los
   adjuntos del legajo SOE: un solo trabajo cierra los dos.
3. **Los logs no rotan**: `config/logger.js` crea los transports `File` sin `maxsize` ni
   `maxFiles`. `logs/combined.log` va por 25 MB solo en la máquina de desarrollo.
4. **`npm audit`: 4 altas.** `brace-expansion`, `ip-address` y `body-parser` salen con
   `npm audit fix` sin romper nada. **`xlsx` no tiene fix** (prototype pollution + ReDoS) y es
   el que parsea las planillas que sube el admin → candidato a migrar a `exceljs`.

5. **La escuela entera sigue colgando del Tailscale Funnel.** Es un relay que no está pensado
   para 300 personas entrando a la vez, y ya dejó el sitio inalcanzable el 20/07, 22/07 y
   10/08, más los cortes intermitentes de la franja 6-11 que midió el watchdog. Desde el
   2026-08-23 hay un guardián que lo repara solo (`tools/funnel-guard.js`, ver el changelog),
   pero **eso compra tiempo, no arregla el fondo**: el arreglo es sacarlo del camino con un
   dominio propio detrás del Caddy que la máquina ya corre para el otro proyecto. Falta que el
   dueño consiga el dominio y decida.

### Ingeniería
- **No hay CI.** `.github/` no existe. Hay ~490 unitarios, ~350 smoke y la matriz de roles, y
  **nada los corre solo**; el `pre-commit` de husky es un placeholder y el único hook vivo es
  el autobump de versión. Con el webhook desplegando directo a producción, una regresión llega
  a la escuela sin que nadie la haya frenado. **Es lo de mayor retorno de la lista.**
- Sin linter ni formatter, sin `README`, sin `.env.example`, sin `engines` en `package.json`
  (corre Node 24), sin medición de cobertura.
- Dependencias en fin de vida: **mongoose 6**, **multer 1.x**, **express 4**.
- Monolitos ya formados: `services/dbFixes.js` (1908 líneas), `routes/admin.js` (1825),
  `routes/activities.js` (1407), `routes/directivo.js` (1196).

### Verificado que ya está (no reinvestigar)
- Imágenes en novedades y adjuntas en tareas: **hechas** las dos.
- Los índices de Mongo están bien puestos en los 23 modelos; hay `/health`; hay manejo de
  404/500 al final de `server.js`.
- **CSRF: no hay tokens y está bien** — las cookies van `sameSite: 'lax'`, que ya corta el
  POST cross-site. No abrir ese frente sin una razón nueva.
- **CSP desactivado a propósito** en helmet (las vistas usan estilos y scripts inline).
  Reactivarlo es un proyecto, no un flag.

---

## Historial de Cambios (Changelog)

### 2026-08-23 — El Funnel se repara solo: guardián cada minuto + sección en el monitor

Pedido del usuario: *"como siempre tengo problemas por los dns del funnel, me gustaría que
cada 3 minutos se lance un script"* con los tres comandos de siempre (`funnel status`,
`funnel reset && funnel --bg 3000`, `funnel status`) *"para evitar tener que estar haciendo
ssh y hacerlo yo"*, y verlo *"en la pestaña monitor"*. En el mismo intercambio lo ajustó:
**"chequéalo cada 1 minuto, y si se encuentra caído, generás el reset"**.

**El reset a intervalo fijo habría empeorado el problema.** `funnel reset` da de baja el
registro DNS público y `--bg 3000` lo vuelve a publicar; esa propagación tardó **10-15 minutos**
el 20/07 (y menos de 1 minuto el 10/08). Un reset cada 3 minutos pisa la propagación en curso
y la reinicia desde cero: el nombre no se publicaría nunca y el sitio quedaría caído **para
siempre** — lo contrario de lo que se buscaba. Encima, cada reset corta las conexiones TLS
abiertas: a las 7 de la mañana, con 300 personas entrando, serían microcortes autoinfligidos.
Por eso el guardián **mide primero y repara solo cuando hace falta**, que es exactamente lo
que el usuario terminó pidiendo.

**Cómo funciona** (`tools/funnel-guard.js`, por cron cada minuto):

| | |
|---|---|
| Mide | la app en `localhost:3000`, el DNS público contra `8.8.8.8`, y HTTPS **a la IP** que devolvió ese DNS (nombre en SNI y en `Host`) |
| Repara | con **2 chequeos fallados seguidos** (`FUNNEL_FALLAS`), corriendo los tres comandos tal cual se hacían a mano |
| Espera | **10 minutos** después de reparar (`FUNNEL_COOLDOWN`) para dejar propagar |
| No repara | si la falla es de la aplicación: un reset no la arregla y agrega un corte encima |

**Las dos mediciones que no se pueden hacer de cualquier forma** (las mismas trampas que ya
documentó el watchdog): el DNS se pregunta con un resolver propio contra `8.8.8.8` porque el
del sistema tiene MagicDNS enganchado y devuelve la IP interna `100.x` — un falso OK; y el
pedido HTTPS va **a la IP**, porque consultar el nombre desde el propio server sale por el
túnel y responde 200 aunque el Funnel esté roto para todo el mundo (la trampa del 22/07).

**En el monitor**: sección **Acceso público (Tailscale Funnel)**, la primera de la página —
es la capa que ya dejó el sitio inalcanzable tres veces con el servidor sano, y es la primera
pregunta ante un "no anda". Estado del último chequeo, reparaciones del rango con su marca en
la franja de tiempo, disponibilidad (1 chequeo por minuto ⇒ cada falla ≈ 1 minuto caído) y
franja minuto a minuto con selector 1h/6h/24h/7d.

**Tres estados del panel que valen más que el verde**:
- *Guardián detenido* — hace más de 5 minutos que no llega un chequeo: el cron no corre. Un
  verde con el guardián apagado diría "cubierto" justo cuando no hay nadie vigilando.
- *N reparaciones fallaron al ejecutarse* — detecta pero no puede arreglar (casi siempre, el
  cron no corre como root).
- *Sin datos* — no está instalado, y el aviso trae el comando de instalación.

**Piezas**: `services/funnelGuard.js` (el criterio, testeado) · `tools/funnel-guard.js` (mide y
ejecuta) · `GET /superadmin/monitor/funnel?rango=` (cache 20 s por rango) · sección en
`views/superadmin/monitor.ejs` · `tools/README-funnel-guard.md` · `npm run funnel:estado |
funnel:simular | funnel:reparar`.

**Detalles que importan**
- El panel es **solo lectura**: no ejecuta nada de Tailscale. La app corre como `walter` y el
  reset necesita root; además, un endpoint que resetea el Funnel sería un botón para tumbar el
  sitio desde el navegador.
- El modo literal del pedido original sigue disponible: `FUNNEL_MODO=siempre` resetea en cada
  corrida. Está documentado junto a por qué no es el default.
- La racha de fallas y el enfriamiento salen de leer el propio log, no de un archivo de estado
  aparte que se pueda desincronizar.
- Los dos grupos de botones de rango del monitor (rate limit y Funnel) comparten la clase
  `.rl-rango`; el selector del rate limit era global y le apagaba el rango marcado al otro.
  Ahora cada uno está acotado a su contenedor.

**Tests**: `tests/unit/funnelGuard.test.js` (25 casos). Cubren los dos modos de falla graves y
opuestos: resetear de más (deja el sitio caído para siempre) y resetear de menos (vuelve el
ritual del SSH a las 7 de la mañana).

**No toca la base de datos.** Todo sale de un archivo de log; no hay colección nueva.


### 2026-08-23 — Se cierra el registro público: las cuentas las crea el administrador

Pedido del usuario: *"me gustaría que ya no puedan añadirse o agregarse más alumnos en la
página de login, los únicos roles autorizados para ingresar o crear alumnos y docentes, es
el usuario administrador"*.

**Había DOS puertas de auto-alta, no una**, y se cerraron las dos:

1. **`/register`** — el "Crear cuenta nueva" que colgaba del modal de DNI de la pantalla de
   login. Es la que el usuario nombró.
2. **`/register/invite/:token`** — el enlace de invitación por escuela que genera el
   superadmin. No está en la pantalla de login, pero **daba de alta alumnos y docentes sin
   que interviniera ningún administrador**: cualquiera con el enlace se registraba y, además,
   **elegía su propio rol** de una lista que incluía `directivo` y `soe`. El rol `soe` abre el
   legajo psicopedagógico de un menor. Dejar esa puerta abierta contradecía el pedido de la
   forma más cara posible, así que entró en el mismo cierre.

**Cómo está hecho**: `services/registroPublico.js`, dos flags (`REGISTRO_ABIERTO`,
`INVITACION_ABIERTA`), los dos en `false`. Mismo patrón que `services/selfEnroll.js` y
`services/joinByCode.js` — esta puerta ya fue y vino varias veces en este proyecto, así que
**reabrir cualquiera de las dos es cambiar un `false` por un `true`**, sin tocar rutas,
vistas ni tests.

| Ruta | Antes | Ahora |
|---|---|---|
| `GET /register` | formulario de alta | `302` → `/login` |
| `POST /register` | creaba la cuenta (201) | `403 { registroCerrado: true }` |
| `GET /register/invite/:token` | pantalla con nombre y color de la escuela | `200` con "Registro cerrado", **sin nombrar la escuela** |
| `POST /register/invite/:token` | creaba la cuenta con el rol pedido | `403 { registroCerrado: true }` |

**Detalles que importan**
- Las guardas contestan **antes de tocar la base**, y antes que el chequeo de mantenimiento.
  El 403 ("por acá no") le gana al 503 ("ahora no"): con 503 el que rebota volvería a intentar.
  El orden está fijado por test — si alguien mete un `await User…` arriba de la guarda, se cae.
- **`GET /register/lookup` sigue vivo**: es el "buscá tus datos de acceso con el DNI" del
  login. No crea nada; le dice a quien YA tiene cuenta con qué correo entra.
- **La automatrícula del alumno no se tocó** (`services/selfEnroll.js`), pero perdió una de sus
  dos puertas: la del registro. Hoy la única viva es la del panel del alumno.
- El pie del modal de DNI ya no ofrece "Crear cuenta nueva": ahora dice a quién pedirle el alta.
- Las dos pantallas del superadmin que reparten el enlace de invitación (`schools.ejs`,
  `school-profile.ejs`) llevan un aviso: el enlace se sigue generando y revocando —eso no se
  tocó— pero **hoy no da de alta a nadie**.

**Tests**: `tests/unit/registroPublico.test.js` (8 casos, monta el router en un Express **sin
Mongo**: si una guarda dejara de contestar primero, el test cuelga en vez de pasar) + los
specs `registro-publico-cerrado` y `registro-cerrado-gana-a-la-validacion` en el smoke. Se
adecuaron 7 specs viejos que daban por hecho el auto-registro; los dos actores de Nivel 1
(`teacher`, `student`) ahora los crea el **superadmin** —no el admin de escuela— porque
`POST /superadmin/users/create` deja la cuenta con `school: null`, que es la semántica que
tenían cuando se autoregistraban. Con el alta del admin quedarían CON escuela y media docena
de specs de 403 pasarían a probar otra cosa sin que nadie se entere.

**No toca la base de datos.** No hay campos nuevos ni migración: es todo código.


### 2026-08-19 — El docente adjunta imágenes a la actividad

Pedido del usuario: *"en la creación de una actividad, el docente debe poder subir y compartir
archivos de imágenes"*. Hasta ahora los adjuntos del docente eran solo `.pdf .doc .docx .xls
.xlsx`: la foto del pizarrón, el mapa o la consigna escaneada —lo que más rápido se genera en
el aula— había que subirla a Drive y pegar el enlace.

Era la única pata que faltaba, y por eso llamaba la atención: el **visor ya sabía mostrar
imágenes** a pantalla completa, el **alumno ya podía entregar** en jpg/png/gif, y la **docente
ya compartía fotos en la sala en vivo**. Lo único que no existía era el camino de entrada.

**Qué se agregó**: los dos formularios de creación aceptan `.jpg .jpeg .png .webp .gif .heic
.heif` —los mismos que el resto de la plataforma, HEIC incluido porque es lo que sale del
iPhone— con un botón propio **"Subir imagen"** que en el celular abre la cámara y la galería
directas. El alumno la ve como un adjunto **con miniatura**, y al tocarla se abre a pantalla
completa en el visor de siempre. Spec: `specs/actividad-imagenes.spec.md`.

**Ruta nueva y no una extensión más en la lista**, que era lo obvio y estaba mal: la imagen no
se guarda como llega. `POST /activities/upload-image` la recibe **en memoria** y la recomprime
a WebP con un preset propio antes de tocar el disco, igual que avatares, portadas, novedades y
la sala. Una foto de celular de 4 MB termina en unos cientos de KB, que es lo que van a bajar
30 alumnos al abrir la tarea. La respuesta es **idéntica** a la de `/upload-attachment`, así
que el formulario mete las dos en el mismo `uploadedFiles` sin recordar de dónde vino cada una.

**El preset `adjunto` es el único que se va por arriba de 1600** (2000 px, calidad 82). Acá la
imagen no se mira, se **lee**: la consigna escrita a mano, el ejercicio del libro, el mapa con
referencias chicas. El alumno le hace zoom en el celular, y con el techo de una novedad el
manuscrito se empasta justo cuando lo necesita legible. Hay un test que lo sostiene, para que
"unificar los presets" no lo deshaga sin querer.

**Dos cosas que estaban mal y salieron en el camino** (las dos con test):

- **El permiso se chequeaba después de multer.** Alguien ajeno a la materia alcanzaba a
  escribir 50 MB en su disco y recién después leía el 403 — la ruta los borraba a mano con un
  `unlink` que ahora sobra. El guard `exigirGestorDelCurso` corre **antes** de recibir el
  cuerpo. Es la regla que ya había dejado escrita la sala en vivo.
- **`uploadedFiles` se guardaba a ojos cerrados.** Es un JSON que arma el navegador: lo que
  llegaba era lo que quisiera mandar quien llamara la ruta, no lo que se había subido. Se podía
  dejar como "archivo" de la tarea cualquier URL —incluida una `javascript:`— y quien la abría
  era el alumno; y un `..` en el medio hacía que borrar la actividad hiciera `unlink` fuera de
  la carpeta de adjuntos. Ahora cada URL pasa por `esUrlDeAdjunto()` y la creación se corta
  entera si alguna no cuelga de `/archivos/`.

**De regalo, un contraste**: el chip *"2 archivos"* del muro fijaba `background:#f0f4f8` con
`color: var(--text-secondary)` — en modo oscuro quedaba gris claro sobre gris claro, ~1,9:1. El
color era exactamente `var(--bg)`, así que el arreglo no cambia un solo píxel en modo claro. Es
otra vez la regla de la sala: si el texto viene de una variable, el fondo también.

**Sin cambios en la base**: la imagen es un `attachment` más (`type: 'file'`), se distingue por
la extensión del nombre. Nada que migrar en producción y las actividades viejas quedan igual.

**Tests**: 12 unitarios nuevos (`tests/unit/adjuntosActividad.test.js`) sobre las reglas
compartidas navegador↔servidor —incluido uno que compara la lista de extensiones del navegador
contra la que autoriza el servidor y falla si alguien toca una sola—, 1 de imágenes para el
preset nuevo, y un spec de smoke que sube la foto, la adjunta, la ve el alumno, la rechaza para
el alumno que intenta subirla, rebota el PNG falso y el `.txt`, y comprueba que borrar la
actividad se lleva el archivo del disco.

Suites completas: **474 unitarios · 18 de imágenes · 349 smoke · matriz de roles sin hallazgos**.
La guarda de `uploadedFiles` se verificó **desactivándola**: sin ella el smoke recibe 201 y la
URL externa queda guardada como adjunto de la actividad, que era exactamente el agujero.

Un detalle del spec de smoke que vale para el próximo: la primera versión subía un PNG de 1×1 y
fallaba pidiendo un `.webp`. **Estaba bien que fallara**: con una imagen diminuta el optimizador
conserva el original a propósito (el WebP pesaría más), así que el test medía la rama equivocada.
Se cambió por una foto de 2400×1800 generada con `fotoDePrueba()`.

### 2026-08-19 — La sala en vivo: fotos del alumno, responder citando, y el chat que no se leía en oscuro

Tres pedidos del usuario en la misma pantalla.

**1. El alumno comparte fotos.** Los adjuntos existían desde el 2026-08-10 pero eran solo de
quien daba la clase: el chico que resolvía el ejercicio solo podía describirlo por texto. Ahora
sube **imágenes** (nunca archivos: una foto es una foto, un `.docx` de 20 MB por alumno es otro
problema y otra moderación). Misma recompresión a WebP con el preset `sala`, misma ruta
autenticada, mismo borrado real de disco.

Para que la docente no quede sin herramientas, el permiso tiene **tres condiciones y valen las
tres**: sala abierta, interruptor prendido, y poder escribir.

- El **interruptor** es propio (`settings.studentsCanShareImages`, botón "Sin fotos de
  alumnos"): cuando las fotos se van de tema se cortan **sin callar a la clase**, que era lo
  único que se podía hacer antes.
- La tercera condición es la que pidió el usuario con todas las letras: **silenciar a alguien lo
  silencia entero**. Al que se le sacó la palabra no puede seguir hablando por foto.
- El botón de la cámara **se apaga solo** en la pantalla de los alumnos en el poll siguiente, sin
  que nadie recargue, y el chat dice por qué. El servidor revalida igual: esconder un botón no
  es un permiso.
- Cupo: **5 imágenes cada 10 minutos por alumno** (la docente conserva sus 20), por usuario y no
  por IP — la escuela entera sale por una sola IP NAT.

**2. Responder a alguien, como en WhatsApp.** Con treinta personas escribiendo, "sí, dale" no
dice nada. Ahora cada mensaje tiene "responder", la cita aparece arriba del cuadro de escribir
y viaja adentro de la burbuja; tocarla lleva al original y lo resalta. Se responde a texto y a
adjuntos, **nunca a un aviso del sistema** (no es de nadie), y una imagen también puede salir
como respuesta — mostrar la carpeta *contestándole* a la consigna es el caso de uso.

La cita se guarda como **snapshot** (`RoomMessage.reply`) y no como un `populate`: el poll pinta
hasta 100 mensajes cada 4 segundos por persona, y resolver la cita ahí sería agregarle una query
a **el** camino más caliente de la app. Eso obliga a su contraparte: **borrar un mensaje apaga
las citas que lo copiaban** (`live.apagarCitasDe`), o la moderación no moderaría nada — el texto
seguiría vivo dentro de cada respuesta. Se paga al borrar, que pasa de a uno, no en cada poll.
Un `replyTo` inexistente, de otra sesión o del sistema manda el mensaje **sin** cita: nunca un
error en la cara.

**3. El modo oscuro: "no se veía el texto".** Era literal. `.lr-msg.mio .lr-burbuja` fijaba el
fondo celeste `#e8f0fe` **sin declarar el color del texto**, así que en oscuro heredaba
`var(--text)` (`#e3e5e8`, casi blanco): **1,10:1 medido en el navegador**. Cada uno veía en
blanco sobre blanco exactamente sus propios mensajes. Lo mismo su propia reacción. Se coló
cuando la sala pasó a seguir al tema por variable (2026-08-17) y estas dos reglas quedaron con
el hex de cuando la sala era una pantalla clara de punta a punta.

Arreglado y **medido en el navegador sobre los colores compuestos**, no a ojo: burbuja propia
**12,6:1**, reacción propia 8,5:1, cita 7,0:1. De paso, midiendo aparecieron cuatro más:

- Los grises tenues del chat (avisos del sistema, pie de las cards, y los botones "responder" y
  "borrar", que son **controles**) daban 3,52:1 en oscuro y **2,64:1 en claro** — el tema claro
  estaba peor y nadie lo había mirado. Los dos suben con **una** variable local de la sala
  (`--lr-tenue`), sin tocar la paleta global que usan otras 30 vistas.
- Las pastillas de reacción, en fondo `--surface` sobre una tarjeta `--surface`, se distinguían
  por un borde de 1,3:1: no se veían como controles.
- El borde del cuadro de escribir, casi invisible en oscuro.
- El avión de enviar tenía la variante oscura escrita **y no se aplicaba nunca**: el color
  estaba en un `style=` inline, que le gana a cualquier hoja. Seguía en 3,59:1.

Quedó **un** hallazgo sin tocar y está en el backlog: `.btn-outline` da 3,59:1 en los dos temas,
pero es el botón global de la app (151 usos en 54 vistas) y arreglarlo es un cambio de paleta,
no un arreglo de esta pantalla.

**Reglas al servicio, y bajo test.** `puedeEscribir` vivía suelta en `routes/rooms.js`; ahora
está con sus dos hermanas nuevas (`puedeCompartirImagen`, `puedeBorrarMensaje`) en
`services/liveRoom.js`, recibiendo un contexto plano en vez de `req` — se componen entre ellas
y se testean sin levantar Express. El permiso de borrado ahora **viaja mensaje por mensaje**
(`puedoBorrar`) en vez de repetir "soy la docente" en el navegador.

**El borrado propio**: el autor borra lo suyo **mientras la sala esté abierta**. Cubre el "subí
la foto equivocada" sin convertir el borrado en una forma de limpiar, la semana siguiente, el
rastro de lo que uno dijo. La docente sigue borrando cualquier cosa y en cualquier momento.

**Ni una migración**: `reply` es `null` y `studentsCanShareImages` es `true` por default, así que
los documentos existentes se comportan igual que antes. **La base de producción no se toca.**

Spec: `specs/sala-imagenes-y-respuestas.spec.md`. Tests: `tests/unit/salaChat.test.js` (27, con
el contraste **calculado** a partir de los colores del archivo — mirarlo a ojo una vez es lo que
ya se había hecho y la regresión entró igual) + 3 specs de smoke nuevos (`sala-borrado-propio`,
`sala-imagen-alumno`, `sala-responder`) y 2 viejos adecuados. El CSV de la transcripción y la
vista de clase archivada suman la columna "Responde a": ahí es donde se reconstruye un episodio,
y una clase entera de "sí", "dale" sin saber a qué contestaba cada uno no reconstruye nada.

### 2026-08-18 — Actividad programada + botón de ojo

El docente prepara con anticipación la actividad de una clase futura. El campo
`availableFrom` ("Disponible desde") ya existía y el servidor ya se la filtraba al alumno,
**pero el docente no lo veía en ninguna parte**: en su lista la programada figuraba igual que
una publicada, así que la feature era invisible y no la usaba nadie. Tampoco había forma de
adelantar o retirar una publicación sin editar la fecha a mano.

Ahora:

- La actividad con "Disponible desde" a futuro le figura al docente **atenuada**, con el chip
  **"Programada · \<fecha\>"**, y se publica sola cuando llega esa fecha (nada corre en
  segundo plano: es una condición de lectura, no una tarea programada).
- Un **botón de ojo** en la tarjeta — y una barra en el detalle — invierte el estado: publica
  ya la programada, u oculta una que ya estaba publicada (chip **"Oculta"**).
- Al elegir una fecha futura, el formulario avisa que la actividad va a quedar deshabilitada
  en vez de dejar al docente creyendo que se publicó.

Modelo: `Activity.visibleOverride` (`null` = automático por fecha, `true` = mostrar ya,
`false` = ocultar). Los documentos anteriores no tienen el campo y se leen como automático:
**el comportamiento de todo lo ya cargado no cambia y no hace falta migrar nada.**

El ojo **no cicla entre tres estados**: invierte el estado efectivo y, si con eso alcanza
volver al automático, borra el override en vez de fijarlo — así **la fecha programada nunca
se pierde** al ir y volver.

La regla vive en **un solo archivo**, `public/js/visibilidadActividad.js`: la `require()` el
servidor (para filtrar el listado, los pendientes y el resumen del inicio) y la carga el
navegador (para el chip y el ícono). Un test cruzado verifica que el fragmento de query de
Mongo acepta exactamente los mismos documentos que la función pura.

De paso quedaron cerrados dos huecos que la feature dejaba a la vista: `POST
/activities/:id/submit` ahora rechaza con 403 la entrega a una actividad que el alumno no
debería estar viendo (por link directo), y el muro de la materia ya no muestra al recargar la
programada que `createActivity()` no le agregaba al crearla.

Spec: `specs/visibilidad-actividades.spec.md`. Tests: `tests/unit/visibilidadActividad.test.js`
(15) + 7 specs de smoke (`visibilidad-*`).

### 2026-08-18 — Las subidas ahora se reintentan solas

Mitigación del corte del Funnel medido esta misma mañana (ver el changelog de abajo). La
subida se rendía en **un segundo** y el corte dura **uno o dos minutos**, así que el docente
veía el error al instante y reintentaba a mano — una lo hizo **seis veces con el mismo PDF
entre las 08:49 y las 09:00**. Ahora el navegador insiste solo: el envío original más 3
reintentos, esperando 5 s, 15 s y 30 s. **Cuatro envíos repartidos en 50 segundos**, que es del
orden de lo que dura un corte.

Si se agota la ventana, lo que ve la persona es **exactamente lo de antes**: la tarjeta se
borra y sale el cartel con un único código `SUB-XXXXXX`. No se agregó ningún elemento nuevo a
la pantalla de fallo.

**A qué se le insiste y a qué no.** Es la única decisión que importaba, porque insistirle a
algo que la aplicación rechazó a propósito no lo arregla y en dos casos lo empeora. La regla:
**si el cuerpo de la respuesta parsea como objeto JSON, contestó la aplicación y no se
reintenta.** Ningún intermediario —Funnel, proxy, balanceador— devuelve JSON; devuelven HTML o
texto plano. Es la misma bifurcación que ya organiza el diagnóstico entero.

| Situación | Quién contestó | Decisión |
|---|---|---|
| Conexión cortada (0 bytes, ~1 s) | nadie | **reintenta** ← el caso real |
| 502 / 504 del proxy | un intermediario | **reintenta** |
| 403 sin acceso, 400 de validación | la app | no |
| 429 de rate limit | la app | no — insistirle a un límite es la única forma de empeorarlo |
| 503 de mantenimiento | la app | no |
| Cualquier 413 por tamaño | la app o un proxy | no — es determinista |

⚠️ **Dos casos que parecían obvios y no lo eran**, y que definieron el criterio final:

1. **No alcanza con buscar el campo `error`.** El 503 del modo mantenimiento responde
   `{ maintenance, message, eta }` **sin** `error`, y los tres caminos de subida mandan
   `Accept: application/json`, así que caen justo ahí. Con la regla del `error`, una ventana de
   mantenimiento habría hecho que **cada subida golpeara el servidor cuatro veces en cincuenta
   segundos** — lo contrario de lo que el mantenimiento pide. Por eso la pregunta es "¿es un
   objeto JSON?" y no "¿tiene tal campo?": así quedan cubiertas las formas de error futuras.
2. **El 413 de un intermediario tampoco se reintenta**, aunque no sea nuestro. Un límite de
   cuerpo es configuración estática: los cuatro intentos darían el mismo 413 y serían cincuenta
   segundos del docente para llegar al mismo lugar. Solo se reintenta lo que puede cambiar solo.

**Lo que ve la persona mientras espera**: `Reintento en 12 s` con cuenta atrás, y
`Reintentando 2 de 4` al arrancar cada envío. Nada de rojo ni de "Error" mientras quede
ventana — todavía no hubo fallo, y pintar en rojo algo que en cinco segundos va a andar enseña
a desconfiar de la pantalla. La barra vuelve a `0%` en cada espera: dejarla en el 8 % del
intento que acaba de morir es la única forma de que la tarjeta mienta.

**El reintento le regala un dato nuevo al diagnóstico.** El reporte se manda **una sola vez**,
al agotarse la ventana (el endpoint tiene rate limit de 30 por hora por persona: avisar en cada
intento quemaría cuatro slots y mostraría un código que no es el del fallo reportado), y ahora
lleva el campo `intentos`. Con eso `ver-subida.js` puede decir algo que antes no se podía saber
de ninguna forma: *"Falló los 4 intentos repartidos en ~50 s: el corte duró, no fue un pico"* —
que separa "se cayó un paquete" de "el Funnel estuvo abajo".

⚠️ **`nuevoIntento()` reinicia `t0` y `enviados` a propósito.** Si acumularan los cuatro
intentos, `ms` daría ~50.000 y el informe concluiría *"decenas de segundos → el archivo ya
estaba arriba, mirá el timeout del proxy"*: falso, y manda a la capa equivocada. `ms` y
`enviados` siguen describiendo el **último** intento; lo nuevo es `intentos`.

**No se agregó `xhr.timeout`**, aunque los tres `ontimeout` sigan siendo código muerto. No es la
causa (las 21 fallas dispararon `onerror` en menos de dos segundos) y no hay un valor que sirva:
`xhr.timeout` mide el tiempo **total** desde `send()`, así que un valor corto para rescatar un
socket colgado mataría una subida legítima de 50 MB en el wifi del aula. Si algún día se quiere
cubrir ese caso, la herramienta correcta es un **vigía de estancamiento** (abortar si pasan 30 s
sin que avance un byte), que distingue "lento pero vivo" de "colgado". Primero habría que medir
si ocurre.

**Riesgo aceptado**: si el servidor recibe el archivo y se pierde la respuesta, el reintento
sube un duplicado. En el adjunto del docente y en la entrega es inofensivo (queda un huérfano
que `cleanup-files.js` ya barre, porque solo la respuesta del intento exitoso entra en la
lista). **En la sala en vivo se vería**: crea un mensaje en el chat. Es acotado y reversible —
se borra con el `DELETE` que ya existe— y la solución de fondo sería una clave de idempotencia,
que hoy sería resolver un problema no observado.

**Alcance**: los 3 caminos (`views/activities/new.ejs`, `public/js/course.js`,
`views/partials/live-room.ejs`). **Tests**: 13 casos nuevos en
`tests/unit/subidaDiagnostico.test.js` y el campo `intentos` sumado a los 2 specs de smoke del
diagnóstico. Suites: **386 unit · 329 smoke · roles sin hallazgos**. Verificado además en el
navegador contra un puerto cerrado: los 4 envíos salieron a los 0,0 s / 5,0 s / 20,1 s / 50,1 s,
con la cuenta atrás corriendo, y al agotarse un solo código.

⚠️ **Trampa de orden de carga que hay que respetar en la sala en vivo**: en `views/course.ejs`
el partial `live-room` se incluye **antes** de que cargue `/js/subida-diagnostico.js`. Toda
referencia a `SubidaDiag` tiene que quedar **dentro** de `subirAdjunto()`; una referencia en el
nivel de arriba del IIFE anda en la sala suelta y tira `ReferenceError` en la solapa "En vivo"
de la materia — un bug que aparecería en una sola de las dos vistas. Está comentado en el código.

---

### 2026-08-18 — El diagnóstico de subidas se equivocaba en las dos direcciones

Llegó el **primer código real** del cartel de subidas (`SUB-9JDGX2`, una docente con un PDF de
739 KB) y con él los primeros 21 casos registrados. Usar la herramienta en serio destapó que
mentía, y en los dos sentidos a la vez — que es el modo de falla propio de un instrumento de
diagnóstico: no se rompe, **afirma con seguridad algo que no midió**, y manda a revisar la capa
equivocada.

**Bug 1 — decía "1 KB" cuando eran 0 bytes.** El `mb()` de `public/js/subida-diagnostico.js`
redondeaba con `Math.max(1, Math.round(b / 1024))`, puesto ahí para que un archivo de 300 bytes
no dijera "0 KB". Pero aplastaba también el cero de verdad: el cartel le decía a la docente
*"se alcanzaron a enviar 1 KB de 739 KB"* cuando el navegador **no había enviado nada**. La
distinción es justo la que la herramienta existe para hacer:

| Lo que dice | Lo que significa | Dónde hay que mirar |
|---|---|---|
| 0 bytes enviados | la conexión **nunca se estableció** | el Funnel, el proxy |
| 1 KB enviado | se estableció y **murió transmitiendo** | el ancho de banda, el enlace |

Encima el informe del servidor mostraba "0 KB" —tiene su propio `mb()` sin el `Math.max`—, así
que los dos números salían del mismo dato y no coincidían. Ahora el cero exacto se resuelve
antes del redondeo, y el cartel dice *"No se alcanzó a enviar nada del archivo (0 de 739 KB)"*.

**Bug 2 — afirmaba que el archivo había subido entero sin haberlo medido.** Las subidas de la
sala en vivo salen por `fetch`, que no puede informar progreso, así que van con
`progresoMedible: false` y el reporte llega **sin** `enviados`. En `veredicto()` de
`tools/ver-subida.js` eso dejaba `pct` en `undefined`, la condición `pct < 100` daba falso y
caía al `else`: *"alcanzó a enviar el archivo entero, sospechá de un timeout de un
intermediario"*. Un timeout que nadie observó. Contradecía el principio que el propio
`subida-diagnostico.js` declara en sus comentarios — *un diagnóstico que miente con seguridad
es peor que uno que dice "esto no lo sé"*. Ahora hay una tercera rama que admite que no sabe y
manda a leer el campo `tardó`, que sí acota el caso.

**Tests**: `tests/unit/subidaDiagnostico.test.js`, 7 casos nuevos. Los 3 que apuntan a los bugs
se verificaron en rojo antes del arreglo. Para poder testearlos, los dos archivos adoptaron el
patrón de export dual de `public/js/ratelimit-chart.js` (`window.*` en el navegador,
`module.exports` bajo `node --test`); `mb` y `detalleHumano` salen **solo** por `module.exports`,
así que la superficie pública en el navegador no cambió. `ver-subida.js` corre igual como CLI:
el `main()` quedó detrás de `require.main === module`.

**Lo que mostraron los 21 casos** — 4 personas distintas, las 3 rutas de subida, archivos de
321 KB a 2,1 MB, **0 bytes enviados en 19 de 21**, muriendo en 0,0–1,5 s, todos declarando
conexión `4g`, concentrados entre las 08:36 y las 09:33. Eso **descarta el límite de tamaño de
cuerpo**, que era la sospecha número uno del caso abierto desde el 15/08 ("PDFs de ~3 MB"):
falla un PDF de 321 KB, y un tope de tamaño rechaza al final, no en el byte cero. También
descarta que sea una persona, un dispositivo o una ruta. La franja horaria coincide con el
[incidente matutino](#) ya cerrado y medido: cortes intermitentes de 1-2 minutos del Tailscale
Funnel. Laura Vásquez reintentó el mismo PDF **seis veces entre 08:49 y 09:00** y falló siempre.

**Se midió el mismo día y cerró el caso.** Cruzando las `subida_fallida` contra los POST de
subida que **sí llegaron** al access log: **1023 subidas llegaron al servidor y 1003 salieron
bien — el 98 %**. Y en la misma hora conviven las dos cosas: el 18/08 a las 08:00 **fallaron 15
y entraron 21**. Un límite de tamaño o un bug de ruta no se comporta así, fallaría siempre. En
todo el log hay **5** `Request aborted` contra 21 fallas, así que al menos 16 murieron **sin
abrir una request**: no llegaron ni cortadas. El perfil horario — 42 % de falla a las 08:00,
5 % a las 09:00, **0 % a las 10:00** — replica el que el watchdog había medido por otro lado
para el incidente matutino. Dos instrumentos independientes apuntando al mismo lugar.

⚠️ **El matiz que importa para elegir el arreglo**: el reporte de diagnóstico (POST JSON de
~500 bytes) llegó las 21 veces mientras la subida moría, pero en esa misma hora 21 subidas
grandes también pasaron. O sea que **no** es "el Funnel rechaza los cuerpos grandes" — durante
los cortes de 1-2 minutos falla lo que intente pasar, y una subida grande está expuesta a la
ventana más tiempo que un POST chico. Además de sacar el Funnel del camino, hay una mitigación
posible sin tocar infraestructura: **reintento automático con backoff en el cliente**. La
subida muere en 0,1-1,5 s y el corte dura minutos, así que hoy el docente ve el error al
instante; 2-3 reintentos espaciados taparían buena parte del agujero. No implementado.

---

### 2026-08-18 — Toda la plataforma pasa a la hora de la escuela (y un reloj en el header)

El servidor de producción corre en **UTC** y la escuela está en UTC−3. Cada vista que
formateaba una fecha por su cuenta con `toLocaleDateString` mostraba, en producción,
**tres horas de más**: vencimientos, entregas, calificaciones y auditoría. Y la otra mitad
del problema estaba del lado del navegador — las máquinas del aula tienen cualquier zona
configurada, así que el mismo vencimiento se veía distinto en cada pantalla.

La sala en vivo ya lo había resuelto para sí misma el 2026-08-07. Esta pasada extiende esa
solución al resto de la aplicación: **76 llamadas en 33 archivos**, medidas, no estimadas.

#### Un solo dueño de la hora, dos caras

`services/liveRoom.js` sigue siendo el único que construye `Intl.DateTimeFormat`. Se le
sumaron las 7 formas que las vistas venían armando a mano (`diaMes`, `diaMesAnio`,
`diaMesHora`, `diaMesAnioHora`, `diaMesLargo`, `diaMesLargoHora`, `horaSegundos`) y el
objeto `fmt` completo se publica en `res.locals` desde `server.js`: **toda** vista lo tiene
sin que ninguna ruta se acuerde de pasarlo.

Para el navegador se agregó **`public/js/fecha.js`**, gemelo exacto de `fmt` con la misma
API y los mismos textos. La zona no se decide ahí: llega en `window.SCHOOL_TZ` desde
`partials/footer.ejs`, que la toma de `fmt.TZ`. Un test compara las 12 funciones una por una
y falla si servidor y navegador imprimen distinto.

| Antes | Ahora |
|---|---|
| `<%= a.dueDate.toLocaleDateString('es-AR', {…}) %>` | `<%= fmt.diaMesAnio(a.dueDate) %>` |
| `new Date(act.dueDate).toLocaleDateString('es-ES', {…})` | `Fecha.diaMesHora(act.dueDate)` |

**61 fechas convertidas.** Las **9 restantes no se tocaron y no son un olvido**:
`total.toLocaleString('es-AR')` formatea un **número** con separadores de miles (`1.234`), no
una fecha. Es la trampa del barrido y por eso la regla del test mira el receptor, no el nombre
del método. Los 3 usos con `timeZone: 'UTC'` explícito tampoco se tocan: son fechas
`YYYY-MM-DD` sin instante, donde la zona correcta *es* UTC.

#### Dos bugs que el barrido destapó y no se hubieran visto hasta producción

- **`fmt` no existe dentro de `routes/` ni de `services/`.** `res.locals` llega a las vistas,
  no al código de servidor. Quedaron `fmt.fechaCorta(...)` en `routes/activities.js` (el CSV
  de notas) y en `services/dbFixes.js`: `ReferenceError` en cuanto alguien pisara esa línea.
  El del CSV está entre las **45 rutas sin test**, así que no lo hubiera visto ninguna suite.
  Hay un test estático nuevo que lo prohíbe.
- **`footer.ejs` usaba `Fecha.*` antes de cargar `fecha.js`.** El pie lo incluyen todas las
  vistas: habría reventado el menú de usuario en **todas** las páginas. La carga se movió
  arriba de todo y hay un test de orden.

#### El reloj de la escuela

Pedido del usuario: *"que aparezca la hora y la fecha, aunque sea chica, para que todos puedan
referenciarse en ese horario"*. Va en el centro del header, debajo del nombre de la escuela.

**La hora la pone el servidor, no el equipo.** El HTML trae `data-epoch` con el instante del
render y el JS solo le suma el tiempo transcurrido, medido con **`performance.now()`** — que
es monótono, así que una sincronización NTP a mitad de clase no corre el reloj (verificado en
el navegador simulando un salto de 3 horas). Una máquina del aula con la hora mal configurada
igual muestra la hora oficial, que es todo el punto de tener un reloj común. Ya sale escrito
del servidor, así que se ve bien aunque el JS no llegue a correr, y el DOM se toca solo cuando
cambia el minuto.

En 375 px la fecha se oculta y queda solo la hora (el centro del header comparte ~127 px con
el nombre de la escuela); la fecha completa sigue en el `title`. Medido: sin desborde.

#### De paso: el superadmin no veía el nombre de la escuela

Bug preexistente que el reloj hizo evidente. El header envolvía el nombre en
`<% if (school) { %>`, y el **superadmin es el único usuario con `school: null`** — administra
la plataforma, no una escuela. Resultado: el rol que más mira el header era el único sin
nombre. Se sacó la condición; el texto es fijo a propósito (es el nombre de la plataforma, no
el de la escuela en la base, que es "Escuela 4118 San José"). Para el resto de los roles no
cambia nada. Fijado por el spec `superadmin-header-nombre-y-reloj`, que además comprueba que
el reloj traiga `data-epoch` reciente — o sea, que la hora la siga poniendo el servidor.

#### Tests

`tests/unit/zonaHoraria.test.js`, **9 casos**, cada uno verificado fallando sin su arreglo:
la regla del barrido, el instante UTC que tiene que dar 14:05 y no 17:05, la entrega de las
23:30 que no puede cambiar de día, la paridad servidor/navegador, la fecha nula que da `''`,
`fmt` en `res.locals`, el orden de carga en el pie, y los dos estáticos de alcance.

Suites: **366 unitarios · 328 smoke · roles sin hallazgos · 17 de imágenes**.

> ⚠️ **Nota de entorno**: `npm run test:unit` corre un proceso por archivo y en la máquina de
> desarrollo se queda sin RAM (`ERR_OSSL_CRYPTO_MALLOC_FAILURE`, que parece una regresión y no
> lo es). Correr `node --test --test-concurrency=1 tests/unit/*.test.js`.

### 2026-08-17 — Móvil, tercera pasada: directivo (y cinco páginas donde el menú no abría)

Continuación de la revisión rol por rol, midiendo posiciones reales a 375 px. El panel del
directivo son 11 vistas. La sorpresa es que el problema grande **no era de móvil**.

#### Cinco páginas sin `partials/footer`

`views/directivo/en-vivo.ejs`, `views/preceptor/en-vivo.ejs` y las tres de la sala
(`views/rooms/clases|session|standalone.ejs`) nunca incluyeron el pie. Y el pie no es
decorativo: ahí viven `toggleDrawer()`, `logout()`, `toggleDarkMode()`, `openInboxModal()`, el
tema guardado, el FAB de sugerencias y `nav-responsive.js`.

Medido en esas páginas: **todas esas funciones daban `undefined`**. El botón de hamburguesa no
abría nada, así que desde un teléfono no había navegación **ni forma de salir de la sesión** —
solo el botón "atrás" del navegador—; en escritorio, el menú del usuario tampoco respondía. Y
como el nav de sección no se colapsaba, las solapas quedaban en una tira de 2455 px que hay que
barrer a ciegas.

El arreglo es incluir el pie en las cinco. El test que lo fija es genérico y no vista por vista:
*toda vista que incluya el header tiene que incluir el footer* — el que se olvida siempre es el
archivo nuevo.

#### Consecuencia: esas páginas vieron el modo oscuro por primera vez

Al aplicarse el tema, quedaron con las superficies blancas fijas que tenían: el nombre de la
materia en la tarjeta daba **1,07:1** contra su fondo. Se pasaron a variables las tarjetas de
"clases en vivo" (`partials/live-cards.ejs`) y **toda la sala** (`partials/live-room.ejs`, 30
colores fijos, más las tres vistas de `rooms/`). Las pastillas de color —el aviso de
supervisión, "en vivo", "sin docente", el cartel violeta de observación— llevan variante oscura
propia, porque son pares fondo+texto que se leen solos pero encendidos sobre una página oscura.

⚠️ Esto **ya estaba roto en producción** para docentes y alumnos en modo oscuro: la solapa "En
vivo" de una materia se renderiza dentro de `course.ejs`, que sí carga el pie. Nadie lo había
reportado.

Medido después, sobre fondo claro / oscuro: materia 16,1 / 12,8 · docente 6,1 / 8,1 · cartel de
observación 11,5 / 10,5 · aviso 7,9 / 9,6.

#### Lo que sí era de móvil

| Qué | Antes | Ahora |
|---|---|---|
| Buscador de Docentes y Divisiones | 25 px de alto | 40 px |
| Nombre de la fila (único acceso a cada ficha) | 17 px | 39-63 px, sin cambiar el alto de la tabla |
| Enlace "volver" de las fichas | 21 px | 33 px |
| "Ver actualizaciones" y "Entendido" del panel | 27 y 24 px | 42 px |

El truco del nombre es padding + margen negativo del mismo valor: el enlace se estira hasta
ocupar la celda entera y la tabla no crece ni un píxel (verificado fila por fila, con y sin la
regla). Los dos botones del panel tenían `class="btn-outline"` sin `btn`: heredaban el color
pero no el padding.

#### Lo que NO hizo falta tocar

Las siete tablas del panel ya viven en contenedores con scroll horizontal y columna anclada:
**nada quedaba fuera de alcance**, que era el patrón que rompía las vistas del alumno. Se
verificó explícitamente buscando desbordes sin ancestro scrolleable en las 11 vistas: cero.

#### Verificación

11 vistas a 375 px, cero desbordes inalcanzables, cero controles por debajo de 30 px (salvo la
barra de suplantación, 29 px, que solo ve un superadmin suplantando). `tests/unit/movil.test.js`
pasó de 18 a 25 casos; los dos representativos se verificaron en rojo. Suites: 333 unitarios.

#### Jefe de sección, en la misma pasada

Sus 5 vistas (`/jefatura`, el detalle de una actividad, docentes, la ficha de un docente y
`/admin/secciones`) dieron un caso serio y uno menor:

- En **`/admin/secciones` la tabla medía 512 px dentro de 375 sin envoltorio scrolleable**, así
  que el body la recortaba y la columna **Acciones** —el único acceso a configurar la sección,
  que es lo único que el jefe puede hacer ahí— no existía desde un teléfono. Le faltaba el
  `.users-table-card` que usa `/admin/users`: esa clase no es solo la tarjeta, es quien lleva
  el `overflow-x: auto` en móvil. **Esto también le pasaba al admin**, que comparte la pantalla.
- El nombre del docente en su listado (`fila-link`) medía 18 px; entró en la misma regla del
  nombre de fila del directivo.

Todo lo demás de jefatura ya estaba bien: cero desbordes inalcanzables y ningún control por
debajo de 30 px en las 5 vistas.

#### Administración, en la misma pasada

19 pantallas (usuarios, materias, cursos, catálogo, importación, tema, plantillas, tareas,
auditoría, secciones y sus formularios). **Tres recortaban contenido sin dejar scroll**:

- **`/admin/divisions`**: la tabla medía 464 px sin `.users-table-card`. Exactamente el mismo
  caso que `/admin/secciones` — dos pantallas del mismo panel a las que se les olvidó el mismo
  envoltorio.
- **`/admin/import`**: las tres tarjetas que explican los tipos de importación son un grid de
  `1fr 1fr 1fr` fijo; la tercera arrancaba en x=347 sobre 375 y se perdía contra el borde. En
  móvil se apilan (necesitó una clase: el estilo estaba en el atributo).
- **`/admin/audit`**: los parámetros de cada evento se imprimen como JSON crudo, y un token de
  400 px sin espacios no corta por más `white-space: normal` que tenga. `overflow-wrap: anywhere`.

Y un defecto de formulario que se repite en todo el panel: **dentro de `.input-group`, un
`<input>` mide 48 px y un `<select>` 15**, porque el select trae `padding:0` en el atributo
style. Los formularios de materia son casi todos selects, así que tocar el borde de la caja no
abría nada. También subieron los botones de acción de cada fila (29 px, con el padding chico
puesto inline para no engordar la tabla) y "quitar suplente" (26 px).

Después del arreglo: **19 vistas, cero contenido inalcanzable y cero controles por debajo de
30 px**, salvo un enlace de 16 px que va dentro de una frase ("asignale ese rol desde
Usuarios") y que se deja como está a propósito: es prosa, no un control.

#### Superadministración: el último rol

17 pantallas. Dos formas nuevas de perder contenido, las dos por la misma causa de fondo —un
contenedor que **no puede encoger**, así que su propio `flex-wrap` nunca llega a actuar—:

- **Filas de acciones con `flex-shrink: 0`**. En la ficha de la escuela la fila medía 489 px y
  "Eliminar escuela" quedaba en x=537, fuera de una pantalla de 375. Mismo caso en la fila de
  acciones de cada sugerencia. Dándoles el renglón completo, el wrap que ya tenían alcanza.
- **`.sp-resumen-grid` colapsaba a `1fr`** en móvil — pero `1fr` no baja de min-content, así
  que la columna se quedaba en 405 px dentro de 347 y la grilla de roles se salía. Va
  `minmax(0, 1fr)`: **es el tercer lugar del proyecto donde aparece este mismo error** (el
  calendario de preceptoría fue el primero).
- La fila de cada usuario en la ficha de la escuela no envolvía, así que el correo empujaba la
  pastilla del rol fuera de pantalla.
- Y `/superadmin/import` tenía **la misma grilla de 3 columnas fijas** que la de admin: ahora
  comparten la clase `.import-intro`.

Los botones del panel iban de 21 a 29 px (padding chico en el atributo `style` para entrar en
filas apretadas): se levantaron con `min-height` en `.main-content .btn`, que no compite con
ese inline. Aparte quedaron los que viven **fuera** de `.main-content`: los desplegables de la
barra de acciones masivas, que es `position: fixed`.

Resultado: **17 vistas, cero contenido inalcanzable y cero controles por debajo de 30 px.**

#### La revisión rol por rol quedó completa

Los 8 roles (alumno, docente, preceptor, directivo, jefe, admin, superadmin, y `soe`, que no
tiene panel propio) están revisados a 375 px. `tests/unit/movil.test.js` quedó en **37 casos**
y es la red que impide que vuelva cualquiera de estos patrones.

#### Anotado, sin tocar

En la lista de presentes de la sala, los ausentes se pintan con `opacity:.45` **más** un gris
claro fijo: sobre fondo claro el nombre queda en ~1,5:1 efectivo. Es una decisión de diseño
(atenuar al ausente), no un bug de layout, así que queda para que la decida el usuario.


### 2026-08-17 — El panel de dirección mostraba clases que habían terminado hacía días

**Reclamo**: "en la solapa de 'en vivo' en el rol de director aparecen muchas clases que ya deberían estar cerradas, porque los docentes no están en vivo".

Medido en el espejo de producción antes de tocar nada: **40 salas figuraban abiertas, y ninguna tenía un solo ping desde hacía entre 2,8 y 6,2 días.** No era un problema de la pantalla: esas sesiones estaban abiertas de verdad en la base.

#### La causa

El autocierre existía (`shouldAutoClose`, 3 h sin actividad) pero se evaluaba en **un solo lugar**: al pedir la sala de una materia (`routes/rooms.js`). O sea que una clase terminaba, la docente cerraba la pestaña, **nadie volvía a entrar a esa sala** — y no había quién disparara el cierre. La sesión quedaba abierta para siempre y los paneles de dirección y preceptoría, que listan por `closedAt: null`, las mostraban todas como clases en curso.

Lo llamativo: **la spec ya decía que tenía que ser así**. RN-08 de `specs/sala-en-vivo.spec.md` decía textual "cada `poll` y cada listado del directivo revisa `shouldAutoClose()`" desde el primer día. El listado del directivo nunca lo hizo.

#### Qué se cambió

- **Barrido en los paneles** — `closeStaleSessions()` en `services/liveRoom.js`, llamado desde `getOpenSessions()`. Sigue siendo perezoso (nada de `setInterval`: con 2 workers correría dos veces), pero ahora el disparador está donde el problema se ve. Cierra exactamente lo que ese panel listaría: recibe el mismo filtro, así que el preceptor no cierra salas fuera de su alcance.
- **La ventana bajó de 3 h a 30 min** (`AUTO_CLOSE_MS`). Las 3 h venían de cuando el disparador era poco confiable y había que ser generoso. Lo que el número mide es **sala vacía**, no clase silenciosa: `lastActivityAt` se refresca con cualquier poll (4 s por persona adentro) y con el latido de la docente (20 s), así que 30 minutos sin tocarlo significan que no quedó nadie en ~450 polls seguidos. Una clase larga en silencio no corre riesgo.
- **El cierre automático se fecha en la última señal de vida**, no en el momento del barrido (`horaDeCierre`). Una sala que quedó abierta el martes figura cerrada el martes a las 10:40, que es cuando se fue el último. Sin esto, el pie "Cerradas hoy" del panel se habría llenado de golpe con 40 clases de la semana pasada. Nunca antes de `openedAt`.
- **`closeSession` pasó a ser atómico**: `findOneAndUpdate` condicionado a `closedAt: null` en vez de `save()`. Con dos workers, dos barridos simultáneos escribían los dos y la transcripción terminaba con el aviso de cierre repetido.
- **Chip "sin docente" en las tarjetas** (`docenteEnLinea`, `views/partials/live-cards.ejs`). Sala abierta no es lo mismo que clase dictándose: con los 30 minutos de gracia, una clase que terminó recién sigue listada un rato. Ahora la tarjeta lo dice —ámbar en vez de verde— en vez de dejarlo a la suposición. Cuentan titular y suplentes (`Course.owner` + `coTeachers`) con la ventana del personal de RN-05b; preceptoría y dirección adentro **no** cuentan, que es justo lo que preguntaba el reclamo.

#### Verificación

- Sobre el espejo real: `getOpenSessions()` cerró las 40 en 228 ms, `closedAt` quedó fechado en la última actividad con 0 s de desfasaje, y "Cerradas hoy" pasó de mostrar 40 fantasmas a las 2 clases que de verdad terminaron ese día.
- **En rojo**: neutralizando el barrido, una sesión envejecida sigue listada como en vivo y con `closedAt: null`.
- En el navegador (panel de dirección, dos salas sembradas): chip verde con la docente adentro, ámbar sin ella; al envejecer la segunda, desaparece del panel y aparece en "Cerradas hoy" con su hora real.
- Suites: **327 smoke** (spec nuevo `envivo-barrido-salas-viejas`), **325 unitarios** (11 casos nuevos en `liveRoom.test.js`), matriz de roles sin hallazgos.

**No toca la BD de producción**: no hay campos ni índices nuevos. Al desplegar, el primer directivo que abra el panel cierra de una las salas viejas que haya, por el mismo camino que usa la app.

### 2026-08-17 — La vista de alumno en el celular: tres cosas que no se podían hacer

**Pedido**: "puedes probar el rol de alumno, como se vería si utiliza el celular, quiero que pruebes todas sus vistas y funciones, para que pueda visualizar lo que necesite cuando lo necesite, si es necesario, reacomoda sus botones".

Se recorrió el rol completo a 375 px (inicio, materia con sus 5 solapas, perfil, pendientes, sala en vivo, modal de entrega) midiendo posiciones reales en el navegador. Aparecieron **tres funciones directamente inalcanzables desde un teléfono** — no incómodas: imposibles. Las tres tenían la misma causa: contenido pensado en fila que no entra en 375 px y que `body { overflow-x: hidden }` **recorta en vez de dejar scrollear**, así que se volvía invisible sin ninguna pista de que estaba ahí.

| Qué no se podía hacer | Por qué | Medición |
|---|---|---|
| **Cerrar sesión** | el botón del avatar es el único acceso a ese menú, y caía fuera de pantalla | header-right x 234→**445** sobre 375 |
| **Ver las notas propias** | "Mis notas", "Personas" y "En vivo" quedaban fuera y `.tabs` no scrolleaba | 5 solapas = 642 px sobre 347 útiles |
| **Cambiar la contraseña** | los botones del perfil quedaban fuera de pantalla | acciones x 433→**639** |

#### Qué se cambió

- **Header** (`@media max-width:900px`): se ocultan el texto "Materias" del logo (~90 px) y el badge de rol (~75 px). El rol no se pierde: sigue dentro del menú de usuario junto al nombre y el correo, y hay un test que lo fija — ocultarlo del header solo es aceptable mientras eso siga siendo cierto. Resultado: header-right 227→363, entra completo, y el nombre de la escuela pasó de 24 px aplastados a 111 px legibles.
- **Salida de sesión en el menú lateral** (`views/partials/header.ejs`). Es el arreglo de fondo: el botón de hamburguesa entra en cualquier ancho, así que colgar la salida de ahí no depende de que el header entre. Va en todos los anchos, no solo en móvil.
- **Solapas de la materia**: envuelven en dos filas como pastillas, en lugar de scroll horizontal. Se eligió así a propósito — con scroll el alumno tiene que *adivinar* que hay contenido corrido al costado, y el pedido era justamente "que pueda visualizar lo que necesite cuando lo necesite". La solapa activa pasa de subrayado a relleno porque el borde inferior deja de señalar nada cuando hay más de una fila.
- **Mi perfil**: se apila en columna, los botones van a ancho completo y los nombres largos (`APELLIDO APELLIDO, NOMBRE NOMBRE`) cortan en vez de desbordar.
- **Área táctil**: los enlaces de las bandas de aviso pasaron de 21 px de alto a ≥32. En el panel de inicio, los controles por debajo del mínimo cómodo bajaron de **35 a 2**.

#### Verificación

Medido en el navegador a 375 px, no a ojo: cero desbordes en las cinco vistas, las 5 solapas alcanzables y funcionando, los modales de correo/contraseña entran con campos de 40 px. **Escritorio sin tocar** (todo vive dentro de `@media (max-width: 900px)`, y hay un test que verifica que ninguna regla se escape). Modo oscuro con contraste suficiente: solapa activa 4.51:1, inactiva 8.07:1.

`tests/unit/movilAlumno.test.js` fija las cuatro invariantes; 8 de sus 10 casos fallan si se revierte el arreglo. Las tres suites pasan (307 unitarios, 326 smoke, roles sin hallazgos).

**Pendiente**: esta pasada cubrió solo el rol **alumno**. Faltan docente, preceptor, jefe, directivo, admin y superadmin — el header y el menú lateral ya quedaron arreglados para todos, pero las vistas propias de cada rol no se revisaron.

### 2026-08-17 — Móvil, segunda pasada: docente y preceptor

Continuación de la anterior, mismo método (medir posiciones reales a 375 px, rol por rol).

#### Docente

- **Calificar entregas** era la peor. `.grade-table` reparte 5 columnas por porcentaje (24/10/30/13/23); a 375 px la tabla quedaba en 286 px y con ella el nombre del alumno en 69 px, la nota en 29 y **el textarea de la devolución en 67 px de ancho**. Acá no había desborde: se comprimía hasta ser inservible, que para el que la usa es lo mismo. Y es la pantalla donde el docente pasa más tiempo. Ahora cada alumno es una tarjeta apilada — la devolución pasó de 67 a **261 px**, la nota de 48×28 a 85×36 y el nombre completo se lee entero. Es solo CSS: el marcado lo genera `loadTeacherDetail()` y no se tocó. Los rótulos "Nota" y "Devolución al alumno" se reponen con `::before` al ocultar el `<thead>`; el "/ N" del encabezado no se pierde porque el modal ya dice "N pts máx." más arriba.
- **Libro de calificaciones**: funcionaba (scrollea y ancla la columna de alumnos), pero repartía mal — 200 px de nombre sobre 347 dejaban menos de una columna de actividad a la vista. Con el nombre en 132 px entran las tres columnas juntas.
- **Sala en vivo**: la barra de escribir daba 19 px de alto, adjuntar 24×24, enviar 24×24 y los emoji ~22. Es un chat que se usa durante la clase y desde el teléfono. Quedó en 41 px el campo, 44×44 enviar, 40×40 adjuntar. El campo va a **16 px de fuente a propósito**: por debajo de eso Safari en iPhone hace zoom solo al enfocar y deja la página corrida de costado.

#### Preceptor

El panel ya estaba bien (el nav colapsa en desplegable y el pase de lista tiene botones de 40 px). Dos cosas:

- **El calendario de "Actividades del día" cortaba la columna del SÁBADO** (x 335→380 sobre 375). Causa: `grid-template-columns: repeat(7, 1fr)`. Un track `1fr` no baja de su contenido (`min-width: auto`), así que los 7 días sumaban 351 px dentro de una tarjeta de 315. Se cambió a `minmax(0, 1fr)` — que es lo que `.ad-layout`, en el mismo archivo, ya venía usando por este mismo motivo.
- El enlace "← Asistencia" del pase de lista medía 17 px de alto y es el único camino de vuelta.

#### Verificación

Cero desbordes y cero controles por debajo del mínimo cómodo en todas las vistas recorridas de los dos roles. `tests/unit/movil.test.js` (renombrado desde `movilAlumno.test.js`, ahora cubre los tres roles) tiene 18 casos; 16 fallan si se revierten los arreglos. Las tres suites pasan: 315 unitarios, 326 smoke, roles sin hallazgos.

**Pendiente**: faltan jefe, directivo, admin y superadmin.

### 2026-08-17 — El servidor puede empujar el backup a otra PC por FTP

**Pedido**: "podrías crear en la sección de backup una opción más tipo que ingrese una ip o un dns como esta computadora tiene en tailscale y puede transferir desde ftp, del servidor acá a local, todo lo necesario para poder descargar la base de datos completa junto con los archivos".

**El problema que resuelve**: bajar el backup por el navegador es la parte frágil de toda la operación. Son ~850 MB atravesando el Funnel de Tailscale hasta la pestaña, y cualquier corte obliga a empezar de cero. Empujando el paquete directo por el túnel, la transferencia va de máquina a máquina y la pantalla solo mira el progreso.

#### La dirección de la flecha, que es al revés de lo que suena

FTP no puede "empujarle" un archivo a alguien que no está escuchando. Acá **el servidor de la escuela es el CLIENTE** y **la PC que recibe tiene que estar corriendo un servidor FTP** (IIS FTP Server o FileZilla Server) y quedarse prendida durante toda la transferencia. Es la única forma de que "del servidor a local" funcione con FTP, y es lo primero que dice la pantalla, con los pasos concretos de Windows en un desplegable — incluido el rango de puertos del modo pasivo, que es el paso que más se olvida y el que hace fallar la transferencia justo *después* de conectar bien.

#### Cómo funciona

`POST /superadmin/backup/ftp/enviar` arma el mismo `.tar.gz` que `GET /download` y lo streamea **directo al socket FTP**: el paquete nunca toca el disco del servidor, igual que la descarga desde el 2026-08-10. Es el mismo archivo, así que sirve para restaurar sin ninguna diferencia.

La respuesta **no** es un JSON al final sino un stream **NDJSON** (un evento por línea): `estado` → `inicio` → `progreso` cada 2 s → `fin`. Un envío puede durar una hora y sin progreso en pantalla nadie sabe si sigue vivo. El latido de 2 s no es cosmético: entre el servidor y el navegador hay un proxy que corta las conexiones calladas.

**Consecuencia a tener presente si alguien toca esta ruta**: los headers salen ANTES de saber si el envío va a funcionar, así que un fallo posterior viaja como evento `fin` con `ok:false` y no como status HTTP. Todo lo que se pueda validar antes de ese punto (destino incompleto, falta de contraseña) se valida antes y **sí** sale como 400 — hay un smoke que lo fija.

| Pieza | Qué hace |
|---|---|
| `config/ftpDestino.js` | destino guardado en `ftp-destino.json` (raíz, gitignored), normalización de lo que se tipea y cifrado de la contraseña |
| `services/backupFtp.js` | conexión, prueba de escritura, subida en streaming con `.part` + rename, y la traducción de errores |
| `tests/unit/ftpServidorDePrueba.js` | servidor FTP mínimo para los tests (no es dependencia de la app) |
| `GET/POST/DELETE /superadmin/backup/ftp/config` | leer, guardar y olvidar el destino. La contraseña **nunca** vuelve al navegador |
| `POST /superadmin/backup/ftp/probar` | login + escritura real. 502 si falla la máquina del otro lado, no 400 |
| `POST /superadmin/backup/ftp/enviar` | arma y empuja el paquete, con progreso NDJSON. Acepta `comprimir: ["imagenes","pdf"]` |

#### Decisiones que no se ven en el código

- **Se sube como `.part` y se renombra al final.** Misma idea que la respuesta chunked de `/download`: un envío cortado tiene que **verse** cortado. Sin esto, en la carpeta de destino quedaría un `.tar.gz` de tamaño plausible que solo se descubre incompleto el día que hace falta restaurarlo, que es el peor día posible. Hay un test que lo fija.
- **"Probar conexión" prueba ESCRITURA, no login.** Sube un archivito y lo borra. IIS crea los sitios FTP en modo lectura por defecto, y enterarse a los 800 MB transferidos sería inaceptable.
- **Los errores se traducen uno por uno** (`mensajeDeError` en `services/backupFtp.js`). Un FTP contra una PC hogareña falla de maneras muy específicas y muy repetidas —firewall sobre los puertos pasivos, MagicDNS apagado, permiso de solo lectura, elegir FTPS implícito cuando el server habla explícito— y `connect ECONNREFUSED 100.64.1.5:21` no orienta a nadie. Cada mensaje dice qué revisar.
- **La contraseña del FTP se guarda cifrada** (AES-256-GCM con clave derivada de `JWT_SECRET`, `config/ftpDestino.js`). No es una bóveda —quien tenga root tiene las dos mitades— pero evita el accidente probable: que la contraseña del FTP de casa termine legible en un archivo copiado sin mirar. Sin `JWT_SECRET` no se guarda ninguna y la pantalla lo explica. `ftp-destino.json` va en `.gitignore` **y en `.nodemonignore`** (mismo caso que `maintenance.json`: JSON de runtime en la raíz, sin eso cada guardado reinicia el server en dev).
- **La contraseña guardada solo se reusa contra el mismo host+puerto+usuario** para el que se guardó. Cambiar el host y apretar "Probar" no puede mandarle la credencial de otra máquina a un destino tipeado con un error.
- **`rejectUnauthorized: false` en FTPS**, a propósito y solo acá: los servidores FTP caseros usan certificado autofirmado y validarlo haría fallar el 100% de los casos reales. El camino entre las dos máquinas ya va cifrado por WireGuard; el TLS del FTPS es una segunda capa, no la única defensa.
- **No hay lock entre workers de PM2**, deliberadamente. Dos envíos simultáneos son caros pero inofensivos (el nombre lleva timestamp, no se pisan), mientras que un lock trabado por un proceso muerto dejaría al dueño sin poder mandar el backup justo el día que lo necesita. Alcanza con el limitador (5/hora) y el botón deshabilitado.
- **Cerrar la pestaña corta de verdad** el empaquetado y el FTP (`res.on('close')` → `AbortController` → `client.close()`), y el `.part` que quedó se borra en una conexión nueva. Sin esto el servidor seguiría comprimiendo y subiendo cientos de MB que ya nadie espera.
- **Auditoría**: `system.backup_ftp` se registra **antes** de transferir, igual criterio que `/download`. El hecho auditable es que una copia completa de la base salió del servidor hacia un destino externo, y eso pasa desde el primer byte. `system.backup_ftp_config` registra los cambios de destino.

#### Verificación

**End-to-end real, no con mocks.** Los tests unitarios levantan un servidor FTP de verdad (`tests/unit/ftpServidorDePrueba.js`, ~10 comandos del protocolo, sin dependencias nuevas) y verifican que lo que llega es byte por byte lo que se mandó. En el navegador se hizo un envío completo contra ese mismo servidor: 261 MB transferidos, `.tar.gz` verificado (manifest 1.0, 14 colecciones, 1428 usuarios, los 3 archivos con su tamaño exacto), progreso llegando incremental (2,3 s → 85 MB · 4,4 s → 186 MB · fin → 261 MB) y cancelación a mitad dejando **cero** archivos con nombre final y **cero** `.part` huérfanos.

Un detalle que se verificó y conviene no perder: la respuesta sale **sin** `Content-Encoding`, o sea que `app.use(compression())` no la toca. Igual el código llama a `res.flush()` después de cada evento, por si algún día ese filtro cambia — sin eso el progreso llegaría todo junto al final, que es justo lo que esta ruta existe para evitar.

**Tests**: 13 unitarios de la transferencia (`tests/unit/backupFtp.test.js`) + 16 del destino guardado (`tests/unit/ftpDestino.test.js`) + 4 smoke (forma de la config sin filtrar la contraseña, validación, traducción del error de conexión, y que el envío exija contraseña **antes** de armar nada). Los smoke nunca guardan un destino ni disparan un envío real: usan un usuario imposible, así que el chequeo de "es otro destino" corta antes de tocar el `ftp-destino.json` de la máquina de desarrollo. Suites completas: **297/297 unitarios, 326/326 smoke, roles sin hallazgos.**

**Dependencia nueva**: `basic-ftp` (^6.2.0) — MIT, sin dependencias propias, CommonJS, sin binarios del sistema.

**Lo que sigue pendiente**: automatizarlo (que el envío salga solo por cron, sin que nadie apriete el botón) es el Nivel 2 del backup y no está hecho.

### 2026-08-15 — Cuando una subida falla, ahora queda dicho POR QUÉ

Docentes reportaron que archivos de ~3 MB (PDFs, sobre todo) fallaban con un cartel de error, y que **antes andaban**. En local no se reproduce a ningún tamaño: 1, 3, 5, 10 y 25 MB entran los cinco en menos de 400 ms, y los topes (50 MB adjunto, 20 MB entrega, 15 MB Excel) están holgados y no se tocaron nunca (`git log -S`). O sea que el problema es de producción y no del código — y ahí se choca con el límite de lo que el servidor puede contar de sí mismo.

**El agujero**: el access log contesta "qué respondió el servidor", y no sirve para nada cuando la request **nunca llegó**. Un intermediario que corta el cuerpo por tamaño, la conexión del aula que se cae a mitad de una subida, un timeout de proxy: el docente ve un error, el log del servidor está impecable, y no hay forma de cruzar las dos cosas. El mecanismo nuevo es el otro extremo del cable — **cuenta lo que vio el navegador**.

#### Cómo se usa

El cartel de error muestra un código corto (`SUB-7F3A2C`). Con una foto de la pantalla alcanza:

```
node tools/ver-subida.js SUB-7F3A2C     # una en particular
node tools/ver-subida.js                # las últimas 15, para ver si hay patrón
node tools/ver-subida.js --hoy
```

En producción, si se corre desde otro lado: `LOGS_DIR=/home/walter/classroom/logs node tools/ver-subida.js SUB-...`

**Que el código NO aparezca también es un resultado**, y de los más informativos: significa que el navegador no pudo ni avisar, así que el problema está antes de la aplicación (red del aula, Funnel, DNS).

#### El dato que decide todo: `enviados` vs `bytes`

Es lo que justifica el mecanismo entero. Se registra cuántos bytes logró empujar el navegador antes de morir:

- **`enviados < bytes`** → se cortó EN CAMINO. Red, Funnel, proxy, límite de cuerpo. No va a haber línea en ningún log de la app porque nunca le llegó.
- **`enviados = bytes`** → subió entero y algo lo rechazó. Ahí sí hay línea, y `requestId` la encuentra directo.

Por eso hay que llamar a `SubidaDiag.progreso()` en cada `onprogress`: sin eso el reporte no distingue esos dos casos, que son problemas de personas distintas.

La otra bifurcación la resuelve sola `tools/ver-subida.js`: la app contesta **JSON con `error` en todos** sus errores de subida, así que si el cuerpo no es JSON nuestro, el que rechazó está delante del servidor. El informe lo dice con todas las letras en vez de dejárselo deducir al que lee.

#### Qué se tocó

- **`public/js/subida-diagnostico.js`** (nuevo): arma el reporte, lo manda y devuelve el código. Nunca lanza — si el diagnóstico se rompe, la subida ya falló y lo último que hay que hacer es tapar el error de verdad con uno nuestro. El aviso sale con `fetch(..., { keepalive: true })` para que salga aunque cierren la pestaña, que es lo que hace cualquiera cuando algo falla.
- **`routes/diagnostico.js`** (nuevo, `POST /diagnostico/subida`): recibe el reporte. **Todo lo que entra lo escribe el cliente y por lo tanto es mentira posible**: se recorta, se castea y se encierra en una lista de valores conocidos antes de tocar el log. Un log al que se le pueden escribir megabytes desde el navegador es un log que cualquiera puede inundar para tapar otra cosa. Lo único que no viene del cliente —y es lo que lo hace útil— es quién lo mandó: eso sale de la sesión. Va con `requireAuth` y limitador **por usuario** (30/hora): si un aula se queda sin internet, los 30 chicos reportan a la vez, que es justo cuando más se quiere el dato.
- **Los tres caminos de subida**: adjunto de actividad (docente, `views/activities/new.ejs`), entrega (alumno, `public/js/course.js`) y adjuntos de la sala en vivo (`views/partials/live-room.ejs`). Se sumó `ontimeout`, que en los dos primeros no estaba manejado.
- **`tools/ver-subida.js`** (nuevo): busca por código e imprime un veredicto que dice **dónde seguir buscando**, más un resumen cuando se lo llama sin argumentos (¿le pasa a uno o a todos?).

#### La trampa de fetch, que casi mete un dato falso

La sala sube con `fetch`, y **fetch no puede informar progreso de subida**. Sin decirlo explícitamente, el reporte de toda subida de la sala habría dicho "se envió 0 de N MB" — o sea "se cortó apenas arrancó" — y habría mandado a buscar el problema a la red aunque la red hubiera andado perfecto. De ahí `seguir(ruta, file, { progresoMedible: false })`: el campo se omite y el informe muestra `?`. **Un diagnóstico que miente con seguridad es peor que no tener ninguno**, y es el modo de falla al que un mecanismo como este es más propenso.

#### Verificado

3 specs nuevos (`diagnostico-subida-*`), incluido uno que comprueba que **el log no se puede inundar** desde el navegador. Y en el navegador de verdad, los dos casos que importan, de punta a punta —cartel → aviso → log → `ver-subida.js`—: conexión cortada al 33% (dice "se cortó en camino") y un 413 con HTML de nginx (dice "lo rechazó un intermediario, ningún log de la app lo va a explicar").

**322/322 smoke, 268 unitarios, 17 de imágenes, matriz de roles sin hallazgos.**

#### 🟡 Detectado de paso: el smoke deja cuentas huérfanas

Revisando la base local aparecieron **18 cuentas `@example.com` acumuladas desde el 10/08**: unas 3 por corrida que los specs de limpieza no cubren (`sinmateria.*`, `scoped.teacher.new.*`, `dnipuntos.*`, `latejoiner.*`, `am.otro.*`). Se borraron a mano después de confirmar que no tenían ninguna entrega asociada.

No afecta producción —el smoke se niega a correr contra un host remoto— pero ensucia el espejo local e infla los contadores de alumnos de los paneles, que es justo lo que hace difícil creerles. **Falta extender los specs de limpieza a esos cinco patrones.**

### 2026-08-15 — Revisión del sistema: se midió la cobertura y se arregló lo que había en la zona ciega

Punto de partida: las cuatro suites en verde (268 unitarios, 17 de imágenes, 283 smoke, matriz de 8 roles × 40 secciones sin hallazgos). Con todo pasando, la pregunta útil no era "¿qué falla?" sino **"¿qué no está mirando nadie?"**.

Se cruzaron las rutas declaradas en `routes/*.js` contra las que tocan los tests. Y ahí, en esa zona, estaban los cinco problemas de abajo. Ninguno se había visto en producción salvo el primero, que nadie podía ver.

**Cómo se mide, porque la primera medición mintió.** Contar "¿algún test nombra esta ruta?" da 29 sin tocar, y es un número inflado: el spec `objectid-invalido-da-404` **nombra 384 rutas** para pegarles con un id mal formado, y que una ruta figure ahí no significa que esté probada — significa que se verificó que no se cuelga. Excluyendo ese bloque, el número real de arranque era **~65 de 232 rutas sin ejercitar funcionalmente**, y al terminar esta tanda quedaron **45**.

La medición quedó en **`tools/cobertura-rutas.js`** (`node tools/cobertura-rutas.js`), que excluye ese spec por defecto y con `--con-objectid` muestra el número laxo para que se vea la diferencia. Es análisis estático: no necesita el server ni la base.

> Al medir cobertura de rutas, excluir siempre `objectid-invalido-da-404`. Si no, el número sale bien justo donde peor conviene que salga bien.

**Lo que falta, por tamaño del hueco**: la feature de **plantillas de tareas entera** (12 de sus 14 rutas: crear, publicar, ofrecer, revocar, previsualizar, asignar — nunca se ejercitó ninguna), **12 rutas de edición del panel de admin** (editar materia, división, catálogo, co-titulares, restablecer contraseña), **6 de actividades** (`/activities/new`, exportar notas, `my-submission`, los dos servidores de archivos) y **5 del superadmin** (editar escuela, `import/execute`, las dos de sugerencias).

#### 🔴 No se podía crear una segunda escuela. Nunca.

`POST /superadmin/schools/create` funciona la primera vez y falla **siempre** a partir de la segunda, con `400 "Ya existe una escuela con ese nombre"` — y el nombre no tenía nada que ver.

El choque es entre dos líneas de `models/School.js` que se leen bien por separado:

```js
inviteToken: { type: String, default: null },                          // el campo siempre existe, y vale null
schoolSchema.index({ inviteToken: 1 }, { unique: true, sparse: true }); // "null no se indexa" ← esto era falso
```

**`sparse` saltea los documentos donde el campo está AUSENTE, no los que valen `null`.** Un `null` explícito se indexa como cualquier otro valor. Como toda escuela nacía con `inviteToken: null`, la segunda chocaba contra la primera en el índice único. El manejador del error 11000 de la ruta traduce cualquier duplicado a "ese nombre", que es exactamente el lugar equivocado donde mirar.

Se arregló **del lado del documento**, que es lo que no obliga a tocar la base de producción: el campo ya no tiene `default` (ausente = sin enlace) y `revoke-invite` lo saca con `undefined` en vez de escribir `null` — sin ese segundo cambio, una escuela que hubiera tenido enlace y lo perdiera volvía a ocupar el casillero. Todas las vistas leen el campo por truthiness, así que `undefined` y `null` se comportan igual y no cambia ninguna pantalla.

> **El arreglo de fondo requiere tocar la BD de producción y quedó pendiente de aviso**: cambiar el índice por uno parcial (`partialFilterExpression: { inviteToken: { $type: 'string' } }`), que además protegería contra cualquier `null` que se cuele en el futuro. Necesita `dropIndex` + `createIndex`. La única escuela que hoy tiene `inviteToken: null` guardado no molesta — un solo null es válido para un índice único.

**Tests**: `superadmin-crea-dos-escuelas` y `superadmin-enlace-de-invitacion-va-y-viene`. El primero crea **dos** a propósito: con una sola, el spec pasa siempre y el bug queda invisible. Eso es lo que lo mantuvo escondido tres meses — en producción hay una escuela, así que el botón "Nueva escuela" nunca funcionó y no había forma de enterarse.

#### 🟠 `bulk-role` escribía roles fuera del enum

`POST /superadmin/users/bulk-role` usa `updateMany`, y **`updateMany` no corre los validadores del schema** salvo que se le pida. Las vías de a uno sí los piden (`runValidators: true`), así que la misma operación **aceptaba por lote lo que rechazaba de a uno**. Verificado: `{"role":"DIRECTOR_SUPREMO"}` → `200 {"ok":true,"updated":1}`, y así quedaba en la base.

No es escalada de privilegios: ningún middleware reconoce un rol desconocido, así que la cuenta queda con los permisos mínimos (falla cerrado). Lo que hace es **tapiarla**: cualquier ruta que después haga `.save()` sobre ese documento revalida el enum entero y explota. El síntoma aparece lejísimos del origen — el dueño de la cuenta deja de poder cambiar su contraseña, con un 500 genérico.

Arreglado validando contra `User.getRoles()` antes de escribir. Tests: `bulk-role-rechaza-rol-invalido` y `bulk-role-invalido-no-tapia-la-cuenta` (este último es el que muestra la consecuencia real, y por eso está separado).

#### 🟠 Los usuarios podían quedar apuntando a una escuela que no existe

`POST /superadmin/users/bulk-school` y `POST /superadmin/users/:id/school` buscaban la escuela **después** de escribir, y solo para ponerle nombre al log. Un `schoolId` inexistente pasaba con `200 {"ok":true}` y dejaba las cuentas colgadas de la nada.

No rompe el día que se hace —Mongoose descarta la referencia al popular— pero es **la misma clase de referencia colgada que en agosto tiró abajo `/admin/courses` con un 500**: aparece meses después, en una pantalla que no tiene nada que ver. Ahora la escuela se resuelve antes de escribir (`escuelaDestino()`, compartida por las dos rutas) y un id inexistente o mal formado devuelve 404. `schoolId: ""` sigue siendo válido: significa "sacarles la escuela".

#### 🟠 Un error del usuario al subir un archivo salía como "Error del servidor"

multer corta la subida **antes** del handler (archivo pasado de tamaño, tipo no permitido) y avisa lanzando un error. Cuatro rutas no lo interceptaban, así que ese error llegaba al manejador global: `500 "Error del servidor (ref: ...)"`. El que subió se queda sin saber qué hizo mal, y el `error.log` —que es donde se mira cuando algo se rompe **de verdad**— se llena de fallas que no son fallas.

Las cuatro: `POST /admin/import/upload`, `POST /superadmin/import/upload`, `POST /activities/create` y `POST /activities/:id/submit`. Confundir el `.csv` del padrón con el `.xlsx` —el error de dedo típico de la pantalla de importación— daba 500.

El patrón ya existía escrito a mano en cuatro lugares (`subirImagen`, `conArchivo` y dos envoltorios inline en `activities.js`). Se extrajo a **`middleware/upload-errors.js`** (`conErroresDeSubida`) y se aplicó a las cuatro que faltaban; los cuatro de antes quedaron como están a propósito, para no arriesgar una regresión en caminos ya cubiertos. De paso, los topes pasaron a constantes (`XLS_MAX_MB`, `ADJUNTO_MAX_MB`) para que el número del límite y el del mensaje no puedan separarse.

#### 🟡 El catálogo de materias acepta nombres repetidos (NO arreglado — requiere tocar la BD)

`routes/admin.js` tiene el manejador del error 11000 para `POST /admin/subjects/create` ("Ya existe una materia con ese nombre"), pero **`subjects` no tiene ningún índice único**: el único índice de la colección es `_id_`. Ese catch es código muerto y los nombres repetidos entran sin chistar.

Importa más de lo que parece por la deuda nº 4 de "Issues Conocidos": la relación Subject↔Course se resuelve por el **texto** del nombre, así que dos materias homónimas en la misma escuela hacen que el detalle de materia muestre cursos de la otra, sin ningún error a la vista. Hoy en el espejo local hay **0 grupos repetidos**, así que todavía no mordió.

No se arregló porque el arreglo es un índice nuevo en la base de producción. El spec `admin-crea-materia-en-el-catalogo` **fija el comportamiento actual** y explica por qué.

#### Cobertura nueva (24 de las 29 rutas)

Además de lo de arriba: el ciclo completo de un tema cruzando los dos paneles (el superadmin ofrece → el admin acepta → configurar → revocar), la cuenta propia de cualquier rol (`change-password`, `PATCH /profile/contact`, `POST /logout` — las tres que los ocho roles usan igual y ninguna estaba), el buscador por DNI del registro, el alta de usuarios del superadmin, las dos plantillas de importación, `/courses/divisions`, `/activities/available-templates` y el camino feliz de `/activities/upload-attachment`.

**Total de la corrida: 319 specs, 0 fallos** (venía de 283). Más 268 unitarios, 17 de imágenes y la matriz de 8 roles × 40 secciones sin hallazgos.

`POST /superadmin/backup/restore` queda excluido **a propósito** y no cuenta como deuda: es destructivo, y se verifica a mano con un round-trip real.

#### `npm run test:smoke -- --only=<regex>`

La suite entera tarda unos diez minutos y esperar eso para ver si un spec nuevo quedó en verde no escala. `--only` filtra por id (es una regex, para poder pedir un grupo que no comparte prefijo: `--only='bulk|de-a-uno'`) y siempre cuela `admin-login` y `superadmin-login`, sin los cuales todo devuelve 302.

> ⚠️ Es **solo para desarrollo**: los specs dependen del `state` que dejaron los anteriores, así que un filtro que corte esa cadena hace fallar specs que en la corrida completa pasan. La corrida que vale sigue siendo la de siempre, sin flags. Y **no editar archivos `.js` mientras corre**: nodemon reinicia el server y la corrida se llena de `fetch failed` que no son regresiones (pasó dos veces armando esto).

### 2026-08-14 — Quién puede crear una materia: de lista negra a lista blanca

`POST /courses/create` solo exigía tener sesión. El botón "Crear clase" nunca estuvo para el alumno, pero eso es la **vista**: con un POST directo, cualquiera con sesión creaba una materia y quedaba como `owner` — y `Course.isTeacher()` mira justamente el `owner`, así que a partir de ahí podía **calificar, publicar novedades y agregar o sacar alumnos** de esa materia. Estaba abierto desde el 2026-07-30.

**El arreglo es cambiar la lista negra por una lista blanca**, que es lo que importa más que los nombres que tenga: antes se nombraba a los que NO podían (`preceptor` y `jefe`, agregados el 2026-08-06 cuando el smoke los detectó), así que **todo rol que no estuviera nombrado entraba** — incluido el alumno, e incluido cualquier rol que se agregue mañana al enum. Ahora es al revés: `ROLES_QUE_CREAN_MATERIAS` en `routes/courses.js` nombra a los que sí, y lo que no está nombrado queda afuera (fail-closed).

Quedan adentro `superadmin`, `admin`, `directivo` y `soe`. Afuera: `student`, `teacher`, `preceptor` y `jefe`.

**El docente quedó afuera por decisión explícita del usuario** ("el docente no puede crear materias ni cursos"), y con eso el endpoint dice por fin lo mismo que la vista: `views/dashboard.ejs` no le muestra el botón "Crear clase" desde el 2026-07-25, pero hasta hoy el POST directo se lo aceptaba igual. Las materias las da de alta el administrador desde `/admin/courses/create`, que además le pide el titular. **Los cursos (`Division`) ya los tenía cerrados**: los únicos lugares que crean divisiones son `routes/admin.js` y `routes/superadmin.js`, ambos detrás de su guarda de rol.

Eso obligó a rehacer lo que se apoyaba en la vía vieja, que era más de lo que parecía:

- **4 specs del smoke** creaban la materia con el docente. Ahora la crean con el `admin` pasando `teacherId`, así que el escenario no cambia —la materia sigue quedando con el docente como titular, que es lo que miden los specs de abajo— pero se arma por la puerta que corresponde. `course-create` pasó a llamarse "El administrador crea una materia y le asigna el docente titular" y **asserta explícitamente que el owner es el docente y no el admin que la creó**.
- **`tests/roles/check-roles.js`** armaba su escenario igual. Mismo cambio.

**Tests**: dos specs nuevos, `student-cannot-create-course` y `teacher-cannot-create-course`. Los dos, además de esperar el 403, comprueban en `/admin/courses` que **la materia no exista** — si el rechazo llegara después del `Course.create`, el que la pidió seguiría siendo owner igual. El del alumno se verificó en rojo volviendo a meterlo en la lista: falla con **201 y `owner` = el id del alumno**, y arrastra otros 7 specs con él (la materia fantasma ensucia los conteos), que es una buena medida del radio que tenía el agujero. **283/283 smoke, 268/268 unitarios, matriz de roles sin hallazgos.**

Va con `logRechazo`, así que el intento queda en el log con el rol que lo hizo.

> Al agregar un rol al `if` del botón en `views/dashboard.ejs` hay que agregarlo **también** a `ROLES_QUE_CREAN_MATERIAS`, o el botón va a dar 403. Está anotado en los dos lados.

### 2026-08-14 — Un `:id` mal formado ya no cuelga el request ni da 500

Cierra el issue conocido nº 10, que estaba abierto desde el 2026-07-30 y se había agravado el día anterior al confirmarse que el patrón se repetía fuera del panel directivo.

**Eran dos síntomas de la misma causa.** Un `:id` que no tiene forma de ObjectId hace lanzar `CastError` a `findById`, y de ahí en más depende de cómo esté escrito el handler:

| | Qué pasaba | Dónde |
|---|---|---|
| Handler `async` **con** `try/catch` | El catch genérico lo contesta como **500** | Casi todos los POST |
| Handler `async` **sin** `try/catch` | Nadie captura el rechazo (Express 4 no lo hace): el request queda **colgado para siempre** | Los GET de `routes/admin.js` |

El segundo es el feo: no hay error en pantalla, el navegador se queda esperando y en el log aparece un `unhandledRejection` sin ruta. Se detectó con `GET /admin/users/new` — una URL que no existe, porque la buena es `/users/create`, y que caía en `/users/:id`.

**El arreglo es una guarda explícita al entrar a cada handler**, `idMalo()` en `middleware/objectId.js`. **No es un middleware de Express a propósito**: se llama ruta por ruta, así que ninguna ruta cambia de comportamiento sin que se la haya tocado. La alternativa —capturar el `CastError` en el manejador de errores de `server.js`— se descartó porque no arregla el caso colgado: ahí el rechazo nunca llega al manejador de errores.

- **La forma de la respuesta sigue a la del handler**: 404 en texto para los GET (renderean vistas) y 404 en JSON para POST/DELETE (se llaman por `fetch()` y el front espera `{ error }`). Mandar el shape equivocado dejaría a la pantalla sin poder mostrar el mensaje.
- **Los tres paneles primero** (36 rutas): 21 de `routes/admin.js`, 11 de `routes/superadmin.js` y 4 de `routes/directivo.js`. `POST /admin/courses/:id/co-teachers/:teacherId/delete` lleva **dos** guardas: validar solo `:id` dejaba el `CastError` de `:teacherId` sin atajar.
- **Y después el resto de la app** (55 rutas más): `activities.js` (14), `courses.js` (8, dos de ellas con `:studentId`), `tasks.js` (10), `preceptor.js` (8), `announcements.js` (4), `messages.js` (4), `messagesInbox.js` (2) y `suggestions.js` (2). Ya no queda ninguna ruta `:id` sin validar.
- **`rooms.js`, `attendance.js` y `jefatura.js` no se tocaron: ya validaban.** Vale la pena mirar cómo, porque es mejor que la guarda repetida: `rooms.js` lo resuelve con `router.use('/:id/sala', …, cargarSala)` —un solo punto para sus 16 rutas— y `attendance.js` con `cargarDivision`/`cargarToma` como middleware por ruta. Cuando un router tiene muchas rutas colgando del mismo `:id`, ese es el camino.
- **Dos guardas se pusieron ANTES de su middleware, no en el handler**: la de `POST /activities/:id/upload-submission-file` va antes de multer (si no, el archivo se escribe en disco y el 404 posterior lo deja huérfano) y la de `POST /messages/mine/:recipientId/reply` antes del `messageReplyLimiter` (un id imposible no debería gastar una de las 10 respuestas por ventana).
- **Lo que quedó sin guarda a propósito**: el `:id` de `routes/dbFixes.js` no es un ObjectId sino la clave del arreglo (`getFix()` ya contesta 404), y `:token`, `:filename` y `:fecha` tampoco son ids.
- Los textos de cada 404 son los que ya usaba el handler, incluido el `'Curso no encontrado'` de las rutas de `Division` (así se llama la Division en la UI del panel — ver la nota de terminología).

**El recuento final, para que la próxima auditoría empiece con el número puesto**: hay **127 rutas con parámetro** en toda la app — 88 con guarda nueva, 32 que ya validaban de antes (`rooms` 16, `attendance` 11, `sections` 3, `jefatura` 2), 6 exentas a propósito (`dbFixes` 4, `auth` 2) y `GET /activities/submission-file/:filename`, que no lleva ningún ObjectId.

> ⚠️ **Contarlas con `grep '^router\.'` da 126 y se saltea una.** `routes/attendance.js` declara **dos** routers (`router` y `alumnoRouter`, que se exportan como `panelRouter` y `alumnoRouter` y se montan en `/preceptor/asistencia` y `/asistencia`), así que `POST /asistencia/:id/presente` —el botón "Dar asistencia" del alumno— queda fuera de cualquier barrido que asuma que el router siempre se llama `router`. Esa ruta **ya validaba** por su cuenta; lo que faltaba era que el smoke la mirara. El patrón para no repetir el error: `grep -rnE "^[a-zA-Z_]+\.(get|post|put|delete|patch)\('[^']*:"`.

**Tests**: smoke nuevo `objectid-invalido-da-404`, que recorre 95 rutas × 4 formas de id inválido (`new`, texto suelto, 24 caracteres no hex, 23 caracteres) más 8 combinaciones de las rutas con dos parámetros: **384 comprobaciones**. Incluye a propósito las que ya validaban de antes (`sections.js`, `rooms.js`, `attendance.js`, `jefatura.js`): el spec es la red que evita que esas guardas se pierdan en un refactor.

Se verificó en rojo neutralizando `idMalo` y volviendo a correr la suite entera: **fallan 338 comprobaciones, y solo ese spec** — las otras 280 del smoke siguen pasando, que es la prueba de que las guardas no cambian nada para un id válido. (Las que igual pasan en rojo son las que ya validaban por su cuenta y no dependen de `idMalo`.)

Una excepción anotada en el spec: `/superadmin/tasks/new` **es** una ruta real (el formulario de alta, definido antes del `/:id`), así que ahí `new` no se prueba. Lo mismo vale para `/activities/new`.

`tests/smoke/lib.js` sumó la opción `timeoutMs`, sin la cual una ruta colgada no falla el spec sino que cuelga el corredor entero, que no tiene timeout propio. **281/281 smoke, 268/268 unitarios, matriz de roles sin hallazgos.**

### 2026-08-14 — El Jefe de Sección configura el contenido de sus propias secciones

**Pedido**: *"con el rol de jefe de sección necesito crear la parte de configuración de secciones que se van a mostrar, son materias de cursos o cursos completos"*, con nombres como **Ciclo Básico, Electricidad, Mecánica y Construcciones**. Y, sobre el alcance: *"el jefe puede ver las materias que desee de los cursos que desee"*.

La entidad ya existía desde el 2026-08-06 (ver "Rol Jefe de Sección + Secciones" más abajo): lo que faltaba era que la pantalla fuera **alcanzable desde el rol**, que hasta acá solo miraba.

**`routes/sections.js` es un archivo nuevo, y no es prolijidad.** `routes/admin.js:133` monta `requireAdmin` sobre **todo** el panel de una sola vez. Meterle una excepción para que entre el jefe le habría abierto también Usuarios, Cursos, Importar y Auditoría. Con las 6 rutas mudadas a su propio router —montado en `server.js` **antes** de `/admin`, que es lo que hace que gane el match— la guarda del panel se queda intacta y el permiso se decide caso por caso. El smoke lo comprueba por los dos lados: 403 en las cinco solapas del admin, 200 en `/admin/secciones`.

**Dónde quedó la línea**:

| El jefe puede | El jefe no puede | Por qué |
|---|---|---|
| Editar contenido y nombre de **sus** secciones | Crear secciones | Crear sería otorgarse un alcance desde cero |
| Elegir **cualquier** curso y **cualquier** materia de su escuela | Borrarlas | La sección puede estar compartida: los dejaría sin alcance a todos |
| | Tocar `heads` | Sería darle acceso a las notas de su sección a un tercero |

- **`heads` no se lee del body en la rama del jefe.** El formulario lo manda igual (la vista es la misma), así que lo que lo hace seguro es que `armarSeccion` recibe los `heads` que la sección ya tenía y **no mira** `body.headIds`. Sin eso, el POST que sale de su propia pantalla —donde la lista de jefes es de solo lectura y por lo tanto viaja vacía— lo habría **expulsado de su propia sección**. Hay un smoke dedicado (`jefatura-secciones-no-cambia-los-jefes`).
- **La grilla se filtra por `heads`, no solo la barrera del `:id`.** Sin el filtro, el jefe vería el nombre, el contenido y los jefes de todas las secciones de la escuela aunque no pudiera abrirlas.
- **`config/sections.js`**: `admin_sections` suma el rol `jefe`. Eso hace aparecer la solapa y, de yapa, la celda *Jefe × Secciones* en `/superadmin/roles`, así se puede apagar por escuela sin tocar código. **No se agregó ninguna entrada al catálogo**: son las mismas 40, una de ellas con un rol más. Por eso `tests/roles/check-roles.js` no necesitó cambios — recorre `SECTIONS` y espera 200 donde `s.roles.includes(rol)`, así que absorbe solo el rol nuevo.
- **La pantalla es una sola para los dos paneles**: `views/admin/sections.ejs` elige `admin-nav` o `jefatura-nav` según el rol. Es la única solapa de `jefatura-nav` que no cuelga de `/jefatura`, y por eso su key es `admin_sections` y no una `jefe_*`.
- **`GET /:id/edit` valida la forma del id.** Antes, un id que no fuera un ObjectId hacía lanzar `CastError` a `findById`, y en Express 4 un throw dentro de un handler `async` deja el request **colgado**. Acá pesa más que en otras pantallas: la barrera es lo único que separa a un jefe de las notas de otra sección, y se prueba justamente escribiendo ids a mano.

**El riesgo, que es una decisión tomada y no un descuido**: un jefe puede meterle a su sección los 51 cursos de la escuela y quedarse con las 502 materias. Se le planteó al usuario con dos formas de acotarlo (que solo pudiera sacar, o un tope fijado por el admin) y eligió explícitamente el alcance libre. El control es posterior y vive en la auditoría: cada `section.edit` queda con el conteo de cursos, materias y jefes.

**Tests**: 5 smokes nuevos (ve solo las suyas · una ajena da 403 por GET y por POST · no crea ni borra · configura la suya y el alcance cambia en el request siguiente · guardar sin jefes no lo expulsa) y el viejo `jefatura-no-entra-a-otros-paneles` adecuado, que ahora comprueba 403 en cinco solapas del admin y 200 en Secciones. **280/280 smoke, 40/40 × 8 roles sin fugas, 268/268 unitarios.** Los 5 nuevos se verificaron en rojo neutralizando la barrera antes de darlos por buenos.

**Verificado en el navegador** con un jefe real: la solapa aparece en el nav de jefatura, la grilla muestra solo su sección sin "Nueva Sección" ni "Eliminar", el árbol le ofrece los 51 cursos, el bloque de jefes va de solo lectura, guarda desde el formulario conservando `heads`, y el curso agregado aparece en el filtro de Actividades acto seguido. El ícono del bloque de jefes pasó de `--text-hint` a `--text-secondary`: daba 2,64 de contraste sobre la tarjeta clara, abajo del 3:1 de WCAG para gráficos; ahora da 6,05 / 8,07.

**No toca la base de datos**: el schema de `Section` no cambió. Las 4 secciones de la escuela (Ciclo Básico, Electricidad, Mecánica, Construcciones) las carga el usuario a mano desde la pantalla.

### 2026-08-14 — Watchdog: por qué no se puede entrar al sitio

**El problema que lo motivó**: ante *"a la mañana producción se cae"*, los logs del servidor estaban **impecables** — cero errores, cero reinicios, cero 429. Eso no descartaba nada: probaba que el problema no dejaba huella donde estábamos mirando. Un usuario que "no puede entrar" puede estar trabado en seis capas, y **cinco son invisibles desde adentro de la aplicación**: el DNS público y el Funnel de Tailscale ya dejaron el sitio inalcanzable tres veces (20/07, 22/07, 10/08) con el servidor perfectamente sano.

**Qué hace**: `tools/watchdog.sh` corre por cron cada minuto y mide las seis capas en el mismo instante (app en localhost, workers, Mongo, cupo del rate limit, DNS público y camino público completo con TLS). `npm run watchdog:informe` agrupa las mediciones en **tramos** —"de 07:31 a 08:07 el DNS público estuvo caído mientras la app respondía"— y da el comando exacto del arreglo. `npm run watchdog:manana` filtra solo la franja 6-11 h, que es donde está el problema reportado. Documentación completa en `tools/README-watchdog.md`.

**Regla de diseño**: el `.sh` **solo mide**, no diagnostica. Todo el criterio vive en `services/watchdogDiagnostico.js`, testeado. Si el veredicto se calculara también en bash, tarde o temprano las dos versiones dirían cosas distintas y no habría forma de saber cuál miente.

**El orden de las capas no es arbitrario**: va de adentro hacia afuera, porque una capa rota explica a todas las de afuera. Con la app caída, que el Funnel no enrute es consecuencia, no causa — y decir "es el Funnel" mandaría a revisar Tailscale cuando hay que abrir `error.log`.

**Dos trampas de medición que ya estaban documentadas y quedaron cubiertas en código**: el DNS se consulta contra `8.8.8.8` explícito (el resolver local tiene MagicDNS enganchado y devolvería la IP interna `100.x` como falso OK; si la respuesta cae en el rango CGNAT se marca `dns=local` y no cuenta), y el chequeo público fuerza la IP con `--resolve` (un `curl` al nombre desde el propio servidor sale por el túnel y responde 200 aunque el Funnel esté roto para todo el mundo).

**Tres bugs que aparecieron al correr la herramienta de verdad**, y que ningún test hubiera anticipado:
1. `ss | grep -c` devuelve "0" **y** exit code 1 cuando no hay coincidencias, así que el `|| echo 0` agregaba un segundo cero en otra línea y **partía el registro en dos**. Ahora todo valor pasa por un sanitizador.
2. `workers=0` con la app respondiendo 200 se reportaba como caída. Si `/health` devolvió 200 hay workers por definición: lo que falló ahí es la medición, no el servidor.
3. Lo mismo con `docker ps` diciendo `mongo=down` mientras la app informaba `db:"ok"`. **La medición directa gana sobre la indirecta** — el criterio general que salió de los dos casos.

Las alarmas falsas son la forma más rápida de que se deje de mirar una herramienta de monitoreo, así que los tres casos tienen su test.

**Tests**: 27 en `tests/unit/watchdog.test.js`. Verificado además de punta a punta contra una mañana simulada con 37 minutos de DNS caído: la herramienta detectó el tramo exacto, lo nombró y dio el comando del arreglo. Suites: unit **268/268**, smoke **275/275**.

### 2026-08-13 — Monitor: el gráfico del rate limit en el tiempo (fase 2)

Completa la sección: curva de ocupación del cupo con el techo punteado, barras de peticiones por intervalo (rojas donde hubo 429), eje temporal y selector **1h / 6h / 24h / 7d**. La matemática vive en `public/js/ratelimit-chart.js` —sin DOM, para poder testearla— y se dibuja con `<polyline>` a mano, igual que las sparklines de Ancho de banda: el proyecto no usa librerías de charting.

**Cache de 30 s por rango en el endpoint.** Sin él, dejar la pestaña abierta en "7d" serían 12 lecturas por minuto de ~20 mil documentos para dibujar una curva que cambia una vez por minuto. El `ahora` no se cachea: es el dato en vivo.

**Tres cosas que aparecieron recién al verificar con datos reales**, y que son la parte que importa de este cambio:

1. **Los huecos mentían.** Un minuto sin tráfico no genera documento, así que dibujando solo los puntos existentes un hueco de tres horas quedaba pegado al anterior, idéntico a uno de un minuto. Ahora se rellena la ventana completa con ceros y esos buckets quedan marcados como "sin datos" — que no es lo mismo que un cero real: puede ser que el servidor estuviera apagado.
2. **El contador de workers se inflaba con cada deploy.** Contaba PIDs distintos de todo el rango, y el PID cambia en cada reinicio: un día con cuatro deploys mostraba "5 workers". Como el texto de la vista dice que el techo efectivo es esa cantidad de veces el cupo, el número engañaba justo sobre lo que hay que entender. Ahora es el máximo de PIDs distintos **dentro de un mismo minuto**, que es la concurrencia real.
3. **Legibilidad**: el eje salía en formato 12 h (`es-AR` da "12:59 a. m." por defecto) y en móvil las barras de "7d" medían 0,8 px con un gap de 1 px, o sea más separador que dato. Eje a 24 h y gap fuera cuando hay más de 80 buckets.

**Tests**: 20 unitarios nuevos (`tests/unit/ratelimitChart.test.js`) + 2 que fijan el conteo de workers. Suites: unit **241/241**, smoke **275/275**, roles sin hallazgos. Verificado en el navegador con datos reales en los cuatro rangos, en escritorio y en móvil, comprobando que ninguna coordenada se sale del `viewBox`.

### 2026-08-13 — Monitor: consumo del rate limit en el tiempo (fase 1)

**Pedido**: *"una vista para que pueda visualizar a través del tiempo el ratelimit usado y el actual"*, al lado de Ancho de banda. Spec completa en `specs/monitor-ratelimit.spec.md`.

**Lo que hacía falta resolver antes de graficar nada**: `ecosystem.config.js` levanta **2 workers** y `express-rate-limit` guarda las cuentas en el `MemoryStore` de cada proceso. Hay dos contadores independientes para la misma IP, y `/monitor/stats` cae en uno u otro por round-robin: graficar la lectura cruda daría un diente de sierra sin significado. Por eso la telemetría se guarda **por minuto y por worker** (`{ minuto, pid }` único) y se **suma al consultar**. El corolario que esto deja a la vista: **el techo efectivo real es ~2x el `max` configurado**, porque una IP recibe 429 recién cuando el worker que le tocó agotó su cuenta. La solución de fondo (store compartido) está anotada como D-03 y **no se hizo**.

**El otro punto no obvio**: los 429 solo se pueden contar desde el `handler` del limiter. Al agotarse el cupo, express-rate-limit responde y **no llama a `next()`**, así que para cualquier middleware posterior esas requests no existen y el contador daría siempre cero — justo el número que importa. Definir `handler` además **desactiva el envío automático de `message`**, así que hay que responder el cuerpo a mano; hay un test que fija ese cuerpo para que nadie le cambie el error a la escuela sin darse cuenta.

**Qué se ve**: cupo de la IP que consulta (usado/límite, barra y "se reinicia en X min"), bloqueos 429 de la última hora con la fecha del último, y el pico de consumo con **la IP que lo provocó** — lo único que distingue "toda la escuela navegando" de "un script suelto". La vista aclara en el mismo lugar las dos cosas sin las cuales el número engaña: que estáticos y sala en vivo están exentos del limiter, y que el total suma los 2 workers.

**Costo**: 2880 documentos por día (2 workers x 1440 min), TTL de 14 días, una escritura por worker por minuto. Si Mongo está caído se descarta la muestra y la app sigue: es telemetría, no puede tumbar un request.

**Tests**: 21 unitarios (`tests/unit/rateLimitStats.test.js`) + 3 smoke. El 429 se prueba montando un express con `max: 3`, porque provocarlo contra el server real serían 12000 peticiones. Suites: unit **220/220**, smoke **275/275**, roles sin hallazgos.

⚠️ **Colección nueva en producción** (`ratelimitsamples`): se crea sola con el índice TTL al primer volcado. No hay que migrar nada ni tocar datos existentes.

### 2026-08-13 — Rate limit general: 1200 → 12000 cada 15 minutos por IP

**Síntoma**: 429 *"Demasiadas peticiones"* corriendo `test:smoke` y `test:roles` seguidos — la limpieza final de roles quedaba a medias y dejaba usuarios y divisiones de prueba en la base. El mismo techo lo puede tocar la escuela en el arranque de clase.

**El número no es por persona**: toda la escuela sale por **una sola IP pública NAT** (~300 personas), así que el cupo es para todas juntas. Con 1200 tocaban a **4 requests cada 15 minutos por cabeza**, menos que abrir un curso y su solapa de actividades. Con 12000 son ~40, que cubre navegación activa real con margen para el pico de las 7:30.

**Sigue contando por IP**, decisión del usuario. La unidad correcta sería el usuario logueado (es lo que ya hacen los 5 limiters de `middleware/rate-limits.js`), pero `generalLimiter` se monta **antes** de cookie-parser y de `requireAuth`, así que `req.userId` todavía no existe: habría que adelantar cookieParser y verificar el JWT dentro del `keyGenerator`. Queda anotado como la mejora de fondo, sin hacer.

**Qué NO queda desprotegido**: los endpoints caros (subidas, chat de la sala, mensajes, autoasistencia) tienen su propio limiter **por usuario**, y login/registro pasan por `authLimiter` (3000/15min, sin tocar). El general es la red de última instancia contra un script suelto.

**Verificado**: `RateLimit-Policy: 12000;w=900` en la respuesta, y las dos suites corridas **una detrás de la otra sin esperar** — smoke 272/272 y roles sin hallazgos, con la limpieza completa esta vez (7/7 usuarios y la división, que era justo lo que fallaba con 429).

### 2026-08-13 — Las devoluciones del docente se perdían si no ponía nota

**Reclamo de los docentes**: *"cuando está dando devoluciones de los trabajos entregados, no se guardan"*.

**Causa** (`public/js/course.js`, `saveAllGrades`): la recolección iteraba los **inputs de nota** y arrancaba con `if (val === '') return;`. Si el docente escribía el comentario pero no ponía nota — que es lo normal cuando la devolución es la corrección y la nota viene después — la fila entera se descartaba y el comentario **nunca se mandaba al servidor**. Encima, con cero entradas la pantalla igual mostraba *"✓ Notas guardadas"*, así que el docente se iba convencido de que había guardado. La segunda pérdida silenciosa estaba dos líneas más abajo: `if (isNaN(points) || points < 0 || points > max) return;` descartaba también las notas fuera de rango, sin avisar.

**Arreglo, de punta a punta**:

- **`models/Activity.js`** — `grades[].points` deja de ser `required`. Un grade con `points: null` significa *"hay devolución escrita, todavía no hay nota"*. **No requiere migración**: los documentos existentes ya tienen su nota y siguen siendo válidos.
- **`POST /activities/:id/grade`** — la nota pasa a ser opcional. Si no viene `points`, la nota que ya estuviera cargada **no se toca** (mandar solo la devolución nunca borra una nota). Se agregó validación de rango server-side (antes `Number(points)` aceptaba cualquier cosa, y `Number('')` convertía un campo vacío en un **0**). Rechaza con 400 el body que no trae ni nota ni devolución.
- **`public/js/devoluciones.js`** (nuevo) — la lógica de "qué filas hay que mandar" salió de course.js a una función pura, para poder testearla sin DOM. Manda solo lo que el docente tocó, y devuelve aparte las notas mal cargadas para poder avisarlas.
- **Frontend** — la devolución se guarda con o sin nota; las notas inválidas se avisan por alert en vez de desaparecer; el cartel de confirmación dice qué se guardó (o *"No había cambios para guardar"*, en vez de mentir). El botón y la columna pasaron a llamarse "Guardar" y "Devolución al alumno".
- **Vista del alumno** — una devolución sin nota **no** lo marca como "Calificada": la caja sigue en "Aún no calificado" y el comentario del docente se muestra igual. En "Mis notas" aparece como "Con devolución".
- **Paneles de directivo y jefatura** — todo lo que cuenta "calificados" ahora filtra por `points != null` en vez de `grades.length` / `$size: 0`. Sin esto, una devolución sin nota habría sacado a la actividad de "vencidas sin calificar" y habría metido un `null` en los promedios (`$divide` con null).

**Tests**: `tests/unit/devoluciones.test.js`, 19 casos. **Verificado revirtiendo el arreglo**: con la recolección vieja fallan 11, entre ellos el del reclamo original. Suite unit completa: 199/199.

**Verificado en el navegador** (docente real de la BD local, curso con 32 alumnos): devolución sin nota → se guarda y sobrevive a la recarga; editar solo la devolución de un alumno ya calificado → conserva su nota; el alumno ve el comentario y la actividad sigue figurando como no calificada.

### 2026-08-11 — Una sesión cuyo usuario fue borrado tiraba 500 en vez de mandar a /login

**Bug de producción** (`logs/error.log`, 14:07:37, IP 186.141.229.186): `GET /courses` → 500 con `TypeError` en `views/dashboard.ejs:32` — *"Cannot read properties of null (reading 'role')"*.

**Causa**: `requireAuth` (middleware/auth.js) solo validaba **firma y vencimiento del JWT**. A quien le borran la cuenta le queda un token **perfectamente válido** hasta 7 días (el `maxAge` de la cookie), así que pasaba la guarda; pero `checkUser` hidrata `res.locals.user` con `getCachedUser()`, que devuelve `null` cuando el documento ya no está en Mongo. La ruta corría con un usuario inexistente y la vista reventaba. `routes/courses.js` ya se cuidaba (`res.locals.user?.role`, líneas 124 y 131); la vista no.

**Arreglo de fondo**: `checkUser` marca `req.userMissing`, limpia ambas cookies y corta; `requireAuth` lo lee y redirige a `/login`, exactamente el mismo mecanismo que ya existía para `req.userDisabled`.

⚠️ **Solo cubre "la consulta respondió y no hay usuario".** Si `getCachedUser` **lanza** (Mongo caído), cae en el catch de siempre, que deja el usuario en null **sin** marcar el flag — a propósito: ante un problema de base no hay que desloguear a toda la escuela ni borrarle la cookie a nadie.

**Defensa en profundidad**: `views/dashboard.ejs` define `const rol = locals.user ? user.role : null` y lo usa en los 5 lugares donde antes hacía `user.role` pelado (el reporte mencionaba 3; había 2 más). Las comparaciones **negativas** llevan además `rol &&`: con `rol` en null, `null !== 'teacher'` daría true y le mostraría botones de administración a una sesión sin usuario.

**Las otras vistas se revisaron y se decidió NO tocarlas** — ver el punto 7 de Issues Conocidos. `profile.ejs` (22 usos), `course.ejs` (5) y `admin/user-profile.ejs` (2) usan `res.locals.user` sin guarda, pero son inalcanzables con null: sus rutas consultan Mongo antes de renderizar, así que el único camino que queda (base caída) las hace fallar antes. Cambiar 29 usos en vistas de alto tráfico para un caso que no puede ocurrir es más riesgo que beneficio.

**Test**: `sesion-de-usuario-borrado` en tests/smoke/specs.js. Crea el usuario, inicia sesión, lo borra **directo en Mongo** (por la API el DELETE del admin también invalidaría la sesión, y lo que hay que reproducir es la cookie que sobrevive a su dueño) y espera 302 a `/login`.

⚠️ **El test NO puede hacer ningún request entre el login y el borrado**: el `userCache` tiene TTL de 45 s por worker, así que una sola navegación dejaría al usuario cacheado y el borrado no se notaría — el test pasaría sin ejercitar nada.

**Verificado revirtiendo el arreglo**: sin él, el test falla con *"esperaba redirección a /login, recibió 200"*. El **200** (y no 500) es el dato interesante: la guarda de la vista sola evita el crash pero deja al usuario borrado **navegando como sesión fantasma**. Hacen falta las dos capas y por motivos distintos. Suite completa: smoke **269/269**, `test:roles` sin hallazgos, unit 169/169, images 17/17.

### 2026-08-11 — Sistema de logs: access log, requestId y los 118 catch que no decían nada

**Pedido**: "quiero que planifiques un log general, para que al momento de que algo así vuelva a fallar se encuentre rápidamente la solución del problema".

**El diagnóstico que lo motivó**: ese mismo día, un reporte de "el login se queda cargando" se llevó dos horas de descartar red, DNS, Funnel, workers, base de datos y endpoint **a mano**, porque no había forma de contestar la pregunta más básica: *¿qué respondió el servidor y en cuánto tiempo?* El estado de partida:

```
118  catch en routes/ que responden 5xx        →  0 logueaban nada
  0  access log: el único logging del proyecto era el manejador global de errores
```

**Etapa 1 — que nada falle en silencio**

1. **`middleware/request-log.js`**: una línea por request con método, ruta, status, duración, pid, usuario e ip. El nivel sale del status (5xx→error, 4xx→warn, resto→info), así que **un 500 que una ruta se tragó en silencio igual queda registrado**. También marca en `warn` las requests que pasan de 2 s aunque respondan 200: una pantalla que tarda 8 segundos está rota para quien la usa y antes no dejaba huella.
2. **`middleware/route-log.js`** con `logDeRuta()` y `logRechazo()`. Los 118 catch quedaron migrados (74 + 40 + 2 a mano, más 44 `catch {` sin binding que hubo que convertir a `catch (err) {`).
3. **Los rechazos deliberados se registran**: `fallar()` de la sala y las cinco validaciones de la suplantación. Eran invisibles porque responden con `res.json()` sin lanzar excepción — el manejador global nunca los ve. Así fue como el rechazo de los `.heic` no dejó una sola línea.

**Etapa 2 — que se pueda correlacionar**

4. **`requestId`** (UUID) por request, devuelto en el header **`X-Request-Id`** y presente en toda línea de esa request. Un usuario copia esa referencia de DevTools y `grep <id> logs/combined.log` trae la request entera. El manejador global lo agrega también al cuerpo del error (`ref: …`).
5. **`pid` en todas las líneas** (config/logger.js). Con 2 workers en cluster, sin esto no se sabe cuál atendió qué — se perdió media hora persiguiendo un "worker zombi" inexistente.
6. **Timestamp ISO con offset**. Antes era hora local sin zona y había que cruzarla a mano contra el `Date` en GMT de las respuestas HTTP.
7. **`ecosystem.config.js`: PM2 dejó de escribir en `logs/error.log`**, que era el mismo archivo de winston. Por eso `tail -40 logs/error.log` devolvía casi puros `DeprecationWarning` y había que filtrar con `grep '"level":"error"'`. Ahora: `error.log`/`combined.log` son de winston, `pm2-error.log`/`pm2-out.log` del proceso.

⚠️ **Al desplegar esto, `pm2 restart classroom` NO alcanza** para el punto 7: ese comando reusa la configuración guardada. Va `pm2 restart ecosystem.config.js --update-env`.

**Dos decisiones que evitan que el log se vuelva inservible** — el modo de falla más común de un logging es ahogarse en su propio ruido:

- **Rutas ruidosas** (`/health`, el poll de la sala, estáticos por carpeta y por extensión, y todo `HEAD`) se registran **solo si fallan**. El poll es el caso extremo: 30 alumnos preguntando cada 4 s son ~450 requests por minuto de una sola clase. Se detectó verificando: el preview local pegaba un `HEAD /` cada 200 ms y en un minuto no se veía otra cosa.
- **El 503 del modo mantenimiento no es un error.** Durante una ventana rebota la plataforma entera, así que contarlo como error sepultaría `error.log` en alarmas falsas justo el día que más hace falta leerlo. Se marca con `res.locals.mantenimiento`.

**Verificación**: `test:unit` 169/169, `test:images` 17/17, **smoke 268/268**, y —lo que importa— esa corrida completa dejó **658 líneas con 0 de nivel error**. Un log en el que una corrida limpia no genera errores es un log en el que un error significa algo.

**Volumen**: 658 líneas (~130 KB) por corrida de smoke. Con uso real de la escuela esto crece rápido y **todavía no hay rotación** — es la etapa 4 del plan, junto con la captura de errores del navegador (lo único que cubriría un problema del lado del cliente, como se sospechó de la sala en vivo).

### 2026-08-11 — Las fotos de iPhone (.heic) ya se pueden subir, y el límite de imagen pasó a 20 MB

**Pedido**: "uno de los profesores además intentó subir un archivo de imagen y documentos pero no funcionó tampoco en la sala del chat".

**Causa**: `EXT_IMAGENES` (config/imagePresets.js) no incluía `.heic`, que es **el formato por defecto de la cámara del iPhone desde iOS 11**. El input de la sala es `accept="image/*"`, así que el teléfono dejaba elegir la foto y el rechazo llegaba recién en el servidor.

**Lo que lo volvía indiagnosticable**: cuando el `fileFilter` de multer rechaza por extensión, deja `req.file` vacío, y `routes/rooms.js` respondía **"No se recibió ninguna imagen"** — un mensaje que culpa al usuario de no haber adjuntado nada cuando sí adjuntó. El POST de *archivo* sí listaba los formatos aceptados; el de *imagen*, no. Por eso el reporte fue "no funcionó" a secas.

Y no dejaba rastro: los rechazos salen por `fallar()`, que hace `res.status(400).json(...)` **sin lanzar excepción**, así que el manejador global nunca lo ve y `error.log` queda mudo. Un log vacío NO significaba que no hubiera pasado nada.

**Cambios**:
1. `.heic` y `.heif` agregados a `EXT_IMAGENES`. Salen convertidos a WebP como cualquier otra imagen: el HEIC nunca queda publicado tal cual, así que al alumno le llega algo que su navegador entiende.
2. `MAX_INPUT_BYTES` de 8 → **20 MB**. Con 8 MB rebotaban fotos de celulares actuales, y era **menor que el límite de los `.zip` de la sala (20 MB)** — siendo que la foto se recomprime a ~100 KB y el zip se guarda entero. Ahora coinciden.
3. El mensaje de `routes/rooms.js` ahora lista los formatos aceptados, igual que el de archivo.
4. `accept` actualizado en el avatar (`views/profile.ejs`) y la portada de materia (`views/course.ejs`), que tenían listas explícitas sin HEIC.

**El riesgo que quedó cubierto**: leer HEIC depende de que el libvips del binario de sharp traiga el códec, y **eso varía por plataforma** — el de desarrollo (Windows) puede no coincidir con el de producción (Linux). Verificado localmente: `sharp.format.heif.input.file === true`. Ojo con la asimetría al diagnosticar: **escribir** HEIC casi nunca está disponible (`heifsave: Unsupported compression`, el codificador HEVC tiene patentes) pero **leerlo** sí; acá solo hace falta leer.

Si en producción faltara, `optimizar()` no da el genérico "no es una imagen válida" —que acusaría a una foto perfectamente buena— sino **"Volvé a enviarla como JPG: Ajustes → Cámara → Formatos → Más compatible"**. La severidad del log distingue los dos casos, y la distinción es el punto: `ERROR` solo si falta el loader (problema de instalación, hay que ir al servidor), `WARN` si el loader está y falló el archivo. Loguear "falta el códec" ante cualquier `.heic` roto llenaría `error.log` de alarmas falsas.

**Tests**: `npm run test:images` 17/17 (dos nuevos: las extensiones aceptadas con el límite, y que un `.heic` ilegible dé el mensaje accionable). `npm run test:unit` 169/169.

### 2026-08-11 — Las solapas del superadmin dejaron de moverse al cambiar de sección

**Pedido**: "cuando estoy como rol de superadministrador o como administrador, se me mueven mucho las solapas que tengo activas, incluyendo si me posiciono en usuarios, y es muy molesto. se mueven de derecha a izquierda".

**Causa**: el ancho del contenedor cambiaba según la pantalla. De las 15 vistas del panel de superadmin que muestran el nav, solo **Usuarios** y **Roles** usaban `main-content-ancho` (1400 px); las otras 13 se quedaban en los 1100 px de `main-content`, centrados. Entrar o salir de esas dos corría las 13 solapas **150 px a la izquierda**.

Es exactamente el mismo problema que se corrigió en el panel de admin el 2026-08-03, y que ahí se resolvió poniéndole el contenedor ancho a **todo** el panel. Superadmin y jefatura habían quedado afuera.

**Cambio**: `main-content-ancho` en las 14 vistas que faltaban de superadmin (Resumen, Escuelas, Importar, Sugerencias, Mensajes + detalle, Temas, Auditoría, Backup, Otros, Tareas, Asignar tareas, Monitor, ficha de escuela) y en las 2 de jefatura que faltaban (detalle de docente y entregas de una actividad). Solo el atributo `class` del `<main>`: ninguna ruta, consulta ni regla de CSS nueva.

**La regla, para no volver a romperla**: si una vista muestra el nav de sección, va con `.main-content-ancho`. La única forma de que las solapas no se muevan es que todas las pantallas del panel midan lo mismo. Los formularios sueltos (alta y edición) siguen angostos a propósito — no muestran el nav, así que no hay solapas que se corran.

**Verificado en el navegador** a 1440 px, sobre las 15 pantallas del superadmin (incluidos los detalles de escuela y de mensaje): el nav arranca en x=44 en todas, el contenedor mide 1400 en todas, la solapa "Usuarios" queda siempre en (299, 104) y ninguna desborda horizontalmente. Antes: x=194 en las angostas contra x=44 en las anchas. Smoke: **267/267**.

Las dos vistas de jefatura quedaron sin verificar en el navegador: **no hay ningún usuario con rol `jefatura` en el mirror local** (ni, por lo tanto, en producción), así que no hay sesión con la que renderizarlas. El cambio es el mismo atributo `class` que en las otras 14, y sus vistas hermanas del mismo panel ya lo usaban.

**Dos cosas que se revisaron y NO eran el problema**, para no volver a investigarlas:

- **El panel de admin ya estaba bien.** Sus 13 vistas con nav llevan el contenedor ancho desde el 2026-08-03; medido pantalla por pantalla, las solapas no se mueven ni un píxel. Lo que sí cambia de ancho ahí son los formularios de alta y edición (600 px centrados), que no tienen nav.
- **La barra de scroll no corre nada.** `html { scrollbar-gutter: stable }` funciona: el `<body>` mide 1424,8 px tanto en una pantalla corta como en una larga. (Ojo con medirlo con `document.documentElement.clientWidth`: ese devuelve 1440 en las cortas y hace parecer que el canal no está reservado.)

**Hallazgo al pasar, sin corregir**: `GET /admin/users/new` (una URL que no existe — la buena es `/users/create`) **deja la petición colgada para siempre** en vez de responder 404. Cae en `/users/:id`, el cast de `"new"` a ObjectId falla y la promesa rechazada no la agarra nadie: en el log aparece `unhandledRejection` y el navegador se queda esperando. Anotado en el backlog.

### 2026-08-10 — La sala en vivo acepta imágenes y archivos (adjuntos privados)

La docente puede compartir en el chat de la sala **una imagen** (se ve como card con preview, y al tocarla se abre en grande) o **un archivo** (card con la extensión, el nombre y el peso; se abre en una pestaña nueva). Puede eliminarlos, y eliminar significa eliminar.

**Sube solo quien gestiona la materia** (`canManage`: titular, co-docentes, admin de escuela). Alumnos, preceptoría y dirección ven y descargan, no suben. Es lo que mantiene previsible el volumen de disco y deja la responsabilidad del material en quien da la clase.

**La decisión que ordena todo lo demás: los archivos NO viven en `/public`.** Van a `archivos/salas/{schoolId}/{courseId}/{sessionId}/` —fuera del estático, como las entregas de alumnos— y se sirven por `GET /courses/:id/sala/archivos/:mid`, que pasa por el mismo `cargarSala` que el chat y revalida el permiso en **cada** pedido. Servirlos como estáticos habría significado que cualquiera con la URL los ve sin loguearse y **para siempre**: o sea que "la docente lo eliminó" sería mentira. En un chat de menores, el borrado tiene que ser real.

- **Modelo**: `RoomMessage.kind` suma `'image'` y `'file'`, más un subdocumento `attachment`. Un adjunto es **un mensaje más**, no una colección aparte: así hereda el cursor `seq`, el soft delete, la moderación y la transcripción sin duplicar nada de eso. `attachment.path` **nunca** sale al cliente.
- **Borrar**: el documento se marca como cualquier mensaje (queda quién, cuándo y qué archivo era) pero **el archivo se borra del disco**. Conservar un texto de 500 caracteres por si hay que reconstruir un episodio es una cosa; conservar indefinidamente una foto que la docente sacó de la vista del curso es otra.
- **Imágenes**: preset `sala` (1600 px, WebP, calidad 76) por el pipeline que ya existía. Medido: un PNG de 417 KB queda en 9 KB — importa más acá que en otros presets, porque 30 chicos bajan la misma foto a la vez, muchos desde datos móviles.
- **Extensiones**: `.pdf .doc .docx .xls .xlsx .ppt .pptx .odt .csv .txt .zip`. Nada ejecutable ni interpretable como HTML (`.html`, `.svg`), y la respuesta va con `nosniff`. Hay un test que falla si alguien agrega una de esas de buena fe.
- **Límites**: 20 MB por archivo (igual que las entregas), 8 MB por imagen (se recomprime). `roomUploadLimiter`: 20 subidas cada 10 min **por usuario** — no por IP, misma razón de siempre (toda la escuela sale por una sola IP NAT; ver el 2026-07-28).
- **Purga**: `cleanup-rooms.js` ahora borra también los archivos de disco de las clases que purga, por carpeta de sesión. Sin eso, las fotos quedaban en disco para siempre sin ningún mensaje que las nombrara. El resumen previo dice cuántos archivos y cuánto espacio.
- **Transcripción y CSV**: los adjuntos aparecen en el historial de la clase y en el CSV como `[Imagen] pizarrón.webp (240 KB)`. Una transcripción que los omitiera diría que la docente estuvo callada.
- **Auditoría**: `room.share_file` nueva; `room.delete_message` ahora anota el tipo y el nombre del archivo.
- **Disco**: `services/diskStats.js` suma `archivos/salas` como renglón propio en el monitor — es el único directorio que se purga solo, así que verlo crecer y bajar aparte dice si la retención de 3 meses alcanza.
- **Huérfanos**: `cleanup-files.js` ahora también barre `archivos/salas`. Referencia los adjuntos de mensajes **no borrados**: un archivo cuyo mensaje figura borrado es, por definición, un `unlink` que falló en su momento, y contarlo como vivo dejaría en disco para siempre justo el material que alguien decidió sacar. Sin esto, un archivo cuyo documento nunca se llegó a crear no lo barría nadie.
- **Tarjetas de supervisión**: el conteo de `getOpenSessions` pasó de `kind: 'text'` a incluir los adjuntos. Una clase donde la docente compartió el material y nadie escribió está muy viva, y la tarjeta decía "0 mensajes · sin actividad" — parecía una sala muerta justo cuando había algo para mirar.
- **La imagen va envuelta en un `<a>`** al archivo, no es un `<img>` con un click encima: se llega con el teclado (antes la foto era inalcanzable sin mouse), anda "abrir en pestaña nueva" del botón derecho, y si el JS falla el link sigue llevando a la imagen. Con JS andando, el handler hace `preventDefault` y abre la lupa; ctrl/cmd/shift+click se dejan pasar.
- **`min-width: 0` en el cuadro de escribir**: un `<input>` trae un ancho intrínseco de ~20 caracteres y `flex: 1` no lo achica por debajo de eso. Con los dos botones nuevos al lado, en un celular de 360 px el botón de enviar quedaba fuera de la barra. Verificado hasta 320 px: sin scroll horizontal, todo adentro.

**Dos bugs previos que aparecieron en el camino, ajenos a los adjuntos:**

1. **El chat duplicaba la conversación entera al reaccionar o borrar.** `vistos.clear(); seq = 0` marcaba "ningún mensaje está pintado" mientras el DOM seguía teniéndolos, así que el poll siguiente los volvía a agregar abajo. Vaciar la lista de vistos y vaciar el chat tienen que ser la misma operación: ahora lo son (`repintarTodo()`).
2. **`loading="lazy"` dejaba las imágenes del chat sin cargar.** El chat es un contenedor con scroll propio y el mensaje nuevo se inserta al fondo, fuera del área visible: la imagen no se pedía nunca, sin error en consola, hasta que alguien scrolleaba a mano. Card en blanco — el peor modo de fallar, porque parece que la docente compartió algo roto. Sacado del chat en vivo (en la transcripción, que scrollea normal, se conserva).

**Sin cambios en la base de datos**: `kind` suma dos valores al enum y `attachment` es opcional. Los mensajes que ya existen siguen siendo válidos y no hay migración.

**Verificado en el navegador** (subida real desde la UI, card, lightbox, borrado, disco, auditoría, transcripción y CSV) y con `sala-adjuntos` en el smoke (267/267) más 10 tests unitarios nuevos.

**Pendiente**: esto se implementó sin spec previa, a pedido. Falta escribir `specs/sala-adjuntos.spec.md` y modularizar (`routes/rooms.js` quedó en ~700 líneas).

### 2026-08-08 — `var(--background)` no existía: 36 fondos que nunca se vieron

**Síntoma**: ninguno visible. Ese era el problema. `var(--background)` se usaba 36 veces en 18 vistas EJS, en `public/css/style.css` y en `public/js/course.js`, pero **esa variable nunca se definió**. Las reales son `--bg` (`#f0f4f8` claro / `#111418` oscuro), declaradas en `style.css:13` y `style.css:29`.

Una `var()` sin definir ni fallback deja la declaración *inválida en tiempo de cómputo*: `background` cae en su valor inicial, `transparent`. Así que todos esos fondos —encabezados y hover de las tablas de directivo/preceptor/jefatura, la caja de resumen de Secciones, los mensajes de Sugerencias, la zona de drop del backup, la textarea de entrega del alumno— venían rindiendo transparentes desde siempre. Nadie los reportó porque no se veían: no rompen nada, simplemente no aparecen.

**Del mismo tipo, pero este sí se veía**: `views/superadmin/monitor.ejs` pedía `var(--text-primary, #1a1a2e)` para `.metric-value`. `--text-primary` tampoco existe (la real es `--text`), así que **siempre** caía en el fallback `#1a1a2e` — casi negro. En tema oscuro esos números grandes quedaban sobre `#1e2124`: prácticamente invisibles. Ahora usa `var(--text)`: 14,6 de contraste en oscuro.

**Lo que costó más que el reemplazo**: las columnas ancladas. Cuando se implementaron (2026-08-02) el default de `--celda-fija-bg-head` se fijó en `var(--surface)` justamente **porque** los encabezados eran transparentes — replicaba lo que se veía. Al arreglar la variable, el encabezado normal pasaba a `--bg` y la celda anclada se quedaba en `--surface`: dos colores distintos en la misma fila. Las 6 tablas afectadas (`courses`, `divisions`, `students`, `teachers`, `grades` de directivo y `division-detail` de preceptor) ahora pisan `--celda-fija-bg-head` / `--celda-fija-bg-hover`, con el mismo patrón que ya usaba `.sp-table` en `views/superadmin/school-profile.ejs`. `grades` solo pisa el encabezado: esa tabla no pinta las filas al pasar por encima.

**El único fondo que había que elegir distinto**: `.sec-chip` en `views/admin/sections.ejs`. Su tabla no está dentro de una tarjeta, así que las celdas son transparentes y el chip queda apoyado directamente sobre el fondo de la página — que es `--bg`. Con la variable "arreglada" el chip habría quedado del mismo color que la página: invisible igual que antes, pero ahora a propósito. Quedó en `var(--surface)`. Con `var(--border)` también se distinguía, pero el texto de 11,5 px daba 4,41 de contraste, apenas abajo del 4,5 que pide WCAG AA para texto chico; sobre `--surface` da 6,05.

**Verificado en el navegador**, en tema claro y oscuro, midiendo colores computados y ratios de contraste en: las 4 tablas de directivo (encabezado y celda anclada coinciden en las 6 tablas), los 4 detalles de directivo, las 2 vistas de preceptor, jefatura, `/admin/secciones`, `/admin/secciones/create`, `/superadmin/otros`, `/superadmin/suggestions`, `/superadmin/backup`, `/superadmin/monitor`, `/courses/profile` y la textarea de entrega del alumno. El texto sobre `--bg` da 5,47 en claro y 9,21 en oscuro; el escalón de `--bg` sobre `--surface` da 1,11 / 1,14, que es el mismo que ya venían usando `.sp-table` y `audit-list`.

**Quedó a la vista y NO se tocó** — otras cuatro variables que tampoco existen: `--text-primary` (47 usos más), `--surface-variant` (10), `--divider` (8), `--hover-bg`, `--success` y `--surface-2` (1 cada una). Las de `color:` sin fallback son casi inocuas (una `var()` inválida en una propiedad heredada hace que el elemento herede el color del padre, que suele ser `--text` igual). La que sí se ve es `--divider` en `border: 1px solid var(--divider)`: invalida el atajo entero y deja el borde en `none`. Comprobado en la textarea de entrega del alumno (`public/js/course.js:1946`), que hoy no tiene borde.
### 2026-08-08 — Fix: los 12 backups de seguridad acumulados eran todos irrestaurables

**Síntoma**: ninguno. Ese es el punto — el problema era invisible hasta el día en que hiciera falta restaurar.

`POST /superadmin/backup/preview` rechazaba con 400 cualquier backup al que le faltara **alguna** colección del array `COLLECTIONS`. Cuando se implementó la sala en vivo se sumaron `roomsessions`, `roommessages` y `roompresences` a ese array, y con eso **todo backup generado antes de esa fecha pasó a ser irrestaurable de golpe**.

Alcance real, verificado leyendo los 12 manifests de `backups/` (2,8 GB, del 22-jul al 3-ago de 2026): **los 12 daban 400**. Y no son backups cualquiera: son los `pre-restore-*.tar.gz` que genera el propio `POST /restore` antes de pisar la base. La red de seguridad estaba rota justo en el escenario para el que existe.

Dos detalles que lo agravaban:

- `BACKUP_FORMAT_VERSION` nunca se bumpeó al agregar las colecciones nuevas. Los backups viejos declaran `1.0` igual que los de hoy, así que el chequeo de versión no podía distinguirlos y el de colecciones terminaba haciendo de guadaña.
- El loop del restore ya toleraba el archivo faltante, pero **vaciando** la colección (`deleteMany` + insertar cero). O sea que el 400 del preview era lo único que separaba al usuario de un comportamiento que ya estaba implementado.

**Fix**: la tolerancia es **por colección, no general**. En `COLLECTIONS`, las que nacieron después de que se congelara el formato 1.0 van marcadas con `optional: true`; el preview solo rechaza si falta una **obligatoria**. Un backup truncado sin `users` se sigue rechazando, que es lo que hay que conservar: restaurarlo vaciaría la tabla de usuarios en silencio.

**Qué pasa con las ausentes: se vacían, no se dejan como están.** Un restore es un viaje a una fecha, y en esa fecha esas colecciones no existían. Dejarlas intactas sería un restore a medias: las sesiones de sala de hoy quedarían apuntando a cursos, divisiones y usuarios que ese mismo restore acaba de borrar, y esas refs son `required` en los tres modelos.

**El preview lo dice en tres lugares**, porque es una pérdida de datos que el usuario tiene que ver antes de confirmar: un recuadro de advertencia que las lista, la fila de la tabla marcada como "no venía" (un `0` se leería igual que "venía vacía", que es otra historia), y una cuarta casilla de confirmación obligatoria que las nombra. El log del restore distingue `Vaciado X: el backup es anterior a esta colección` de `Restaurado X: N documento(s)`, y la auditoría guarda el campo `vaciadas`.

**Tests**: `backup-preview-accepts-backup-sin-colecciones-nuevas` (acepta y avisa) y `backup-preview-rejects-backup-sin-coleccion-obligatoria` (la contracara: sigue rechazando). Fabrican el `.tar.gz` al vuelo con un manifest controlado — el preview a propósito solo lee `manifest.json`, así que el fixture pesa unos bytes y no hay binarios commiteados.

**Al agregar una colección nueva al backup**: va en `COLLECTIONS` con `optional: true`, y se queda así para siempre. Es lo que evita que esto vuelva a pasar.

**No requiere ningún cambio en la base de producción.**

### 2026-08-08 — Fix: el deploy quedaba trabado para siempre si el árbol de producción se ensuciaba (v1.0.30)

**Síntoma**: se pusheó la v1.0.28 y producción siguió mostrando la v1.0.26 en el footer. Ya había pasado con la v1.0.27, con el mismo desenlace: reload manual por SSH.

**Causa raíz**, que `logs/deploy.log` tenía escrita textualmente:

```
error: Los cambios locales de los siguientes archivos serán sobrescritos al fusionar:
        agente.md
        config/sections.js
        …
error: Los siguientes archivos sin seguimiento en el árbol de trabajo serán sobrescritos al fusionar:
        models/RoomMessage.js
        routes/rooms.js
        …
Abortando
ERROR deploy: git pull fallo
```

Los 15 archivos "modificados" y los 15 "sin seguimiento" eran **exactamente** los que toca el commit `1ac404a` (salas en vivo). O sea: el disco tenía el contenido de la v1.0.27 pero `HEAD` seguía en `0927d05` (v1.0.26). Eso solo pasa si un `git pull` **escribió los archivos y murió antes de mover HEAD**. El `find /home/walter/classroom -not -user walter` lo confirmó: había `routes/*.js`, `specs/` y hasta objetos de `.git/objects/` con dueño **root**, resaca de varios pulls manuales corridos como root en sesiones anteriores. Desde entonces el usuario `walter` —el que corre el deploy automático— no podía pisar esos archivos.

**Lo grave no era el pull roto, sino que era irreversible sin intervención humana**: `git pull` hace un merge, y un merge se niega a sobrescribir archivos locales. Basta que el árbol se ensucie **una vez** para que **todos** los deploys posteriores mueran en el mismo punto, para siempre.

**Fix**: el paso de actualización pasa de `git pull` a `git fetch origin && git reset --hard origin/main`. El árbol de producción es un espejo de `origin/main` —nadie edita código en el server—, así que no hay nada local que preservar, y `reset --hard` sí pisa modificados y sin seguimiento por igual. El deploy queda **idempotente y capaz de autorrepararse**. De paso vuelve innecesario el `git checkout -- package-lock.json` del 2026-07-29: era un caso especial del mismo problema general.

El mensaje de error del reset incluye ahora la pista del `chown`, porque el otro modo de falla (archivos de root) se manifiesta como un "Permiso denegado" que no dice qué hacer.

**Reparación manual que hubo que hacer una vez** (los pasos, en orden, por si reaparece):

```bash
chown -R walter:walter /home/walter/classroom
sudo -u walter -H git -C /home/walter/classroom fetch origin
sudo -u walter -H git -C /home/walter/classroom reset --hard origin/main
sudo -u walter -H bash -c 'cd /home/walter/classroom && npm install --omit=dev --no-audit --no-fund'
sudo -u walter -H /usr/local/bin/pm2 restart classroom --update-env
```

**⚠️ Bootstrap, la regla de siempre**: el push que instala este cambio lo procesa el webhook **viejo** que está en memoria, el que todavía usa `git pull`. Como el árbol quedó limpio, ese pull debería funcionar; recién el push siguiente estrena el `reset --hard`.

**No requiere ningún cambio en la base de producción.**

### 2026-08-07 — Verificación de los 8 roles + `npm run test:roles`

**Pedido**: "necesito que pruebes las configuraciones básicas de cada rol y confirmes que todo esté funcionando".

**Cómo se probó**: un verificador nuevo que da de alta un usuario por rol y **los deja configurados como en la vida real** antes de mirarlos — el preceptor con una división a cargo, el jefe con una sección, el docente con una materia propia y el alumno matriculado en ella. Sin eso, preceptor y jefe caen en la vista `no-scope` (que no tiene nav, y está bien que no lo tenga) y medio panel parece roto sin estarlo. Después recorre, rol por rol: el redirect de `/`, las **37 secciones** del catálogo, las solapas del menú, el rol en español y el toggle de `/superadmin/roles`.

**Resultado**: 8/8 roles correctos. **Cero fugas de permisos, cero 500, ninguna solapa de más ni de menos.** Un solo hallazgo, abajo.

**El hallazgo — el superadmin tenía tres puertas que daban a una pared**. Entrando a `/admin` (puede, su rol está en `roles`), el nav le ofrecía Tema, Tareas y Plantillas: las tres administran la configuración de UNA escuela y el superadmin no tiene escuela propia, así que morían en "Escuela no encontrada" (404) y "Este usuario no tiene escuela asignada" (400). No era un agujero de permisos —el acceso base estaba bien— sino un callejón sin salida con una página de error pelada.

**El arreglo va en el catálogo, no en la plantilla**: campo `needsSchool: true` en `config/sections.js` y una línea en `res.locals.can` (`server.js`), que es el único lugar por donde pasan todos los navs. Parchear `admin-nav.ejs` con un `user.school &&` habría arreglado esa pantalla y dejado el mismo agujero esperando en el próximo nav que use la misma solapa. **Las rutas no se tocaron**: escribiendo la URL a mano siguen contestando lo mismo, que es lo correcto — lo que cambió es que ya no se ofrece la puerta. El nav del superadmin en `/admin` pasó de 11 solapas a 8, y las que sí le sirven (Usuarios, Materias, Auditoría…) siguen ahí. Un admin de verdad, que sí tiene escuela, sigue viendo las 11.

**Lo que se confirmó correcto y conviene no volver a investigar**: `/activities/my-pending` redirige (302) a `/courses` para todo el que no sea alumno; preceptor sin divisiones y jefe sin sección caen en `no-scope` sin nav (fail-closed a propósito); el drawer manda "Mis clases" a `/` y no al path literal; y `soe` sigue sin panel propio, aterrizando en `/courses` con las solapas generales.

**Queda en el repo**: `tests/roles/check-roles.js` → **`npm run test:roles`**. Recorre la matriz entera en ~40 s, borra todo lo que crea (la limpieza va en un `finally`) y solo devuelve exit 1 ante una fuga de permisos o un 500 — un desajuste de nav se reporta pero no frena un deploy. El paso 4 replica a propósito la lógica de `res.locals.can` en una función sola y comentada: si esa lógica cambia y el test no, el test deja de valer.

**Verificado**: `npm run test:roles` sin hallazgos, 216/216 smoke y 28/28 unitarios después del cambio en `server.js`. **No requiere ningún cambio en la base de producción.**

### 2026-08-07 — Sala en vivo: la hora la pone el servidor (bug de zonas horarias)

**Pedido**: "tengo problemas con la sala de chat… da cambiados las horas, puede tener cualquier horario, necesito que se establezca una sola, hazlo con el horario que obtiene del servidor".

**El bug, en dos mitades**. La hora de cada mensaje la formateaba **el navegador** con `toLocaleTimeString()`, o sea con la zona horaria del equipo: las máquinas del aula tienen cualquier zona configurada, así que el mismo mensaje se veía a las 14:05 en una pantalla y a las 17:05 en la de al lado. La otra mitad es al revés: las vistas que ya se renderizaban del lado del servidor (clases anteriores, transcripción, CSV) usaban la zona del **proceso**, y producción corre en UTC — tres horas de más, en el registro que después se consulta como comprobante de asistencia.

**Y encima cambiaba el formato, no solo el número**: `toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' })` devuelve `"20:47"` en Node y **`"08:47 p. m."` en Chrome** (verificado en el navegador con este arreglo puesto). O sea que el mismo mensaje se veía con otro reloj y con otro formato según con qué abriera cada uno.

**El arreglo**: una sola fuente de hora. `TZ = process.env.SCHOOL_TZ || 'America/Argentina/Buenos_Aires'` en `services/liveRoom.js`, con cinco formatters `Intl.DateTimeFormat` construidos **una vez** (esto corre por cada mensaje de cada poll) y exportados como `fmt`. El payload del poll manda `hora: "14:05"` ya armada en vez de la fecha cruda; las plantillas usan `fmt.hora()` / `fmt.fechaDia()` / `fmt.fechaLarga()`. **No quedó ni un `toLocaleTimeString` en el código de la sala**: si vuelve a aparecer uno, vuelve el bug.

**Detalles que importan**: `hourCycle: 'h23'` y no `hour12: false` (con `hour12` algunos locales imprimen "24:15" a medianoche); una fecha nula o inválida devuelve `''` y no "Invalid Date", porque estos textos van derecho a la pantalla y al CSV. Regla nueva en la spec: **RN-30**.

**Archivos**: `services/liveRoom.js`, `routes/rooms.js`, `views/partials/live-room.ejs`, `views/partials/live-cards.ejs`, `views/rooms/clases.ejs`, `views/rooms/session.ejs`, `cleanup-rooms.js`.

**Verificado**: 28/28 unitarios (5 nuevos: mismo instante → misma hora venga como `Date`, ISO o milisegundos; medianoche 00:xx y no 24:xx; el cruce de medianoche también cambia el día) y 216/216 smoke, con una aserción nueva en `sala-mensajes-cursor` que exige que el `hora` del poll venga formateado y sea el de la escuela. **No requiere ningún cambio en la base de producción.**

**Pendiente, fuera de esta entrega**: el resto de la app (actividades, entregas, auditoría, perfiles) sigue formateando fechas en el navegador o con la zona del servidor. Mismo bug latente en producción (UTC). Anotado en el backlog.

### 2026-08-06 — Sala en vivo: presencia y chat dentro de la materia

**Pedido**: "quiero que dentro de la materia haya una opción para que la profesora pueda habilitar un espacio, tipo sala de chat, para ver y poder hablar con los chicos conectados… que aparezcan pequeños círculos estilo perfil… la conversación también deberá ser backupeada". Después: tarjetas de las clases en curso para la directora, y lo mismo para el preceptor "pero ese sí que aparezca visible para todos".

**Spec**: `specs/sala-en-vivo.spec.md` (29 reglas de negocio, 72 criterios de aceptación). Aprobada antes de escribir código.

**La idea central**: la sala es una **sesión de clase**, no un chat perpetuo. La docente la abre al empezar y la cierra al terminar; fuera de esa ventana nadie escribe. Eso da, sin trabajo extra, el registro de asistencia por clase, y evita un chat de menores funcionando de madrugada sin ningún adulto.

**Modelos nuevos** (3, ninguna migración — se crean solas al primer uso): `RoomSession` (una por clase; `closedAt: null` es el único criterio de "en vivo"), `RoomMessage` (con `seq` incremental por sesión) y `RoomPresence` (un documento por persona y sesión: **es** el registro de asistencia).

**Transporte: polling, no WebSockets.** PM2 corre en cluster con 2 workers y un mensaje que entra al worker A no llegaría a los clientes del worker B sin sticky sessions ni adapter; con polling el estado compartido es Mongo y el problema no existe. Cero dependencias nuevas.

**El cursor es `seq`, no `createdAt`** (`$inc` atómico sobre `RoomSession.lastSeq`): dos mensajes en el mismo milisegundo son indistinguibles por fecha y el poll se saltea uno — que es justo lo que pasa cuando media clase contesta a la vez.

**⚠️ Rate limiting — lo más delicado de esta entrega**: las rutas de la sala quedan FUERA del `generalLimiter` (`skip` en `server.js`) y tienen un limiter propio **por usuario** en `middleware/rate-limits.js`. El cupo general es de 1200 req/15 min **por IP** y toda la escuela sale por una sola IP NAT: 25 alumnos polleando cada 4 s lo agotan en tres minutos y lo que se cae no es el chat, es login, actividades y entregas para todos. Mismo tipo de bug que el `uploadLimiter` del 2026-07-28.

**Permisos**: método nuevo `Course.canWatchLive(user, scopeDivisionIds)` — **no se tocó `canManage()`**. Entrar a mirar y poder gestionar son cosas distintas: sumar `directivo` o `preceptor` a `canManage` les habría abierto crear actividades, calificar y borrar en las 419 materias. Abrir, cerrar, moderar y silenciar siguen pidiendo `canManage`.

**Dirección entra en silencio; preceptoría, a la vista de todos.** Decisión explícita del usuario. El equipo directivo entra con `?modo=observacion`: no genera presencia, no se anuncia, no puede escribir, y tiene un botón "Presentarme" que lo hace visible. Queda registrado en auditoría (`room.observe`) — silencioso para la clase, visible para la institución. El preceptor entra siempre visible, con su círculo y un aviso en el chat: es quien controla la asistencia y su trabajo es que se note. **El modo lo decide el ROL y el estado de presencia, nunca el query param** (ver el bug de abajo).

**Retención**: los mensajes de clases cerradas hace más de 3 meses se purgan con `npm run cleanup:rooms` (con `--dry-run` y confirmación explícita). Las sesiones y la presencia **no se purgan nunca**: la asistencia es lo que se consulta meses después. Una clase purgada muestra "La conversación ya no está disponible" y conserva su lista de presentes.

**Backup**: las tres colecciones se agregaron al array `COLLECTIONS` de `routes/backup.js`. Sin esa línea no se respaldan y nadie se entera hasta que hace falta restaurar — el backup enumera colecciones a mano, no es un `mongodump`.

> ⚠️ Este cambio tuvo un efecto secundario que no se vio en su momento: **invalidó de golpe todos los backups anteriores**, porque el preview exigía que estuvieran TODAS las colecciones del array. Se arregló el 2026-08-08 (ver ese changelog); las colecciones nuevas ahora van con `optional: true`.

**Paneles**: `/directivo/en-vivo` (toda la escuela) y `/preceptor/en-vivo` (acotado a `assignedDivisions`, fail-closed). Un solo partial de tarjetas y un solo `getOpenSessions()` para los dos, con un único aggregate por refresco. `preceptor_envivo` es la primera solapa configurable de ese panel — se puede apagar desde `/superadmin/roles`.

**Tres bugs encontrados durante la verificación**, los tres reales:
1. `express-rate-limit` v8 aborta el arranque si un `keyGenerator` propio usa `req.ip` sin el helper `ipKeyGenerator` (`ERR_ERL_KEY_GEN_IPV6`). El proceso moría al importar el módulo.
2. **El modo observación se derivaba del query param**, y el POST de un mensaje no lo lleva: el directivo que estaba mirando en silencio podía escribir. Ahora se deriva de la **presencia en la base**, que es igual para todas las rutas y es exactamente lo que crea "Presentarme". Efecto extra buscado: quien ya se presentó no puede volver a esconderse.
3. Un **comentario de JavaScript que contenía la etiqueta de cierre de script literal** cortaba el bloque: el resto del código se renderizaba como marcado y la sala quedaba muda, sin ningún error de sintaxis a la vista. El parser de HTML no sabe que está dentro de un comentario.

**Verificado**: 216/216 smoke tests (17 escenarios nuevos), 23/23 unitarios (`npm run test:unit`, runner nuevo), y la sala probada en el navegador contra un curso real de 37 alumnos: apertura, círculos de presencia, envío con emoji, mensaje de sistema y aviso fijo. **No requiere ningún cambio en la base de producción.**

### 2026-08-06 — Tope de 9 materias: el alumno con el curso completo ya no pide más altas

**Pedido**: "quiero que si el alumno tiene un total de 9 materias o más, ya no le figure el botón de «Enviar solicitud para unirme» ni el botón de «Unirme con un código»".

**La regla**: `MAX_MATERIAS_ALUMNO = 9` en `services/enrollment.js`, que es donde ya vivía todo lo que sabe de matrícula. Con 9 materias o más el curso está completo, y las dos vías por las que el alumno puede pedir sumar materias desaparecen de su panel. Un solo número para las dos, porque el motivo es el mismo: lo que llegue de ahí para arriba son altas equivocadas.

**No toca el alta administrativa.** El admin, el preceptor y el docente siguen pudiendo matricular por encima del tope — hay alumnos con 14 y 20 materias en la base, y esto no los desmatricula ni les cambia nada de lo que ya tienen. Es un freno a la vía del alumno, no una regla de la base ni una validación de `Course`.

**Dónde se aplica**: `routes/courses.js` (GET `/`) calcula `cupoMateriasLleno` con las materias donde el alumno figura como tal y `views/dashboard.ejs` esconde los dos botones **y sus dos modales** — dejar los modales en el DOM sin botón es dejar la función accesible desde la consola. Del lado del servidor, `services/joinByCode.js` rechaza el código con un 400 que explica el motivo, para que un request armado a mano tampoco pase. La solicitud no necesita guarda equivalente: va a `POST /suggestions`, que es el endpoint genérico de sugerencias y no matricula a nadie.

**Verificado**: render de `views/dashboard.ejs` con 8, 9 y 20 materias — con 8 aparecen los dos botones y los dos modales, con 9 y con 20 no aparece ninguno. El spec de smoke `course-join-with-code` sigue valiendo: su alumno tiene 1 materia, muy por debajo del tope. **No requiere ningún cambio en la base de producción.**

### 2026-08-06 — Sugerencias: hilo de conversación

**Pedido**: "si bien los usuarios me mandan mensajes, quiero seguir con el hilo de la conversación, en caso que vuelvan a responder sobre lo que yo les envié. Sino que abran una nueva sugerencia".

**Punto de partida**: una sugerencia era un único ida y vuelta — `text` del usuario, `response` del superadmin, y ahí terminaba. Si el usuario quería aclarar algo tenía que mandar una sugerencia nueva, que llegaba suelta y sin contexto de la anterior.

**La regla, que es la mitad del pedido**: el hilo sirve para seguir UNA conversación. El usuario solo puede responder **si el equipo ya le contestó algo**; mientras su sugerencia está pendiente no hay nada que continuar y lo que corresponde es abrir una nueva. Lo mismo cuando la conversación llega a los 20 mensajes: ahí ya es otro tema. En los dos casos el error lo dice con esas palabras, no con un "no se puede".

**Dónde vive el hilo, y por qué no todo junto**: los dos primeros mensajes siguen en `text` y `response`; lo que viene después va a `messages[]` (`from: 'user' | 'staff'`, autor, texto, fecha, `editedAt`). Meter también los dos primeros adentro del array habría exigido **migrar la base de producción** para no perder el historial — así, `messages[]` está vacío en todas las sugerencias que ya existen y se siguen leyendo exactamente igual. `services/suggestionThread.js` (nuevo) es el único módulo que sabe esto: arma el hilo completo y responde "¿de quién es el turno?" y "¿puede seguir el hilo?". Rutas y vistas piden el hilo armado y no vuelven a mirar los campos sueltos.

**Cómo vuelve a la vista del superadmin**: cuando el usuario responde, la sugerencia vuelve a `status: 'pending'`. Es lo que la devuelve a la solapa donde el superadmin entra por default — si quedara en "Respondidas", la repregunta se archivaría sin que nadie la viera. La tarjeta suma un chip **TE RESPONDIÓ** y los dos listados pasan a ordenarse por `updatedAt` para que el hilo con novedad suba. Marcar como leída se guarda con `timestamps: false` a propósito: abrir la bandeja no es actividad de la conversación y no tiene que reordenar nada.

**Responder ≠ editar**. El botón "Responder" ya no desaparece al contestar (antes sí, y era lo que hacía imposible seguir). El endpoint `POST /superadmin/suggestions/:id/respond` ahora distingue tres cosas por el mismo camino: primera respuesta (llena `response`), respuesta de seguimiento (suma al hilo, sin pisar nada) y edición (corrige **lo último** que escribió el equipo, esté en `response` o en el hilo). El modo lo decide el botón que abrió el editor, no el estado de la tarjeta — una sugerencia respondida se puede tanto editar como continuar, así que deducirlo del estado era ambiguo.

**Del lado del usuario**: la bandeja del sobre muestra la conversación completa con su caja de respuesta. Ruta nueva `POST /suggestions/mine/:id/reply` (solo sobre sugerencias propias, 404 si no lo son), auditoría `suggestion.reply`.

**Verificado**: smoke **197/197** con 5 specs nuevos (`suggestions-thread-*`), incluidos el bloqueo antes de la primera respuesta, que la segunda respuesta del equipo no pise la primera, que editar toque el último mensaje y no el inicial, y que nadie pueda escribir en el hilo de otro. **No requiere ningún cambio en la base de producción.**

### 2026-08-06 — Alumnos duplicados por DNI: elegir la cuenta y el correo, como con los docentes

**Pedido**: "que si figuran en el fix de *Dos alumnos con el mismo DNI en un curso*, se pueda hacer como con los docentes, eligiendo qué correo va a utilizar".

**Punto de partida**: el arreglo `dni-duplicado-en-curso` de `/superadmin/otros` era solo masivo. Sacaba del curso la cuenta vacía y conservaba la que tenía las entregas, sin tocar correos, y salteaba los casos donde las dos cuentas tenían trabajo. Funciona para el duplicado obvio, pero no cubre el caso real que motivó el pedido: la cuenta que cursa es la vieja y el correo bueno está en la nueva.

**Decisión**: las dos vías conviven en la misma tarjeta. El botón masivo sigue igual (los duplicados vacíos son la mayoría y no tienen nada que decidir) y abajo aparece un bloque por caso con las tres elecciones: qué cuenta se conserva, con qué correo queda y qué pasa con la otra. La alternativa —reemplazar el masivo por la elección caso por caso, como en docentes— se descartó porque acá los grupos pueden ser decenas.

**Qué se transfiere** (`fusionarAlumnos` en `services/dbFixes.js`): entregas, notas, acuses de lectura, comentarios en novedades, sugerencias y las materias del curso donde figuraba solo la cuenta sobrante. Dos detalles que no son obvios:

- **Los choques no se pisan.** `Submission` y `ActivityView` tienen índice único `{activity, student}` y `grades[]` una entrada por alumno: si las dos cuentas entregaron o tienen nota en la MISMA actividad, lo de la sobrante se queda donde está y se informa en el mensaje. Pisarlo sería borrar la entrega real de un alumno.
- **La fecha de inscripción se hereda**, no se pone "hoy". `routes/activities.js` usa `enrollmentDates` para ocultar las tareas vencidas antes del alta: con la fecha de hoy le desaparecerían al alumno las tareas viejas del curso, incluidas las que él mismo ya entregó. Si la sobrante no tenía fecha (altas viejas = "siempre estuvo"), tampoco se le pone una a la conservada.

La cuenta sobrante puede quedar **solo fuera del curso** (opción nueva, es lo que hacía el arreglo masivo), **deshabilitada** (default) o **eliminada** — y si le quedaron entregas propias no se elimina aunque se pida, igual que en docentes. La tarjeta avisa con un chip cuando una de las cuentas además cursa en otro curso, porque ahí darla de baja le saca el acceso allá.

**El correo funciona igual que en docentes**: `pasarCorreo()` (extraído de `fusionarDocentes`, ahora compartido) intercambia los correos entre las dos cuentas pasando por uno temporal, porque `User.email` es único global y no admite que las dos tengan el mismo valor ni por un instante.

**Refactors que trajo**: el bloque de grupos de `views/superadmin/otros.ejs` es ahora **uno solo** para los dos arreglos interactivos — título, detalle de cada cuenta, chips y opciones de la sobrante los arma `services/dbFixes.js` (`presentarGruposAlumnos`/`presentarGruposDocentes`), porque los números que hay que mirar para elegir no son los mismos para un docente que para un alumno. Y `POST /superadmin/otros/:id/fusionar` dejó de armar el mensaje y el detalle de auditoría: los devuelve el propio arreglo, junto con el `schoolId` del evento (antes se deducía partiendo la clave del grupo, que en alumnos es `divisionId|dni` y no `schoolId|dni`).

**Verificado**: smoke **192/192** con 5 specs nuevos (`alumnos-dup-*`), incluidos el rechazo de una cuenta o un correo ajenos al grupo, que la nota quede en el gradebook a nombre de la cuenta conservada y que el login funcione con el correo adoptado y la contraseña de siempre.

### 2026-08-04 — Analítica de producto con PostHog (apagada por default)

**Pedido**: medir comportamiento de uso — pantallas más visitadas y retención, tiempo activo real por pantalla (no solo carga de página), clicks en CTAs, profundidad de scroll y embudos básicos. Preferencia declarada por PostHog, "salvo que se justifique otra".

**Análisis previo a escribir código**: PostHog es la herramienta correcta para estos 5 objetivos (Plausible/Umami no hacen embudos serios; Matomo self-hosted es más pesado). La decisión real estaba en **dónde** vive: el servidor de producción es una máquina **compartida** con otro proyecto no relacionado (ver `production_server` en memoria), y esta es una plataforma con **alumnos menores**. Se presentaron ambas opciones (self-hosted vs. Cloud EU) al usuario; eligió delegar la decisión de hosting y confirmó medir todos los roles. Se optó por **PostHog Cloud, región EU**, con la configuración del SDK endurecida — ver la sección "Analítica de producto (PostHog)" más arriba para el detalle completo de qué se desactivó y por qué (sin autocapture, sin grabación de pantalla, sin cookies, sin nombre/email/DNI en ningún evento).

**Arquitectura**: un catálogo único resuelve el nombre de cada pantalla — `config/sections.js` ganó `sectionForPath()`/`normalizePath()`, reusando las mismas claves que ya usa la solapa `/superadmin/roles` (así "Importar" es `admin_import` en el nav, en el 403 y ahora también en los reportes de PostHog), con fallback a la URL normalizada (ObjectIds reemplazados por `:id`) para las páginas fuera del catálogo. `server.js` expone `res.locals.screenKey`/`posthogKey`/`posthogHost`; `views/partials/analytics-init.ejs` (nuevo, incluido en `header.ejs`, `login.ejs`, `register.ejs`, `invite-register.ejs`) imprime el snippet oficial de PostHog **solo si `POSTHOG_KEY` está seteada**; `public/js/analytics.js` (nuevo) hace el resto: pageview manual, heartbeat de tiempo activo con Page Visibility API, scroll depth por umbrales, y clicks delegados vía `data-analytics="..."` en los elementos.

**Verificado sin clave configurada** (el estado por default en todos lados): `window.posthog` no existe, `analytics.js` retorna sin hacer nada, cero errores de consola, y la suite de smoke **167/167** sin cambios — el catálogo de secciones y el enforcement de `/superadmin/roles` no se tocaron, solo se les agregaron dos funciones de lectura nuevas.

**Pendiente, fuera del alcance del código**: crear el proyecto en PostHog Cloud (región EU), confirmar Session Replay/Autocapture apagados también del lado del dashboard, y cargar `POSTHOG_KEY` en el `.env` de producción + `pm2 reload --update-env`. Documentado en la sección de arriba.

### 2026-08-04 — Solapa "Roles": habilitar y deshabilitar accesos por rol y por escuela

**Pedido**: "quiero que el rol de superadministrador tenga otra solapa que diga Roles, la cual dentro podremos observar los roles que hay actualmente, y habilitarle o deshabilitarle los accesos, primero a las solapas en sí, para poder controlar que ve cada Rol".

**Punto de partida**: toda la autorización estaba hardcodeada. Los siete roles viven en un enum (`models/User.js`) y cada middleware compara contra una lista literal; los `*-nav.ejs` ni siquiera tenían condicionales, porque el rol lo garantizaba el middleware de la ruta. Si una escuela quería que su directivo no viera "Promedios", había que tocar código y redesplegar.

**Decisiones acordadas antes de escribir nada**: el bloqueo oculta la solapa **y** cierra la URL (ocultar sin bloquear es seguridad aparente); la configuración es **por escuela**; y el rol superadministrador se muestra con candado, **no editable**, para que no exista una configuración que deje a esa cuenta afuera de la única pantalla desde donde se arregla.

**Arquitectura — una capa que solo puede quitar**. Ningún middleware de rol se tocó: `requireAdmin`, `requireDirectivo` y `requirePreceptor` siguen decidiendo el acceso base, y lo nuevo corre después. Una configuración mal hecha nunca puede escalar privilegios, y si algo falla el comportamiento que queda es el de siempre.

Tres piezas leen del **mismo catálogo** (`config/sections.js`), para que no puedan desincronizarse:
- `res.locals.can(key)` (inyectado en `server.js`) → qué se pinta en los navs y en el drawer.
- `middleware/sections.js` → `sectionGuard(panel)` en cada router y `requireSection(key)` donde el router no coincide con un panel.
- `views/superadmin/roles.ejs` → qué celdas se pueden configurar.

**Se guardan las secciones DENEGADAS, no las habilitadas** (`School.rolePermissions`, campo hermano de `settings`). Es lo que evita el script de migración: una solapa nueva aparece sola con su default, sin re-guardar escuela por escuela. Y va **fuera** de `settings` a propósito: ese namespace lo edita el admin de la escuela desde `/admin/tasks`, así que si esto viviera ahí, sumar una key a `TASK_SETTINGS` por error le daría al admin la llave para desbloquearse solo.

**Lo que no se puede deshabilitar, y por qué**: las pantallas de inicio de cada panel y `/courses` son los destinos del redirect de `/` — apagarlas dejaría al usuario con un 403 apenas entra. Backup y Otros ya están atados al email del dueño. Y todo el panel de superadministración, por la decisión de arriba. Se catalogan igual, con candado y el motivo en el `title`, en vez de dejar un hueco sin explicación.

**Detalles que costaron una vuelta**:
- `sectionGuard` matchea por **límite de segmento** y con el prefijo más largo primero: si no, `/admin/users/:id` caería en `/admin` y `/admin/task-templates` en `/admin/tasks`. Usa `originalUrl` porque dentro de un router montado `req.path` viene sin el prefijo.
- Como matchea por path y no por método, apagar "Usuarios" cierra también `POST /admin/users/:id/delete`, `/reset-password` e `/impersonate`. Es lo deseado: una solapa apagada con sus acciones abiertas no serviría de nada.
- `/admin/audit` vive en `routes/audit.js`, montado en `/` **antes** que adminRoutes, así que el guard de panel nunca lo ve: lleva su propio `requireSection`. Tiene spec propio para que no se caiga sin que nadie lo note.
- Durante una suplantación se aplican las restricciones del usuario suplantado (`res.locals.school` es la de él). Es lo correcto y además es la forma más rápida de verificar la configuración.
- El `.select()` de `server.js` tuvo que sumar `rolePermissions`: sin eso el campo no llega y toda la función queda muda, sin romper nada (fail-open) y sin dar señales.

**Alcance de esta primera etapa**: paneles Administración (10 solapas), Directivo (6), Preceptoría y los accesos del menú lateral. Docente y Alumno aparecen en la grilla pero casi sin celdas editables: sus pestañas viven **adentro** de cada materia (Novedades, Actividades, Calificaciones, Personas) y no tienen URL propia, así que bloquearlas de verdad exige ir endpoint por endpoint en `routes/activities.js` y `routes/courses.js`. Queda anotado como segunda etapa.

**Cobertura**: 7 specs nuevos en `tests/smoke/specs.js` — la pantalla carga; apagar una solapa la saca del menú y devuelve 403 en la URL y en su POST; el caso de `/admin/audit`; el rechazo del rol superadmin, de las secciones bloqueadas y de las keys desconocidas (400); un admin no puede tocar la pantalla (403); y el restablecer. Todos dejan la escuela como la encontraron. Suite completa: **167/167**.

**Ajuste posterior — el nav de admin pasa a repartirse solo**: el corte de dos filas del panel de administración lo fijaba un separador invisible (`.admin-nav-break`) que siempre cortaba después de "Auditoría". La razón original era que las solapas no cambiaran de fila según la pantalla. Con esta función eso se dio vuelta: apagando tres solapas quedaba una primera fila de cinco ítems y media pantalla vacía al lado. Se sacó el separador de `admin-nav.ejs` — el `flex-wrap` de `.admin-nav-2filas` ya hacía el trabajo — así que ahora se llena la primera fila y baja lo que no entra. Medido con las 10 solapas: 9+1 a 1280 px, 8+2 a 1100, 6+4 a 960, sin scroll horizontal en ningún caso, y por debajo de 900 sigue colapsando en el botón hamburguesa. **El nav de superadmin conserva su corte fijo**: ahí el agrupamiento tiene sentido semántico y sus solapas no se deshabilitan.

### 2026-08-03 — El restore rechazaba backups de más de 500 MB

**Pedido**: "quiero restaurar un backup de la base de datos pero me sale un cartel que dice el archivo supera los 500 MB, obviamente de aquí en más van a pesar mucho más".

**Causa**: el tope de subida de `POST /superadmin/backup/preview` (`routes/backup.js`) se fijó en 500 MB cuando el volumen de adjuntos era de ~33 MB. Hoy `public/archivos` + `archivos/entregas` ya suman ~400 MB en el mirror local y siguen creciendo con cada entrega, así que el propio backup que genera el sistema pasó a ser más grande que lo que el sistema acepta recibir.

**Dos arreglos, porque había dos techos y el segundo no daba un mensaje claro**:

1. **Tope de subida configurable** (`routes/backup.js`): `BACKUP_MAX_UPLOAD_MB`, default **4096 (4 GB)**. El mensaje del error 413 usa el valor real, así que no vuelve a quedar desactualizado. No es un límite de memoria: multer escribe a disco a medida que recibe, el techo verdadero es el espacio libre en `os.tmpdir()`.
2. **`server.requestTimeout` a 1 h** (`server.js`). Node corta toda request que tarde más de 5 min en llegar completa, y subir cientos de MB desde una conexión hogareña se pasa de largo: la subida moría a mitad de camino y en el navegador se veía como "error de conexión", sin relación aparente con el tamaño. `headersTimeout` queda en el default (65 s), que es lo que frena un slowloris de headers.

**Sin riesgo para el restore en sí**: la extracción del `.tar.gz` ocurre *antes* del `deleteMany`, así que si el disco no alcanza la operación aborta con la base intacta (y el backup de seguridad pre-restore ya está escrito).

**Pendiente relacionado**: la descarga (`downloadBackup()` en `views/superadmin/backup.ejs`) hace `res.blob()`, o sea que el navegador se guarda el backup entero en memoria antes de ofrecerlo. Con 400-500 MB anda; cerca de los 2 GB es el próximo techo. Está anotado en el backlog.

### 2026-08-02 — Al salir de la suplantación, el superadmin volvía al panel de admin

**Pedido**: "con el rol de superadministrador, hago click en un usuario para ver su perfil y luego ver como este usuario; al regresar se me colocan las solapas de administrador solamente".

**Causa**: `GET /exit-impersonate` (`routes/auth.js`) terminaba con `res.redirect('/admin')` — fijo, sin mirar quién estaba volviendo. Para el admin era su panel y nadie lo notaba; el superadmin aterrizaba en el panel de administración, con las solapas de admin y sin las suyas. Y de ahí no se sale: ninguna solapa de ese panel vuelve a `/superadmin`, así que parecía que la suplantación le había cambiado el rol.

**Arreglo**: redirige a `/`, que ya reparte por rol (`server.js`): superadmin → `/superadmin`, admin → `/admin`, directivo → `/directivo`, preceptor → `/preceptor`, resto → `/courses`. Un renglón y sin lógica duplicada. De paso cubre el caso del `adminToken` vencido: ahí no queda sesión y `/` manda a `/login`, en vez de rebotar contra `/admin`.

**Regresión cubierta**: spec nuevo `exit-impersonate-returns-to-own-panel` (`tests/smoke/specs.js`). Suplanta a un alumno con el superadmin y con el admin — cada uno con su propio actor, para que una falla a mitad de camino no le deje la cookie del suplantado pegada a los actores que usan los demás specs — y verifica las tres etapas: suplantando, `/` lleva a `/courses`; `/exit-impersonate` redirige a `/`; y `/` devuelve a cada uno a SU panel. **Verificado que el test detecta el bug**: reintroduciendo el `redirect('/admin')` falla con "fue a /admin", y con el arreglo pasa. Suite completa: **143/143**.

### 2026-08-02 — La columna "Acciones" ya no se esconde detrás del scroll

**Pedido**: "con el rol de administrador no puedo ver el botón de Ver perfil, porque se esconde detrás del scroll". En `/admin/users` la tabla tiene 8 columnas y no entraba en el contenedor de 1100 px: la última columna quedaba fuera de pantalla y había que scrollear la tarjeta a ciegas para llegar al botón.

**Tres cambios, todos de presentación** (ninguna ruta ni consulta tocada):

1. **`/admin/users` usa el contenedor ancho** (`main-content-ancho`, hasta 1400 px), el mismo que ya usaba `/superadmin/users` por el mismo motivo.
2. **Padding lateral de las celdas: 20 px → 12 px** (el de la primera columna se mantiene en 20 para no pegar el contenido al borde). Con 8 columnas, 20 px por lado eran ~320 px de puro aire, que era buena parte de lo que empujaba "Acciones" afuera.
3. **La columna Acciones queda fija a la derecha** (`position: sticky`) dentro de la tarjeta que scrollea. Aunque la tabla no entre — pantalla chica, zoom alto — el botón "Ver perfil" siempre está a la vista, y las columnas tapadas se alcanzan scrolleando con el botón siempre presente.

La sombra al costado de la columna fija **solo aparece cuando hay algo tapado**: un script en `partials/header.ejs` pone la clase `has-overflow` en `.users-table-card` si `scrollWidth > clientWidth` (al cargar y al redimensionar). Si la tabla entra entera, no hay sombra ni scroll.

**Verificado en el navegador**: a 1292 px la tabla entra completa (1228 px, sin overflow, sin sombra); a 900 px hay scroll y el borde derecho de la celda de Acciones coincide con el de la tarjeta — es decir, queda anclada — con el botón en una sola línea (`white-space: nowrap`). Comprobado en tema claro y oscuro.

**Extendido al resto de los listados anchos** (mismo día). El anclaje quedó como un mecanismo genérico de `style.css`, opt-in con una clase en la `<table>`:

| Clase | Qué ancla | Dónde se usa |
|---|---|---|
| `.acciones-fijas` | última columna, a la derecha | `/admin/users`, `/superadmin/users`, `/admin/courses`, `/admin/divisions`, ficha de escuela del superadmin (`.sp-table`), listado de alumnos del preceptor |
| `.nombre-fijo` | primera columna, a la izquierda | listados del directivo: materias, docentes, cursos, alumnos y notas por materia |

En las tablas del directivo el botón no está a la derecha: el acceso es el **nombre de la fila**, en la primera columna. Ahí lo que se perdía al scrollear era saber de qué materia o de qué docente era el número que estabas mirando — por eso se ancla la primera columna en vez de la última. Es opt-in a propósito: en las previsualizaciones de importación la última columna es un dato más y anclarla no aportaría nada.

Tres detalles que costaron:

- **`overflow: clip` en la tabla, no `hidden`.** Muchas de estas tablas traen `border-radius` + `overflow: hidden`, y eso las convierte a ellas en el contenedor de scroll de referencia: el `sticky` se anclaba al borde de la propia tabla, o sea, no hacía nada. `clip` recorta igual (el radio se sigue viendo) pero no es contenedor de scroll, así que el anclaje pasa al div que scrollea. Va con selector `table.` porque el `<style>` de cada vista está en el `<head>` **después** de `style.css` y le ganaba por orden.
- **Los colores salen de variables** (`--celda-fija-bg`, `--celda-fija-bg-head`, `--celda-fija-bg-hover`) y ese bloque se queda en **una sola clase** de especificidad, justamente para que cada tabla pueda pisarlas: `.users-table` usa sus grises (`#f8f9fa` / `#fafafa`) y `.sp-table` usa `var(--bg)`.
- **`.sp-table-wrap` tenía `overflow: hidden`** — el mismo bug que la tarjeta de `/admin/users`: recortaba la tabla sin dejar scroll. Ahora es `overflow-x: auto` + `overflow-y: hidden`.

El script del header se generalizó: en vez de buscar una clase de contenedor fija, sube desde cada tabla anclada hasta el primer ancestro que scrollea y le pone `has-overflow`. Así ninguna vista tiene que acordarse de agregar nada.

**Hallazgo al pasar**: las tablas de directivo y preceptor pintaban encabezado y hover con `var(--background)`, **una variable que no existe** — la real es `--bg`. Por eso el default de `--celda-fija-bg-head` quedó en `var(--surface)`: replicaba lo que se veía. **Corregido el 2026-08-08** (ver el changelog de ese día): esas tablas pasaron a `var(--bg)` y cada una pisa `--celda-fija-bg-head` / `--celda-fija-bg-hover` para que la celda anclada acompañe.

**Verificado**: con las dos tablas scrolleadas a fondo, la columna anclada coincide con el borde del contenedor en ambos casos (última a la derecha, primera a la izquierda), el fondo de la celda anclada coincide con el de su fila en tema claro y oscuro, y el encabezado anclado con el de sus vecinos. Smoke: **142/142**.

### 2026-07-31 — El autor puede editar y eliminar su novedad

**Pedido**: "que el docente pueda editar o eliminar la novedad que ha creado". Hasta ahora una novedad publicada era **inmutable**: no existía ninguna ruta de edición ni de borrado, ni siquiera para su autor. Un error de tipeo quedaba para siempre.

**Rutas nuevas** (`routes/announcements.js`):

| Ruta | Quién puede |
|---|---|
| `PUT /announcements/:id` | **solo el autor** |
| `POST /announcements/:id/delete` | el **autor**, o quien gestiona la materia (`canManage`: docente titular/suplente y admin de la escuela) |

**Por qué editar y eliminar no tienen el mismo permiso.** Editar es solo del autor a propósito: nadie corrige palabras ajenas y las deja firmadas con el nombre de otro, ni siquiera el admin. Eliminar se abre al docente y al admin porque los **alumnos también publican novedades** y no había ninguna vía de moderación — si un alumno publica algo inapropiado, alguien tiene que poder bajarlo. El borrado por moderación queda distinguido en la auditoría (`meta.como = 'moderación'` vs `'autor'`).

**Alcance de la edición**: solo el texto. La imagen no se toca — para cambiarla hay que borrar la novedad y publicarla de nuevo. Al eliminar sí se borra la imagen del disco (con chequeo de que la ruta resuelta no escape de `ARCHIVOS_BASE`) y se van los comentarios, que son subdocumentos.

**`Announcement.editedAt`** (campo nuevo, default `null`) — marca "(editada)" en el stream. **No alcanza con mirar `updatedAt`**: comentar una novedad hace `ann.save()` y también lo mueve, así que cualquier novedad comentada habría figurado como editada sin haberlo sido. Verificado con un test específico. Campo nuevo con default, sin migración: las novedades existentes quedan en `null` = "nunca editada", que es lo correcto.

**UI** (`public/js/course.js` + CSS): al expandir una novedad aparecen "Editar" y "Eliminar" según corresponda. Editar es inline (textarea con Guardar/Cancelar, no permite dejarla vacía). Se agregó `window.USER_ID` en `views/course.ejs` — hasta ahora la vista solo exponía `IS_OWNER`, que no alcanza para saber si sos el autor de una novedad puntual.

**Verificación**: script de punta a punta con 5 identidades (autor, otro docente de la materia, admin, alumno inscripto y un docente ajeno), creando sus propios usuarios y su propia materia y borrando todo al final — **27/27**. Cubre: el autor edita y borra lo suyo; docente, admin y alumno reciben **403** al editar lo ajeno; el alumno no borra la novedad del docente; el docente y el admin sí pueden borrarla por moderación; un docente ajeno a la materia recibe 403 en ambas; texto vacío da 400 sin pisar el original; comentar no marca como editada; la imagen se borra del disco; y las dos acciones quedan en la auditoría distinguiendo autoría de moderación. Más el ciclo completo en el navegador y **142/142** en la suite de smoke.

### 2026-07-31 — El administrador ya puede quitar suplentes de una materia

**Pedido**: verificar si el rol Administrador puede gestionar los docentes de una materia (agregarlos y quitarlos) y completarlo si faltaba.

**Estado previo** — el admin ya podía:
- **Cambiar el titular** (`Course.owner`): desde el select "Docente" del formulario de edición, o con el lápiz de la columna Docente en `/admin/courses` (`POST /admin/courses/:id/assign-teacher`).
- **Agregar suplentes** (`Course.coTeachers`): `POST /admin/courses/:id/co-teachers`.
- **Lo que faltaba**: quitar un suplente. Se había dejado explícitamente para más adelante en la sesión del 2026-07-25; una vez agregado, el único camino para sacarlo era editar Mongo a mano.

**Lo que se agregó:**

| Archivo | Cambio |
|---|---|
| `routes/admin.js` | **nueva** `POST /admin/courses/:id/co-teachers/:teacherId/delete` — valida escuela, que el docente sea realmente suplente de esa materia, lo saca del array y audita |
| `config/audit-actions.js` | nueva acción `course.remove_coteacher` ("quitó un suplente", `group_remove`, naranja) |
| `views/admin/course-form.ejs` | botón `person_remove` en cada fila de la lista de suplentes + handler delegado con `confirm()` |

**Decisión de alcance**: la ruta **no** permite quitar al titular. Una materia sin `owner` queda huérfana y la alerta del panel directivo la marcaría como "materia sin docente"; para cambiar el titular está `assign-teacher`, que lo reemplaza en un solo paso.

**Verificado en el mirror local** con la cuenta `administrador@escuela.edu.ar`: se quitó y se volvió a agregar un suplente de "Educación Artística (A) Teatro" desde la UI, con los dos registros correspondientes en la auditoría. La materia quedó con sus dos suplentes originales.

**Qué pasa con el contenido del docente que se quita** (se verificó, no se asumió). El contenido cuelga de la **materia**, no del docente: `Activity.course` y `Announcement.course` son las claves de pertenencia y `author` es solo metadata de firma — ninguna ruta decide permisos mirando `author`. Prueba real en "Lengua Extranjera", donde la suplente CHAPARRO había creado la única actividad y la única novedad: al quitarla, ambas siguieron en la materia con su nombre, los 31 alumnos las siguieron viendo y el titular pudo editarlas y calificarlas. La cuenta del docente queda intacta. Tres efectos esperados: (1) pierde el acceso a esa materia, incluso a lo que creó él; (2) cambia el `featuredTeacher` de la ficha, que se calcula por volumen de contenido entre titular y suplentes; (3) los reportes históricos (directivo M3, columnas Nov/Act/Msg) le siguen atribuyendo esas producciones, porque van por `author`.

### 2026-07-31 — El admin entra a `/courses/:id` con permisos de docente

**Pedido**: al admin le daba "Acceso denegado" en la ficha de cualquier materia (`GET /courses/:id` solo dejaba pasar a docentes de esa materia y alumnos inscriptos). Podía mirarla únicamente suplantando a un docente. El usuario eligió explícitamente **permisos completos**, no solo lectura.

**`Course.canManage(user)`** (`models/Course.js`) — nuevo método, ahora el punto de verdad para PERMISOS. Es `isTeacher()` más los admins de la escuela del curso y el superadmin:

| | `isTeacher(userId)` | `canManage(user)` |
|---|---|---|
| Para qué | pertenencia real (¿es docente de esta materia?) | permisos de ruta y de UI |
| Recibe | un id | el **usuario completo** (necesita `role` y `school`) |
| Titular / suplente | ✅ | ✅ |
| Admin de la escuela | ❌ | ✅ |
| Superadmin | ❌ | ✅ |
| Admin de **otra** escuela | ❌ | ❌ |

Los dos conviven a propósito: **los listados de "mis materias"** (dashboard, perfil, panel directivo) siguen usando la pertenencia real por `owner`/`coTeachers`. Si usaran `canManage`, el admin vería las 419 materias como propias. Verificado: su dashboard sigue con 0 tarjetas.

**Reemplazados los ~20 chequeos** de `course.isTeacher(...)` por `course.canManage(res.locals.user)` en `routes/courses.js`, `routes/activities.js`, `routes/announcements.js` y las 11 condiciones de `views/course.ejs`.

**Dos trampas del `select`** que hay que respetar en código nuevo:
- `canManage` necesita `school` además de `owner coTeachers`. `GET /courses/:id/customize` traía solo los dos últimos — se le sumó `school`, si no el admin caía en un `undefined` y se lo rechazaba por error.
- `GET /activities/available-templates` usa `.lean()`, así que el documento **no tiene métodos**: ahí el chequeo quedó a mano, replicando el mismo criterio (documentado en el propio código).

**Gestión de docentes desde la solapa Personas** (mismo día, pedido inmediato después): entrar a `/admin/courses/:id/edit` solo para tocar docentes era un rodeo, así que la card "Profesor / Docentes" de la ficha ahora trae los controles para el admin:

- **`+` en el encabezado** → modal para agregar un suplente.
- **`swap_horiz` en el titular** → mismo modal en modo "cambiar titular". El texto de ayuda avisa que el titular actual **pierde el acceso**, y sugiere agregarlo como suplente antes si se lo quiere conservar.
- **`person_remove` rojo en cada suplente** → lo quita, con confirmación.

No hay endpoints nuevos: pega contra `assign-teacher`, `co-teachers` y `co-teachers/:teacherId/delete` de `/admin/courses`, que ya están detrás de `requireAdmin`. `GET /courses/:id` pasa a la vista `manageTeachers` (true solo para admin/superadmin) y `schoolTeachers`, la lista de docentes activos de la escuela **ya filtrada** de los que están asignados a esa materia — por eso el select no ofrece al titular ni a un suplente actual.

**Bug lateral arreglado en `assign-teacher`**: si el nuevo titular ya figuraba como suplente, quedaba en las dos listas a la vez (aparecía dos veces en Personas, como TITULAR y como SUPLENTE). Ahora se lo saca de `coTeachers` al promoverlo. Era alcanzable desde el select del panel de admin, que sí lista a todos los docentes.

**Verificación**: test unitario de `canManage` con los 12 casos de rol (titular, suplente, docente ajeno, alumno inscripto, admin misma escuela, admin de otra escuela, admin sin escuela, superadmin, preceptor, directivo, soe, sin sesión) — 12/12. Suite de smoke completa **142/142 PASS**. Y en el navegador: la ficha abre con las 4 solapas, `IS_OWNER=true`, los 36 alumnos en Personas, botones de agregar/exportar/personalizar, y `/activities/course/:id`, `/gradebook`, `/available-templates` y `/announcements/course/:id` los cuatro en 200.

Para la solapa Personas se probó el ciclo completo en el navegador (agregar suplente desde el modal → aparece con badge SUPLENTE y su botón de quitar, el encabezado pasa de "Profesor" a "Docentes", el select baja de 334 a 333 → quitarlo → todo vuelve atrás), con los dos registros en la auditoría. Y **la parte que importaba**: con un docente descartable creado para eso, se comparó el HTML servido a un docente contra el servido al admin — el docente ve la materia igual pero **ninguno** de los cuatro controles, y llamando los tres endpoints de admin a mano recibe **403** en los tres. El docente de prueba y sus audit logs se borraron al terminar.

### 2026-07-29 — Se elimina el tipo de actividad "Examen": quedan 3 tipos

**Pedido**: "Evaluación" y "Examen" eran lo mismo en la práctica. Queda solo **Evaluación**, así los tipos de actividad son tres **hasta nuevo aviso**: `Tarea`, `Evaluación`, `Trabajo Práctico`.

**Impacto en la base: prácticamente nulo.** El tipo es un simple string en `Activity.type` — no hay colección aparte, ni índice por tipo, ni referencias desde otros modelos. Y el conteo previo al cambio dio **cero exámenes**, verificado en las dos puntas:

```
mirror local → [ { _id: 'tarea', n: 82 }, { _id: 'tp', n: 2 } ]
producción   → [ { _id: 'tarea', n: 82 }, { _id: 'tp', n: 2 } ]
```

Ni `examen` ni `evaluacion` se habían usado nunca. (De paso quedó confirmado que el mirror local está sincronizado con producción.)

**Archivos tocados:**

| Archivo | Cambio |
|---|---|
| `models/Activity.js` | `'examen'` fuera del `enum` de `type` |
| `public/js/course.js` | entrada `examen` fuera de `TYPE_CONFIG` |
| `views/activities/new.ejs` | `<option>` eliminado |
| `views/course.ejs` | `<option>` eliminado en los dos modales (crear y editar) |
| `migrate-examen-to-evaluacion.js` | **nuevo** — `npm run migrate:examen[:dry]` |

**Por qué existe un script de migración si hay 0 registros.** Porque un documento con `type:'examen'` que sobreviva al cambio **no es inofensivo**. Se verificó experimentalmente contra la base:

1. **Se lee perfecto** — Mongoose no valida en lectura.
2. **Pero `activity.save()` tira `ValidationError` en `type`.** Eso rompe **calificar** (`POST /:id/grade`), **editar la actividad** (`PUT /:id`) y **recibir entregas** (`POST /:id/submit`). La actividad quedaría de solo lectura y el docente no podría ponerle nota.
3. Además la tarjeta se vería como **"Tarea"**, porque `typeConfig()` cae al fallback con un tipo desconocido (confirmado en el navegador: `typeConfig('examen').label === 'Tarea'`).

La ventana de riesgo es real aunque chica: entre el conteo y el deploy, un docente todavía puede crear un "Examen" con la UI vieja. Por eso el script se corre **después** de desplegar, que es cuando la UI ya no puede generar más. Es idempotente.

**Verificado**: los tres `<select>` de tipo (`activityType`, `editType`, `sType`) muestran exactamente las 3 opciones; `TYPE_CONFIG` quedó con 3 claves; `POST /activities/create` con `type: 'examen'` responde **400** (`is not a valid enum value`); el script probado en seco y en serio con 2 exámenes sembrados (los convirtió y verificó que no quedara ninguno) y sobre la base limpia (informa "Nada para migrar"). Sin errores de consola.

### 2026-07-29 — "Unirse por código" deshabilitado: ahora se pide por solicitud

**Pedido**: deshabilitar **temporalmente** que el alumno se una a una materia con el código de 6 caracteres. En su lugar, un botón "Enviar solicitud para unirme" que abre un modal pidiendo **DNI y nombre completo del alumno**, y manda eso como una sugerencia común al superadmin.

**Killswitch, no borrado.** Todo el flujo por código queda intacto detrás del flag `JOIN_BY_CODE_ENABLED` (default: **apagado**). Se reactiva poniendo `JOIN_BY_CODE_ENABLED=true` en el `.env` y reiniciando, sin tocar una línea de código. Es la misma idea que el `TASK_TEMPLATES_ENABLED` de plantillas.

**El flag gatea las dos capas**, no solo la vista:

| Capa | Archivo | Con el flag apagado |
|---|---|---|
| Botón + modal | `views/dashboard.ejs` | "Enviar solicitud para unirme" en vez de "Unirse a clase"; se renderiza `#requestModal` y no `#joinModal` |
| Endpoint | `routes/courses.js` — `POST /courses/join` | responde **403** con el motivo |
| Vacío de alumno | `views/dashboard.ejs` | "Usá el botón «Enviar solicitud para unirme»" en vez de "Pedile el código a tu docente" |

Gatear el endpoint y no solo el botón es deliberado: esconder un botón no cierra nada, cualquiera con la URL podía seguir posteando el código.

**La solicitud es una sugerencia común.** El modal arma un texto de tres líneas y lo manda a `POST /suggestions`, el mismo endpoint que usa el botón de sugerencias del footer:

```
Solicitud para unirse a una materia
DNI del alumno: 40123456
Nombre completo: Juan Pérez
```

Aparece en `/superadmin/suggestions` junto al resto, con su estado (pendiente/revisada/respondida) y la posibilidad de responder. **No hubo cambios en el modelo `Suggestion` ni en ningún esquema** — no requiere tocar la base de producción. El DNI se normaliza a dígitos (`40.123.456` → `40123456`) igual que en `/register/lookup`, para que el superadmin pueda buscarlo tal cual en el panel de usuarios.

**Detalle de implementación**: solo uno de los dos modales existe en el DOM a la vez, así que `public/js/dashboard.js` ahora chequea que el nodo exista antes de tocarlo. Sin eso, el modal ausente tiraba un `TypeError` que se llevaba puesto también al de crear clase. Se agregó `.form-success` a `style.css` (contraparte de `.form-error`, con variante dark).

**Verificado en el navegador** con la cuenta de administrador: el botón nuevo aparece, el modal pide los dos campos, un DNI corto corta con "Ingresá un DNI válido (mínimo 6 dígitos)", el envío devuelve **201** y la sugerencia queda con el texto y el DNI normalizado. `POST /courses/join` responde **403**. Prendiendo el flag vuelve todo al comportamiento viejo (botón "Unirse a clase", `#joinModal`, y el endpoint contestando 404 en vez de 403). Sin errores de consola en ninguno de los dos estados.

### 2026-07-29 — Fix: el deploy nunca instalaba dependencias, y `prepare` lo abortaba

**Síntoma**: tras pushear la v1.0.8, producción seguía sirviendo código viejo. `/health` consultado varias veces devolvía versiones **distintas según el worker**:

```
{"version":"1.0.8","pid":228830,"uptime":286}      ← recargado
{"version":"1.0.6","pid":209945,"uptime":147023}   ← 40 h sin recargar, se salteó la v1.0.7 entera
```

Es el mismo Frankenstein del 2026-07-28 (archivos nuevos en disco + código viejo en memoria), pero por causas nuevas. El `git pull` decía "Ya está actualizado": el push **sí** había llegado.

**Causa 1 — `"prepare": "husky"` rompía cualquier install en el server.** husky es una `devDependency`, así que con `npm install --omit=dev` no se instala; npm igual corre el script `prepare` de postinstall, `husky` no existe y el install muere con código 127. Como el comando de deploy manual encadenaba todo con `&&`, **el `pm2 restart` posterior nunca llegaba a ejecutarse**. Fix: `"prepare": "husky || true"` (el workaround que documenta husky v9 para entornos sin devDependencies). Verificado: sin husky sale 0, con husky instalado sigue instalando los hooks normalmente.

**Causa 2 — el webhook nunca corría `npm install`.** El `deployCmd` era `git pull && pm2 reload`, sin ningún paso de dependencias. Consecuencia: **una dependencia nueva agregada en un commit nunca llegaba sola a producción** — exactamente lo que pasó con `sharp` en la v1.0.7. Fix: se agregó `npm install --omit=dev --no-audit --no-fund` entre el pull y el reload.

**Causa 3 (operativa) — `pm2` corrido como `root`.** PM2 mantiene un daemon **por usuario**. Los workers son de `walter`, así que `pm2 list` como root devuelve la tabla vacía y cualquier `pm2 restart` como root no toca la app real. Siempre `sudo -u walter -H /usr/local/bin/pm2 …`.

**Causa 4 — `package-lock.json` sucio abortaba el `git pull`.** Apareció al pushear la v1.0.9: el webhook disparó bien y trajo los commits, pero el pull murió con

```
error: Los cambios locales de los siguientes archivos serán sobrescritos al fusionar:
        package-lock.json
```

`npm install` **reescribe** ese archivo, así que basta un install manual en el server para dejarlo modificado; a partir de ahí git se niega a fusionar y **el deploy entero muere antes del reload**, con producción quedándose dos versiones atrás. Fix: el deploy ahora hace `git checkout -- package-lock.json` antes del pull. Es un archivo generado — la versión válida es siempre la del repo.

**Diagnóstico honesto**: la primera hipótesis fue que `.git/` tenía archivos con dueño root (por un `git pull` corrido como root). Era falsa — `find /home/walter/classroom -user root` volvió vacío. Lo que resolvió el caso fue `logs/deploy.log`, que tenía el error textual. **Mirar ese log primero, antes de teorizar.**

**Cada paso reporta su propio error.** Antes todo iba unido con `&&`; con esa forma, el fallo de un paso disparaba el mensaje de error del *siguiente* y `deploy.log` mentía sobre la causa. Ahora cada paso lleva su `|| { echo "ERROR deploy: <paso> fallo"; exit 1; }`.

**⚠️ Prerequisito antes de pushear esto**: en el server hay carpetas dentro de `node_modules` con dueño `root` (resaca de un `npm install` corrido como root durante el diagnóstico). El nuevo paso de install falla con `EACCES` sobre ellas y —por diseño— **aborta el deploy antes del reload** para no dejar workers sin dependencias. Hay que correr **una vez**:

```bash
chown -R walter:walter /home/walter/classroom
```

**⚠️ Bootstrap**: el primer push con este cambio lo procesa el webhook **viejo** que está en memoria (el que no instala dependencias). Va a recargar bien el código nuevo, pero sin `npm install`. Recién a partir del push siguiente el paso de dependencias corre solo.

### 2026-07-28 — Optimización automática de imágenes al subirlas (v1.0.7)

**Pedido**: que las imágenes se redimensionen apenas se suben y se guarden pesando mucho menos, con la herramienta conviviendo en el mismo servidor. Alcance acordado: avatares de perfil, portadas de materia e imágenes de novedades.

**El problema medido**: los cuatro `multer.diskStorage()` guardaban el byte-por-byte que mandaba el navegador. En el mirror local: **78 imágenes = 74,7 MB**, avatares de hasta **3,07 MB** mostrados en un círculo de 40 px. Esto es exactamente la "observación para revisar aparte" que había quedado anotada al agregar la card de Almacenamiento al monitor (198 MB / 141 archivos en producción).

#### Piezas nuevas

| Archivo | Qué hace |
|---|---|
| `config/imagePresets.js` | Los techos por tipo de imagen, en un solo lugar |
| `services/imageOptimizer.js` | Envuelve sharp: rota por EXIF, redimensiona, reencodea a WebP |
| `middleware/image-upload.js` | multer en memoria + escritura en disco con nombre cache-busting |
| `optimize-existing-images.js` | Backfill de lo ya subido (con `--dry-run`) |
| `tests/images/optimizer.test.js` | 15 tests unitarios (`npm run test:images`, runner nativo `node --test`) |

| Preset | Dónde | Máx | Ajuste | Calidad |
|---|---|---|---|---|
| `avatar` | perfil | 512×512 | `cover` | WebP 78 |
| `header` | portada de materia | 1600×600 | `inside` | WebP 80 |
| `novedad` | imagen de novedad | 1600 px lado mayor | `inside` | WebP 80 |

**Resultado medido con el backfill en dry-run: 74,74 MB → 2,89 MB (96% de ahorro), 78/78 archivos, 0 errores.** Los backups `.tar.gz` bajan en la misma proporción.

#### Por qué `memoryStorage` y no `diskStorage`

Tres motivos, el segundo es el importante:

1. El original nunca toca el disco (antes se escribían 3 MB para después borrarlos).
2. **Elimina el callback `filename()` que borraba la imagen anterior.** Ese callback era la causa raíz de la vulnerabilidad de `POST /courses/:id/customize` documentada más abajo: multer corre antes que el handler, así que un docente ajeno borraba la portada de la víctima aunque después recibiera 403. La mitigación era un middleware previo que validaba permisos; ahora el borrado vive dentro del handler y el agujero está cerrado **por diseño**, no por orden de middlewares. El middleware previo se conservó igual, como defensa en profundidad.
3. El costo es RAM (hasta 8 MB por request en vuelo), acotado por el `uploadLimiter` que ya existía. **No** se aplicó a entregas ni adjuntos de actividades: ahí hay PDFs de hasta 50 MB que no tienen por qué pasar por memoria.

#### Detalles que no son obvios

- **`.rotate()` antes del resize, siempre.** Al reencodear se pierde el EXIF — bien, porque ahí viaja el GPS de las fotos de celular de los alumnos (bonus de privacidad). Pero con el EXIF también se va el flag de orientación que hoy usa el navegador para enderezar la foto: sin rotar antes, toda foto vertical de celular quedaría acostada para siempre.
- **Nombres con sufijo único** (`avatar-ms5e5v8i9df025.webp`). Con nombre fijo, re-subir el avatar pisaba el archivo pero no cambiaba la URL, y el navegador seguía mostrando el anterior desde su cache. Con todo convertido a `.webp` el nombre habría sido siempre el mismo y el bug pasaba de intermitente a permanente.
- **`failOn: 'error'` y no el default `'warning'`.** El default rechazaba un avatar bajado de Google que cualquier navegador muestra perfecto ("premature end of JPEG image"), y de forma intermitente según la carga — lo más difícil de diagnosticar de todo esto. Con `'error'` toleramos los warnings de libjpeg igual que un navegador. Lo relevante para seguridad no cambia: un archivo que no es imagen revienta antes, en `metadata()`.
- **`fit: 'cover'` + `withoutEnlargement: true` no se llevan bien** — con una entrada de 1600×400 sharp devolvía 512×**400** y el avatar salía rectangular, que el CSS circular después aplasta. Para `cover` el lado se calcula a mano como `min(preset, ancho, alto)`. Lo encontró un test unitario antes de que llegara a la app.
- **Validación real de que es una imagen**: el `fileFilter` de multer solo mira la extensión y el `Content-Type` que declara el cliente, los dos falsificables — un archivo arbitrario renombrado a `.jpg` terminaba escrito dentro de `/public`. Decodificarlo con sharp es la validación de verdad. Ahora responde 400.
- **Degradación si falta sharp**: el `require` va protegido con `try/catch`. El webhook de deploy hace `git pull` + `pm2 reload` pero **no** `npm install`; si el binario nativo no está, la app guarda los originales sin optimizar y loguea el error, en vez de no arrancar.
- **GIF animado**: pasa intacto (convertirlo a WebP animado es caro y suele pesar más).
- **Si el WebP pesaría más que el original**, gana el original (imágenes ya optimizadas).

#### Retrocompatibilidad

Las URLs viejas (`.jpg`/`.png`) siguen en la base y los archivos siguen en disco: nada se rompe. El backfill es un paso aparte y opcional.

#### Backfill (`optimize-existing-images.js`)

⚠️ **Toca la base de datos**: al cambiar la extensión cambia el nombre, y las URLs viven en `User.avatar`, `Course.header.image` y `Announcement.image`. Reescribir los archivos sin actualizar la base dejaría todas las imágenes rotas.

Orden por archivo: escribir la nueva → actualizar la base → recién ahí borrar la vieja. Si el proceso muere en el medio, lo peor que queda es un archivo huérfano (lo levanta `cleanup-files.js`); nunca una URL apuntando a un archivo inexistente.

Reintenta en **modo tolerante** los archivos que no decodifican en estricto: esos ya están publicados y el navegador los muestra parciales, así que rechazarlos no le devuelve la imagen a nadie y deja el peso completo en disco. En el mirror local fue 1 archivo de 78 — un JPEG truncado de 1,62 MB que quedó en 0,03 MB.

Procedimiento en producción: backup → modo mantenimiento → `--dry-run` → correr → verificar → salir de mantenimiento.

#### Verificación

- `npm run test:images`: **15/15**.
- `npm run test:smoke`: **109/109**, incluidos 9 specs nuevos de imágenes.
- Backfill en dry-run sobre las 78 imágenes locales: 96% de ahorro, 0 errores.

### 2026-07-28 — Monitor del superadmin: sección Almacenamiento

**Pedido**: una card en el monitor que muestre cuánto se va guardando en disco y cuánto queda disponible.

**Qué muestra**: uso del volumen con barra (mismo patrón visual que RAM), espacio libre, cuánto ocupa la app en total, y un desglose con barras proporcionales — entregas de alumnos, adjuntos/avatares y base de datos (con cantidad de documentos y peso de índices).

#### La decisión de diseño que importa: dos costos muy distintos

`views/superadmin/monitor.ejs` **refresca cada 5 segundos** (`REFRESH_SECONDS = 5`). Eso obliga a separar:

| Dato | Costo | Estrategia |
|---|---|---|
| Espacio del volumen (`fs.statfs`) | una syscall, microsegundos | se calcula siempre |
| Tamaño de las carpetas | O(cantidad de archivos) | **cacheado 60s** |

Hoy son 144 archivos / ~214 MB y el escaneo tarda 39 ms, pero crece con cada entrega. Recorrer el árbol cada 5 segundos sería tirar I/O a la basura. El servicio devuelve `calculadoHace` y la card muestra la antigüedad del desglose en vez de fingir que es del segundo exacto.

`services/diskStats.js` concentra todo. Detalles no obvios:
- Usa **`bavail` y no `bfree`**: Linux reserva un porcentaje del filesystem para root, y `bfree` lo incluiría, mostrando más espacio libre del que la app realmente puede usar.
- **No sigue symlinks** — un link que apunte hacia arriba haría recursión infinita. `isFile()` da false para symlinks, así que quedan afuera solos.
- Los errores por entrada (permisos, archivo borrado entre el `readdir` y el `stat`) se saltean: es un panel informativo, no vale abortar el cálculo entero por un archivo.
- `mongoose` se recibe por parámetro, no se importa, para poder testear el servicio sin base.

**Degradación**: el cálculo va en su propio `try` dentro de la ruta y el endpoint devuelve `disk: null` si falla. Verificado con mongoose caído y con un objeto vacío: el bloque `db` reporta `disponible: false` y el volumen y las carpetas siguen calculándose. El monitor nunca pierde usuarios, RAM ni carga por un problema de disco.

**Verificado** contra datos reales: 249 GB usados de 376 GB (66%), 127 GB libres; entregas 14.2 MB / 3 archivos; adjuntos 198.4 MB / 141 archivos; BD 932 KB / 2.369 documentos. Coincide con `du -sh`. Caché: 39 ms el primer llamado, **0 ms** el segundo. Suite **100/100**.

**Observación para revisar aparte**: "Adjuntos y avatares" ocupa 198 MB en 141 archivos (~1,4 MB promedio). Probablemente haya imágenes de portada de curso sin comprimir. Ahora que la métrica es visible, conviene mirarlo. → ✅ **Resuelto**: era exactamente eso. Ver "Optimización automática de imágenes al subirlas (v1.0.7)" al principio del changelog.

### 2026-07-28 — El ítem "Clases" del menú pasa a "Inicio" en roles administrativos

**Consulta del usuario**: que el directivo entre directo a su panel al iniciar sesión, como admin y superadmin, en vez de caer en los cursos.

**Hallazgo: eso ya funcionaba.** `server.js` (`app.get('/')`) redirige por rol —directivo → `/directivo`— y `public/js/login.js` manda a `/` tras autenticar. Verificado de punta a punta: login de un directivo termina en `/directivo`, título "Directivo - Classroom", sin pasar por `/courses`.

**El problema real era el menú lateral**, y afectaba a los tres roles administrativos por igual. El primer ítem del drawer decía **"Clases" apuntando a `/`** — que para estos roles redirige a su propio panel. Resultado: dos entradas distintas al mismo destino (`Clases` y `Administración` / `Panel Directivo`), y un rótulo que prometía cursos y abría un panel. Admin y superadmin no lo hacían mejor: arrastraban el mismo ítem.

**Fix** (`views/partials/header.ejs`): el rótulo y el ícono se resuelven según rol — `Inicio` + `home` para admin/superadmin/directivo, y **`Clases` + `school` sin cambios para docentes y alumnos**, donde `/` sí lleva a `/courses` y el nombre es exacto.

Durante una suplantación `res.locals.user` es el usuario suplantado, así que el rótulo acompaña al rol que se está viendo — que es lo correcto.

Se descartaron dos alternativas: apuntar "Clases" a `/courses` (un directivo que no dicta nada vería un dashboard vacío) y ocultar el ítem (quien sí dicte una materia perdería el acceso desde el menú).

**Verificado**: admin, superadmin y directivo muestran "Inicio"; alumno y docente conservan "Clases" y su `/` sigue resolviendo a `/courses`. Suite **99/99**.

### 2026-07-28 — Aviso para completar el perfil (alumnos y docentes)

**Pedido**: replicar el aviso de "tareas pendientes" del dashboard para invitar a cargar los datos del perfil.

**Cómo funciona**: `GET /courses` arma `profilePrompt` con los campos del perfil personal que faltan (`bio`, `interests`, `futureGoal`) y el dashboard muestra un banner que los nombra. No hace query extra — `getCachedUser` ya trae el usuario con `.select('-password')`.

**Decisiones de diseño**:

- **Azul informativo, NO el ámbar de `.pending-band`.** Una tarea que vence es urgente; completar el perfil es opcional. Si compartieran color, el alumno aprendería a ignorar los dos.
- **No se piden teléfono ni redes.** Son datos de contacto y buena parte de los alumnos son menores: empujar por ellos desde un banner sería presionar por información sensible. Que los cargue quien quiera, desde el perfil, sin que el sistema insista.
- **Descartable, con caducidad de 7 días.** El descarte vive en `localStorage` y no en la base: es una preferencia de presentación, no un dato del usuario. Caduca para que el aviso vuelva a aparecer una vez, en vez de perderse para siempre por un click distraído.
- **Solo `student` y `teacher`.** Admin, superadmin y directivo aterrizan en sus propios paneles y el perfil no les aporta nada institucional.
- El banner arranca con `display:none` y lo muestra el script si no fue descartado, para que no parpadee al cargar.

**Desaparece solo al completarse**: `PATCH /profile/about` llama a `invalidateUser`, así que el usuario cacheado se refresca en el próximo request. Si faltara esa invalidación, el aviso seguiría apareciendo hasta que venciera el TTL de 45s — el smoke test lo cubre.

**Verificado** con usuarios reales creados y borrados en la sesión: aparece con el perfil vacío; el descarte persiste al recargar; con fecha de hace 8 días vuelve a mostrarse; con el perfil completo el servidor ya no lo manda; faltando un solo campo menciona únicamente ese. Roles: admin `false`, docente `true`, alumno `true`. Suite **99/99**.

**Nota**: `.pending-band` está declarado dos veces en `public/css/style.css` (líneas ~219 y ~1536) — duplicación preexistente, gana la segunda (ámbar). No se tocó.

### 2026-07-28 — Perfil personal: presentación, intereses y proyecto a futuro

**Pedido**: aprovechar el espacio vacío a la derecha de "Contacto y redes" en `/profile` con algo tipo gustos y preferencias.

**Campos nuevos en `User`** (todos opcionales, aditivos, sin migración):
- `bio` — presentación breve, máx. 280 caracteres.
- `interests` — array de IDs de `config/interests.js`.
- `futureGoal` — máx. 120. El label cambia según rol: alumnos ven *"Me gustaría dedicarme a…"*, el resto *"Formación o especialidad"*. Es un solo campo.

El de mayor valor institucional es `futureGoal` en alumnos: es justamente el dato que necesita un Servicio de Orientación Escolar, y el rol `soe` existe en el sistema pero está vacío.

#### Por qué los intereses son una lista cerrada y no texto libre

`config/interests.js` define 22 opciones con `id` (lo que se guarda, estable) + `label` + `icon`. **El mismo array se usa en los dos lados**: el frontend pinta los chips y el backend valida contra él. Agregar una opción la hace aparecer en ambos.

Es cerrada a propósito: los alumnos son menores y lo que cargan lo ve el equipo directivo, así que un campo abierto obligaría a moderar. Además permite agrupar a futuro ("alumnos con interés en tecnología"). Tope de 6 por persona — sin límite, un perfil con las 22 marcadas no comunica nada.

**La validación server-side no es redundante**: un PATCH directo salteando la UI podría guardar texto arbitrario que después se renderiza en el panel del directivo. Los IDs desconocidos se descartan en silencio (si la lista cambia, el usuario no pierde el resto de lo que cargó) y hay smoke test que lo cubre.

#### Visibilidad — decisión explícita

Lo ve **el propio usuario y el equipo directivo**, igual que los datos de contacto. NO lo ven compañeros ni docentes. Se optó por el criterio ya vigente para no introducir una exposición nueva sobre datos de menores. El perfil se lo aclara al usuario con una nota al pie.

Se implementa con `views/partials/about-info.ejs` (espejo de `contact-info`), incluido sólo en `directivo/student-detail`, `directivo/teacher-detail` y `admin/user-profile`. **Si en el futuro se incluye ese partial en una vista que vean alumnos, se cambia la decisión de privacidad sin querer.**

Los diccionarios `INTEREST_LABELS`/`INTEREST_ICONS` van en `res.locals` globales (`server.js`) para que el partial funcione desde cualquier vista sin que cada ruta tenga que acordarse de pasarlos.

#### UI

`profile.ejs` pasa a dos columnas (`.profile-two-col`, colapsa a una bajo 900px): Contacto a la izquierda, Sobre mí a la derecha — que es el espacio que antes quedaba vacío por el `max-width:420px` de los inputs. Chips toggleables; al llegar al tope los no elegidos se atenúan, para que se entienda por qué dejan de responder al click. Contador de caracteres que avisa a partir de 250.

**Verificado**: guardado válido; interés inventado descartado; tope de 6 → 400; bio de 281 → 400; duplicados deduplicados; el partial rendea labels legibles y no IDs crudos; el tope de chips y el contador probados con clicks reales. Suite **98/98**.

### 2026-07-28 — Panel directivo: evolución docente mes a mes + vista por división

**Pedido**: "características nuevas para el rol directivo, me gustaría que tuviera alguna visión sobre las tareas realizadas por los docentes… además de otras vistas".

**Diagnóstico**: el panel mostraba **volumen, no práctica docente**, y todas las métricas eran fotos del momento contra ventanas fijas (30 días, 15 días). Sin tendencia, no se puede detectar al docente que arrancó bien y se apagó. Los datos para medirlo (`grades[].gradedAt`, `grades[].feedback`, `grades[].manual`) **ya existían en el modelo y `routes/directivo.js` nunca los leía**.

Alcance elegido por el usuario: evolución mes a mes + vista por división. Descartó para esta tanda tiempo de corrección, entregas sin corregir y calidad de devolución. Queda pendiente el detalle de actividad.

#### Serie temporal de actividad docente

- **Ventana de 6 meses**, dos series: actividades creadas (`Activity.createdAt`) y correcciones hechas (`grades[].gradedAt`).
- **`grades.manual: true` es obligatorio** en el filtro de correcciones: el autocalificador escribe `gradedAt` en el mismo momento de la entrega con `manual: false`, así que sin ese filtro un docente que usa plantillas interactivas aparecería con cientos de "correcciones" que nunca hizo.
- **Atribución por `Activity.author`, no por `course.owner`.** Es un cambio semántico deliberado y sólo para la serie: la pregunta es "¿qué produjo este docente?", no "¿de quién es la materia?". Resuelve además que los co-docentes aparecieran con todo en cero. Las columnas viejas (`monthlyActs`/`overdueActs`/`avg`) **siguen atribuyendo por owner** para no alterar números que el directivo ya venía leyendo.
- Índice nuevo `{ author: 1, createdAt: -1 }` en `models/Activity.js` — sin él el pipeline hacía collscan. Sirve también a `services/userActivityStats.js`, que ya hacía `$match {author}` sin índice.
- Las etiquetas de meses se generan en JS y no desde los datos, para que **un mes sin actividad aparezca con cero en vez de faltar**: ver el bache es el objetivo.
- Visualización con **barras CSS puras, sin librería de charting** (mismo criterio que `.bucket-bar` en grades.ejs): sparkline de 6 barras + ícono de tendencia en el listado, gráfico con las dos series en el perfil. Las barras en cero tienen `min-height: 2px` para no leerse como un hueco de renderizado.

#### Buscador y orden en `/directivo/teachers`

Antes `queryParams: {}` — sin búsqueda ni orden. **La escuela tiene 352 docentes**, así que el listado paginado de a 25 era inusable. Se agregó `filters-bar` (búsqueda por nombre + 4 órdenes), con `queryParams` para que la paginación conserve los filtros.

#### Vista por división (nueva)

- `GET /directivo/divisions` — materias, alumnos únicos, docentes únicos, actividades, tasa de entrega, promedio y vencidas sin calificar. **Los alumnos se cuentan únicos por división** (`$setUnion` sobre el `$reduce` de `students`): un alumno cursa varias materias del mismo año y sumar `students.length` lo contaría repetido. Ojo al leer: la suma de la columna Alumnos entre divisiones supera el total de la escuela, porque un alumno puede cursar materias de más de una división.
- `GET /directivo/divisions/:id` — materias y alumnos, con links cruzados a sus detalles. Valida pertenencia a la escuela con 403.
- Ítem nuevo en `directivo-nav.ejs` y la tarjeta "Cursos / Divisiones" del dashboard, que era un número muerto, ahora enlaza al listado.

#### Smoke suite: 97/97 (antes 93/94 con un fallo permanente)

Tres specs nuevos (`directivo-teachers-search`, `directivo-divisions-list`, `directivo-division-detail`) y **se arregló `directivo-sees-courses-with-metrics`**, que fallaba siempre contra una base espejada de producción: buscaba "Materia Smoke" en el listado sin filtrar, pero `/directivo/courses` pagina de a 25 ordenando por peor tasa y con 419 materias el curso nunca caía en la página 1. Ahora lo busca con `?search=`. El test era anterior a que se agregara esa paginación.

**Deuda detectada, no arreglada** (fuera del alcance aprobado): las cuatro rutas `/:id` del panel devuelven **500 en vez de 404 con un ObjectId malformado** (`/directivo/courses/no-es-un-objectid`). Es preexistente y afecta por igual a las rutas viejas y a la nueva. Fix: `mongoose.isValidObjectId()` al entrar al handler.

**Nota sobre los datos actuales**: la base tiene 53 actividades, todas de julio 2026 — la plataforma arrancó este mes. Los sparklines muestran hoy 5 meses vacíos y uno con datos; la métrica cobra valor con el tiempo.

### 2026-07-28 — Previsualización embebida de Google Drive / Docs / Sheets / Slides

**Pedido**: que el docente pueda adjuntar un enlace a un archivo de Google Drive en una tarea.

**Aclaración**: adjuntar links **ya funcionaba** (botón "Agregar enlace" en `/activities/new` y en el modal de creación; el backend los guarda como `{ type:'link', url, name }`). No hizo falta tocar backend. Lo que faltaba era la previsualización: al hacer click, todo link que no fuera de YouTube abría una pestaña nueva.

**Cambio** (`public/js/course.js`, solo frontend):
- Helper nuevo `_gDriveEmbedUrl(url)` — devuelve la URL `/preview` si reconoce un archivo de Google embebible, o `''` si no. Al devolver `''` el flujo cae en el `window.open` de siempre, así que **cualquier formato no reconocido sigue comportándose exactamente como antes**.
- Formatos soportados: `drive.google.com/file/d/ID/view`, `drive.google.com/open?id=ID` (formato viejo de compartir), y `docs.google.com/{document,spreadsheets,presentation}/d/ID/edit`.
- **Google Forms queda deliberadamente afuera**: el alumno necesita interactuar y completar, y embeberlo en un modal es peor experiencia que abrirlo en su propia pestaña.
- `openAttachmentPreview`: branch nuevo que renderea el iframe de Drive, siguiendo el mismo patrón que el de YouTube.
- El botón de la barra superior pasa a "Abrir en Google Drive". **Por qué no "Descargar"**: el atributo `download` de `<a>` es ignorado en cross-origin, así que ese botón no haría nada. Además es la salida del alumno si el archivo no está compartido (ver limitación abajo).
- `buildAttachmentListHTML`: el ícono del ítem ahora anticipa lo que va a pasar al click — `play_circle` (YouTube), `visibility` (Drive, previsualiza en el modal), `open_in_new` (el resto, abre pestaña).

**⚠️ Limitación conocida**: el archivo debe estar compartido en Drive como **"cualquiera con el enlace"**. Si queda restringido, Google muestra su propia pantalla de "solicitar acceso" *dentro* del iframe. No se puede detectar desde el frontend (es cross-origin), por eso el botón "Abrir en Google Drive" siempre está disponible como escape. Sería una mejora futura avisarlo en la UI al pegar un link de Drive.

**Verificado**:
- 12 formatos de URL probados contra la función: los 6 de Google embeben correctamente; Forms, YouTube, sitios comunes, URL vacía, `null` y URLs malformadas caen en el fallback sin excepciones.
- En el navegador, los flujos preexistentes intactos: YouTube sigue embebiendo, los links comunes siguen abriendo pestaña, el PDF sigue con su visor y botón "Descargar".
- Flujo real de punta a punta: crear actividad con link de Drive → se guarda → se renderea con ícono `visibility` → el click abre el modal con `.../preview` y el botón correcto.
- Suite smoke: 93/94 (el único fallo sigue siendo el ambiental de paginación, ver Issues Conocidos #8).

### 2026-07-28 — Fix CRÍTICO: el deploy automático se suicidaba a mitad de camino

**Síntoma**: tras pushear, el footer de las páginas seguía mostrando `v1.0.2` mientras `package.json` en el disco del servidor ya decía `v1.0.4`. El sitio respondía HTTP 200 y no parecía roto.

**Causa raíz**: el webhook (`POST /deploy` en `server.js`) hacía

```js
exec('git -C /home/walter/classroom pull && /usr/local/bin/pm2 restart classroom --update-env', …)
```

Ese `exec` corre **dentro de un worker de PM2**, y el comando reinicia esos mismos workers. Al llegar a `pm2 restart`, PM2 mata el worker — y con él al proceso hijo que estaba ejecutando el comando. El `git pull` completaba (va primero), el restart no.

**Estado resultante — un Frankenstein silencioso:**

| Qué | De dónde sale | Tras el deploy roto |
|---|---|---|
| `public/js/*`, `public/css/*` (estáticos) | disco, en cada request | **nuevo** |
| Vistas `.ejs` | memoria — `NODE_ENV=production` activa el view cache de Express | **viejo** |
| `routes/`, `models/`, `APP_VERSION` | memoria, al arrancar el worker | **viejo** |

> **Corrección (2026-07-28)**: una versión previa de esta nota decía que las vistas `.ejs`
> se releen del disco en cada request. Es **falso con `NODE_ENV=production`** (que es el
> valor tanto en producción como en el `.env` de desarrollo): Express cachea las plantillas
> compiladas al primer render. Consecuencia práctica: **editar un `.ejs` no se refleja hasta
> reiniciar el proceso**, y nodemon por defecto no vigila `.ejs` — hay que tocar un `.js`
> para forzar el reinicio.

Lo que queda desincronizado es entonces **los archivos estáticos contra todo lo demás**: el JS del navegador es nuevo y puede llamar endpoints que el servidor viejo no tiene (404), o esperar respuestas con una forma que las rutas viejas todavía no devuelven.

**Pista diagnóstica**: en `pm2 list`, los contadores de restart (`↺`) quedan **desparejos entre workers** (se vio 12 y 8). En cluster mode PM2 reinicia de a uno; el comando alcanzaba a reiniciar el primero y moría antes del segundo.

**Fix** (`server.js`): `spawn` con `detached: true` + `unref()` y `stdio: 'ignore'`, para que el comando quede en su propio grupo de procesos y sobreviva a la muerte del worker. `reload` en lugar de `restart` (levanta de a uno, sin downtime). Salida a `logs/deploy.log`.

**Red de seguridad**: el deploy ahora termina comparando la versión que `/health` reporta desde **memoria** contra la de `package.json` en **disco**. Si divergen, escribe `ERROR deploy NO recargo: disco=vX memoria=vY` en `deploy.log` y sale con código 1, en vez de fallar en silencio — que es lo que hizo que este bug pasara desapercibido.

**⚠️ Bootstrap**: el primer push que incluya este fix lo va a procesar el webhook **viejo**, que se sigue suicidando. Va a dejar el código nuevo en disco sin recargar. Hace falta **un** `sudo -u walter pm2 reload classroom --update-env` manual esa única vez; a partir de ahí el pipeline se arregla solo.

### 2026-07-28 — Endpoint `/health`

`GET /health` → `{ status, version, pid, uptime, db }`. Público, sin auth.

Montado **antes** del rate limiter y del middleware de mantenimiento a propósito: tiene que responder justamente cuando algo anda mal (cupo agotado, sitio en mantenimiento), que es cuando más se lo consulta. Devuelve 503 si Mongo está caído.

El campo `version` sale de `APP_VERSION`, que se lee de `package.json` **una sola vez al arrancar el worker** (`server.js:19`). Por eso es la fuente de verdad de qué código hay realmente cargado en memoria, a diferencia del `package.json` del disco — y comparar ambos es lo que detecta un deploy que copió archivos sin recargar.

`pid` distingue entre workers del cluster; `uptime` es de ese worker en particular.

Smoke test nuevo: `health-reports-loaded-version` (suite 93/94; el único fallo restante es el ambiental de paginación del directivo, ver Issues Conocidos #8).

### 2026-07-28 — Fix CRÍTICO: `course.js` abortaba entero para el alumno (card de adjunto invisible)

**Bug reportado**: "al adjuntar archivo de parte de la respuesta a una actividad del docente, no me levanta la card que previsualiza el estado que se está subiendo al servidor y qué tipo de archivo es, si es pdf, o word, o excel, como sí figura cuando el docente lo precarga cuando arma la actividad".

**Causa raíz** (mucho más grave de lo que parecía el síntoma): `public/js/course.js` hacía, en el **nivel superior** del script:

```js
document.getElementById('imageInput').addEventListener('change', …);   // línea 456
```

`#imageInput` (adjuntar imagen a una novedad) vive dentro de `<% if (course.isTeacher(user._id)) { %>` en `views/course.ejs` → **no existe para el alumno**. Entonces `getElementById` devuelve `null`, el `.addEventListener` tira `TypeError`, y **la ejecución del script se corta ahí**.

Consecuencia en cascada: todo lo declarado más abajo con `const`/`let` en el nivel superior nunca se inicializa y queda permanentemente en la TDZ (Temporal Dead Zone). En particular `SUB_ALLOWED_EXTS` y `SUB_MAX_SIZE` (línea 1650). Como las `function` declarations **sí** se hoistean, `uploadSubFile` existía y se podía llamar — pero explotaba en su primera línea con `ReferenceError: Cannot access 'SUB_ALLOWED_EXTS' before initialization`, **antes** de llegar a crear la card. De ahí que no apareciera absolutamente nada: ni card, ni barra de progreso, ni modal de error.

Por eso el docente no lo sufría: para él `#imageInput` existe, el script carga completo, y todo funciona.

**Fix**: optional chaining (`?.`) en los **7** `addEventListener` de nivel superior del archivo, ya que el DOM de `course.ejs` varía según el rol:
`imageInput`, `activityFileInput`, `linkUrlInput`, `activityModal`, `editActivityModal`, `activityDetailModal`, `addStudentModal`.

**Verificado** en el navegador con un alumno real de prueba (creado y borrado en la misma sesión):
- Antes: `SUB_ALLOWED_EXTS is not defined`, grid vacío.
- Después: `SUB_ALLOWED_EXTS` OK; card visible 110×104 px, aparece **inmediata** con la barra de progreso, y con el color correcto por tipo — PDF `rgb(234,67,53)` / XLSX `rgb(52,168,83)`.
- Al terminar la subida la card se convierte en clickeable (`cursor:pointer`) y abre el previewer.
- El botón ✕ quita la card sin abrir el previewer (`stopPropagation`).
- Envío final: `POST /:id/submit` guarda la entrega y la re-renderiza con el archivo clickeable.

**Nota de mantenimiento**: `course.js` es un único script compartido por las vistas de docente y de alumno, que renderean DOM distinto. Cualquier `getElementById(...)` nuevo **en el nivel superior** debe usar `?.` o ir dentro de una función, o se repite este bug silencioso (no hay error visible en pantalla, solo en la consola del navegador).

### 2026-07-28 — Preview de adjuntos pre-subidos, antes de enviar la entrega

**Pedido**: el alumno no podía ver el archivo que acababa de adjuntar hasta después de darle "Entregar".

**Cambio**:
- **Backend**: nuevo `GET /activities/:id/staged-file/:filename` (routes/activities.js) que sirve **inline** un archivo ya pre-subido pero todavía sin `Submission`. Seguridad: solo lee de `ENTREGAS_BASE/{schoolId}/{actId}/{userId}/{filename}` — el directorio propio del alumno, tomado de la sesión, nunca del request. `path.basename()` sobre el filename bloquea path traversal. Con `?dl=1` fuerza descarga.
- **Frontend** (`uploadSubFile`): al completar la subida, la miniatura y el nombre de la card quedan clickeables con `data-att-*` + `handleAttachmentClick` apuntando al endpoint nuevo. El botón ✕ lleva `event.stopPropagation()` para no abrir el previewer al quitar.
- **Previewer**: el helper que agrega `?dl=1` al botón "Descargar" ahora también reconoce las URLs de `staged-file` (antes solo `submission-file`).

**Verificado**: `staged-file` responde 200 `application/pdf` + `Content-Disposition: inline` y carga en iframe; `?dl=1` → `attachment`; path traversal (`..%2F..%2F..%2Fpackage.json`, con y sin encodear) → 404; click en la card abre el modal con el `iframe src` correcto.

### 2026-07-28 — UI de adjuntar entrega del alumno igual a la del docente

**Pedido**: "quiero que me permita adjuntarlo como lo hace el docente en la sección de tareas". El alumno tenía un botón `.btn-outline` chico "Adjuntar archivos" — funcional, pero visualmente inconsistente con la card "Adjuntar" del docente en `views/activities/new.ejs` (círculo grande "Subir" bien visible + grid de previsualización).

**Cambio** (public/js/course.js, `renderSubmissionSection`): el formulario de entrega del alumno ahora usa el mismo layout que el creator del docente — `<div class="creator-card">` con `<div class="creator-att-row">` conteniendo el `.creator-att-btn` circular "Subir", más el `#subFilePreviews` con clase `.att-preview-grid`. Todas las clases CSS ya existían (las usa el docente en new.ejs); no se agregó CSS nuevo.

La infraestructura de upload (`uploadSubFile` con XHR + progress bar por archivo + `removeUploadedSubFile`) ya venía usando las clases `.att-preview-card` / `.att-preview-thumb` / `.att-preview-ext` iguales al docente — solo el botón "Adjuntar" era distinto. Ahora todo el flujo se ve idéntico.

**Verificado**: JS syntax OK, smoke suite 81/93 sin regresiones. El reproductor del alumno ABREGO en la actividad "Nueva tarea" confirma que `canEdit=true` y el formulario se renderea (antes del cambio el botón estaba pero era chico y poco visible; ahora es un círculo grande "Subir" imposible de perderse).

### 2026-07-28 — Preview de archivos entregados (alumno y docente)

**Bug reportado**: al ver "Mi entrega" en una actividad ya enviada, el alumno no podía previsualizar los archivos que había subido — solo se descargaban al click. Mismo problema para el docente viendo las entregas de sus alumnos en la solapa Notas.

**Causa doble**:
1. `GET /activities/submission-file/:filename` (routes/activities.js) siempre forzaba `Content-Disposition: attachment` → aunque el frontend intentara mostrar el archivo en un iframe, el navegador disparaba "Save as…" en vez de renderizarlo.
2. `renderSubmissionSection` (public/js/course.js) y la tabla de entregas del docente rendeaban los archivos como `<a href="…" download>` en vez de usar `handleAttachmentClick` como sí hacen los adjuntos de la actividad.

**Fix**:
- **Backend**: el endpoint ahora sirve `inline` por defecto (permite iframe preview del PDF/imagen). Con `?dl=1` fuerza `attachment` — usado por el botón "Descargar" del modal para descarga real. Los checks de acceso (dueño de la entrega o docente del curso) no cambiaron.
- **Frontend**: los archivos de entrega ahora se rendean con `data-att-*` + `onclick="handleAttachmentClick(this)"` — mismo previewer que los adjuntos del docente. Cambiado en `renderSubmissionSection` (vista alumno) y en la tabla `sub.files.map` del gradebook (vista docente).
- **Previewer**: agregado soporte para imágenes (jpg/png/gif/webp) — antes solo tenía PDF, Office y YouTube; caía en `else` sin `bodyContent` y el modal se abría vacío. Ahora imagen embedded + fallback textual para formatos sin preview (ej: ZIP). Helper nuevo `_isImage`.
- **Previewer**: el botón "Descargar" del modal, cuando la URL apunta a `/activities/submission-file/`, agrega `?dl=1` para forzar descarga (el attribute `download` del `<a>` por sí solo puede no ganar contra `Content-Disposition: inline` en todos los navegadores).

**Verificado** contra el server real: `GET /submission-file/:f` responde `Content-Disposition: inline` por defecto y `attachment` con `?dl=1`, los 403/302 de acceso siguen intactos. Suite smoke: 81/93 sin regresiones (mismas 2 fallas preexistentes).

### 2026-07-28 — Fix: "Error al cargar notas" y actividades/novedades sin cargar (rate limiter mal aplicado)

**Bug reportado**: al abrir un curso, la solapa "Mis notas" mostraba "Error al cargar notas.", y las listas de novedades y actividades no cargaban.

**Causa**: en `server.js` estaba `app.use('/activities', uploadLimiter)` y `app.use('/announcements', uploadLimiter)` con `max: 60/hora por IP`. Eso limitaba **cualquier request** a esas rutas, incluidos los GET de lectura (`GET /activities/course/:id`, `GET /activities/:id/my-submission`, `GET /announcements/course/:id`, etc.). Con ~300 personas de la escuela detrás de la misma IP pública NAT (mismo motivo por el que `authLimiter` usa 1000, ver comentario en server.js:78), el cupo se agotaba en minutos y todos los alumnos que abrieran un curso veían 429 disfrazado del mensaje "Límite de subidas alcanzado". Confirmado reproduciendo el flujo end-to-end como el alumno afectado (ABREGO SEÑO, LUCAS URIEL en el curso Lengua 2°2° de BRUDEZAN): antes del fix, los 4 GETs que dispara `public/js/course.js` devolvían 429; después del fix, 200.

**Fix**:
- `middleware/rate-limits.js` (nuevo): exporta `uploadLimiter` con `max: 600/hora` (cabe uso escolar normal y sigue frenando un abuser real).
- `server.js`: se quita la definición local y los dos `app.use('/…', uploadLimiter)` globales.
- `routes/activities.js` y `routes/announcements.js`: se aplica `uploadLimiter` inline en las 5 rutas que realmente hacen upload de archivos — `POST /activities/create`, `POST /activities/upload-attachment`, `POST /activities/:id/upload-submission-file`, `POST /activities/:id/submit`, `POST /announcements/create`. Todo el resto (GETs, calificar, comentar, borrar, editar) queda sin este limiter (sigue cubierto por `generalLimiter`: 400/15min).

**Verificado**: smoke suite completa sin regresiones (81/93 igual que antes, las 2 fallas son preexistentes — una depende de credenciales de superadmin no pasadas, la otra es el test flaky de dataset grande ya conocido). Reproductor manual confirma que los 4 GETs del alumno vuelven 200; los uploads siguen protegidos por el limiter aplicado inline.

**Extra** (mismo día, decisión del usuario tras el fix): se **triplicaron los 3 rate limiters** como blindaje preventivo, para que un pico de uso escolar no vuelva a agotar ninguno:
- `generalLimiter`: 400 → **1200** peticiones / 15min (server.js)
- `authLimiter`:    1000 → **3000** intentos / 15min (server.js)
- `uploadLimiter`:  600 → **1800** subidas / hora (middleware/rate-limits.js)

Todos siguen siendo suficientes para detectar y desalentar un abuser real (3000 login attempts o 1800 uploads en 15/60 min es claramente anormal), pero con ~300 personas de la escuela detrás de la misma IP pública NAT, dejan margen amplio para picos de arranque de clase, reintentos y actividad simultánea.

### 2026-07-27 — Campos de contacto y redes en el perfil (celular, Instagram, Facebook)

Nuevos campos opcionales en `User`: `phone`, `instagram`, `facebook`. Solo el propio usuario los edita; se muestran como chips de solo lectura en las vistas donde admin/directivo ya veían el perfil de otro usuario.

**Modelo** (`models/User.js`): 3 campos String opcionales, `default: null`, sin validación en el schema (se valida/sanitiza en la ruta). Sin migración — Mongoose aplica el default a los documentos existentes.

**Backend** (`routes/courses.js`):
- `PATCH /courses/profile/contact` (requireAuth, actúa sobre `req.userId` — nadie edita el contacto de otro). Body `{ phone, instagram, facebook }`, todos opcionales; mandar `''` borra el campo.
- `sanitizePhone()`: acepta dígitos, `+`, espacios, guiones y paréntesis, 7-20 caracteres.
- `sanitizeSocialHandle(raw, domain)`: acepta `@handle`, `handle` o URL completa (`https://www.instagram.com/handle/...?query`) y devuelve solo el handle limpio (sin protocolo, `www.`, dominio, query ni path extra). Nunca se guarda la URL completa — se reconstruye al mostrarla.
- `logAudit(..., 'user.contact_change', ...)` + `invalidateUser()` para no servir el caché de 45s con datos viejos.
- Acción nueva en el catálogo: `config/audit-actions.js` → `user.contact_change`.

**Frontend propio** (`views/profile.ejs`): sección "Contacto y redes" con 3 inputs editables + botón Guardar, AJAX contra el PATCH de arriba (mismo patrón que cambiar email/contraseña).

**Solo lectura** — partial compartido `views/partials/contact-info.ejs` (recibe `person`), incluido en:
- `views/admin/user-profile.ejs` — admin viendo cualquier usuario de su escuela.
- `views/directivo/student-detail.ejs` y `views/directivo/teacher-detail.ejs` — directivo/admin viendo alumno o docente (`routes/directivo.js` — se agregó `phone instagram facebook` a los `.select()` de `/students/:id` y `/teachers/:id`, que antes NO traían esos campos).
- Chips: teléfono (`tel:`) + WhatsApp (`wa.me/` con solo dígitos — funciona si el usuario carga el número con código de país), Instagram y Facebook como link `https://dominio/handle` con `target="_blank" rel="noopener noreferrer"`. Todo interpolado con el tag de output que escapa por defecto (no con el que no escapa), para blindar contra XSS aunque los handles ya vengan saneados.

**Gap conocido, no cerrado en esta pasada**: docente/preceptor/SOE no tienen hoy ninguna vista para ver el perfil de otro usuario (`middleware/directivo.js` solo acepta `directivo/admin/superadmin`), y superadmin no tiene página individual de usuario (`routes/superadmin.js` no tiene `GET /users/:id`). La regla de visibilidad "todos estos roles ven el contacto de todos" queda documentada pero sin superficie donde mostrarse para esos casos — se resuelve cuando exista la tab "Personas" del curso (gap #12 del audit backlog) o una página individual en superadmin.

**Verificado** end-to-end contra el server real: alumno autoregistrado guarda/borra contacto vía PATCH (con formatos de input variados: `@handle`, URL completa con query, `www.`), rechazo 400 de teléfono/handle inválido, admin creó alumno y docente de prueba en su escuela → cada uno seteó su contacto → verificado que aparece en `/admin/users/:id`, `/directivo/students/:id` y `/directivo/teachers/:id` con los links correctos. Sin regresiones (usuarios de prueba borrados al final).

### 2026-07-27 — Columna Nov·Act·Msg en listados de usuarios (admin y superadmin)

Nueva columna en `/admin/users` y `/superadmin/users` con 3 chips coloreados que muestran cuánto ha PUBLICADO cada usuario (semántica docente-centered elegida por el usuario):

- **Novedades** (azul `#1a73e8`): anuncios donde `Announcement.author === userId`.
- **Actividades** (naranja `#e37400`): tareas donde `Activity.author === userId`.
- **Mensajes** (verde `#137333`): comentarios que el usuario escribió dentro de `Announcement.comments[]`.

Chips con 0 se muestran en gris atenuado, chips > 0 con fondo suave del color correspondiente. Tooltip en cada chip con el label completo y el número.

**Implementación**:
- Helper nuevo `services/userActivityStats.js` — 3 aggregations bulk (una por métrica) filtradas por el conjunto de `userIds` de la página actual. Devuelve `Map<userId, {novedades, actividades, mensajes}>`. Escala con el `limit` de la página (25 en admin, hasta 100 en superadmin), no una query por usuario.
- Partial compartido `views/partials/user-activity-stats.ejs` consume el `stats` del helper. Comentario del partial usa `<%# ... %>` (comentario EJS), no `<% // ... %>` — este último rompe el parser cuando dentro del comentario hay ejemplos con `<%- include %>` porque el `%>` interno cierra el bloque exterior.
- Rutas: `routes/admin.js:161-162` y `routes/superadmin.js:290-292` invocan el helper y pasan `activityStats` a la vista.
- Vistas: `views/admin/users.ejs:67` y `views/superadmin/users.ejs:108` agregan header + celda con `include` al partial.

**Sin índices nuevos**: `Announcement.author` y `Activity.author` no están indexados; con el volumen actual de la escuela (decenas de anuncios/actividades) el aggregation es rápido. Si en producción se nota, agregar `{author:1}` a ambos modelos.

**Verificado** contra el server real: los conteos del helper coinciden con `countDocuments` bruto por usuario, y los chips renderizan en el HTML con los colores correctos (validado con `document.querySelectorAll('span[title*="publicadas"]')`).

### 2026-07-27 — Modo mantenimiento: usuarios sin sesión aterrizan en /login

**Problema**: si al dueño (`waltermedinilla@gmail.com`) se le reiniciaba la máquina o vencía la cookie estando el modo mantenimiento activo, la pantalla `views/maintenance.ejs` no linkeaba al login. Podía escribir `/login` a mano (siempre estuvo exempt) o borrar `maintenance.json` en disco, pero ninguno de los dos era descubrible.

**Cambio** (`server.js:190-215`): en el middleware global de mantenimiento, si `!res.locals.user && req.accepts('html') && req.method === 'GET'` → `res.redirect('/login')` antes de renderizar la pantalla de mantenimiento. Usuarios logueados no-dueño siguen viendo la pantalla igual que antes. Clientes JSON sin auth siguen recibiendo 503 (no redirect).

Una vez que el dueño se autentica, el bypass por email (`res.locals.user?.email === SYSTEM_OWNER_EMAIL`) ya funciona: entra a la app, va a `/superadmin/backup` y apaga el modo.

**Verificado** con script contra el server real (6 escenarios: sin sesión→redirect, admin no-dueño→503, superadmin→bypass, GET/POST /login funciona, JSON sin auth→503). Sin regresiones.

### 2026-07-27 — Ver entrega en modo solo lectura + edición opt-in por actividad

**Solicitud**: el alumno debe poder ver su entrega ya enviada (texto + archivos), pero sin poder editarla. Solo si el docente lo habilita explícitamente en esa actividad, el alumno puede reenviarla mientras el plazo esté abierto.

**Modelo** (`models/Activity.js`):
- Campo `allowResubmission: Boolean, default: false`. **No requiere migración**: Mongoose aplica el default al leer. Documentos existentes en producción se comportan como "no editable" hasta que el docente los edite y active la casilla.

**Backend** (`routes/activities.js`):
- `POST /activities/create` y `PUT /activities/:id` aceptan `allowResubmission` en el body.
- `POST /activities/:id/submit` y `POST /activities/:id/upload-submission-file` bloquean con 403 si ya existe `Submission` del alumno y `allowResubmission=false`. Mensaje: "Esta actividad no permite modificar la entrega una vez enviada".
- La regla convive con `allowLateSubmissions`: primero se chequea plazo vencido, después edición-post-entrega.

**UI docente**:
- Casilla "Permitir que el alumno edite su entrega después de enviarla" en el sidebar del formulario de crear actividad (`views/activities/new.ejs`, id `sAllowResubmission`) y en el modal de editar actividad (`views/course.ejs`, id `editAllowResubmission`). Ambos mandan el flag al server.

**UI alumno** (`public/js/course.js`):
- `renderSubmissionSection(actId, submission, isBlocked, allowResubmission)`: cuando el alumno ya entregó y `allowResubmission=false`, muestra el bloque de solo lectura con texto, archivos descargables y aviso "El docente no permite modificar la entrega una vez enviada. Solo podés visualizarla." SIN el formulario de textarea/adjuntar.
- `renderRunnerSection`: para actividades interactivas, oculta el runner cuando ya se respondió y no está permitida la edición — el alumno ve solo el resultado autogradeado.
- `submitWork` re-renderiza pasando `act.allowResubmission` para no perder el flag después de un reenvío exitoso.

**Datos**:
- No se elimina ni modifica ningún documento existente. Efecto en actividades ya creadas: cualquiera con entregas previas queda cerrada a edición por defecto (comportamiento deseado); si el docente quiere abrirla, entra al modal de editar y marca la casilla.

**Tests**: el spec `activity-create` en `tests/smoke/specs.js` ahora crea la actividad de prueba con `allowResubmission: '1'` — el suite hace tres submits secuenciales sobre la misma actividad y sin el flag el 2° submit fallaría con 403.

### 2026-07-25 — Restricciones UI a docentes + infraestructura multi-docente (WIP)

**Contexto**: la auditoría de 2026-07-01 había detectado 62 grupos de materias (Course) con nombre repetido dentro de la misma División — casi todas del mismo lote de importación "Cargos", con distintos docentes asignados. El usuario pidió consolidarlas: una sola materia por grupo, uniendo a los docentes de las eliminadas como co-docentes de la que queda. Esta sesión dejó la **infraestructura lista y commiteada, pero la fusión de datos reales sin empezar** — ver memoria `materias-duplicadas-consolidacion` para el estado exacto y los próximos pasos.

**Restricciones de UI a docentes (completo)**:
- `dashboard.ejs`: oculta "Unirse a clase" y "Crear clase" para `role==='teacher'`.
- `course.ejs` (tab Personas): oculta "Agregar Alumno", "Deshabilitar cuenta", "Quitar del curso" — solo cuando el dueño del curso es específicamente docente (un admin-dueño conserva los botones).
- Decisión explícita: solo UI, sin bloquear el backend (las rutas siguen aceptando la acción si se llaman directo).

**Modelo multi-docente (nuevo, para soportar la fusión)**:
- `Course.coTeachers: [ObjectId]` — docentes adicionales con los mismos permisos que `owner` sobre la materia. `owner` sigue siendo el docente principal, nunca se pisa.
- `Course.isTeacher(userId)` — método de instancia, único punto de verdad para "¿es docente de esta materia?" (owner o cualquier coTeacher). Seguro con el campo poblado o sin popular. ⚠️ Desde el 2026-07-31 los **permisos** se chequean con `Course.canManage(user)`, que suma a los admins de la escuela; `isTeacher` quedó para la pertenencia real (listados de "mis materias").
- Reemplazados los ~27 chequeos `course.owner.toString() === userId` esparcidos en `activities.js`, `announcements.js`, `courses.js` y `course.ejs` por `course.isTeacher(userId)`.
- Queries "mis cursos" (dashboard, perfil, panel directivo M4) extendidas para incluir materias co-dictadas.
- Alerta directivo "materias sin docente" ahora considera coTeachers activos antes de marcar una materia como huérfana.
- Límite de alcance consciente: el reporte directivo M3 "Actividad docente" sigue atribuyendo cada materia solo a su owner principal (es un reporte de lectura, no un chequeo de permisos) — documentado en el código, se extiende si hace falta.

**Pendiente para la próxima sesión**: función de fusión de materias (migrar alumnos/actividades/entregas/novedades del perdedor al ganador + sumar su owner a coTeachers + recién ahí borrar), smoke tests del flujo multi-docente, y la revisión interactiva de los 60 grupos ambiguos (ninguno tiene una señal automática que distinga cuál conservar — se decide caso por caso con el usuario).

### 2026-07-23 — Auditoría (Fase 2: cobertura completa + ~30 rutas instrumentadas)

Extiende la fase 1 con la instrumentación completa. Ahora se registran **todas las acciones que importan** — 41 acciones en 12 categorías. Sin sumar aún logins (queda para cuando duela la ausencia).

**Catálogo ampliado** (`config/audit-actions.js`) — nuevas acciones:
- **Cursos**: create, edit, delete, join, add_student, remove_student, assign_teacher.
- **Divisiones**: create, edit, delete (categoría nueva — el admin-nav las llama "Cursos" pero acá son `division` para no chocar con Course).
- **Usuarios**: create, delete, role_change, toggle_active, reset_password, password_change, impersonate, bulk_role, bulk_school, school_change.
- **Materias**: create, edit, delete.
- **Escuelas** (superadmin): create, edit, delete, invite_generate, invite_revoke.
- **Sugerencias**: create, status_change, delete.
- **Importación**: execute (los 3 flujos del panel admin + el flujo del superadmin, cada uno con contadores en meta).
- **Sistema** (dueño): backup_create, restore, maintenance_on, maintenance_off.

**Instrumentación** — ~30 puntos de log agregados sin tocar ni una línea de la lógica de negocio. Puntos clave del diseño:
- **Snapshot antes del delete**: `school.delete`, `subject.delete`, `division.delete`, `course.remove_student`, `suggestion.delete` hacen un `findById(...).select('name').lean()` ANTES de borrar, para que el evento siga legible aunque el recurso no exista más. Costo: 1 query extra por delete — despreciable.
- **Override de `schoolId`** vía el 4° argumento de `logAudit`: cuando el actor es superadmin (school=null) pero el recurso pertenece a una escuela específica (ej. `school.edit`, `user.role_change` sobre un usuario de escuela X, `user.school_change`), el evento se guarda con la escuela **del recurso**, no la del actor. Así el admin de esa escuela ve en su panel las acciones del superadmin sobre su institución.
- **`user.school_change`** captura ambos snapshots: la escuela de origen (populado ANTES del update) y la de destino (query por schoolId destino) — quedan como `de: X, a: Y` en el meta.
- **Cambios en `role_change` / `division.edit` / `subject.edit`** capturan el nombre viejo si cambió, así el meta puede mostrar `de: X, a: Y` cuando hubo rename.
- **`import.execute`** loguea contadores por tipo de flujo (`cargos` / `sistema` / `alumnos` / superadmin genérico), no logs individuales por cada usuario importado — sería demasiado ruido para una operación bulk.
- **`system.backup_create`** loguea ANTES de streamear el .tar.gz al cliente: si el download callback falla por red, el evento igual se registró porque el backup ya se generó exitosamente en disco.

**Smoke tests** — 3 specs nuevos + cleanup mejorado:
- `audit-full-coverage` — verifica que cada una de las 6 categorías principales (activity, submission, announcement, course, user, suggestion) tenga al menos 1 evento al final del flujo. Compara total del header con y sin filtro, no busca strings en el HTML (evita falsos positivos por el dropdown de filtros que ya contiene todos los labels).
- `audit-search-filter` — busca "Smoke" en el panel y verifica que devuelva > 0.
- `audit-superadmin-sees-system-events` — verifica que el panel `/superadmin/audit?category=system` incluya los `maintenance_on/off` disparados por el spec de mantenimiento.
- **Cleanup robusto** — antes matcheaba solo por `actor.email` y `targets.name` con regex del RUN_ID; ahora también matchea por `actor.userId` y `targets.id` contra los IDs reales de los recursos de smoke (`state.scopedTeacherId`, `state.courseId`, etc.). Elimina falsos negativos que dejaban 5-7 huérfanos por corrida. Además se agregó un `sleep(500ms)` al arranque del cleanup para que los `logAudit` fire-and-forget de las últimas acciones (cascada de delete de curso/usuarios) alcancen a persistir antes del delete.
- Solo quedan **3 huérfanos por corrida** (documentados): los 2 de mantenimiento del superadmin + el 1 de backup, que no tienen ni RUN_ID ni ids de smoke — inofensivos.

**56/56 pasando** contra el mirror local de producción.

### 2026-07-23 — Auditoría (Fase 1: infraestructura + 4 rutas piloto)

Nueva colección `auditlogs` y panel de auditoría en `/admin/audit` (scoped por escuela) y `/superadmin/audit` (todas las escuelas, con filtro extra por escuela). El objetivo es tener registro histórico de "quién hizo qué, cuándo, sobre qué" — arranca con las acciones que importan (crear/entregar/calificar/publicar); logins y el resto de las rutas quedan para la Fase 2.

**Diseño**:
- **Modelo `AuditLog`** (`models/AuditLog.js`): `action` (string canónico, ej: `submission.grade`), `actor` (**snapshot** de name/role/email además del ref al userId — así el log sigue legible aunque después se borre al usuario o le cambien el nombre), `targets` (array de `{ type, id, name }` — también con snapshot), `school` (para scope), `timestamp`, `meta` (mixed, extras por acción), `ip`, `userAgent`. Índices compuestos `{school:1, timestamp:-1}`, `{actor.userId:1, timestamp:-1}`, `{action:1, timestamp:-1}` para las 3 queries naturales del panel.
- **Catálogo de acciones** (`config/audit-actions.js`): cada acción tiene label en español (verbo), icono Material Symbol, color y categoría. Agregar una acción nueva = una línea en el catálogo + una llamada a `logAudit(...)` donde ocurra. En dev, el helper valida contra el catálogo y avisa por consola si aparece una acción sin registrar; en prod la guarda igual (no queremos que un typo rompa la operación real).
- **Helper `logAudit`** (`middleware/audit.js`): **fire-and-forget**. Nunca hacer `await` sobre él — el diseño es que un fallo del log no bloquee ni demore la operación real. Si Mongo hipa, se loguea a stderr y ya; el evento se pierde pero la request cerró bien. Concurrencia gratis: cada `insertOne` es independiente, los 2 workers de PM2 escriben en paralelo sin coordinación.
- **Rutas** (`routes/audit.js`): un solo router con handlers `GET /admin/audit` y `GET /superadmin/audit` — el compartido escapa regex en `category` y `q`, arma filtro por `action` / `role` / rango de fechas / texto libre sobre `actor.name|email` y `targets.name`. Paginado de a 50, con clamp de página fuera de rango. Se monta en `server.js` **antes** de adminRoutes/superadminRoutes para interceptar esos paths.
- **Vista compartida** (`views/partials/audit-list.ejs` + dos wrappers en `views/admin/audit.ejs` y `views/superadmin/audit.ejs`): filtros arriba, filas con ícono coloreado + snapshot del actor con badge de rol en español + verbo del catálogo + targets separados por `·` + meta como línea secundaria + fecha/hora a la derecha. Link "Auditoría" agregado a `admin-nav.ejs` y `superadmin-nav.ejs`.

**Instrumentación piloto** (4 rutas, ~30 líneas totales):
- `POST /activities/create` → `activity.create` con meta `{ tipo, adjuntos, puntos? }`.
- `POST /activities/:id/submit` → `submission.create` (primera entrega) o `submission.update` (reenvío — se distingue por el snapshot de `existing` antes del upsert) con meta `{ archivos, tardia? }`.
- `POST /activities/:id/grade` → `submission.grade` con snapshot del nombre del alumno calificado (una query extra minimal `.select('name').lean()`) y meta `{ puntos, maximo? }`.
- `POST /announcements/create` → `announcement.create` con meta `{ con_imagen }` y el texto de la novedad truncado a 60 chars como nombre del target.

**Ejemplo de render** (verificado en el navegador con datos reales):
> **Gabriela López** [Docente] · calificó una entrega · TP N°3 — Ecuaciones · Juan Pérez · Matemática 1°1° — puntos: 8, maximo: 10 — 23 de jul de 2026, 12:13 p.m.

**Scope y decisiones tomadas** (respuestas del usuario):
- Solo acciones que importan (no logins/navegación) — logins quedan como "sumar después es 2 líneas".
- Visibilidad: **Superadmin ve todo** (con filtro extra por escuela) + **Admin ve su escuela** (scoped). Directivo NO ve el panel.
- Retención: **sin límite** por ahora. Cuando duela el volumen se decide entre TTL automático y export+purga manual.

**Smoke tests**: 3 specs nuevos + cleanup automático:
- `audit-denied-for-teacher` — un docente recibe 403 en `/admin/audit`.
- `audit-admin-sees-events` — el admin ve los eventos generados por los specs anteriores (activity.create + submission.grade + announcement.create) y el panel usa los verbos del catálogo.
- `audit-filter-by-category` — filtrar por categoría reduce estrictamente el total mostrado en el header (compara contadores, no busca strings en el HTML — evita falsos positivos por el propio dropdown de filtros).
- `cleanup-auditlogs-db` — borra los logs de cada corrida por `actor.email` matchea el RUN_ID.

**53/53 pasando** contra el mirror local de producción.

**Cambio de BD**: se crea una colección nueva `auditlogs` con 3 índices. Mongo la crea sola al primer insert, no hace falta migración manual — pero si en algún momento cambian los índices, sí. **Sin commitear, sin pushear** (según tu preferencia). La colección arranca vacía; los logs solo se generan de acá para adelante.

**Pendiente Fase 2** (cuando digas): extender `logAudit(...)` a las ~25 rutas restantes (resto de activities/announcements + courses + users admin/superadmin + subjects + schools + system: backup/restore/mantenimiento). Agregar impersonate. Después: sumar logins (`auth.login` / `auth.logout`) si sirve.

### 2026-07-22 — 🔒 Fix seguridad: `/courses/:id/customize` validación de owner antes del multer

**Bug encontrado en revisión previa al deploy.** El orden de middlewares dejaba una vulnerabilidad concreta: `POST /courses/:id/customize` tenía `headerUpload.single('image')` ANTES del handler que validaba `course.owner === req.userId`. El `filename()` callback del multer (definido en las líneas 29-39) hace `readdirSync` + `unlinkSync` para borrar el header anterior — **eso ejecutaba antes** de que se pudiera devolver 403.

**Consecuencia**: cualquier docente autenticado podía mandar `POST /courses/{ID_AJENO}/customize` con una imagen y borrar la portada del curso ajeno. Iterando sobre IDs podía dejar cursos de otros docentes sin imagen. La imagen del atacante quedaba en disco pero no referenciada en la BD.

**Fix**: se agregó un middleware inline entre `requireAuth` y `headerUpload` que hace un `Course.findById(...).select('owner')` y devuelve 403 si el usuario no es el owner. El multer ya no arranca en ese caso. Costo: 1 query extra por request legítima. El chequeo redundante en el handler final se dejó como defensa en profundidad.

**No aplica al avatar** (`POST /courses/profile/avatar`): ahí el destino usa `res.locals.user._id` (el propio usuario), no un parámetro de URL. Cada uno solo puede tocar el suyo.

Spec de regresión agregado a smoke tests: `customize-rejects-non-owner` — un alumno (no-owner) intenta customizar el curso y debe recibir 403. **49/49 pasando.**

### 2026-07-22 — Modo Mantenimiento (Caso A: la app sigue viva, se bloquea a propósito)

Nueva pieza en `/superadmin/backup` (misma pantalla del backup, sección nueva arriba de todo). Solo `waltermedinilla@gmail.com` puede activarlo/desactivarlo — reutiliza `requireBackupAccess`.

**Diseño**: `config/maintenance.js` — estado persistido en `maintenance.json` en la raíz del proyecto (gitignored), NO en memoria. Mismo motivo que el `previewToken` del restore: en PM2 cluster (2 workers) el disco se comparte, la memoria no. Además, leerlo directo del disco en cada request (sin cache) garantiza que desactivar el modo tenga efecto inmediato en ambos workers — acá la instantaneidad importa más que ahorrarse una lectura de archivo de pocos bytes.

**Middleware global** en `server.js` (después de `checkUser`/`school`/`roleNames`, antes de montar las rutas):
- Si `maintenance.json` no existe → sigue de largo, cero overhead.
- Si existe y el usuario es `waltermedinilla@gmail.com` → bypass total (sigue viendo la app real, no la pantalla de aviso).
- Si existe y es cualquier otro (o nadie logueado) → **503** con `views/maintenance.ejs` (HTML) o `{ maintenance: true, message, eta }` (si el request pide JSON). `Retry-After: 300` en el header.
- Excepciones aunque no seas el dueño: `/login`, `/logout`, estáticos (`/css/`, `/js/`, `/favicon.png`, `/Logo.jpg`) y `/deploy` (este último redundante en la práctica porque el webhook responde más arriba en el archivo, antes de este middleware — se deja como documentación/defensa en profundidad).

**`views/maintenance.ejs`**: página 100% autónoma, sin `include` de `header`/`footer` ni ninguna dependencia de BD — a propósito, para que se pueda renderizar aunque Mongo esté teniendo problemas. Reusa el logo SVG + `Logo.jpg` + clases CSS (`auth-body`, `auth-card`) que ya usa `login.ejs`.

**Activación automática durante `/restore`**: antes de tocar cualquier dato, se activa mantenimiento (salvo que ya estuviera activo manualmente — en ese caso no se toca ni al empezar ni al terminar, para no apagar algo que no prendimos nosotros). Se desactiva en el `finally`, así se apaga incluso si el restore falla a mitad de camino.

**Consolidación de código**: el email `waltermedinilla@gmail.com` estaba duplicado como constante local en `routes/backup.js` (`BACKUP_ALLOWED_EMAIL`). Se centralizó en `config/maintenance.js` como `SYSTEM_OWNER_EMAIL`, y `routes/backup.js` ahora lo importa de ahí — un solo lugar para cambiar si alguna vez cambia el dueño del sistema.

**Hallazgo durante las pruebas — nodemon se auto-reiniciaba en cada toggle**: `maintenance.json` vive en la raíz del proyecto con extensión `.json`, y nodemon (sin config de ignore) vigila esa extensión por defecto. Cada activar/desactivar disparaba un restart completo del server en desarrollo (no pasa en producción: PM2 corre con `watch: false`). Se agregó `.nodemonignore` (nuevo archivo) excluyendo `maintenance.json`, `backups/`, `logs/`, `public/archivos/`, `archivos/entregas/`, `sin-commitear/`. **Importante**: nodemon solo relee su config de ignore al arrancar el proceso completo (`npm run dev` desde cero) — un simple auto-restart de su hijo NO alcanza para tomar un `.nodemonignore` nuevo.

**Smoke tests**: 2 specs nuevos. El de toggle usa `try/finally` DENTRO del `run()` del spec (no solo el manejo de errores genérico de `run.js`) para garantizar que el modo se desactive incluso si una aserción falla a mitad de camino — crítico porque los specs de limpieza que corren después usan el actor `admin`, que quedaría bloqueado con 503 si el mantenimiento se quedara pegado. **48/48 pasando.**

**Verificado real, no con mocks**: ciclo completo activar → admin normal bloqueado (503 HTML y JSON) → dueño con bypass (200) → desactivar → acceso restablecido. Visualmente confirmado en el navegador, incluyendo tildes/caracteres especiales en el mensaje custom (un primer intento con `curl -d` en git-bash corrompió la tilde por un problema de encoding del propio comando de prueba, no del servidor — se confirmó pasando el body como archivo UTF-8 explícito).

**Caso B (app completamente caída) queda fuera de alcance a propósito** — si el proceso Node no arranca o crashea, ningún middleware nuestro puede responder; eso requeriría configurar el reverse proxy (Tailscale Funnel) con una página de fallback, que es infraestructura, no código, y no se abordó en esta sesión.

### 2026-07-22 — Backup y Restauración (Nivel 1) — panel superadmin

Nueva sección `/superadmin/backup`, solo accesible para `waltermedinilla@gmail.com` (doble capa: `requireSuperAdmin` + chequeo de email exacto — ver `middleware/superadmin.js` + `requireBackupAccess` local en `routes/backup.js`).

**Generar backup** (`GET /superadmin/backup/download`):
- Vuelca las 9 colecciones (schools, users, courses, activities, submissions, announcements, suggestions, divisions, subjects) a JSON + copia completa de `public/archivos/` y `archivos/entregas/`, todo empaquetado en un único `.tar.gz` con `manifest.json` (fecha, versión, contadores).
- Se genera en `os.tmpdir()`, se streamea al navegador, y se borra del server inmediatamente después — nunca queda un backup de descarga persistido server-side.
- Probado contra la BD real: **21.7 MB comprimidos** (32 MB de archivos + ~1.1 MB de BD).

**Restaurar backup** (`POST /superadmin/backup/preview` → `POST /superadmin/backup/restore`):
- Flujo en dos pasos: primero se sube el `.tar.gz` y se lee SOLO el `manifest.json` (sin descomprimir `db/` ni `files/`) para mostrar un diff "actual vs backup" por colección — instantáneo aunque el backup pese cientos de MB.
- El upload queda en disco (no en memoria) bajo un `previewToken` — importante en PM2 cluster: el disco SÍ se comparte entre los 2 workers (a diferencia de un `Map` en memoria), así que el `POST /restore` puede caer en un worker distinto al que atendió el `/preview` sin perder el archivo.
- Antes de tocar cualquier dato, `POST /restore` genera automáticamente un backup de seguridad del estado actual, persistido en `backups/` (gitignored) — nunca se restaura sin poder volver atrás.
- Requiere escribir literalmente `"RESTAURAR"` + 3 checkboxes tildados en la UI antes de habilitar el botón.
- `insertMany` reconstruye los `_id` (ObjectId) y fechas automáticamente vía el casting de schema de Mongoose al recibirlos como strings/ISO desde el JSON — verificado con un round-trip real.
- Después de restaurar se invalida todo el cache de usuario/escuela (`invalidateAll()`, nuevo método en `config/cache.js` + `middleware/cache.js`) porque los `_id` cacheados pueden ya no corresponder a la BD reemplazada.
- Rate limit dedicado: 3 intentos de restore por hora (protege contra doble-click/bugs, no contra abuso — es una operación rara a propósito).

**Verificado end-to-end contra el mirror local de producción** (no solo con mocks):
- Descarga real de 21.7 MB, tar.gz válido (verificado con la librería `tar`, no con el `tar` de shell — en Windows/git-bash falla con paths que tienen `:`).
- Preview real: diff correcto contra las 1276 users / 485 courses / etc. existentes.
- **Restore real ejecutado**: se restauró el mismo backup recién generado (por seguridad, sin pérdida de datos posible) — conteos idénticos antes/después, mismo `_id` y mismo hash de contraseña del superadmin, sesión del navegador siguió viva post-restore (confirma que `invalidateAll()` no rompe la sesión activa).
- Acceso denegado (403) confirmado para un admin de escuela normal.
- Manejo de archivo corrupto/inválido: al principio devolvía 500 con el error crudo de la librería `tar` — se arregló para devolver 400 con mensaje claro.

**Smoke tests**: 4 specs nuevos (acceso denegado, stats, download produce tar.gz válido, preview rechaza archivo inválido). Deliberadamente **sin spec de `/restore`** en la suite automática — restaurar es seguro pero pesado (genera ~20 MB en `backups/` cada vez); se prueba manualmente antes de cada release, no en cada corrida de `npm run test:smoke`. **46/46 pasando.**

**Dependencia nueva**: `tar` (^7.5.21) — sin shell-out a binarios del sistema, funciona igual en Windows dev y Linux prod.

**Nivel 2 y 3 quedan pendientes** (no implementados a propósito, ver especificación original): backup automático por cron, retención con límite, subida a almacenamiento externo (S3/Backblaze/OneDrive), restore parcial (solo una colección), progreso en vivo del restore vía streaming (hoy es un solo request bloqueante con un log final).

> Actualización: **la parte off-site del Nivel 3 se hizo el 2026-08-17**, aunque no contra S3 sino contra una PC del dueño por FTP sobre Tailscale — ver ese changelog. Sigue siendo manual (hay que apretar el botón): automatizarlo es el Nivel 2 y no está hecho.

### 2026-07-22 — Performance: `font-display: swap` en Material Symbols

Lighthouse contra producción (`/courses`) reportó 97/100 en Performance, con una única mejora significativa: la fuente `Material Symbols Outlined` bloqueaba el render ~620 ms hasta descargar.

Fix: se agregó `&display=swap` al querystring del `<link>` de Google Fonts en las **40 vistas EJS** que la cargan. Impacto:
- El texto se ve inmediatamente al abrir la página (antes: pantalla en blanco hasta cargar la fuente).
- Los íconos aparecen cuando la fuente termina de descargar (unos ms después) sin bloquear el resto.
- Elimina la mayor parte del CLS (Cumulative Layout Shift) que Lighthouse reportaba en 0.1.

Cambio idempotente, sin efecto en el backend. Smoke test: 42/42 sigue pasando.

### 2026-07-21 — Panel Directivo: 2 correcciones detectadas en revisión

Cambios contenidos íntegramente a `routes/directivo.js`. Ninguna otra pieza del sistema afectada.

**Fix 1 — Tardías correctas cuando el alumno reenvía**: el cálculo de "¿esta entrega fue tardía?" comparaba `submission.createdAt` contra `activity.dueDate`. Como el `POST /:id/submit` hace upsert, `createdAt` queda fijo en la primera entrega — si un alumno entregaba a tiempo y después reenviaba tarde, aparecía como "no tardía" pese a que la entrega vigente (la que va a corregir el docente) llegó fuera de plazo. Ahora se usa `updatedAt`, que el propio schema Submission documenta como "el último reenvío". Impacta:
- Aggregate M2 en `GET /directivo/students` (columna "Tardías" del listado + chip "Muchas tardías")
- Cálculo en `GET /directivo/students/:id` (perfil, badge "Tardía" por entrega + total)

**Fix 2 — Admins que dictan cursos ahora visibles al directivo**: `Course.owner` puede ser un admin (ver `routes/admin.js`, dropdown de docente al crear/editar curso), pero el panel directivo asumía en 4 lugares que todos los docentes tienen `role: 'teacher'`. Verificado contra prod: hay 1 admin dictando 1 curso (Vallejo). Ese curso y sus métricas quedaban invisibles. Impacto:
- Dashboard: "Materias con docente deshabilitado" ahora considera admins deshabilitados también.
- M1 `/directivo/grades`: la columna "Docente" ya no queda vacía para cursos con owner admin.
- M3 `/directivo/teachers`: total pasó de 350 → 353 al incluir a los admins. Ordenado y paginado como el resto.
- `/directivo/teachers/:id`: la validación `teacher.role !== 'teacher'` devolvía 404 para admins. Ahora acepta `['teacher', 'admin']` para no romper el link desde el listado.

Smoke test: 42/42 sigue pasando.

### 2026-07-21 — Paginación en las 3 vistas del Panel Directivo

Materias, Alumnos y Docentes ahora paginan de a 25 (mismo `views/partials/pagination.ejs` que reusa el admin). Se agregó línea de contexto "Mostrando 26–50 de 485" arriba de cada tabla.

**Decisión de diseño**: la paginación se aplica en JS después de calcular todas las métricas y ordenar por prioridad (más flags primero en alumnos, peor tasa primero en materias, más sin calificar primero en docentes). Alternativa `.skip().limit()` en Mongo pierde ese orden — se descartó. Con los índices agregados, calcular las métricas de toda la escuela sub-segundo hasta ~1000 alumnos.

**Contadores globales**: los chips de "Bajo rendimiento: 12 / Silencioso: 34 / Tardías: 8" en `/directivo/students` siguen mostrando totales de escuela — no dependen de la página actual.

**Preservación de filtros**: los links de páginas mantienen `?search=`, `?division=`, `?sort=`, `?estado=` intactos vía `queryParams` que se pasa al partial.

**Clamp de página fuera de rango**: `?page=999` cuando solo hay 20 páginas cae limpio en la última (vía `Math.min(page, totalPages)` en el server), evitando el "Mostrando 24951–485" que aparecería si `slice()` recibiera un `pageStart` inválido.

### 2026-07-21 — Panel Directivo (M1 + M2 + M3 + M4)

**Completa el bloque directivo con la parte pedagógica.** Con esto el rol tiene panel operativo completo (todo lo del roadmap Alta+Media hecho; Baja — export Excel, notificaciones — descartada por decisión del usuario).

- **M1 · Promedios** (`GET /directivo/grades`) — promedios normalizados a 0-10 (cada `points/activity.points × 10`), por curso y por división, más el promedio institucional. Tabla ordenada por peor promedio primero. Distribución en 4 buckets (<4, 4-6, 6-8, 8-10) con barra apilada. Excluye actividades con `points: null`.
- **M2 · Alumnos con foco** (`GET /directivo/students`) — cada alumno con: entregas último mes, cantidad de tardías (`submission.createdAt > activity.dueDate`), promedio normalizado. Etiquetas: Bajo rendimiento (`avg < 6`), Silencioso (0 entregas último mes), Tardías (`≥3 entregas y >30% fuera de plazo`). Chips de filtro por estado. Orden: los que tienen más flags activos primero.
- **M3 · Actividad docente** (`GET /directivo/teachers`) — por docente: cursos, alumnos únicos, actividades publicadas último mes, actividades vencidas sin calificar hace > 15 días, promedio general de sus cursos. Orden: los que tienen más "sin calificar" primero.
- **M4 · Perfiles read-only** (`GET /directivo/students/:id` y `/directivo/teachers/:id`) — datos personales + mini-stats + historial. Alumno: cursos inscripto + historial completo de entregas (con tardía, nota, feedback). Docente: materias que dicta + actividades publicadas con estado (En curso / Parcial / Sin calificar / Vencida).
- **Nav actualizado** (`views/partials/directivo-nav.ejs`): Resumen · Materias · Alumnos · Docentes · Promedios.
- **Smoke tests**: 5 specs nuevos. **42/42 pasando**.

### 2026-07-21 — Panel Directivo (A1 + A2)

**Nuevo rol operativo con panel propio de solo lectura.** Antes el `directivo` existía como enum pero al loguearse veía lo mismo que un docente. Ahora `/directivo` es su landing por defecto (redirect en `server.js` según el rol).

- **Middleware** `middleware/directivo.js` — acepta `directivo`, `admin`, `superadmin` (mismo patrón que `requireAdmin`).
- **Rutas nuevas** (`routes/directivo.js`, montada en `/directivo`, todas scoped por `res.locals.user.school`):
  - `GET /directivo` — dashboard institucional: 6 tarjetas (alumnos / docentes / materias / divisiones / conectados últ. 15 min / nuevas altas último mes) + 3 alertas "requiere atención" (materias con docente deshabilitado, actividades vencidas sin calificar hace > 15 días, alumnos sin matricular).
  - `GET /directivo/courses` — listado con métricas por curso: alumnos, actividades, entregas, **tasa de entrega %** (verde >80, ámbar 50-80, rojo <50), **cantidad de actividades vencidas sin calificar**. Filtros: búsqueda, división, orden (peor/mejor tasa primero, o nombre). Aggregate único con `$lookup` para evitar N+3 queries por curso.
  - `GET /directivo/courses/:id` — detalle read-only del curso: actividades con estado (En curso / Parcial / Sin calificar / Vencida) + alumnos con tasa individual.
- **Vistas** en `views/directivo/`: `dashboard.ejs`, `courses.ejs`, `course-detail.ejs`, `no-school.ejs` (pantalla amigable si el directivo no tiene escuela). Nav horizontal en `views/partials/directivo-nav.ejs`. Link en el drawer (`views/partials/header.ejs`).
- **Índices nuevos** en `Activity` (`{course, availableFrom}`, `{course, dueDate}`) y `Submission` (`{student, createdAt}`) para que las agregaciones escalen.
- **Smoke tests**: 6 specs nuevos (crear directivo, login + dashboard, listado con métricas, detalle, 403 al intentar mutar cursos, cleanup). **37/37 pasando** contra la BD real (896 alumnos, 351 docentes, 485 materias).

**Pendiente del roadmap directivo** (ver [Plan de Futuras Actualizaciones]):
- **M1** — Promedios por curso / división / escuela (con normalización a escala 0-10).
- **M2** — Alumnos con bajo rendimiento + silenciosos + con tardías.
- **M3** — Actividad docente (publicaciones, calificaciones atrasadas, promedio de sus cursos).
- **M4** — Perfiles read-only de alumno / docente / curso.

**Detalle a corregir eventualmente** — `POST /admin/users/create` en `routes/admin.js:161` siempre asigna la escuela del admin que crea al nuevo usuario. Si un superadmin (que tiene `school: null`) crea un directivo, este queda con `school: null` y su panel aparece vacío. La creación de directivos debería hacerla el admin de la escuela específica, o bien el endpoint debería permitir elegir la escuela cuando lo llama un superadmin.

### 2026-07-21 — Sugerencias abiertas, cache, monitor con bandwidth, entregas del alumno con progreso, smoke tests

**Sugerencias — abiertas a todos los roles**
- Antes solo staff (superadmin/admin/directivo/preceptor/soe) podía enviar sugerencias. Ahora **cualquier usuario autenticado** ve el FAB 💡 y puede enviar (`routes/suggestions.js` + `views/partials/footer.ejs`).
- Panel superadmin `/superadmin/suggestions` ahora **paginado** (25 por página, misma UI que el resto de listados).
- Nuevos índices en `Suggestion` para el filtro por estado + orden: `{status:1, createdAt:-1}` y `{school:1, createdAt:-1}`.

**Cache de usuario/escuela + invalidación**
- `checkUser` + middleware de escuela corrían `User.findById` + `School.findById` en **TODAS** las requests. Ahora hay un TTL cache en memoria por-worker (`config/cache.js` + `middleware/cache.js`) que reduce ~45× las queries a Mongo en el path caliente.
- TTL **45 segundos** (NO 5 min) a propósito: PM2 en Linux reparte round-robin entre 2 workers y cada worker tiene su propio Map — un cambio de rol/estado invalida SOLO en el worker que atendió la mutación. Con TTL de 5 min había una ventana real de inconsistencia; 45s la acota a menos de 1 min.
- Todas las rutas que mutan usuario (`admin.js`, `superadmin.js` bulk + individual + toggle, `courses.js` avatar + toggle-active) y escuela (edit, delete, temas) llaman `invalidateUser`/`invalidateSchool` para el worker local.

**Monitor del superadmin — conectados ahora + ancho de banda**
- Tarjeta nueva **"Conectados ahora"** (últimos 2 min) con desglose por rol y punto verde pulsante. Convive con "Activos (15 min)" que era la métrica histórica.
- Throttle de `User.lastSeen` bajado de 5 min → 1 min en `checkUser`. Índice `{lastSeen:1}` para que la consulta escale.
- Sección **Ancho de banda** con tasa en vivo (auto-escala B/s → KB/s → MB/s), total acumulado y sparkline SVG por dirección. Lee `/proc/net/dev` (`config/network.js`). En Windows muestra "N/D"; en Ubuntu de producción son valores reales.
- Refresh cada **5 segundos** (antes 30s).

**Entregas del alumno — pre-upload con progreso (opción A)**
- Nuevo endpoint `POST /activities/:id/upload-submission-file` que pre-sube un archivo al path final y devuelve `{ storagePath, name, filename, mime, size }`. Espeja el patrón del docente (`/upload-attachment`).
- `POST /:id/submit` acepta ahora **JSON con `uploadedFiles`** (flujo nuevo) o **multipart con `files`** (viejo, retrocompat). Middleware multipart condicional.
- **Defensa contra hijack**: al recibir el JSON el server filtra los `storagePath` que no arranquen con `{schoolId}/{activityId}/{userId}/` del solicitante. Un alumno no puede referenciar archivos de otro.
- Frontend del alumno (`public/js/course.js` + modal reutilizable en `views/course.ejs`): validación cliente (extensión + 20 MB), barra de progreso en tiempo real por archivo, mismo modal de error que el docente, botón "Entregar" deshabilitado mientras haya uploads en curso.

**Suite de smoke tests end-to-end**
- Nueva carpeta `tests/smoke/` con `lib.js` (cliente HTTP con cookie jar por actor), `specs.js` (31 escenarios), `run.js` (orquestador) y `README.md`. Cero dependencias nuevas — solo `fetch` global de Node.
- Corre con `npm run test:smoke` (más env vars opcionales `SMOKE_ADMIN_*`/`SMOKE_SUPERADMIN_*` o `.env.test`). Cubre registro, login, curso completo (crear→unirse→novedad→actividad→entrega→calificación→gradebook), sugerencias abiertas, invalidación de cache al deshabilitar, paginación del panel superadmin, y los 3 tests nuevos del flujo A de entregas (rechazo de extensión, upload+submit JSON, defensa anti-hijack).
- Se niega a correr contra hosts no-localhost (guard de seguridad).
- Al final borra todo lo que creó (curso, división, usuarios, sugerencias).

**Herramientas de sincronización dev**
- `pull-from-prod.js` + `sync-prod.ps1`: espejan la BD de producción hacia la local vía túnel SSH. No tocan producción; solo overwrite completo de local.

### 2026-07-04 — Correcciones de bugs (revisión con Opus)
- **[CRÍTICO] Bucle de redirección con sesión vencida**: `GET /login`, `/register` y `/register/invite` chequeaban `req.cookies.token` en vez de `res.locals.user`. Con un JWT vencido pero cookie presente se producía un bucle infinito `/login → / → /login` (ERR_TOO_MANY_REDIRECTS). Ahora chequean el usuario validado.
- **[CRÍTICO] Import de cursos del superadmin roto**: creaba `Course` con campos inexistentes (`section`, `subject`) y sin `division` (requerido) → todo fallaba en silencio. Ahora resuelve/crea la `Division` desde la columna `seccion` del Excel.
- **[MEDIA] Borrado de curso desde admin sin cascada**: `POST /admin/courses/:id/delete` ahora usa `cascadeDeleteCourse()` que elimina actividades, entregas, novedades y archivos físicos asociados.
- **[BAJA] Selector de tipo de actividad**: el creador full-page (`/activities/new`) ahora tiene selector Tarea/Evaluación/TP/Examen (antes todo quedaba como `tarea`).
- **[MENOR] `connectDB()` duplicado** en `server.js` eliminado.

### 2026-06/07 — Subida de adjuntos y fechas por defecto
- Pre-subida de adjuntos de actividad con barra de progreso y modal de error (endpoint `POST /activities/upload-attachment?courseId=`). Límite de archivo subido a **50 MB**. Validación cliente de tipo y tamaño.
- "Disponible desde" precargado con la fecha/hora actual; "Fecha de entrega" precargada a +7 días.
- Webhook de deploy (`POST /deploy`) cambiado de `pm2 reload` a `pm2 restart --update-env` (garantiza que todos los workers tomen el código nuevo).

---

## Rol Preceptor — panel `/preceptor` (2026-07-30)

**Pedido**: que el preceptor controle y vea los cursos a cargo; que al entrar a un curso encuentre las materias con sus profesores y el listado de alumnos actuales; que pueda dar de alta alumnos nuevos; y que al crear un preceptor se defina qué cursos ve (o todos).

**Vocabulario**: lo que la escuela llama "curso" (1°1°, 2°3°) es una `Division` en el código; `Course` es una materia dictada dentro de una división. El panel usa el lenguaje de la escuela en la UI y el del código por dentro.

### Alcance (scope) — dos campos nuevos en `User`
```
assignedDivisions: [ObjectId → Division]   // divisiones concretas a cargo
allDivisions:      Boolean                  // true = todas las de su escuela
```
**Fail-closed a propósito**: NO existe la convención "array vacío = todas". El rol `preceptor` se puede asignar por caminos que no preguntan por divisiones (cambio de rol individual desde el perfil o el listado, cambio en lote del superadmin), y en todos ellos el usuario queda sin ver nada hasta que un admin le defina el alcance. Si "vacío" significara "todas", esos caminos entregarían la escuela entera por omisión.

Cambio **aditivo**: no requiere migración de la base. Los usuarios existentes toman los defaults.

`middleware/preceptor.js` resuelve el alcance una vez por request en `req.scopeDivisionIds`, filtrando **siempre** por escuela — incluso sobre `assignedDivisions`, porque `POST /superadmin/users/:id/school` no desvincula nada al mover un usuario de escuela y le quedarían divisiones viejas pegadas en el array.

### Rutas
| Ruta | Qué hace |
|---|---|
| `GET /preceptor` | Grilla de tarjetas, una por curso a cargo (materias / alumnos / docentes). Sin alcance → pantalla "todavía no tenés cursos asignados" |
| `GET /preceptor/divisions/:id` | Materias con su docente **y co-docentes**, más la nómina de alumnos con entregas y promedio |
| `POST /preceptor/divisions/:id/students` | Alta de alumno + matrícula en todas las materias del curso |
| `GET /preceptor/students/:id` | Ficha del alumno: datos editables, materias, actividades y notas |
| `POST /preceptor/students/:id/edit` | Nombre, correo, DNI, teléfono |
| `POST /preceptor/students/:id/toggle-active` | Baja lógica / rehabilitación |
| `POST /preceptor/students/:id/unenroll` | Lo saca de todas las materias de un curso (no borra la cuenta) |
| `POST /preceptor/students/:id/move` | Lo pasa de un curso a otro: sale de todas las del viejo, entra en todas las del nuevo |

**Toda** ruta con `:id` valida contra el alcance en el servidor. Las tres rutas `/students/:id` además exigen que el alumno esté matriculado en alguna materia de una división del alcance (`alumnoEnAlcance`): el chequeo de escuela solo —que es lo que hacen las rutas read-only del directivo— no alcanza cuando hay escritura.

**Fuera del rol por diseño**: crear/editar materias, tocar docentes, borrar alumnos definitivamente, resetear contraseñas.

### Gestión de la matriculación (2026-07-30)
Desde la ficha del alumno, un bloque **Matriculación** con una tarjeta por curso donde está inscripto:
- **Sacar del curso** — lo desmatricula de todas las materias de esa división. La cuenta y sus datos quedan intactos; se lo puede volver a matricular.
- **Mover a otro curso** — lo saca del viejo y lo inscribe en todas las materias del nuevo. El destino tiene que estar también a cargo del preceptor: mover a alguien a un curso que no administra sería sacárselo de encima hacia donde no puede seguirlo.

**Guarda de entregas**: ambas acciones se bloquean con 409 si el alumno ya entregó algo en ese curso, y la tarjeta ni siquiera muestra los botones (explica por qué). Es el mismo criterio que ya rige para los docentes en `DELETE /courses/:id/students/:studentId` — que el sistema se comporte igual para los dos roles evita la sorpresa de "a mí me deja y a vos no". Sacarlo escondería su trabajo y la corrección del docente sin dejar rastro.

Detalles: al desmatricular se borra también su entrada en `enrollmentDates` (si se lo reinscribe, la fecha que vale es la nueva). En el traslado el orden es **primero sacar, después inscribir** — al revés, si las dos divisiones compartieran una materia, el alta la sumaría y la baja la volvería a quitar. Todo queda auditado con `course.remove_student` / `course.add_student` y un `via` que distingue el flujo (`preceptor-sacar-del-curso`, `preceptor-mover-origen`, `preceptor-mover-destino`).

### Asignación de cursos (panel admin)
- Alta: al elegir rol Preceptor aparece el checkbox "Todos los cursos" + la lista de divisiones. ⚠️ **El alta de usuario está DUPLICADA en dos vistas** y hay que tocar las dos: el modal de `views/admin/users.ejs` (al que llega el nav "Nuevo usuario" → `/admin/users?create=1`, y es el camino que se usa en la práctica) y la página completa `views/admin/user-form.ejs` (`/admin/users/create`). Ambas postean al mismo `POST /admin/users/create`.
- Reasignación: bloque "Cursos a cargo" en `/admin/users/:id` con `POST /admin/users/:id/divisions`. Muestra un **aviso ámbar** si el preceptor quedó sin cursos — es el único lugar donde el admin se entera de que un usuario convertido a preceptor desde el listado no ve nada.
- Ambos caminos validan las divisiones contra la escuela (`resolveScopeDivisions`) y llaman a `invalidateUser`: el alcance se resuelve desde el doc cacheado (TTL 45s) y sin invalidar seguiría vigente el alcance viejo.

### Endurecimiento asociado
- **`preceptor` salió del auto-registro** (`POST /register` y `POST /register/invite/:token`, y del select de la vista de invitación). Cualquiera con el link de invitación de la escuela podía asignarse el rol; era inocuo mientras el rol no hacía nada, dejó de serlo al darle permisos sobre alumnos. Ahora lo crea un admin, igual que `admin`.
- **`POST /courses/create` rechaza al preceptor** (403) y el botón "Crear clase" se le oculta en `/courses`. Sin eso podía crear una materia, quedar como `owner` y por `isTeacher()` calificar y gestionar alumnos de esa materia. ⚠️ Esa ruta **sigue sin validar el rol para el resto** — un alumno logueado puede hacer el mismo POST. Agujero preexistente, pendiente de arreglo aparte.

### Refactors (extracciones sin cambio de lógica)
- `services/enrollment.js` ← `enrollStudentInDivisionCourses`, que vivía en `routes/admin.js`. El alta del admin y la del preceptor tienen que matricular igual (incluido el `enrollmentDates` que oculta las tareas ya vencidas y el caso "el DNI ya existe").
- `services/divisionDetail.js` ← el cuerpo de `GET /directivo/divisions/:id`. Lo consumen los dos paneles para que no puedan divergir en los números. Suma `coTeachers` (la vista del directivo sigue mostrando solo el titular).

### Redirección e ingreso
`GET /` manda al preceptor a `/preceptor`. El drawer le muestra "Mis cursos" y también "Mis clases" (`/courses`), porque puede estar matriculado en materias como cualquier usuario y el redirect ya no lo lleva ahí.

### Auditoría
Reusa `user.create` y `course.add_student` con `via: 'preceptor'` en la metadata, para que las altas del preceptor aparezcan en el mismo timeline que las del admin pero distinguibles. Acciones nuevas: `user.edit` y `user.assign_divisions`.

### Cobertura
16 specs en `tests/smoke/specs.js`, centrados en la barrera: 403 en lectura y escritura fuera del alcance, 403 en los paneles de admin y directivo, 403 al crear materias, no poder tocar un alumno ajeno, y que el rol no sea auto-asignable. Más los caminos felices: alta con matrícula, edición, baja, sacar del curso y mover.

⚠️ **Trampa al escribir estos specs**: para probar el 409 de "mover con entregas" el destino tiene que estar **dentro** del alcance del preceptor, si no la ruta corta antes con 403 y la guarda de entregas nunca se evalúa. Por eso el smoke crea tres divisiones: una con el curso, una asignada como destino válido, y una NO asignada para probar el fuera-de-alcance.

### Arreglo colateral en `tests/smoke/lib.js`
El spec `backup-download-produces-valid-tarball` fallaba con "archivo demasiado chico (null bytes)" aunque la descarga funcionara perfecto (258 MB, headers correctos). Causa: el cliente hacía `arrayBuffer()` sobre la respuesta binaria, cargando los 258 MB **enteros en memoria**; en una máquina con poca RAM libre eso falla, el `catch {}` se lo come y `byteLength` queda en `null`. Ahora se usa `Content-Length` cuando está declarado y se cancela el stream, sin bufferear. **130/130.**

---

## DNI obligatorio y fin de la matriculación por código (2026-07-30)

### DNI obligatorio en toda alta y edición
Validación centralizada en `services/dni.js` (`normalizeDni`), aplicada en las **6 rutas** que crean o editan usuarios: `POST /admin/users/create`, `POST /superadmin/users/create`, `POST /preceptor/divisions/:id/students`, `POST /preceptor/students/:id/edit`, `POST /register` y `POST /register/invite/:token`.

**Por qué NO es `required: true` en el schema**: al momento del cambio había **118 cuentas sin DNI** (109 alumnos, 8 docentes, el superadmin). Marcarlo requerido en el modelo haría fallar *cualquier* `.save()` sobre ellas — incluso operaciones que no tocan el DNI, como deshabilitar la cuenta o cambiar la contraseña. Validando en las rutas, esas cuentas siguen operativas y el dato se exige recién cuando alguien las edita. Si algún día se quiere apretar la tuerca, primero hay que completar esas 118.

**Normalización**: se guarda solo dígitos (`40.123.456` → `40123456`), que es como lo indexa `{school, dni}` y como lo busca `/register/lookup`. Se aceptan 7 a 9 dígitos.

El alta por invitación además chequea el DNI duplicado **antes** de insertar, para devolver un mensaje que hable del documento en vez del 11000 crudo, que hablaría del correo aunque el choque real sea otro.

### Matriculación por código: ELIMINADA
Estuvo apagada por el flag `JOIN_BY_CODE_ENABLED` desde el 2026-07-29; ahora se quitó del todo. Se eliminaron: la ruta `POST /courses/join`, el flag y su `res.locals.joinByCodeEnabled`, el modal "Unirse a clase", `showJoinModal`/`hideJoinModal`/`copyCode` en `public/js/dashboard.js`, y la visualización del código en **8 vistas** (`course.ejs` ×2, `dashboard.ejs`, `admin/courses.ejs`, `admin/subject-detail.ejs`, `admin/user-profile.ejs`, `profile.ejs`, `superadmin/school-profile.ejs`). También salió de la metadata de auditoría de `course.create`.

**El campo `Course.code` sigue en el modelo** (se autogenera, con su índice único) pero ya no se usa ni se muestra. Dejarlo es reversible y no requiere migración sobre las 419 materias; borrarlo sería irreversible y no aporta nada.

Los alumnos se matriculan ahora solo por vías administrativas, que dejan registro de quién los inscribió: el alta con Curso desde `/admin/users/create` o desde preceptoría (ambas vía `services/enrollment.js`), y `POST /courses/:id/add-student` para una materia suelta. El botón "Enviar solicitud para unirme" sigue: manda una sugerencia al superadmin, no matricula.

### Efecto lateral: la suite de smoke quedó en verde
Los 9 specs que fallaban desde el 2026-07-29 dependían de que el alumno se inscribiera por código. El spec `course-join` se reemplazó por `course-add-student` (el docente lo matricula) más `course-join-route-is-gone` (verifica el 404). **126/126 pasan.**

Dos detalles que aparecieron al arreglarlos, útiles como advertencia:
- Varios specs usaban DNIs con letras (`p1-${RUN_ID}`, y `RUN_ID` es base36): `normalizeDni` descarta lo que no sea dígito, así que quedaban vacíos. Ahora hay un helper `dniSmoke(n)` que genera DNIs numéricos únicos por corrida.
- `preceptor-cannot-touch-student-outside-scope` **pasaba por accidente**: usaba al alumno del smoke, que nunca llegaba a inscribirse porque el `join` fallaba. Al arreglar la matrícula, ese alumno quedó legítimamente dentro del alcance del preceptor y el spec empezó a fallar — correctamente. Ahora usa un alumno sin ninguna matrícula, que es el caso que de verdad hay que probar.

---

## Solapa "Otros" — Sanar la base de datos (2026-07-30)

Panel en `/superadmin/otros`: tarjetas con problemas de integridad detectados, cada una con su conteo, la vista previa de a quiénes afecta y —cuando corresponde— un botón que aplica el arreglo.

**Acceso**: misma doble capa que Backup (rol superadmin **+** `SYSTEM_OWNER_EMAIL`). Estos arreglos escriben en masa y no se deshacen; el chequeo de rol solo no alcanza si mañana hay otro superadmin.

### La regla de oro de `services/dbFixes.js`
Un arreglo solo es `aplicable: true` si existe **una respuesta correcta derivable de los datos**. Si hace falta criterio humano, se queda en diagnóstico y deriva al panel que corresponda. **Inventar el dato es peor que no arreglarlo.** Por eso 3 de los 7 son solo diagnóstico:

| Arreglo | Aplicable | Por qué |
|---|---|---|
| Matrícula parcial | ✅ | Regla inequívoca: si estás en una materia del curso, van todas |
| DNI duplicado en un curso | ✅ *(parcial)* | Se conserva la cuenta con entregas o notas y se saca la vacía. Si las dos tienen trabajo, ese caso queda para revisar a mano |
| Cuentas sin escuela | ✅ | Hay una sola escuela; el campo no depende de nada más |
| Preceptores sin cursos | ✅ | "Todos los cursos" es una acción concreta y reversible |
| Alumnos en varios cursos | ❌ | Nada dice cuál de los dos cursos es el correcto; desmatricular del equivocado borraría entregas |
| Cuentas sin DNI | ❌ | El DNI no se deduce de ningún campo. Se probó extraerlo del email: los únicos con dígitos son **fechas de nacimiento**, no documentos |
| Alumnos sin ninguna materia | ❌ | Matricular exige saber a qué curso va cada uno, y no tienen división ni DNI que cruzar |

### El arreglo principal: matrícula parcial
Alumnos que figuran en 1 o 2 materias de su curso en vez de en todas (quedaron así de las altas viejas), así que no ven la mayoría de sus tareas. En la base había **50 alumnos y 438 inscripciones faltantes en 162 materias**.

Garantías, verificadas aplicando de verdad y comparando contra un snapshot: **0 inscripciones perdidas, 0 duplicados**. Las materias donde el alumno ya figura no se tocan — conserva sus entregas y sus notas. Usa `$addToSet` (idempotente si se corre dos veces) y escribe `enrollmentDates = ahora` en cada inscripción nueva, para que las tareas ya vencidas no le aparezcan como pendientes.

**Exclusión clave**: deja afuera a los alumnos que figuran en más de una división. Son 50, y hay casos de uno en **5 cursos distintos** (`1° 6° + 3° 1° + 3° 3° + 3° 4° + 5° 3°`) — completarlos habría multiplicado el problema en vez de arreglarlo. Van al diagnóstico `alumnos-en-varios-cursos` para resolverse a mano; una vez que quedan en un solo curso, el arreglo automático los completa.

### Notas de implementación
- `calcularMatriculaParcial()` se comparte entre `diagnosticar()` y `aplicar()`: recorrer las 419 materias dos veces por request sería tirar trabajo.
- Después de aplicar se llama a `invalidateAll()`: varios arreglos tocan documentos de `User` que viven cacheados 45 s por worker.
- Cada aplicación registra `system.db_fix` en auditoría con el arreglo, cuántos se detectaron, cuántos se afectaron y los parámetros usados.
- Un arreglo que falla al diagnosticar no tumba la pantalla: su tarjeta muestra el error y el resto sigue funcionando.

---

## Rediseño responsive unificado (2026-07-30)

**Pedido**: desfasajes de ancho en todos los roles, letras que no se achican, solapas interminables en el celular, mucho espacio vacío al scrollear. Y: "cuando sea posible ocultar varios menúes en algún botón".

### La causa raíz era una sola
`.admin-nav` es un flex **sin wrap ni scroll y sin ningún media query**. Con 11 solapas medía **1356 px** y, al no poder envolver, estiraba el `<body>` entero a **1372 px en un viewport de 375**. Ese único elemento producía el scroll horizontal y el "desfasaje de ancho" en *todas* las páginas de panel — no era un problema por vista.

Medido antes del arreglo: `/superadmin` body 1372 px · `/admin/users` 1132 px · `/directivo/courses` 804 px.

### Solución
**`public/js/nav-responsive.js`** — bajo 900 px las solapas colapsan en un botón que muestra la sección actual y despliega el resto en un panel. Es genérico sobre `.admin-nav`, la clase que comparten los cuatro partials de navegación, así que no hubo que tocar ninguna vista ni mantener cuatro variantes. Se carga desde `partials/footer.ejs`, el único partial que incluyen todas las vistas.

⚠️ **Degradación deliberada**: el CSS que oculta el nav exige el atributo `[data-responsive-listo]`, que pone el JS *después* de inyectar el botón. Si el script falla o queda cacheado viejo, el nav **no se oculta** y sigue siendo navegable (en fila, con scroll propio). Sin esa guarda, un error de JS dejaría al usuario sin ninguna forma de cambiar de sección.

### Resto del trabajo (sección "RESPONSIVE UNIFICADO" al final de `style.css`)
- **Contención de ancho**: `overflow-x: hidden` en `html, body` como red de seguridad, para que un elemento ancho nuevo no reintroduzca el problema sin que nadie lo note.
- **`.users-table-card` tenía `overflow: hidden`** para recortar al radio de la tarjeta, pero eso **recortaba la tabla**: en `/admin/users` medía 1050 px y las columnas de la derecha eran inaccesibles, sin scroll posible. Ahora `overflow-x: auto` (conserva el radio y devuelve el scroll).
- **Tipografía fluida** con `clamp()` en vez de saltos por breakpoint, para que no haya escalón justo en el límite del media query.
- **Densidad**: `.card-banner` bajó de `min-height:140px` a 92 px, y las grillas pasan a **dos columnas desde 360 px** (antes una sola hasta 768). En `/preceptor` con 39 cursos la página pasó de **8356 px a 3871 px (−54 %)**.
- Filtros apilados, paginación con wrap, tablas compactas, barra de suplantación que ya no tapa el encabezado.

### Verificación
**24 rutas medidas a 375 px en los cuatro roles: cero desbordes.** Escritorio (1265 px) sin cambios: solapas en fila, h2 a 28 px, contenido a 1100 px. Suite en **130/130**.

| Vista | Antes | Después |
|---|---|---|
| `/superadmin` | body 1372 px | 375 px |
| `/admin/users` | body 1132 px, tabla recortada | 375 px, tabla con scroll propio |
| `/directivo/courses` | body 804 px | 375 px |
| `/preceptor` | 8356 px de alto, 1 columna | 3871 px, 2 columnas |

---

## Arreglo nuevo: dos alumnos con el mismo DNI en un curso (2026-07-31)

Séptima tarjeta de `/superadmin/otros` (`dni-duplicado-en-curso`, severidad alta). Detecta la misma persona cargada dos veces —alta manual + importación, o registro público sobre una cuenta que ya existía—: el docente la ve repetida en la lista y en el gradebook, y las entregas quedan repartidas entre las dos cuentas.

### Por qué el índice único no lo evita
`models/User.js` ya tiene `{ school: 1, dni: 1 }` único, pero compara el **string crudo**. `"40.123.456"`, `"40123456"` y `"040123456"` conviven sin que Mongo se queje, y son la misma persona. El arreglo compara con `normalizarDni()` — solo dígitos, sin ceros a la izquierda. También cubre los duplicados anteriores a que existiera el índice.

### "Curso" = División, no materia
La búsqueda es por División (1°1°, 2°3°…), no por `Course`: una misma persona puede estar con una cuenta en Matemática y con la otra en Historia del mismo curso, y por materia eso no se ve. Coherente con `alumnos-en-varios-cursos`, que también razona por división.

### Cómo elige cuál conservar
Mide el **trabajo hecho por cuenta dentro de ese curso** en las dos fuentes donde vive, porque puede haber una sin la otra: `Submission` (entregó) y `Activity.grades[]` (el docente calificó en papel y lo cargó).

- **Una sola cuenta con trabajo** → esa se conserva; las otras están vacías en ese curso y se sacan.
- **Ninguna con trabajo** → ninguna tiene nada que perder. Se conserva la que más "vive": habilitada > en más materias > conexión más reciente > más antigua.
- **Dos o más con trabajo** → **ambiguo, no se toca**. Aparece como "revisar a mano": cuál es la buena y qué se hace con el trabajo de la otra lo decide una persona. `aplicar()` los saltea y el conteo posterior los deja visibles.

### Qué escribe exactamente
`$pull` del `students[]` y `$unset` de `enrollmentDates.<id>`, **solo en las materias de ese curso donde la cuenta duplicada figura**. No borra cuentas, no borra entregas ni notas, no toca nada fuera de ese curso. Dar de baja la cuenta sobrante, si corresponde, es una decisión aparte desde el panel de administración. Como `$pull` saca todas las apariciones, de paso limpia el caso del mismo alumno cargado dos veces en el array de una misma materia.

### Verificación
Base descartable con los tres escenarios (duplicado con formato distinto donde la que entregó no es la del nombre "real", duplicado sin trabajo con una cuenta deshabilitada, y duplicado con entrega de un lado y nota del otro): detecta 3, aplica 2, deja 1 para revisión manual, no pierde ninguna entrega y no borra ninguna cuenta. Controles que **no** debe marcar: alumno sin duplicado, y dos alumnos sin DNI en el mismo curso (sin DNI no hay con qué comparar — eso es `usuarios-sin-dni`).

En el espejo local: **0 casos**, diagnóstico en 95 ms. El panel completo con las 7 tarjetas carga en 208 ms.

---

## El alumno elige su curso una sola vez (2026-07-31) — TEMPORAL

**Pedido**: que el alumno pueda elegir su curso y automatricularse, tanto al registrarse como desde su panel si ya tiene cuenta y no está en ninguna materia. Explícitamente temporal, pero disponible.

⚠️ **Va contra la decisión del 2026-07-30**, a sabiendas: ese día se eliminó "unirse por código" para que matricular fuera siempre una acción administrativa, y al alumno le quedó la vía de "enviar solicitud". Esto reabre la puerta. Por eso vive concentrado en `services/selfEnroll.js`:

- **Apagarla**: `AUTOMATRICULA_ACTIVA = false`. Las dos pantallas dejan de ofrecer el curso y las dos rutas rechazan el pedido. Nada más que tocar.
- **Borrarla**: eliminar ese archivo y sus usos en `routes/auth.js`, `routes/courses.js`, `views/register.ejs`, `views/dashboard.ejs` y `public/js/register.js` (listados en la cabecera del propio archivo).

### Las dos puertas
| Dónde | Quién | Qué pasa |
|---|---|---|
| `/register` | El que se registra como **Alumno** | El `<select>` de Curso se despliega al elegir el rol Alumno y es **obligatorio** |
| `/courses` (su panel) | Alumno **sin ninguna materia** | Bloque "Elegí tu curso" en el estado vacío, con confirmación antes de escribir |

En las dos, elegir el curso lo inscribe en **todas** las materias de ese curso, por el mismo `enrollStudentInDivisionCourses()` que usan el alta del admin y la de preceptoría — incluido el `enrollmentDates` que evita que le aparezcan como pendientes las tareas ya vencidas.

### "Una sola vez" es estado, no un flag
`POST /courses/self-enroll` solo acepta al alumno que **hoy no está en ninguna materia**. Una vez matriculado, el mismo pedido devuelve 409 y el bloque desaparece del panel. No hay un campo `yaEligió` que alguien pueda olvidarse de escribir, y es también lo que impide que se sume cursos de a uno hasta quedar en varios.

Lo demás que no puede hacer aunque manipule el request: cambiarse de escuela (si su cuenta ya tiene una, solo ve cursos de esa), elegir un curso sin materias (lo dejaría igual de huérfano), o auto-asignarse otro rol.

### Efectos colaterales buscados
- **El curso define la escuela.** `POST /register` creaba las cuentas con `school: null` — ése es el origen de las 127 cuentas del arreglo `usuarios-sin-escuela`. Ahora el alumno que elige curso nace con escuela. A los que ya existían, elegir curso se las asigna.
- **Chequeo de DNI duplicado en el registro.** Conocida la escuela, se puede chequear `{school, dni}` antes de crear y devolver un 409 claro en vez del 11000 que hablaba del correo. Es la puerta por donde se colaban los duplicados que detecta `dni-duplicado-en-curso`.
- **`alumnos-sin-matricular` se vacía solo.** El arreglo sigue siendo solo diagnóstico —el dato que falta lo tiene el alumno, no un botón del superadmin— pero ahora la nota separa a los que nunca se conectaron, que son los únicos que siguen necesitando alta manual. En el espejo local los 60 se conectaron alguna vez: todos pueden resolverse solos.

### Verificación
**137/137 en la suite de smoke** (eran 130), con 6 specs nuevos o reescritos:

| Spec | Qué prueba |
|---|---|
| `register-student` | Saca el id del curso **del propio formulario**: si el `<select>` deja de pintarse, falla acá |
| `register-student-requires-curso` | Alumno sin curso → 400 (no vuelven a nacer cuentas huérfanas) |
| `self-enroll-only-once` | El ya matriculado que insiste → 409 |
| `self-enroll-setup-student-without-course` | Alta por admin sin curso: el caso de los alumnos que ya existían |
| `self-enroll-panel-offers-curso` / `…-picks-course` | El selector aparece, matricula, y **desaparece** después |
| `self-enroll-rejects-non-student` | Un docente que llama a la ruta → 403 |

Se agregó además la limpieza `cleanup-self-registered-db`: los usuarios de Nivel 1 ahora quedan inscriptos en materias reales de la base local, así que hay que sacarlos de ahí además de borrar la cuenta.

---

## Columna "Curso" en el listado de usuarios del admin (2026-07-31)

`/admin/users`, entre **Rol** y **Nov·Act·Msg**. Solo se llena para alumnos: los demás roles no se matriculan (el preceptor tiene cursos *a cargo*, que es otra cosa y se ve en su perfil), así que la celda queda **vacía** en vez de mostrar un guion que se leería como "está sin curso". El alumno sin matricular sí muestra `—`.

**Es un array, no un string**: un alumno mal cargado puede figurar en materias de dos cursos distintos (el diagnóstico `alumnos-en-varios-cursos` de `/superadmin/otros`) y se muestran los dos separados por `+`. Elegir uno al azar escondería el problema justo en la pantalla donde se arregla.

Sin queries nuevas: la consulta que ya armaba el badge "(Sin Matricular)" ahora trae también `division` y se popula el nombre. De paso se acotó a los alumnos **de la página**: `course.students` trae todos los de la materia, así que se estaban construyendo entradas de gente que no se muestra.

Cubierto por el spec `admin-users-curso-column` (la columna existe, el alumno matriculado muestra su curso, y la fila del docente no muestra ninguno). **138/138 en el smoke.**

---

## Vuelve el código de clase, acotado (2026-07-31)

`POST /courses/join` volvió a existir. Historia completa, porque la ruta fue y vino tres veces: existía → se apagó por flag el 29/07 → se eliminó del todo el 30/07 (matricular tenía que ser siempre administrativo) → vuelve el 31/07 a pedido del usuario. Todo vive en `services/joinByCode.js`, apagable con `JOIN_BY_CODE_ACTIVO = false`.

**Nunca hubo que regenerar nada**: `Course.code` siguió en el modelo todo este tiempo y las 419 materias ya tenían el suyo. Lo que se había eliminado era la puerta, no el dato.

### La regla que lo hace seguro: solo materias del propio curso
El código funciona únicamente si la materia pertenece a una División donde el alumno **ya** está matriculado. Sin eso, un código reenviado por WhatsApp lo mete en materias de otro año — exactamente el desorden que diagnostica `alumnos-en-varios-cursos` en `/superadmin/otros`.

Caso de uso real: el docente crea una materia nueva en el curso y dicta el código en clase, en vez de pedirle al admin que matricule a los 30 uno por uno.

Corolario deliberado: un alumno **sin ninguna materia no puede usar el código**, porque no hay curso contra el cual validar. Ese es el caso de la automatrícula: primero elige curso, después suma materias sueltas de ese curso. Las dos funciones se complementan en vez de pisarse.

### Detalles que no son obvios
- **Mismo mensaje para "no existe" y "es de otra escuela"**. Responder distinto convertiría el endpoint en un oráculo para adivinar códigos ajenos a fuerza de probar.
- **El código se normaliza a mayúsculas y sin espacios**, porque se lo dictan en voz alta. Lo que NO se corrige es el 0/O: cambiaría el código por otro que podría existir.
- **Solo lo ve el docente**, en el encabezado de su materia, con botón de copiar. Al alumno no: ya está en la materia y verlo solo le daría algo para reenviar.
- El botón de copiar tiene camino alternativo con `execCommand`: `navigator.clipboard` no existe fuera de contextos seguros, y por la IP de Tailscale en http quedaría inerte.
- Se inscribe con `enrollmentDates = ahora`, así que no le aparecen como pendientes las tareas ya vencidas.

### Verificación — 142/142
Cuatro specs nuevos que reemplazan a `course-join-route-is-gone` (el que verificaba el 404 de cuando la ruta no existía): se une con el código en minúsculas y con espacios, repetirlo avisa que ya está, el código de otro curso se rechaza, uno inexistente se rechaza, y un docente recibe 403. Más las tres comprobaciones de UI: el docente ve el código, el alumno no, y el alumno tiene el botón en su panel.

⚠️ **Trampa que costó 6 specs rotos**: crear la materia de prueba y dejarla viva rompía a `enrolldiv-*` y `dni-existing-completes-missing-course`, que cuentan las materias de la división del smoke y esperan **una sola**. Los specs del código de clase borran lo que crean *dentro del propio spec*, no en la limpieza del final. Cualquier spec nuevo que agregue materias a `state.divisionId` tiene que hacer lo mismo.

---

## El admin no podía entrar a la solapa Materias (2026-08-03)

**Síntoma**: en producción, `/admin/courses` respondía **500** para el rol administrador. El resto del panel (`/admin`, `/admin/users`, `/admin/divisions`, `/admin/subjects`, `/admin/audit`, `/admin/theme`) andaba bien. En el mirror local no se reproducía.

**Causa**: dos materias "Ciencias Naturales" (Cursos 2° 1° y 2° 9°) tenían `Course.owner` apuntando a un usuario **que ya no existe** — el docente fue eliminado desde el panel y `POST /admin/users/:id/delete` no hacía ninguna verificación ni limpieza. Con la referencia colgada, `populate('owner')` devuelve `null` y la vista hacía `c.owner._id` → TypeError → 500 de la página entera. Un solo registro roto tiraba abajo el listado completo de 419 materias.

Diagnóstico: se acotó con el filtro por división (dos divisiones fallaban) y después con `?search=` letra por letra hasta aislar el nombre. Ni hizo falta entrar al servidor.

**El bug más grave estaba en el modelo**: `idToString()` en `models/Course.js` hacía `val.toString()` sin chequear null, así que `isTeacher()` — y con él `canManage()` — reventaba para cualquier materia con el owner colgado. Eso no es solo el listado del admin: es **toda** ruta que valide permisos sobre esa materia (abrir el curso, actividades, novedades, gradebook). Las dos materias eran inaccesibles para todo el mundo, no solo para el admin.

### Qué se cambió
- `models/Course.js` — `idToString()` tolera `null`/`undefined` y devuelve `''` (nunca coincide con un id real, así que no concede permisos por accidente).
- `views/admin/courses.ejs` — muestra **"Sin docente"** en rojo cuando falta el titular, y el botón de asignar sigue funcionando (con el select preseleccionado en el primero de la lista). Es el camino para reparar los datos desde la propia UI, sin script.
- Mismo criterio defensivo en `views/admin/subject-detail.ejs`, `views/admin/user-profile.ejs`, `views/course.ejs` (encabezado + solapa Personas), `views/dashboard.ejs` y `views/profile.ejs`. Las vistas de directivo ya lo hacían bien — de ahí se copió el "Sin docente".
- `routes/courses.js` — `featuredTeacher` y el set de docentes ya tomados aguantan `owner` nulo.
- `routes/admin.js` — `POST /users/:id/delete` ahora **rechaza con 409** si el usuario es titular de materias ("es docente titular de N materia(s)…"), igual que ya hacía el borrado de divisiones. Y cuando el borrado sí procede, hace `$pull` del usuario en `coTeachers` y `students` de todas las materias: esos son arrays, así que una referencia colgada no rompe el `populate` pero deja suplentes fantasma e infla el contador de alumnos.

### Detalle que no es obvio
Con arrays (`students`, `coTeachers`) Mongoose descarta silenciosamente las referencias que no resuelven, así que nunca explotan — se pudren de a poco (contadores inflados). Con una referencia **suelta** (`owner`, `division`) devuelve `null` y explota en la primera propiedad que se lea. Por eso el único campo que tiraba 500 era `owner`.

### Pendiente de datos en producción
Las dos materias siguen sin titular hasta que se les asigne uno desde `/admin/courses` (botón del lápiz junto a "Sin docente"). No hace falta tocar la base: el borrado del docente ya ocurrió y no se puede deshacer. Ojo: en producción hay un usuario "ARCAJO" con id distinto — probablemente la cuenta recreada después del borrado.

---

## Fusionar docentes duplicados por DNI — solapa Otros (2026-08-03)

Cuarta tarjeta con arreglo del panel `/superadmin/otros`: **"Dos docentes con el mismo DNI"**. En la base real hay 4 casos, todos con la misma forma — la cuenta vieja con el mail personal se quedó con las materias y la institucional (`@escuelasanjose.edu.ar`), creada después, está vacía. El docente entra por la que le dieron y no ve nada.

### Por qué no es un botón más
El resto de este panel se rige por la REGLA DE ORO de `services/dbFixes.js`: un arreglo solo es automático si existe UNA respuesta derivable de los datos. Cuál de las dos cuentas se conserva **no lo es** — la escuela puede querer quedarse con el mail institucional justamente aunque esté vacío. Antes eso condenaba al caso a ser "solo diagnóstico".

Acá se abrió una tercera categoría, `interactivo: true`: la tarjeta trae la decisión adentro. Un bloque por duplicado, las dos cuentas con sus números (materias como titular y como suplente, actividades, novedades, último acceso), un radio para elegir y un botón propio por grupo. La cuenta con más trabajo encima viene preseleccionada como **sugerida**, pero es solo eso.

### Qué mueve la fusión
Todo lo que cuelga de la cuenta sobrante pasa a la elegida: `Course.owner`, `Course.coTeachers`, `Activity.author`, `Announcement.author` y el `author` de los comentarios. Las matrículas sueltas (un docente dentro de `students[]` por cargas viejas) se quitan en vez de transferirse.

**El orden es el punto**: primero se transfiere, la cuenta sobrante se toca al final. Si algo falla en el medio queda una transferencia parcial con las dos cuentas vivas — nunca una cuenta borrada con materias apuntando a ella, que es exactamente el bug de referencias colgadas que tiraba 500 el panel de materias (ver el changelog anterior).

### Con qué correo queda la cuenta conservada
Son **dos decisiones distintas**, y a propósito: qué cuenta se conserva y con qué correo queda. El caso más común de todos es quedarse con la cuenta que **ya tiene las materias** —así no se mueve nada— pero con el correo institucional, que hoy está en la otra. Un segundo select por grupo lista los correos de las cuentas del duplicado; por defecto sigue a la cuenta elegida y deja de moverse en cuanto se lo toca a mano.

`User.email` es único global, así que el correo elegido tiene que estar **libre** antes de asignarlo. De ahí que ese paso vaya último de todos:
- Si la cuenta sobrante se **elimina**, el correo queda libre y se asigna directo.
- Si queda **deshabilitada**, los correos se **intercambian**: la conservada toma el institucional y la deshabilitada se queda con el personal. Nadie pierde un correo válido, no se inventa ninguno y se revierte haciendo el camino inverso.

El intercambio pasa por un correo temporal (`fusion-en-curso-<id>@invalido.local`) porque el índice único no admite el mismo valor en las dos ni por un instante. Si el proceso se cortara justo ahí, la cuenta **deshabilitada** queda con ese temporal —se ve a simple vista y se corrige desde el panel— y la conservada nunca queda sin correo.

Ojo con lo que NO cambia: el **nombre** es el de la cuenta que se conserva. Si te quedás con la institucional (`Diego cornejo`) y preferís el nombre bien cargado (`CORNEJO, DIEGO ALEJANDRO`), eso se edita después desde `/admin`. La **contraseña** también es la de la cuenta conservada: el docente entra con el correo nuevo y la clave de siempre de esa cuenta.

### Detalles que no son obvios
- **Se agrupa por DNI normalizado dentro de la misma escuela.** El índice único `{ school, dni }` compara el string crudo, así que "12.345.678" y "12345678" conviven sin que Mongo se queje — y son la misma persona. Entre escuelas distintas no se agrupa: un docente puede trabajar en dos.
- **Si la elegida ya era suplente de una materia que recibe como titular, se la saca de suplentes**; si no, queda listada dos veces en la solapa Personas (misma regla que `POST /courses/:id/assign-teacher`).
- **La sobrante se deshabilita por defecto**, y hay opción de eliminarla. Si tiene entregas propias no se elimina aunque se pida: dejaría `Submission.student` colgado. La respuesta lo dice.
- **Las cuentas ya deshabilitadas y sin materias no cuentan como duplicado**: son el resto de una fusión anterior. Sin esa regla, el grupo quedaría reportado para siempre después de resolverlo.
- **El servicio recalcula el grupo desde la base antes de tocar nada**, así que un panel abierto en otra pestaña no puede fusionar contra un estado que ya cambió: contesta 400 y pide actualizar.
- Auditoría: acción nueva `user.merge` ("fusionó cuentas de"), con la cuenta conservada como primer target y el detalle de lo transferido en el meta. Se registra con la escuela del grupo, así que el admin la ve en su propio panel.

### Verificación — 152/152
Siete specs nuevos (`docentes-dup-*`): se arman dos cuentas con el mismo DNI (una con puntos, cargado directo en Mongo porque por la ruta de alta no entra), el panel las detecta igual, fusionar hacia una cuenta ajena al grupo se rechaza, la fusión hacia la cuenta **vacía** le transfiere la materia y deja a la otra sin poder iniciar sesión, y el grupo deja de figurar. Los dos últimos cubren el correo: un correo que no es de ninguna cuenta del grupo se rechaza, y tras el intercambio la conservada entra con el correo adoptado y su contraseña de siempre, mientras la deshabilitada se queda con el viejo y no puede entrar.

Las cuentas y la materia de prueba se borran dentro del propio bloque, por la trampa de `enrolldiv-*` documentada más arriba.

⚠️ **Trampa del entorno, no del código**: la primera corrida completa de estos specs quedó cortada porque el servicio de MongoDB **se murió con "out of memory"** a mitad (`reportOutOfMemoryErrorAndExit` en `mongod.log`) — la máquina de desarrollo se queda sin RAM con el smoke completo, ver la nota operativa del backlog. Se ve como una cascada de 302 a `/login` y `ECONNREFUSED 27017`; no hay que buscarle una causa en el código. El servicio reserva por defecto la mitad de la RAM menos 1 GB (~3 GB acá): conviene limitarlo con `storage.wiredTiger.engineConfig.cacheSizeGB: 1` en `mongod.cfg`.

---

## Acuse de lectura de actividades — "¿quién abrió la tarea?" (2026-08-03)

**Pedido**: "me gustaría que los docentes puedan ver de alguna forma si los alumnos han abierto las actividades, o sea, si la han visto".

### El problema
El docente solo podía saber **quién entregó**: el estado salía de la existencia de un `Submission`. No había forma de distinguir *"la vio y no la hizo"* de *"nunca se enteró de que existía"*, que es justo lo que decide si hay que insistirle al alumno o si el problema es de comunicación.

### Modelo nuevo: `ActivityView`
Colección aparte, no un array embebido en `Activity`. Dos razones: espeja a `Submission` (mismo par `{activity, student}`, índice único, upsert) así que el docente cruza los dos mapas con el mismo patrón; y un array dentro de `Activity` crecería un elemento por alumno y por actividad, sin techo.

Campos: `firstViewedAt` (una sola vez, `$setOnInsert`, igual que `Submission.firstSubmittedAt`), `lastViewedAt` (se pisa) y `viewCount` (`$inc`). **La ausencia de documento significa "sin abrir"**: no hizo falta ningún backfill para las actividades que ya existían.

### Dónde se registra
`POST /activities/:id/view`, que dispara `loadStudentDetail()` al abrir el modal — el único momento en que el alumno realmente ve la consigna. Va **fire-and-forget** desde el cliente (sin `await`, con `.catch()`): el detalle no debe esperar al ping ni romperse si falla.

Es POST y **no** se colgó del `GET /:id/my-submission` que ya se disparaba ahí, aunque hubiera sido más barato: un GET no debe mutar, y así el acuse queda testeable por separado.

Dos guardas en la ruta:
- **Si no es alumno, se ignora en silencio** (`{ ok: true }`, no error). El docente que entra a mirar su propia actividad no tiene que inflar el contador "N vieron", pero tampoco está haciendo nada mal.
- **Se verifica que el alumno esté en `course.students`** antes de escribir. Sin eso, cualquiera podría registrar vistas en actividades de otros cursos pingueando IDs.

No se audita: es alto volumen y bajo valor forense.

### Qué ve el docente, en tres lugares
- **Chip en la tarjeta del listado** (`viewedChip`), al lado del de entregas: `18/25`. Es el que permite detectar de un vistazo la actividad que **nadie** abrió. El contador sale de un `ActivityView.aggregate` que corre en `Promise.all` junto al de `Submission`, en `GET /activities/course/:courseId` — mismo patrón que ya usaba `submittedCount`.
- **Resumen del modal**: "· N vieron" después de calificados y entregados. Cuenta **solo alumnos que siguen inscriptos**: si uno se dio de baja, su registro sigue en la base pero no aparece en la tabla, y el resumen tiene que coincidir con lo que se ve.
- **Columna "Visto"** en la tabla de entregas, antes de "Entrega" (orden natural: vio → entregó). Con fecha de primera apertura y, si volvió, un "Últ: ..." — mismo tratamiento que el "Act:" de la entrega. Sale de un tercer fetch a `GET /activities/:id/views` sumado al `Promise.all` que ya existía; si ese fetch falla, el mapa queda vacío y la columna dice "Sin abrir" en todos, sin romper la tabla de notas.

**Detalle de color, que no es capricho**: "Visto" va en **azul** y no en verde para que no se confunda con "Entregado" leyendo la fila de reojo, y "Sin abrir" en **gris neutro, no rojo** — todavía no haber abierto no es una falta, es información.

### Solapa "Tareas" en el panel del admin
La decisión de si al alumno se le avisa que su apertura queda registrada es de la escuela, no del código. El proyecto **no tenía infraestructura de settings**, así que se creó la mínima:

- `School.settings.showViewReceiptToStudents`, default `false` — comportamiento silencioso, para no cambiarle nada a las escuelas existentes sin que el admin lo decida.
- `GET /admin/tasks` + `POST /admin/tasks/settings`. La key se valida contra la lista blanca `TASK_SETTINGS` y el valor se castea a booleano: **nunca se persiste el body crudo** (mismo criterio que `buildConfig()` en superadmin). Sin esa lista blanca, un `$set` con la key que venga del cliente escribe cualquier campo del documento.
- Auditoría: acción nueva `school.settings_update`, con qué ajuste cambió y a qué valor en el meta. Es la primera `school.*` que dispara un **admin** y no el superadmin.

⚠️ **La trampa**: `res.locals.school` va cacheado 5 min por worker y se arma con un `.select()` explícito en `server.js`. Hubo que **sumar `settings` a ese select** (si no, el campo nunca llega a las vistas) y llamar a `invalidateSchool()` al guardar (si no, el admin guarda, recarga y sigue viendo el valor viejo).

**El toggle NO apaga el registro**, y la vista lo dice con todas las letras: el docente sigue viendo quién abrió cada actividad. Lo único que cambia es si el alumno ve la línea al pie del detalle ("El docente puede ver que abriste esta actividad").

### Nav del admin en dos filas
Con "Tareas" el nav pasó de 9 a 10 solapas y `.admin-nav` es flex **sin wrap**. Se le aplicó el mismo tratamiento que ya tenía el de superadmin: `.admin-nav-2filas` + un `.admin-nav-break` fijo después de "Auditoría" — arriba la gestión de datos, abajo la configuración de la escuela. El corte no se deja librado al ancho (las solapas saltarían de fila según la pantalla y uno las busca donde las vio la última vez); debajo de 1090 px el separador se apaga y envuelven solas.

### Tres cascadas de borrado que había que tocar
Un `ActivityView` colgado no es solo basura: el chip "N vieron" cuenta documentos por actividad, así que un registro de alguien que ya no está seguiría sumando y podía mostrar **más vistos que alumnos** ("3/2"). Se cubrió por los dos lados:

- **Borrado**: `cascadeDeleteCourse()` y `DELETE /activities/:id` limpian por actividad; `POST /admin/users/:id/delete` limpia por alumno. Este último importa porque un alumno **sin entregas sí se puede borrar** (con entregas la ruta devuelve 409), y ese es justamente el caso que deja el acuse huérfano.
- **Desmatriculación**, que no borra nada: el aggregate del contador filtra por `student: { $in: course.students }`. La tabla del modal ya aplicaba el mismo criterio por otro camino (cruza contra `studentGrades`, que son los inscriptos), así que los dos números coinciden siempre.

Se encontró probando en el navegador, no en los tests: el spec `activity-view-survives-unenrolled-student` se escribió después, para fijarlo.

### Dark mode: se sacó el media query
Los badges de esta tabla usaban `@media (prefers-color-scheme: dark)`, que responde al **sistema operativo** e ignora el botón de tema de la app. `partials/header.ejs` setea `data-theme` **siempre** (default `'light'`), así que el resto de la app usa `[data-theme="dark"]` y esta tabla era la excepción.

Se vio en el navegador durante la verificación: con Windows en oscuro y la app en claro, los badges salían oscuros dentro de una tabla blanca. Los cuatro pasaron a `[data-theme="dark"]` y el media query se eliminó.

### Verificación
**160/160.** Ocho specs nuevos: el ping registra y el docente lo ve (`activity-view-ping`), reabrir incrementa `viewCount` sin crear otro registro ni mover `firstViewedAt` (`activity-view-idempotent`), el alumno no puede listar quién abrió (403), el listado del docente trae `viewedCount`, el contador ignora a un alumno desmatriculado o borrado (`activity-view-survives-unenrolled-student`), y tres del panel de admin — prender/apagar el toggle, rechazo de una key fuera de la lista blanca (400) y rechazo del docente (403). El spec del toggle deja el ajuste **apagado** al terminar para no alterar la escuela del entorno.

Además, recorrido manual completo en el navegador con un alumno descartable: aviso al alumno, chip `1/23` solo en la actividad abierta, resumen "0/23 calificados · 0/23 entregaron · 1/23 vieron", columna "Visto" con fecha y "Últ:" tras reabrir, 22 filas en "Sin abrir", cero errores de consola, sin desborde horizontal, y el nav del admin cortando 7+3.

**Sin migración**: `activityviews` es una colección nueva y `School.settings` se resuelve por default de Mongoose sin tocar los documentos existentes.

---

## El panel de admin se corría de lugar al cambiar de solapa (2026-08-03)

**Pedido**: "no me gusta que en el rol de administrador, cuando hago click en la solapa usuarios o materias, se me corre todo el listado incluyendo las solapas, pero si hago click en cualquier otra solapa, queda fijo mostrándose de manera profesional".

Eran **dos** corrimientos distintos sumados, y el grande no era el que parecía.

### 1. Dos vistas de diez tenían otro ancho (~90 px)
`views/admin/users.ejs` y `views/admin/courses.ejs` eran las únicas con `.main-content-ancho`. Medido a 1280 px: en Tema el contenedor iba a 1100 centrado (`left: 90`), en Usuarios a ancho completo (`left: 0`). Al saltar entre solapas se movían de lugar el listado, el título **y las propias solapas**.

La clase existe por una razón real —la tabla de Usuarios tiene 8 columnas y necesita ~1265 px, no entra en los 1036 px útiles de un contenedor de 1100—, así que sacarla habría dejado la tabla apretada. Se resolvió al revés: **la llevan las 10 vistas del panel**. Que dos pestañas tengan otro ancho es la causa del salto; emparejar hacia arriba mantiene la tabla cómoda y deja el nav clavado en el mismo píxel en todas.

### 2. La barra de scroll (~15 px)
Encima, las pantallas largas (Usuarios, Materias) hacen aparecer la barra vertical, el viewport se angosta 15 px y todo se corre otra vez. Se resolvió con `html { scrollbar-gutter: stable }`: el canal se reserva siempre, haya o no scroll. El costo es un canal vacío en las pantallas cortas; la alternativa es que la página salte.

### Verificación
Medido en las cuatro combinaciones (con y sin barra, larga y corta): `navLeft` 32, ancho del nav 1201 y del contenedor 1265 — **idénticos en todas**. El nav sigue cortando 7+3, la tabla de Materias usa los 1201 px y no hay scroll horizontal. 160/160 en el smoke.

### Trampa del entorno que apareció en el camino
El `.env` local tiene `NODE_ENV=production`, y con eso Express prende `view cache`: **los cambios en archivos `.ejs` no se ven hasta reiniciar el server**, aunque nodemon esté corriendo (solo vigila `js,mjs,json`). Se manifiesta como "edité la vista y el navegador sigue mostrando lo viejo" en unas páginas sí y en otras no, según cuáles se hayan renderizado antes del cambio. No es cache del navegador ni un error de tipeo.

### Pendiente relacionado
`views/superadmin/users.ejs` tiene el mismo `.main-content-ancho` suelto dentro de un panel de 11 solapas que no lo usan: el panel del superadmin arrastra exactamente el mismo salto. No se tocó porque el pedido era sobre el rol de administrador.

---

## Cargar un grupo de materias en un grupo de cursos — solapa Otros (2026-08-05)

Novena tarjeta de `/superadmin/otros`, `alta-masiva-materias`. Se elige un conjunto de cursos, se escribe una lista de materias —nombre, quién está a cargo y el aula, los mismos tres campos que el alta de a una— y se crean en todos los cursos elegidos de una sola pasada. Al armar el ciclo lectivo la misma grilla se repite en las 40 divisiones: cargarla a mano son 40 × 10 pasadas por `/admin/courses/create`.

**La materia que ya existe en ese curso no se toca.** Ni el docente, ni el aula, ni los alumnos, ni el `code` con el que los alumnos se unen. La tarjeta solo crea lo que falta, así que correrla dos veces con la misma lista no duplica nada — la segunda vez informa "ya existían" y no escribe.

### Un tipo nuevo de tarjeta: `compositor`
Las tarjetas de este panel son "un problema con un contador y un botón". Esta no: lo que hay que crear **no está en la base**, lo escribe la persona. Se agregó la marca `compositor: true` al contrato de `services/dbFixes.js`; la vista, al verla, pinta un formulario propio en vez del par contador/botón, y `diagnosticar()` devuelve `opciones` (cursos, docentes, nombres sugeridos) en vez de una lista de afectados.

No es una excepción a la REGLA DE ORO del archivo sino la otra cara: ahí donde hace falta criterio humano, acá el criterio humano **es** el input y el arreglo se limita a repetirlo sin deducir nada.

### Por qué el nombre se compara normalizado
`claveMateria()` saca tildes, baja a minúsculas y colapsa espacios antes de preguntar si la materia ya está. Comparando el string crudo, escribir "Educacion fisica" donde ya existe "Educación Física" crearía una segunda materia en el mismo curso — justo los duplicados que hubo que consolidar a mano. El nombre se guarda **tal como se escribió**; la normalización es solo para decidir si ya existe.

### Por qué matricula por omisión
Una materia nueva y vacía en un curso que ya tiene alumnos deja a **todo** el curso con matrícula parcial, o sea que crearía el problema que resuelve la primera tarjeta del mismo panel. Por eso el tilde "Inscribir a los alumnos que ya cursan" viene puesto: toma los alumnos de las materias que el curso ya tenía (`Division` no tiene lista de alumnos propia) y los inscribe con `enrollmentDates = ahora`, igual que `matricula-parcial`, para que no les figuren como pendientes las tareas ya vencidas. Un curso sin materias previas queda vacío: no hay de dónde sacarlos.

### Dos cosas que se agregaron al panel para esto
- **`POST /:id/previsualizar`** — vista previa por arreglo. El botón "Crear materias" pasa siempre por acá antes de pedir confirmación, así el número que se confirma sale del servidor y no del formulario. Es el mismo cálculo que después aplica, recalculado contra la base en las dos llamadas: una pestaña vieja no puede crear sobre un estado que ya cambió.
- **`aplicar()` puede devolver `schoolId` y `meta`** — el `schoolId` fija la escuela del evento de auditoría (el superadmin no tiene escuela propia: sin eso el evento quedaba con `school: null` y el admin de la escuela no lo veía en su panel). El `meta` es el resumen que reemplaza al body crudo, que acá son decenas de cursos por decenas de materias y no entra en un renglón de auditoría.

El `code` de cada materia se genera en el servicio contra los que ya existen y contra los de la misma tanda, en vez de dejárselo al `default` del modelo: `insertMany` no reintenta ante una colisión del índice único y en una tanda de cientos ese choque tumbaría el documento.

### Errores de carga, con su mensaje
Cursos sin elegir, lista vacía, materia sin nombre, materia sin docente, el mismo nombre dos veces en la lista, un docente que no es de la escuela, cursos de dos escuelas distintas en la misma tanda. Todos devuelven **400 con el texto tal cual** (el servicio marca el error con `status: 400`), no el 500 genérico que hacía pensar que se rompió algo.

### Cobertura
6 specs nuevos en el smoke (`alta-masiva-*`), con dos divisiones propias para no alterar los conteos de los specs de matrícula. El que más importa es `alta-masiva-no-pisa-lo-que-ya-existe`: repite la tanda con **otro docente y otra aula** y verifica contra Mongo que las materias que ya estaban conserven las originales. Baseline: **174/174**.

---

## Rol "Jefe de Sección" + Secciones (2026-08-06)

Faltaba la figura intermedia entre el directivo (ve toda la escuela) y el preceptor (ve divisiones, pero su panel es de gestión de alumnos): alguien responsable de un recorte del establecimiento que **no coincide con una división ni con una materia**, y cuyo trabajo es mirar qué están dando los docentes de ese recorte.

Dos piezas nuevas: la entidad **Sección** (`models/Section.js`, la crea el admin en `/admin/secciones`) y el rol **`jefe`**, de solo lectura, con panel propio en `/jefatura`.

> **Actualizado el 2026-08-14**: el jefe dejó de ser de solo lectura *del todo*. Sigue sin poder tocar actividades, entregas ni notas, pero ahora **configura el contenido de sus propias secciones** desde `/admin/secciones`, servido por `routes/sections.js`. Ver la entrada del 2026-08-14 en el changelog.

### ⚠️ Tres cosas se llaman "sección" y no son lo mismo
| Qué | Dónde | Significa |
|---|---|---|
| `Section` | `models/Section.js` | **Entidad de datos**: el recorte con nombre |
| `SECTIONS` | `config/sections.js` | Las **solapas** de cada panel |
| `sectionGuard` | `middleware/sections.js` | El **enforcement** de esas solapas |

Comparten la palabra y nada más. Los tres archivos lo dicen en su encabezado.

### Forma del modelo, y por qué
```js
{ name, school, divisions: [Division], courses: [Course], heads: [User] }
index({ name: 1, school: 1 }, { unique: true })   // como Division
index({ heads: 1 })                                // "mis secciones", 1ª query de cada request
```

- **`divisions` y `courses` separados, no aplanados a una lista de materias.** Guardar "1°1° entero" como las 13 materias que hoy tiene congelaría la sección: una materia creada mañana —o cargada con el alta masiva de `/superadmin/otros`— no entraría nunca. Guardando la división, el alcance se resuelve **en cada request**. Misma semántica que `allDivisions:true` del preceptor. Hay un smoke dedicado a esto (`jefatura-materia-nueva-entra-sola`).
- **`heads` en la Sección, no `assignedSections` en User.** Además de ser lo que se pidió (se administra desde la pantalla de la sección), **no toca el schema de `User`**: cero migración, cero backfill. Y tiene una consecuencia útil: los jefes **no** quedan pegados al doc de usuario, que vive cacheado 45 s, así que agregar o sacar un jefe se ve en el request siguiente. Lo único que sigue tardando hasta 45 s es el cambio de **rol**. Por eso `POST /admin/secciones/:id/edit` **no** llama `invalidateUser` — y no es un olvido.

### Alcance: fail-closed, resuelto a materias
`middleware/jefatura.js` es el espejo de `middleware/preceptor.js`, con la diferencia de que resuelve a **materias** (`req.scopeCourseIds`), que es el grano contra el que cuelgan las actividades. Dos queries por request, las dos indexadas.

Sin secciones **no ve nada**. El rol se puede asignar por caminos que no preguntan por secciones (cambio individual o en lote desde `/admin` y `/superadmin`), así que el estado por omisión tiene que ser "no ve nada" — si "vacío" significara "toda la escuela", esos caminos entregarían el establecimiento entero. Es el spec más importante del bloque (`jefatura-sin-seccion-no-ve-nada`).

Tres barreras, una por tipo de `:id`: `materiaEnScope`, `actividadEnScope` (por su materia) y `docenteEnScope` (dicta alguna materia del alcance, como titular **o** suplente).

### Se cuenta por `author`, no por `owner`
El pedido fue ver "las actividades que **hagan** los docentes": importa quién hizo el trabajo, no quién figura como titular, así que un suplente que sostiene la materia aparece con su producción y no en cero. Es una **divergencia consciente** con `routes/directivo.js`, que en sus columnas de conteo atribuye la materia al `owner` (ver el comentario de `directivo.js:644`). Está anotada en el encabezado de `routes/jefatura.js`.

### Las cuatro pantallas
| Ruta | Qué |
|---|---|
| `GET /jefatura` | Listado de actividades. **Todos los filtros se expresan en Mongo** y se pagina con `skip`/`limit` — a diferencia del directivo, que trae todo a memoria. El conteo de entregas se hace solo sobre las 25 de la página |
| `GET /jefatura/actividades/:id` | Entregas: la **nómina completa**, no solo quienes entregaron — para un jefe el dato es quién NO entregó. Quien se incorporó después del vencimiento sale como "No le correspondía" y no como falta |
| `GET /jefatura/docentes` | Docentes de la sección, por defecto los que más vencidas sin calificar tienen |
| `GET /jefatura/docentes/:id` | Ficha acotada al alcance + serie de 6 meses |

`services/serieMensual.js` salió de `routes/directivo.js` para que los dos paneles no muestren meses distintos del mismo docente. Mismo criterio con el que nació `services/divisionDetail.js`.

### El selector de contenido
40 divisiones × ~11 materias = **456 materias**: una lista plana de checkboxes es inusable. Es un **acordeón por división** con buscador y contador vivo al pie ("1 curso completo + 2 materias sueltas → 15 materias"). Tildar el curso entero **atenúa y deshabilita** sus materias sueltas, y esas materias **no se mandan** en el POST: guardarlas sería redundante hoy y quedarían pegadas si mañana se destilda el curso.

### Privacidad — decisión explícita del usuario (2026-08-05)
El jefe ve **entregas y notas de alumnos**, que son menores. Se planteó el reparo y se confirmó el pedido. Queda acotado por diseño: solo desde una actividad de una materia de sus secciones, **sin** buscador de alumnos, **sin** ficha de alumno y **sin** datos de contacto. Si algún día se agrega una pantalla de alumnos a este panel, esto hay que volver a discutirlo.

### Bug preexistente que encontró el smoke
`jefatura-no-entra-a-otros-paneles` falló en la primera corrida: el jefe **podía crear materias** por `POST /courses/create`, quedando como `owner` y ganando por `isTeacher()` permiso para calificar. Es el agujero que ya estaba en el backlog ("no valida el rol del llamante"). Se lo bloqueó igual que al preceptor. **El agujero general sigue abierto**: convertirlo en lista blanca exige decidir antes si directivo y SOE conservan la posibilidad, que hoy la UI les ofrece.

### Alcance del cambio
El rol nuevo tocó **más de 20 archivos** solo para registrarse: 6 `<select>` de rol, 5 bloques de `superadmin/school-profile.ejs`, los colores de avatar en 2 vistas, el monitor, el importador y los mapas de nombres. La matriz de `/superadmin/roles` **sí** es data-driven (sale de `User.getRoles()` + `SECTIONS`), así que esa se armó sola.

**13 specs nuevos** (`jefatura-*`). Baseline: **187/187**. No hubo cambios de base: la colección `sections` nace vacía y no hay campo nuevo en `User`.

---

## Matriculación del docente a una materia — las 5 vías (2026-08-07)

Reporte del usuario: *"arreglá la matriculación de un docente a una materia, por todos los métodos existentes, algunos no funcionan"*. Se auditaron y probaron **todas** las vías de escritura sobre `Course.owner` / `Course.coTeachers`. Tres estaban rotas y una faltaba.

### Un solo validador para las cuatro vías que ya existían
`resolveCourseTeacher(teacherId, schoolId)` en `routes/admin.js` es ahora el punto de verdad de crear la materia, editarla, cambiar el titular y agregar un suplente. Antes **cada una validaba distinto**:

| Ruta | Validaba antes |
|---|---|
| `POST /admin/courses/create` | escuela |
| `POST /admin/courses/:id/assign-teacher` | escuela |
| `POST /admin/courses/:id/co-teachers` | escuela |
| `POST /admin/courses/:id/edit` | **nada más que la existencia del id** |

Ese último era el bug de fondo: `User.findOne({ _id: teacherId })` aceptaba como titular a **un alumno, un preceptor o un docente de otra escuela**. La materia quedaba en manos de alguien que ni siquiera podía abrirla y en el listado figuraba con docente asignado — el problema no se veía hasta que el docente real reclamaba. Ahora se valida rol `teacher`, misma escuela y cuenta habilitada, con mensajes que dicen qué pasó (*"X tiene el rol Alumno: solo un Docente puede estar a cargo de una materia"*).

Los `<select>` de docente de `/admin/courses`, `/admin/courses/create` y `/admin/courses/:id/edit` ahora filtran `active: { $ne: false }`, igual que ya hacía la solapa Personas: listar deshabilitados solo servía para que el admin eligiera y se comiera un error del validador.

### El editar duplicaba al docente
`POST /courses/:id/edit` no sacaba al nuevo titular de `coTeachers`. Promover a titular a alguien que ya era suplente lo dejaba **listado dos veces** (TITULAR y SUPLENTE) en la solapa Personas y en el propio formulario. `/assign-teacher` sí lo contemplaba desde siempre; se copió esa lógica.

### La vía que faltaba: matricular desde el perfil del docente
Al **preceptor** se le asignan sus cursos desde su perfil (`POST /admin/users/:id/divisions`, bloque "Cursos a cargo"). Al **docente** no había nada equivalente: había que entrar materia por materia. Con 457 materias, cargarle el horario a alguien que dicta ocho era impracticable — que es lo que el usuario estaba sufriendo.

Nueva ruta **`POST /admin/users/:id/courses`** + bloque **"Materias que dicta"** en `views/admin/user-profile.ejs`, espejo del bloque del preceptor: acordeón agrupado por división (41 grupos), buscador, contador vivo y "Destildar todas".

Dos decisiones que el código documenta:
- **Siempre agrega como suplente (`coTeachers`), nunca como titular.** El titular es uno solo; pisarlo desde acá le sacaría la materia a otro docente sin avisar. Para cambiar al titular está el modal de `/admin/courses` o la solapa Personas.
- **Las materias donde ya es titular vienen tildadas y `disabled`**, con badge TITULAR. Destildarlas dejaría la materia sin docente. La guarda **no** es solo de UI: la ruta ignora las bajas sobre materias donde el usuario es `owner`, así que un POST armado a mano tampoco puede huerfanar una materia (hay spec: *un POST armado a mano no puede sacarlo de donde es TITULAR*).

De paso, el perfil ganó la sección **"Materias como suplente"**: hasta ahora `createdCourses` solo miraba `owner`, así que el perfil de un docente que **solo** era suplente se veía idéntico al de uno sin ninguna materia.

### Qué se probó
Suite propia de 44 chequeos sobre las 5 vías + las 4 pantallas que las exponen, y verificación en el navegador del bloque nuevo (457 materias en 41 grupos, buscador 457→34 al filtrar "matemática", guardado real y persistencia tras recargar). **Smoke: 216/216**, sin regresiones.

**No hay cambio de base**: `coTeachers` ya existía y ya se poblaba (consolidación de materias duplicadas). No hace falta tocar la BD de producción.

---

## Ventana de mantenimiento: esperar a que la plataforma se vacíe (2026-08-07)

Pedido del usuario: *"que me muestre cuándo puedo hacer el mantenimiento, pero si los usuarios están trabajando, que espere hasta que dejen de estarlo; solo se aplica a los que quieran entrar en ese momento"*.

Hasta ahora el modo mantenimiento era todo-o-nada: se activaba y en la request siguiente todos veían el 503, incluida la docente a mitad de una corrección. Ahora hay un **tercer estado**. Spec completa en `specs/mantenimiento-ventana.spec.md`.

| Estado | `maintenance.json` | Qué hace |
|---|---|---|
| normal | no existe | nada |
| **en espera** | `{ pending: true }` | **no echa a nadie**; corta solo los ingresos nuevos y espera a que la plataforma se vacíe |
| activo | `{ active: true }` | el 503 para todos menos el dueño (lo de siempre) |

### La pieza central es un cambio de semántica, no de middleware
`getMaintenanceState()` pasa a devolver el estado **solo si `active === true`**. Gracias a eso, el bloqueo global de `server.js` no cambió su lógica y una ventana en espera simplemente no bloquea a nadie con sesión abierta. Lo único que se corta mientras espera es la puerta de entrada, en `routes/auth.js`: `POST /login`, `POST /register` y el registro por invitación devuelven 503 con un mensaje explícito. **El dueño está exceptuado del bloqueo de login**: sin eso, una cookie vencida durante su propia ventana lo dejaría afuera del panel donde se apaga (mismo agujero que se tapó el 2026-07-27).

### El promotor
`setInterval` de 30 s en `server.js`, el primero del proyecto. Sin espera pedida no hace ni una query (solo la lectura del archivo de estado). Corre en **un solo worker** (`NODE_APP_INSTANCE`): con los dos, ambos podrían promover en el mismo tick y duplicar el evento de auditoría. Killswitch `MAINTENANCE_SCHEDULER=false`. Si Mongo no responde **no promueve**: activar un mantenimiento por no haber podido contar sería lo contrario de esperar.

"Estar trabajando" = `User.lastSeen` dentro de los últimos N minutos (default 5, editable 1–60). No se inventó ninguna señal: `checkUser` ya escribe `lastSeen` con throttle de 1 min, así que hasta el poll de la sala en vivo cuenta como actividad. **El dueño se excluye del conteo**: mirando el panel refresca su propio `lastSeen` cada 10 s y bloquearía su mantenimiento para siempre.

### El semáforo
`/superadmin/backup` muestra en vivo 🟢 *listo para mantener* / 🟠 *N personas trabajando*, con **nombre, rol y hace cuánto** de hasta 25 personas (los nombres van escapados: salen de la BD y los escriben otras personas). Poll cada 10 s, **detenido con `document.hidden`** para que un panel olvidado no consuma. Endpoints nuevos en `routes/backup.js`: `GET /maintenance/activity`, `POST /maintenance/schedule`, `POST /maintenance/cancel`. `/maintenance/on` y `/off` no cambiaron.

Detalles que el código documenta:
- **Programar con la plataforma ya vacía activa en el acto**, sin pasar por "en espera" (esperar 30 s a descubrir lo que ya sabemos sería absurdo).
- **Tope de espera opcional** (`maxWaitMinutes`): en horario escolar una espera indefinida puede no llegar nunca.
- **Aviso a los que están adentro**: existe (`views/partials/maintenance-banner.ejs`) pero **apagado por default** — avisar acelera la espera, pero también puede provocar una avalancha de entregas de último momento.
- **El `/restore` ya no pisa una espera**: guardaba un booleano y el `finally` la habría borrado; ahora guarda el estado crudo y lo restaura.

### Qué se probó
**Unitarios nuevos: 34** (`tests/unit/maintenanceWindow.test.js` + `maintenanceState.test.js`, total del proyecto 62/62). **Smoke: 220/220**, con 4 specs nuevos. Y el ciclo completo contra el server local: con 1 persona trabajando la ventana quedó en espera, el que ya estaba adentro siguió navegando (`/courses` 200) mientras un login nuevo recibía 503, y al minuto de silencio **el mantenimiento se activó solo** (`reason: auto`, `promotedBy: empty`).

**No hay cambio de base**: ni schema, ni migración, ni backfill. Deploy = push, sin `npm install`.

> ⚠️ **Rollback**: el código viejo trata *cualquier* `maintenance.json` como "activo". Si alguna vez hay que volver atrás esta feature con una ventana en espera puesta, hay que **cancelarla o borrar el archivo primero**, o el rollback bloquea a toda la escuela.

---

## Backup comprimido: elegir qué achicar antes de descargar (2026-08-08)

Pedido del usuario: *"en la card de desglose de lo guardado, al hacerle click, mostrarme un filtro de los archivos, el peso de los mismos, y que me permita comprimirlos"*, acotado después a *"comprimir archivos antes de descargar el backup, pero si quiero restaurarlo, que me permita hacerlo"*.

**Primero hubo que corregir la premisa**: el pedido original decía "para achicar la base de datos", pero **los archivos no están en Mongo**. No hay GridFS ni base64 — Mongo guarda solo rutas (strings) en `Activity.url`, `Submission.storagePath`, `User.avatar`, `Course.header.image` y `Announcement.image`. Comprimir achica **el disco y el backup**, no la base.

Medido el 2026-08-08 sobre el mirror local: 908,8 MB en 700 archivos = **581 MB en 346 imágenes jpg/png sin optimizar** (fotos de celular guardadas byte por byte; 8 de más de 4,4 MB), 315 MB en 247 PDFs, 9,7 MB en documentos y 2,6 MB en WebP. El optimizador que ya existía (`services/imageOptimizer.js`) nunca tocó los adjuntos ni las entregas: solo corre en avatares, portadas y novedades.

### La invariante que gobierna todo el diseño

**El nombre y la extensión de cada archivo no cambian nunca.** jpg→jpg, png→png, pdf→pdf.

Es lo que permite que un backup comprimido se restaure con el flujo de siempre **sin tocar un solo documento de Mongo**. Convertir a WebP comprimiría ~4 puntos más, pero cambiaría el nombre del archivo y obligaría a reescribir las rutas dentro de los JSON de `db/` del tarball; cualquier ruta que se escapara dejaría esa imagen en 404 después de restaurar. Por eso `services/backupCompressor.js` **no reusa** `imageOptimizer.js`, que convierte a WebP a propósito.

Dos decisiones más, del mismo tenor:
- **La compresión se aplica solo al staging temporal**, nunca a `public/archivos` ni `archivos/entregas`. Eso ya es "guardar el original", sin carpeta de respaldo ni botón de revertir.
- **`BACKUP_FORMAT_VERSION` sigue en `1.0`.** El campo `manifest.compresion` es opcional. Subir la versión habría hecho que `POST /preview` rechazara todos los backups ya generados.

### Qué se agregó

| Pieza | Qué hace |
|---|---|
| `services/backupCompressor.js` | catálogo de tipos, análisis con caché de 60 s, compresión con pool (4 imágenes / 2 PDFs) |
| `views/partials/backup-compress-modal.ejs` | el modal, incluido por `monitor.ejs` **y** `backup.ejs` |
| `GET /superadmin/backup/file-stats` | desglose por tipo + qué herramientas hay en este servidor |
| `GET /superadmin/backup/download?comprimir=imagenes,pdf` | la query se filtra contra lista blanca, nunca se usa cruda |

La card "Desglose de lo guardado" de `/superadmin/monitor` es ahora clickeable (con `role="button"` y teclado) y el refresco de 5 s **se pausa** mientras el modal está abierto, para no competirle ancho de banda a una descarga de cientos de MB.

Detalles que el código documenta:
- **El encoder se elige por el formato REAL, no por la extensión.** En esta base hay tres avatares que son JPEG (y uno WebP) con nombre `.png`; elegir por extensión los mandaba al encoder PNG, el resultado salía más grande y la regla de "gana el original" los dejaba sin comprimir. El nombre sigue sin tocarse: se preserva el formato que el archivo ya tenía.
- **PNG sin paleta**: cuantizar a 256 colores ahorraba apenas 2 puntos más (71% vs 69% medido) a cambio de banding en las fotos guardadas como PNG.
- **Si el resultado pesa más, gana el original**; **si un archivo falla, se cuenta y se sigue**. Un escaneo dañado no puede hacer fracasar el backup entero — que es justo lo que uno quiere tener cuando algo anda mal.
- **`sharp.cache(false)` durante el batch y restaurado al terminar**: en cientos de archivos distintos el caché de libvips no acierta nunca y solo acumula presión de memoria (el mismo `vips_tracked: out of memory` que apareció al correr los tests en paralelo).
- **`req/res.setTimeout(0)`** en `/download`: comprimir suma minutos a la request más larga del sistema.
- **Ghostscript es opcional**, detectado una vez y cacheado (`gs` en Linux, `gswin64c` en Windows). Sin él, el check de PDFs aparece deshabilitado **con el motivo a la vista** en vez de desaparecer, así se entiende que hay ahorro pendiente y por qué.
- La pantalla de restore **avisa si el backup viene comprimido** antes de dejar confirmar.

### Qué se probó

**Unitarios nuevos: 17** (`tests/unit/backupCompressor.test.js`, total del proyecto 79/79). **Smoke: 221/221**, con `backup-file-stats` nuevo. Y el ciclo completo contra el server local, con los 700 archivos reales:

| | |
|---|---|
| Descarga con `?comprimir=imagenes` | 33 s, **795 MB → 383 MB** |
| Imágenes | 581,2 MB → 98,4 MB (**−83%**), 321 comprimidas, 25 omitidas, 0 fallidas |
| Archivos vivos del servidor | 700 intactos, mismo byte count |
| Nombres dentro del backup | 700/700 coinciden exactamente con el servidor |
| Rutas de Mongo | 275 URLs + 158 `storagePath` resuelven dentro del backup |
| Preview del restore | acepta el comprimido, lee `manifest.compresion`, diff limpio en las 12 colecciones |

**No hay cambio de base**: ni schema, ni migración, ni backfill.

> ⚠️ **Producción necesita `sudo apt install ghostscript`** para habilitar la compresión de PDFs (los otros 315 MB). Sin eso degrada sola, igual que sharp. El webhook de deploy no corre `apt` ni `npm install`.

> 🐛 **Encontrado de paso (pre-existente, sin arreglar)**: los 12 `pre-restore-*.tar.gz` de `backups/` (2,8 GB) **no se pueden restaurar**. Ninguno incluye `roomsessions`/`roommessages`/`roompresences`, agregadas después a `COLLECTIONS`, y el chequeo de `missingCollections` los rechaza con 400. Son justamente las redes de seguridad que genera el propio `/restore`. Ver el roadmap.

> 🔧 **Arreglado de paso**: la grilla de `/superadmin/backup` decía "qué se va a incluir" pero omitía las tres colecciones de sala en vivo, que sí se respaldaban. El smoke `backup-stats` tenía el mismo desfase y ahora chequea las 12.

---

## El backup dejó de poder descargarse en producción (2026-08-10)

Síntoma del usuario: apretar "Generar y descargar backup" en producción devolvía el cartel rojo **"Error al generar el backup"**, sin más detalle. Se atribuyó al salto de versión 1.0.27 → 1.0.30, pero el `git diff` entre esos dos commits **no toca ni la ruta `/download` ni `downloadBackup()`**. No era el código nuevo: era el volumen de datos, que venía creciendo hasta pasar el punto donde el diseño original dejaba de dar.

### Lo que costaba un backup, medido sobre la base real

| | Antes | Ahora |
|---|---|---|
| Disco temporal en `os.tmpdir()` | **1757 MB** | **1,7 MB** |
| Tiempo hasta el primer byte al navegador | **22,6 s** | **0,2 s** |
| Memoria de la pestaña del navegador | ~850 MB (blob entero) | 0 |
| Tamaño final del `.tar.gz` | 848,5 MB | 849,9 MB |

Tres defectos independientes, cada uno suficiente para romper la descarga:

1. **Se copiaban 909 MB a `os.tmpdir()`** para empaquetarlos y borrarlos. Sumado al `.tar.gz` resultante, el pico era de 1,76 GB de temporal. En producción `os.tmpdir()` es `/tmp`, que en Ubuntu moderno es **tmpfs — o sea RAM**, y la máquina la comparte con otro stack de Docker.
2. **El navegador quedaba 22,6 s sin recibir un byte** mientras se armaba el paquete, con la conexión abierta y muda a través del Funnel de Tailscale.
3. **`views/superadmin/backup.ejs` hacía `fetch()` + `res.blob()`**: la pestaña juntaba los 850 MB **enteros en memoria** antes de poder guardarlos. Este es el sospechoso principal del error concreto que veía el usuario — y el `catch` genérico de esa función mostraba el mismo texto tanto para un fallo del servidor como para uno del navegador, que es lo que hacía el síntoma indescifrable.

### El cambio

**El paquete ya no se copia ni se materializa: se enlaza y se streamea.**

- `buildBackupStaging()` (nuevo, extraído de `createBackupTarball`) arma el staging con los JSON de la BD y **enlaza** `files/archivos` y `files/entregas` a los originales en vez de copiarlos. `tar.c({ follow: true })` sigue los enlaces y empaqueta el contenido real, así que **el `.tar.gz` sale con el mismo layout de siempre y los backups viejos y nuevos son intercambiables**.
- `GET /download` streamea el tar mientras lo arma (`tar.c()` sin `file:`, `.pipe(res)`). Sin `Content-Length`, la respuesta sale chunked: eso hace que una descarga interrumpida **se vea interrumpida** en vez de dejar un `.tar.gz` truncado con pinta de completo. En un backup esa diferencia vale más que la barra de progreso que se pierde.
- La pantalla dispara la descarga con un **iframe** en vez de `fetch` + blob: la escribe el navegador, directo a Descargas.
- **`gzip` bajado a nivel 1**: el contenido son JPEG y PDF ya comprimidos, así que el nivel 6 conseguía 6,6% a cambio de 20 s de CPU por backup. Nivel 1 da prácticamente el mismo tamaño (849,9 vs 848,5 MB).
- `createBackupTarball()` sigue existiendo y produciendo un archivo en disco: lo usa el backup de seguridad pre-restore, que **sí** necesita un archivo porque termina guardado en `backups/`.

> ⚠️ **La propiedad de la que depende todo esto**: `fs.rmSync(staging, { recursive: true })` borra el **enlace**, no el destino. Se verificó explícitamente antes de escribir el código y hay un test que lo fija. Si alguna vez se cambia la limpieza del staging por otra cosa, **hay que volver a verificarlo**: seguir el enlace ahí significaría borrar `public/archivos` y `archivos/entregas` del servidor de producción.

### Qué se probó

**Unitarios nuevos: 5** (`tests/unit/backupTarball.test.js`, total 84/84). Fijan el layout del tarball, que no queden enlaces sin resolver, que no sobrevivan directorios de staging, que una carpeta de origen inexistente entre igual como vacía, y —el importante— que generar un backup no se lleve puestos los originales.

Ciclo completo contra los 909 MB reales: 710 archivos empaquetados (413 adjuntos + 297 entregas), las 12 colecciones presentes, 0 enlaces sin resolver, originales intactos, y validación equivalente a la de `POST /preview` en verde.

Para poder testearlo, `ARCHIVOS_BASE` y `ENTREGAS_BASE` pasaron a ser overrideables por env var (`BACKUP_ARCHIVOS_BASE` / `BACKUP_ENTREGAS_BASE`), con el mismo criterio que `MAINTENANCE_FILE` en `config/maintenance.js`: correr los tests contra un fixture de unos KB en vez de los 909 MB del proyecto. En producción no se setean nunca.

> 🔧 **Arreglado de paso**: el cliente de smoke tests (`tests/smoke/lib.js`) prefería `Content-Length` antes que bufferear la respuesta, y sin ese header caía a `arrayBuffer()` — volviendo a cargar los 850 MB en memoria, justo lo que ese bloque existía para evitar. Ahora cuenta los bytes al pasar. De paso guarda los primeros 4, y el spec `backup-download-produces-valid-tarball` verifica **la firma gzip (`1f 8b`)**: como el status 200 sale antes que el contenido, era el único chequeo que faltaba para distinguir un backup de verdad de una respuesta rota servida con 200.

> 🔧 **Arreglado de paso (2)**: `pull-from-prod.js` (el espejo prod → local) escribía en `classroom-clone`, una base que la app **ya no usa** — el `.env` apunta a `classroom-escuela`. Sincronizaba sin fallar y la app seguía mostrando los datos viejos. Ahora saca el destino del `.env`. Además tenía la lista de colecciones hardcodeada y vieja (le faltaban las 3 de sala en vivo, `sections`, `activityviews`, `activitytemplates`, `templateassignments` y `auditlogs`): ahora enumera lo que existe en producción, avisa si local tiene colecciones que prod no, y aborta si origen y destino coinciden.

---

## Mensajería del superadministrador (2026-08-10)

Spec: `specs/mensajeria-superadmin.spec.md` (aprobada el 2026-08-10).

Hasta ahora la comunicación iba en un solo sentido: cualquiera le mandaba una sugerencia al superadmin y el superadmin contestaba. No existía el camino inverso — para avisar algo había que salir del sistema. Ahora el superadmin **elige destinatarios, escribe, y decide con un click si se le puede contestar**.

**A quién**: toda la comunidad, por rol (uno o varios), o personas sueltas por buscador (DNI, nombre o correo). Los roles se intersectan con un filtro opcional de escuela; las personas sueltas se **suman** al grupo. El recorte por curso/división quedó explícitamente para más adelante — decisión del usuario.

> "Toda la comunidad" hay que elegirla **a propósito**: dejar todo sin tildar no es "todos", es audiencia vacía y el servidor la rechaza con 400. Y arriba de 50 destinatarios el botón pide confirmación con el número escrito. Un envío masivo no se deshace solo.

### Las dos decisiones de diseño que sostienen todo

**1. Dos colecciones, no una.** `Message` es el envío (el texto, una sola vez); `MessageRecipient` es una fila por persona con su estado de lectura y su hilo privado. Con los destinatarios embebidos, cientos de alumnos respondiendo escribirían el **mismo** documento —contención pura— y el doc crecería sin techo contra el límite de 16 MB.

**2. La audiencia se congela al enviar, no se evalúa al leer.** Un aviso del 3 de marzo dirigido a "todos los docentes" **no** es para la docente que entró en agosto: es correo, no un tablón. Además el badge del sobre corre en **cada request**: con snapshot es un `countDocuments` por índice; sin snapshot habría que re-resolver la audiencia en todas las páginas que abre todo el mundo. Y "leído por 87 de 143" no tendría denominador. `Message.audience` guarda los filtros como **memoria** de lo que se pidió —para mostrarlo, reenviar y auditar—, nunca como fuente de verdad de quién ve qué.

`roleAtSend` y `schoolAtSend` también se congelan: el panel tiene que poder decir "se lo mandaste a Juan como Docente" aunque hoy Juan sea Preceptor. Sin eso, un cambio de rol reescribe la historia del envío.

### El sobre del header ahora muestra dos cosas

Las sugerencias propias y los mensajes recibidos conviven en el mismo modal y el mismo badge, ordenados por última actividad, cada uno con su píldora ("Mi sugerencia" / "Mensaje del equipo"). Para el usuario es un solo lugar: lo que tengo para leer.

- `res.locals.unreadSuggestionCount` **se conserva** con su nombre y su significado de siempre (lo consumen vistas y specs); se suma `unreadMessageCount` y la suma va en `unreadInboxCount`, que es lo que pinta el header.
- Las dos cuentas van en `Promise.all`, cada una con killswitch propio (`SUGGESTIONS_INBOX_ENABLED` / `MESSAGES_ENABLED`) y `.catch(() => 0)` por separado: **una feature caída no se lleva puesta a la otra**, y el sobre nunca rompe la página.
- El modal pide las dos fuentes en paralelo desde el cliente. No se hizo un endpoint `/inbox` unificado a propósito: `/suggestions/mine` ya existe, está cubierto por los smoke tests y no había motivo para tocarlo.

### Respuestas

Toggle por mensaje. Si está apagado, el destinatario ve el mensaje sin caja de texto **y el POST devuelve 403** aunque se lo llame a mano. Si está prendido, el hilo es privado 1 a 1 con tope de 20 mensajes — mismo criterio que las sugerencias.

El toggle **se puede cambiar después de enviado, en los dos sentidos**. Apagarlo cierra la caja pero **no borra nada**: lo que alguien ya escribió se conserva y se sigue viendo de los dos lados. Perder mensajes de gente no era una opción.

> **Por qué modelo nuevo y no generalizar `suggestionThread`**: `Suggestion` guarda sus dos primeros mensajes en `text` y `response`, fuera de `messages[]`, porque cuando el hilo se agregó ya había sugerencias en producción. Eso es deuda heredada, no diseño. `services/messageThread.js` copia la **forma de la API** para que las vistas se lean igual, sin arrastrar el caso especial. Si algún día se migra `Suggestion`, ese es el momento de unificar los dos.

### Qué se probó

**Unitarios nuevos: 35** (`tests/unit/messageAudience.test.js` y `messageThread.test.js`, total del proyecto **119/119**) — cubren los criterios 1-14 de la spec: intersección rol ∩ escuela, la unión de las personas sueltas, que el remitente nunca se autoenvíe, que `everyone` ignore los roles, que ninguna cuenta deshabilitada entre ni siquiera eligiéndola a mano, y el tope del hilo.

**Smoke nuevos: 22** (`tests/smoke/specs.js`, criterios 15-45, suite completa **245/245**): envío, rechazo de audiencia vacía sin dejar un `Message` huérfano, bandeja del destinatario, 403 al responder lo que no admite respuestas, 404 al tocar el mensaje de otro, el badge que se apaga al leer y **vuelve a encenderse** cuando el superadmin contesta sobre un mensaje ya leído, DNI primero y roles en español en el detalle, y el borrado en cascada. `npm run test:roles` sin hallazgos.

> El badge unificado obligó a cambiar cómo se verifica: los specs **no pueden asumir que arranca en cero**, porque a esa altura del suite el alumno ya tiene una sugerencia sin leer. Se toma una base antes de enviar y se verifica la aritmética (`base` → `base+1` → `base`). Es un test más fuerte que el "no debería haber badge" que tenían las sugerencias: comprueba que las dos fuentes se suman y que ninguna se lleva puesta a la otra.

Ciclo completo verificado en el navegador contra la base real (1428 usuarios): la previsualización dio **333 docentes** y **355 con preceptores**, los números exactos de la base. Enviado a una docente, leído, respondido desde el sobre, la respuesta apareció en el panel ("1 lo leyeron · 1 respondieron"), y el borrado la sacó de la bandeja sin dejar filas huérfanas.

> 🔧 **Encontrado al verificar**: la pluralización de roles agregaba una "s" al singular, o sea "Administradors", "Preceptors" y "Jefe de Seccións". Ahora hay un mapa `ROLES_PLURAL` en `routes/messages.js` que se le pasa a la vista, así el texto del servidor y el de la previsualización en vivo salen del mismo lugar. Y los checkboxes de rol estaban en `display:none`, que los sacaba del orden de tabulación: los roles no se podían elegir con el teclado.

### Cosas a tener en cuenta

- **Producción**: no hay migración de datos (dos colecciones nuevas, vacías), pero la primera arrancada crea índices y el middleware global suma un `countDocuments` por request.
- **Killswitch**: `MESSAGES_ENABLED=false` apaga la solapa, las rutas (404) y el contador, sin redeploy.
- **Rate limit**: 20 envíos/hora y 10 respuestas/minuto, ambos **por usuario** — con clave por IP, la escuela entera sale por una sola IP NAT y uno solo dejaría sin escribir al resto.
- Al sumar la solapa 13, el corte de dos filas del nav de superadmin (`.admin-nav-break`) se movió un ítem antes: quedan 8 arriba y 5 abajo.

---

## Asistencia de preceptoría (2026-08-10)

Spec: `specs/asistencia-preceptoria.spec.md` (aprobada el 2026-08-10). **Fases A y B completas.**

Hasta ahora la única "asistencia" del sistema era un efecto secundario de la sala en vivo: quién se había conectado a la clase de una materia. Útil, pero no es lo que hace un preceptor — él toma la asistencia **del curso** (3°2° entero) y **del día**, y eso no existía. Ahora existe, en `/preceptor/asistencia`.

**Dos modos, el mismo modelo**. *Pase de lista*: abre, ve los 26 nombres, marca y cierra. *Ventana abierta*: la deja abierta y la va completando (en la Fase B los alumnos se marcan solos desde su pantalla). Cuatro estados: presente, tarde, ausente y justificado, este último con una observación de hasta 200 caracteres.

**Modelos nuevos** (2, ninguna migración): `AttendanceSession` (una toma por curso, día y etiqueta — índice único, que es lo que hace idempotente el botón "Abrir" cuando dos preceptores lo tocan a la vez) y `AttendanceMark` (una marca por alumno; **es** el registro de asistencia).

### Las cuatro decisiones que sostienen todo

**El día es un string `YYYY-MM-DD` calculado en la zona de la escuela**, no un `Date`. Producción corre en UTC: con un `Date` local, una toma abierta a las 21:30 de Buenos Aires quedaría fechada al día siguiente **y el índice único dejaría abrir una segunda toma "del mismo día"**. `diaEscolar()` vive en `services/liveRoom.js`, junto al resto de los formateadores, porque la zona horaria del proyecto tiene un solo dueño — un segundo `Intl.DateTimeFormat` en otro archivo es exactamente cómo volvería el bug de las tres horas (ver el changelog del 2026-08-06). Cinco tests unitarios lo cuidan.

**La nómina se congela al abrir.** Se crea una marca por alumno con su nombre y su DNI copiados. Un chico que se matricula a las 10 no aparece en la toma de las 7:30, y uno que se va de la escuela sigue figurando en las tomas de cuando estaba. Va a parecer un error y no lo es: la asistencia de un día es la de los que estaban ese día.

**La sala en vivo sugiere, nunca marca.** Decisión explícita del usuario. El enganche automático son cuatro líneas en `touchPresence`, pero la marca la pone siempre una persona. Cuando el preceptor acepta la sugerencia, la marca queda con origen `preceptor`, porque la puso él. (La sugerencia en sí llega en la Fase B; la clave `enClase` ya viaja en el payload, vacía.)

**Al cerrar, lo que quedó sin marcar pasa a ausente.** Una toma cerrada no tiene ningún `null`. Y una toma abierta de un día anterior se cierra sola en el primer request que la toque — de forma perezosa y no con un `setInterval`, porque PM2 corre dos workers y un timer se ejecutaría dos veces. Una ventana olvidada el viernes dejaría a todo el curso presente el lunes.

### Dos cosas que cambiaron respecto de la spec

**El cierre programado se pide en minutos, no en hora del reloj.** Un "08:15" tipeado en el navegador se interpreta con la zona de esa máquina, y las computadoras del aula tienen cualquier zona configurada. Un intervalo no depende de ninguna zona; la hora que se muestra la calcula después el servidor.

**Se agregó "Reabrir para corregir"** (`POST /toma/:id/reabrir` + acción de auditoría `attendance.reopen`). La spec decía que una toma cerrada rechaza marcas y que para corregir "hay que reabrir", pero nunca definía cómo — el caso del que llega 8:40 quedaba sin resolver. Solo se reabre la toma **de hoy**: una de ayer se vuelve a cerrar sola en el request siguiente.

### El bug que apareció verificando en el navegador

La primera versión repintaba la lista entera después de cada marca. Con 26 alumnos en un celular eso no es un detalle estético: los botones se mueven bajo el dedo y **los clicks siguientes caen sobre nodos que ya fueron reemplazados y se pierden**. Medido: de 6 clicks rápidos entraba 1. Ahora se actualiza solo la fila tocada y el resumen se recalcula en el cliente; el poll de 15 s vuelve a sincronizar con la base, así que cualquier diferencia se corrige sola. De 6 clicks rápidos entran 6.

**Auditoría**: se registran la apertura, el cierre, la reapertura y **solo las correcciones** — pisar una marca que ya tenía estado. El pase de lista normal son 30 marcas por curso y por día: auditarlas todas dejaría `/admin/audit` inservible, y quién marcó y cuándo ya vive en la marca misma.

**Solapa** `preceptor_asistencia`, apagable por escuela desde `/superadmin/roles`. **Backup**: las dos colecciones entraron a `COLLECTIONS` (`routes/backup.js`) — ojo, esa lista es el único lugar que decide qué se respalda, y la asistencia no se purga nunca.

### Revisión del mismo día: una sola planilla por día

Al probarlo, el usuario pidió dos cambios que reescriben una regla central.

**Una sola planilla por curso y por día.** El preceptor puede pasar lista varias veces —a primera hora, después del recreo, a la tarde— pero todas esas pasadas **ajustan la misma**: al final del día queda una. Desapareció la "segunda toma con etiqueta". El índice único pasó de `{división, día, etiqueta}` a `{división, día}`, y "Pasar lista otra vez" reabre la planilla en vez de crear otra, contando `pasadas`.

Eso además arregló un problema latente: con dos tomas el mismo día, la planilla mensual tiene **una sola columna** para esa fecha, y cuál de las dos aparecía dependía del orden en que Mongo devolviera los documentos.

**Y destapó otro, más serio.** Si el cierre de la mañana marca a todos los que faltan como ausentes "por el preceptor", entonces la ventana de la tarde **no le sirve a ningún alumno**: todos llegan ya decididos y la autoasistencia los rechaza. La solución es distinguir el origen: el cierre escribe `source: 'cierre'`, que **no es una decisión de nadie**, sino el valor por defecto de quien no fue marcado. Con eso, el alumno todavía puede darse la asistencia en una pasada posterior, esas marcas no ensucian la auditoría como "correcciones", y el CSV las muestra como "Ausente por cierre" en vez de atribuírselas a una persona.

**La ventana llega hasta 6 horas**, una opción más entre las duraciones (30 min a 6 h). "No cerrarla sola" sigue existiendo: en ese caso la cierra el cambio de día. Un valor por encima del tope se **recorta** en vez de ignorarse — pedir 10 horas y quedarse sin cierre automático sería lo contrario de lo que quiso quien lo pidió.

**La sugerencia de la sala también cambió**: ahora incluye a los que **figuran ausentes**, no solo a los sin marcar. "Marcaste ausente a Juan y está en Matemática en este momento" es el aviso más útil de la feature, y es el que el preceptor no puede conseguir de ninguna otra forma. Con el filtro anterior, después del primer cierre la sugerencia no volvía a mostrar a nadie nunca.

### "Los alumnos no ven el botón del presente"

Lo reportó el usuario y la causa **no era el celular**. Medido en 360×560, el cartel del alumno y su botón entran enteros en la primera pantalla, sin scrollear. Lo que pasaba es que la planilla se había abierto con **"Pasar lista"** —el botón principal, el obvio—, que es el modo donde marca el preceptor y el alumno no participa: `autoasistencia: false`, cero tomas para él, sin cartel. Correcto por diseño, imposible de deducir desde la pantalla.

Dos arreglos. **El nombre**: "Abrir ventana" pasó a **"Que la den los alumnos"**, y el panel ahora dice qué va a pasar del otro lado ("A los alumnos les aparece *Dar asistencia* al entrar"). **Y el aviso**: la planilla abierta muestra arriba de todo, antes que los números, si los chicos la están viendo o no —en ámbar *"Los alumnos NO ven nada: esta lista la estás pasando vos"*, en verde *"Los alumnos ven Dar asistencia hasta las 18:10"*— con el botón para cambiarlo ahí mismo. Va arriba a propósito: en un celular, más abajo queda fuera de la primera pantalla y es justo el dato que se estaba escapando.

`POST /toma/:id/autoasistencia` cambia el modo **sin cerrar la planilla ni perder lo marcado**, y no cuenta como pasada nueva.

### Fase B: el alumno, las sugerencias y los reportes

**El botón "Dar asistencia"** aparece en el inicio del alumno (`views/partials/asistencia-banner.ejs`) cuando preceptoría dejó una ventana abierta. Se marca a sí mismo y siempre como presente: el cuerpo del POST **se ignora por completo**, así que mandar el id de un compañero o un estado inventado no hace nada. Es idempotente —doble toque, F5 o dos pestañas dan una sola marca y no pisan la hora original— y las divisiones salen de las materias que el dashboard **ya tenía cargadas**, así que el cartel no agrega una consulta a la pantalla más visitada de la aplicación.

**Y no revierte al preceptor.** Si él ya decidió algo para ese chico, el toque deja constancia de que dice estar presente (la grilla muestra "la dio el alumno") pero no cambia el estado, y el cartel se lo dice. Sin esa regla, el botón sería una forma de discutirle desde el celular a quien controla la asistencia.

**Las sugerencias de la sala** ya funcionan: el poll trae "estos N sin marcar están ahora en clase", con la materia, y un botón para marcarlos a todos. La marca queda con origen `preceptor`, no `sala`: la sugerencia la trajo el sistema, la decisión la tomó él. La query arranca por `{ school, closedAt }` porque **ese** es el índice que tiene `RoomSession` — filtrar por división sola recorrería decenas de miles de sesiones cada 15 segundos.

**El historial** (`/preceptor/asistencia/:id/historial`) muestra los días tomados y el acumulado por alumno, con una columna por día. Las dos tablas scrollean **dentro de su caja**: en el celular la página nunca se va de costado. Y los dos CSV —el del día y el del período— salen con el mismo dialecto que los de la sala en vivo (`;` + BOM, para el Excel en español), reusando `csvRows` en vez de redefinirlo.

**El porcentaje cuenta la llegada tarde como asistencia** y no calcula inasistencias reglamentarias: eso es un acto administrativo que esta feature no hace, y la pantalla lo dice.

**Dos trampas que costaron una vuelta cada una**: el rango de fechas se valida antes de tocar la base (un rango invertido o malformado da 400, no una consulta sin límites contra la colección más grande del sistema); y el BOM del CSV **no se puede verificar desde el smoke**, porque el decoder de `fetch()` se lo come al llamar a `res.text()` — se testea a nivel string en los unitarios.

## Actividad desde la clase en vivo + "Actividades del día" de preceptoría (2026-08-12)

Spec: `specs/actividades-en-clase.spec.md` (aprobada el 2026-08-12).

Dos mitades de un mismo pedido. La primera: **la docente puede dejar la consigna sin salir de la clase**. Al lado del chat de la sala en vivo hay ahora un botón "Crear actividad" que abre el mismo modal de siempre; la actividad queda en la solapa **Actividades** de esa materia como cualquier otra. La segunda: **preceptoría ve, en un calendario del mes, qué materias dejaron actividad cada día** — `/preceptor/actividades`, con el detalle del día al costado.

**Lo que NO se agregó, y es lo que mantiene la feature chica**: ningún campo en `Activity`, ninguna colección, ninguna migración, ningún índice. **La base de producción no se toca.** Todo se apoya en `createdAt`, que ya estaba. Eso salió de tres decisiones del usuario:

- **Cuenta cualquier actividad del día**, no solo la creada desde la sala. El botón del chat es un atajo para crearla, no una categoría aparte: una materia que subió la tarea por el camino de siempre figura igual como "subió". Sin esa decisión hacía falta un campo `roomSession` en el modelo.
- **Un calendario por curso**, con selector arriba — mismo criterio que la solapa Asistencia.
- **El vínculo con la clase es un aviso en el chat**, no una marca en la tarjeta: al crearla desde la sala se publica un mensaje de sistema ("*Fulana creó la actividad «X»*") que queda en la transcripción de esa clase.

**Cero formulario nuevo.** La solapa "En vivo" vive dentro de `views/course.ejs`, que ya tenía el modal de creación completo —título, tipo, consigna, entrega, "disponible desde", puntos, adjuntos y links— con su `createActivity()` en `public/js/course.js`. Estaba **sin punto de entrada** desde que el "+" flotante pasó a llevar al formulario de página completa (`/activities/new`): código vivo y mantenido que no abría nadie. El botón de la sala lo reusa tal cual, marcando de dónde salió el pedido (`fromRoom`). Lo único que el modal no ofrece y sí ofrece el formulario grande son las **plantillas** de tareas; para dejar una consigna en el momento no hacía falta.

El `locals.enLaMateria` del partial no es una precaución de más: `views/partials/live-room.ejs` lo usan **dos** contenedores, y en `views/rooms/standalone.ejs` —por donde entran dirección y preceptoría— ese modal no existe.

**El aviso del chat es accionable** (agregado el mismo día, a pedido del usuario): trae un botón chico **"Ver actividad"** que abre la actividad. Con JS **no recarga** —la solapa "En vivo" y la de Actividades son la misma página, así que el detalle se abre ahí mismo sin sacar a nadie de la clase— pero es un `<a href>` de verdad, con el mismo patrón que la lupa de las imágenes: el link es el respaldo (teclado, botón derecho, "abrir en pestaña nueva") y el handler es el comportamiento normal. De paso quedó el **link directo `/courses/:id?actividad=<id>`**, que abre la solapa Actividades y el detalle al cargar — un paso hacia el "deeplink por actividad" que estaba en el roadmap.

El mismo botón está **en la transcripción de la clase archivada** (`views/rooms/session.ejs`): media razón para volver a abrir una clase vieja es encontrar lo que se dejó ese día. Ahí el criterio de quién lo ve se calcula en el servidor (`puedeAbrirMateria = esGestor || esAlumno`) y no por el contenedor, porque esa vista sí la comparten las dos audiencias.

Eso sí suma **un campo**: `RoomMessage.activity` (ref, opcional, `null` por default, sin índice). El id va como dato y no adentro del texto del mensaje: con la URL escrita en el texto habría que parsear el aviso para pintar el botón, y cualquier cambio de rutas rompería los mensajes ya guardados. **No necesita migración ni backfill**: los mensajes anteriores quedan en `null` y se pintan como siempre. El botón **no se pinta en la sala suelta** (dirección y preceptoría), porque el link va a `/courses/:id` y ahí esos roles reciben 403 — un botón que lleva a una pared es peor que no tenerlo. Y como el aviso pasó de `textContent` a `innerHTML` para poder llevarlo, el texto va escapado sí o sí: adentro viaja el título de la actividad, que lo escribió una persona.

**El aviso lo decide el servidor, nunca el cliente.** El id de la sesión no se toma del body: se resuelve con la sala abierta de ese curso. Del otro lado hay el chat de un curso de menores, y un id que viene del navegador es una invitación a escribir en la clase de al lado. Si no hay sala abierta, no hay aviso y la actividad se crea igual. Y va con su propio `try/catch`: la actividad ya está creada, así que **un error al escribir en el chat no puede voltear la respuesta** ni dejar a la docente creyendo que no se guardó nada.

**El día se decide en la zona de la escuela**, con el mismo `diaEscolar()` de `services/liveRoom.js` que archiva la asistencia. Producción corre en UTC: una actividad cargada 21:30 de Buenos Aires caería en la celda del día siguiente. En el resumen del mes eso se resuelve con un `$dateToString` con `timezone` en el aggregate y una ventana de fechas **holgada** (±1 día) en el `$match` — el rango solo tiene que ser lo bastante ancho como para no dejar nada afuera; el corte fino lo hace el bucketing. Así no hay que calcular a mano el desfasaje ni su cambio por horario de verano.

**Lo que la pantalla del día NO dice**: qué materias *deberían* haber subido. El sistema no tiene horario escolar —no hay dato de qué materias tienen clase un martes—, así que lista **todas** las materias del curso partidas en "Subieron" / "No subieron". Ponerle expectativa a eso es lo que el usuario dejó explícitamente para después.

**Solapa** `preceptor_actividades`, apagable por escuela desde `/superadmin/roles`, y **de solo lectura**: no hay ni un POST en esa parte del router, igual que el panel de jefatura. **Tests**: 7 unitarios de la grilla del calendario (`tests/unit/actividadesDelDia.test.js`), 3 smoke nuevos y la sección nueva sumada al toggle de la matriz de roles.

## La docente "cerraba" la sala sin cerrarla (2026-08-13)

Reclamo del usuario: la docente abre la sala en vivo, se va a **Novedades** o **Actividades** —solapas de la misma pantalla— y los alumnos, preceptoría y dirección ven que **cerró la clase**. No la cerraba: la sala seguía abierta en la base y los paneles la seguían listando "en vivo". Lo que pasaba es que **desaparecía de la lista de conectados**, y una sala con la docente afuera se lee como una clase terminada.

**La causa**: `aLaVista()` corta el poll de la sala cuando la solapa "En vivo" no está visible —existe para que abrir la materia no marque presente a cualquiera que la tenga abierta— y sin poll no se refresca el `lastPingAt`. A los 45 s el servidor la da por desconectada. Medido antes de tocar nada: con la sala abierta y la docente en Novedades, el poll de la alumna devolvía `estado: abierta` y `conectados: [la propia alumna]`.

**El arreglo son dos mitades, y las dos hacen falta**:

1. **Latido en el cliente** (`views/partials/live-room.ejs`): cada 20 s, **solo para quien gestiona la sala**, y solo cuando el poll normal no está corriendo. Manda el mismo `/poll` y tira la respuesta —`seq` no se toca, así que los mensajes se piden enteros cuando la sala vuelve a estar a la vista.
2. **Ventana de presencia de 3 minutos para el personal** (`STAFF_ONLINE_WINDOW_MS` en `services/liveRoom.js`), contra los 45 s de los alumnos. Salió en 2 y el usuario la subió a 3 el mismo día: son ~3 latidos throttleados de margen, así que hacen falta tres seguidos perdidos —y no uno— para que la docente desaparezca de la sala.

Por qué la segunda: el primer intento fue solo el latido y **no alcanzó** — se vio al medirlo. Con la pestaña del navegador en segundo plano el navegador baja los `setInterval` a uno por minuto, más lento que la ventana de 45 s: el latido llegaba tarde y la docente parpadeaba dentro y fuera de la sala. Verificado después del arreglo: con la docente 90 s en Novedades, su último ping era de hace 62 s (o sea, el latido corrió throttleado) y `presenceSummary` la seguía dando conectada.

**La ventana de los alumnos no se toca, y esa asimetría es el punto.** El "N de M presentes" es un dato de la clase que se mira segundo a segundo y tiene que seguir siendo fiel; si un alumno latiera desde Novedades, contaría como presente cualquiera que tenga la materia abierta — justo lo que `aLaVista()` existe para evitar. La presencia del personal no alimenta ningún conteo (solo dice quién está a cargo), así que ahí la tolerancia no falsea ningún número. Y sigue siendo honesta: dice "pingueó hace menos de 3 minutos", no "está"; una máquina apagada se cae igual, un rato después.

**Tests**: 4 unitarios nuevos en `tests/unit/liveRoom.test.js` (42/42). Van ahí y no al smoke porque dependen del paso del tiempo: hay que poder inyectar el `now` en vez de esperar 90 segundos por request.

## Rol SOE — Servicio de Orientación Escolar, panel `/soe` (2026-08-18)

Pedido del usuario: *"me gustaría que desarrollaras un rol que diga SOE, referido a la orientación
psicopedagógica, para poder conocer cómo está el niño, cuáles son sus falencias, sus puntos fuertes
y débiles, cómo podemos hacer para contenerlo, llevar un seguimiento si al alumno se lo deriva o no
a otro lugar y en ese lugar qué le dicen"*.

El rol `soe` **ya existía y estaba vacío** desde el principio: estaba en el enum de `models/User.js`,
se podía asignar, tenía nombre, color e ícono y entraba a las salas en vivo como staff — pero
aterrizaba en `/courses` como un docente sin materias. `views/superadmin/roles.ejs` tenía una nota
diciendo justamente eso. Lo que se construyó no es el rol: es su trabajo.

Spec: `specs/soe-orientacion.spec.md` (31 criterios de aceptación).

### Qué hace

**Legajo por alumno** (`models/SoeCase.js`, uno por alumno para siempre — se cierra y se reabre, no
se duplica), con cuatro solapas en la ficha:

- **Situación** — motivo de intervención, fortalezas (con qué cuenta), dificultades (qué le cuesta)
  y estrategias de contención acordadas para el aula.
- **Seguimiento** — línea de tiempo de entrevistas, observaciones, contactos con la familia y
  acuerdos con docentes. Cada entrada lleva la fecha **del hecho** (no la de carga), su autor, y un
  campo "cómo se lo vio" (bien / con altibajos / preocupante) que es lo que convierte el legajo en
  un pulso y no en una foto.
- **Derivaciones** — a dónde, por qué, con qué referente, en qué estado, y las **devoluciones** que
  ese lugar va dando. Con fecha de "volver a preguntar": vencida sin respuesta, la derivación se
  resalta. Es el mecanismo que evita que un chico se pierda entre la derivación y la devolución que
  nunca llegó.
- **Cómo viene** — asistencia (30 días y ciclo), promedio por materia, entregas pendientes y
  tardías, última conexión, intereses y a qué quiere dedicarse. Todo dato que la plataforma **ya
  tenía**; nadie lo carga a mano. No calcula ningún "índice de riesgo": muestra los números, el
  juicio queda en la persona del gabinete.

Más `/soe/derivaciones`, la lista de toda la escuela ordenada por lo que pide atención primero.

### Las tres decisiones que importan

**1. La confidencialidad no pasa por `config/sections.js`.** Ese sistema es restrictivo y fail-open:
solo QUITA lo que los middlewares conceden, y lo que no está denegado pasa. Es lo correcto para una
solapa de "Materias" y lo equivocado para una historia psicopedagógica, donde el default tiene que
ser cerrado y la configuración tiene que AGREGAR. Vive en `School.soeAccess`, con tres niveles:

| nivel | qué ve |
|---|---|
| `none` (default de todos) | ni la solapa: `/soe` responde 403 |
| `resumen` | fortalezas, estrategias de aula, estado, prioridad y que hay una derivación en curso — **sin** motivo, dificultades, entrevistas ni destino |
| `completo` | todo, en modo lectura |

Preceptor y docente **topean en `resumen`**, y el techo lo aplica `services/soeAcceso.js` al leer, no
solo el enum del schema: un valor escrito con `mongosh` no concede nada. Lo configura el superadmin
desde `/superadmin/roles`, en una tarjeta aparte de la grilla.

**Escribir escribe siempre y solo el rol `soe`.** Ni el superadmin — un legajo firmado por el dueño
técnico de la plataforma no significa nada. El superadmin sí puede leer (tiene la base igual), y esa
lectura queda auditada.

**2. El alcance es fail-OPEN, al revés de preceptor y jefatura.** Un SOE sin `assignedDivisions` ve
toda su escuela; solo queda acotado si un admin le carga divisiones (escuelas con un gabinete por
turno). Los otros paneles son fail-closed porque el rol se asigna por caminos que no preguntan por
divisiones; acá eso es justamente lo buscado, y está escrito y testeado para que nadie lo "arregle".

**3. La autorización nunca lee el snapshot.** Un alumno no tiene división propia: se deduce de
`Course.students`. `SoeCase.division` es un snapshot para listar sin joins, pero `alumnoEnScope()`
resuelve las divisiones **actuales** con una query. Si al chico lo cambiaron de curso, lo ve el SOE
del curso nuevo.

### Fuera de alcance, decidido

**Adjuntos** (informes escaneados) — y no por recortar: los adjuntos de hoy van a disco con
`diskStorage` y se sirven por una URL adivinable. Un informe psicológico de un menor no puede vivir
ahí; necesita ruta propia con guarda de lectura, que es otra spec. También quedaron afuera el pedido
de intervención del docente ("Derivar al SOE" desde la ficha), las alertas automáticas de riesgo, el
export a PDF y la mensajería con la familia.

**El alumno y la familia no ven absolutamente nada**: no hay ninguna ruta del lado del alumno.

### Archivos

Nuevos: `models/SoeCase.js`, `middleware/soe.js`, `routes/soe.js`, `services/soeAcceso.js` (todas las
reglas puras), `services/soeIndicadores.js`, `views/soe/{index,alumnos,legajo,derivaciones}.ejs`,
`views/partials/soe-{nav,styles}.ejs`, `tests/unit/soe{Acceso,Scope}.test.js`.
Tocados: `models/School.js` (`soeAccess`), `server.js` (mount, `.select()` de la escuela y redirect
de `/`), `config/sections.js` (panel + 3 solapas), `config/audit-actions.js` (6 acciones y la
categoría `soe`), `views/superadmin/roles.ejs` y `routes/roles.js` (la tarjeta de configuración),
`tests/roles/check-roles.js`, `tests/smoke/specs.js`.

**Cambio en la base**: colección nueva `soecases` + campo `soeAccess` en `School`. Los dos aditivos:
ninguna escuela ni usuario existente necesita migración, y nada de lo ya cargado cambia.

### Verificación

34 unitarios nuevos (`soeAcceso` + `soeScope`), suite completa **435/435**. Matriz de roles: las 44
secciones × 8 roles, **44/44 en todos, sin fugas**. Y en el navegador, con datos reales de la escuela:
se abrió un legajo, se cargó una entrevista fechada el 10/08 (que se imprimió 10/08 y no 09/08 — la
trampa de zona horaria del proyecto), se derivó con seguimiento vencido y apareció resaltada en las
tres pantallas. La prueba que más importa, corrida de punta a punta: con el directivo en nivel
`resumen`, ninguno de los cinco textos clínicos aparece en el HTML que llega al navegador, no se le
dibuja ningún formulario, y tanto él como el superadmin reciben 403 al intentar escribir — **23/23**.

**Una excepción documentada en `tests/roles/check-roles.js`**: el paso 3 asume "figura en `roles` →
entra". El panel del SOE es el único donde eso no vale, porque la puerta la abre `School.soeAccess`.
Con una escuela sin configurar, lo correcto es que directivo y admin reciban 403, y así se verifica.

## Solapa "Actividades Diarias" del directivo (2026-08-17)

Pedido del usuario: *"me gusta la manera que manejaste el calendario en el rol de preceptor, quiero una nueva solapa en el rol de directivo"*. Dirección no tenía forma de responder **quién cargó actividad y quién no** en un período: el calendario del preceptor contesta otra pregunta —un curso, un mes, día por día— y hay que entrar división por división para armarse el panorama.

**Qué es**: `/directivo/actividades-diarias`. Una fila por curso × materia con todas las materias de la escuela, filtro de fechas desde/hasta, atajos **Día de hoy** y **Semanal**, y cada fila marcada **Entregado** o **Pendiente**.

**Las decisiones que le dan forma**, todas cerradas con el usuario antes de escribir código (ver `specs/directivo-actividades-diarias.spec.md`):

- **"Entregado" mide al DOCENTE, no al alumno**: que haya cargado al menos una actividad en el rango. La tasa de entrega de los alumnos ya vive en `/directivo/courses` y son dos preguntas distintas.
- **La fecha es elegible**: por *creación* (`createdAt`, "¿el docente dejó trabajo?") o por *entrega* (`dueDate`, "¿qué le vence al alumno?"). En modo entrega las actividades **sin fecha límite no cuentan** —`dueDate` es nullable— así que un mismo docente puede figurar Entregado en un modo y Pendiente en el otro. La pantalla lo avisa en vez de dejar que se lea como un error.
- **"Semanal" es lunes a viernes**, la semana escolar. El fin de semana no tiene actividad que mirar.
- **El denominador son TODAS las materias del alcance**, tengan o no actividad: entregadas + pendientes = total, siempre. Contar solo las que cargaron algo convertiría la pantalla en la lista de los que sí cumplieron, que es justo la mitad que no se busca.
- **Los totales de arriba se calculan sobre el set completo**, antes del filtro de estado. Recalcularlos sobre lo filtrado haría que "Solo pendientes" muestre siempre "0 con actividad".

**Dónde vive el código**: la lógica se agregó a `services/actividadesDelDia.js`, el mismo service del calendario del preceptor, en vez de un archivo nuevo. La regla de qué cuenta como actividad tiene que ser **una sola**: dos copias es cómo las dos pantallas empiezan a contestar distinto sobre el mismo hecho. Lo que cambia entre pantallas va como parámetro (`campo`), no como copia. El día lo sigue decidiendo `live.diaEscolar` — ni un `Intl.DateTimeFormat` nuevo, que es como vuelve el bug de las tres horas.

**Sin cambios en la base**: ni campo, ni colección, ni migración, ni índice. La solapa se registra en `config/sections.js` y es **configurable desde `/superadmin/roles`** (denegarla da 403 en la ruta, no solo la esconde del menú).

**Todos los filtros llegan sucios y ninguno rompe**: un rango dado vuelta, `desde=ayer`, un `campo` inventado o un id de división mal formado caen al default en vez de devolver error. Son filtros de una pantalla de consulta, no recursos pedidos. Hay un tope de 366 días para que un rango escrito a mano en la URL no cuelgue el aggregate.

**Verificado contra el espejo local** (579 materias, 40 divisiones, 672 actividades): del 1/6 al 17/8 la pantalla da 311 con actividad y 268 pendientes, y un conteo independiente hecho a mano contra la base da exactamente lo mismo.

**Tests**: 32 unitarios nuevos en `tests/unit/actividadesDelDia.test.js` (el del domingo se verificó rompiendo `rangoDeSemana` a propósito: `dow - 1` manda al lunes de la semana *siguiente* y el test lo caza), un spec de smoke con los filtros y los rangos inválidos, y la solapa sumada a la lista de toggles de la matriz de roles.

## Plan de Futuras Actualizaciones (Roadmap)

> Backlog completo y detallado en la memoria del proyecto (`audit_backlog.md`).
> **Sincronizado con el backlog el 2026-08-18.** Suites de referencia a esa fecha: **328 smoke ·
> 366 unitarios · 17 de imágenes · matriz de roles sin hallazgos**. Lo que se resuelve se saca
> de acá: si un renglón dice "pendiente", es porque lo sigue estando.

### 🔴 Investigaciones abiertas
- ~~**Producción no carga a la mañana**~~ **CERRADA el 2026-08-18: es el Tailscale Funnel.** El watchdog midió la semana del 11 al 17/08 y **todas** las fallas de la franja 6-11 son de capa 5/6 (`dns-funnel` o `funnel`): *"la aplicación está sana, pero el nombre público no resuelve desde internet"*. Adentro el servidor contesta en 1 ms con load 0,00 y 2,5 GB de 15 usados. Fallas por hora: 06:00 → 17/180 · 07:00 → 7 · 08:00 → 7 · 09:00 → 4 · 10:00 → 1 · 11:00 → 14. Son cortes intermitentes de 1-2 minutos, no una caída sostenida, lo que explica el *"después se normaliza"*. **El código no tiene nada que ver.** El parche conocido es `tailscale funnel reset && tailscale funnel --bg 3000`; el arreglo de fondo es **sacar el Funnel del camino**: la máquina ya corre `server-caddy-1` para otro proyecto, así que servir la escuela por un dominio propio detrás de Caddy es una opción concreta, no un rediseño. **Esa es la conversación siguiente.**
- **Docentes reportan error al subir PDFs de ~3 MB** ("antes andaba"). Local no reproduce (1/3/5/10/25 MB dan 200 en <400 ms) y los topes nunca cambiaron, así que es de producción. Desde el 2026-08-15 hay con qué diagnosticarlo: pedir el código `SUB-XXXXXX` del cartel y correr `node tools/ver-subida.js <código>`. Falta el caso real.

### Mantenimiento de producción — código listo, falta ejecutar
- **Correr el backfill de imágenes** (`optimize-existing-images.js`): ~198 MB históricos sin comprimir. ⚠️ Toca la base (reescribe URLs), va con backup + modo mantenimiento. Ver el changelog de v1.0.7. ✅ **`sharp` ya está instalado en el servidor** (verificado el 2026-08-18): el único paso que falta es correr el backfill.
- **Activar PostHog**: el código está completo y en modo no-op. Falta crear el proyecto en Cloud EU, cargar `POSTHOG_KEY` en el `.env` de producción y `pm2 reload --update-env`. Ver la sección "Analítica de producto".
- ~~**Instalar `ghostscript` en el servidor**~~ ✅ **HECHO** — verificado el 2026-08-18: `gs` está en `/usr/bin/gs`, así que la compresión de PDFs del backup ya está habilitada (315 MB de ahorro potencial). Falta usarla una vez y medir el ahorro real.
- **Reflejar en producción la consolidación de materias duplicadas**: las 62 fusiones se aplicaron solo contra el espejo local. La vía acordada es backup local → restore en producción, y exige auditar de nuevo antes (comparar un backup fresco de producción contra el local, colección por colección).

### Cambios que tocan la BD de producción — avisar antes
- **Índice parcial en `schools.inviteToken`**: `partialFilterExpression: { inviteToken: { $type: 'string' } }` en lugar de `sparse`. Es el arreglo de fondo del bug que impedía crear una segunda escuela (`sparse` saltea el campo ausente, no el que vale `null`). Necesita `dropIndex` + `createIndex`.
- **Índice único en `subjects` `{school, name}`**: hoy la colección solo tiene `_id_`, así que el catch del 11000 de `POST /admin/subjects/create` es código muerto y los nombres repetidos entran. Engancha con la deuda de `Subject`↔`Course` por texto.
- **Índice `{ course: 1, createdAt: -1 }` en `activities`**: no se agregó a propósito (el `{course:1, availableFrom:1}` cubre el prefijo). Es el candidato si el calendario del mes se nota lento con uso real.

### Correcciones / deuda técnica pendiente
- ~~**Fechas sin zona horaria fija fuera de la sala en vivo**~~ ✅ **RESUELTO el 2026-08-18** — barrido completo: 61 fechas migradas a `fmt` (servidor) y `Fecha` (navegador), fijado por `tests/unit/zonaHoraria.test.js`. Ver el changelog. Lo único que sigue formateando por su cuenta son **9 usos de `toLocaleString` sobre números** (separadores de miles), que no tienen nada que ver con la zona horaria.
- **`generalLimiter` cuenta por IP, no por usuario** (`server.js`): la escuela entera sale por una sola IP pública (NAT). Se subió el cupo a 12000/15min el 2026-08-13 como parche; la mejora de fondo es adelantar `cookieParser` y verificar el JWT en el `keyGenerator`, como ya hacen los limiters de `middleware/rate-limits.js`. Ojo: el techo efectivo es ~2x por los 2 workers, cada uno con su `MemoryStore`.
- **Escribir `specs/sala-adjuntos.spec.md` y modularizar `routes/rooms.js`** (~700 líneas, mezcla la sala con toda la mecánica de adjuntos). Pedido explícito del usuario al implementarlos derecho. Lo natural es sacar el almacenamiento a `services/roomAttachments.js`; `arreglarNombre()` está duplicado a propósito con `routes/activities.js` y ahí es candidato a unificarse.
- **`backups/` no tiene retención ni UI**: crece sin límite (2,8 GB hoy) y no se ve desde ningún panel. Cada `/restore` le suma un tarball del tamaño del backup completo.
- **El envío del backup por FTP sigue siendo manual** (desde 2026-08-17 existe `/superadmin/backup/ftp/enviar`, pero hay que apretar el botón). Automatizarlo por cron es el Nivel 2: reusar `buildBackupStaging()` + `enviarBackup()` desde un timer, que tiene que correr en un solo worker de PM2 (mismo patrón que el promotor de mantenimiento, vía `NODE_APP_INSTANCE`).
- **Restaurar desde un `.tar.gz` ya presente en el server** (`backups/`, subido por scp/rsync): hoy el único camino es el upload por HTTP en `POST /preview`, que para backups grandes suma el `requestTimeout` y una copia extra en `os.tmpdir()`.
- **Los archivos de disco no entran al backup**: `routes/backup.js` respalda colecciones, no filesystem. Un restore deja entregas, adjuntos de actividad y adjuntos de sala apuntando a archivos que no están (la ruta contesta 404, no rompe).
- **Quedan directorios `classroom-backup-staging-*` huérfanos en `os.tmpdir()`** (2 del 2026-08-14 en la máquina local). No son peligrosos —contienen enlaces, no copias— pero se acumulan. Falta averiguar por qué camino de `GET /download` se escapan del `limpiarStaging()`; el envío por FTP no dejó ninguno.
- Extender el optimizador de imágenes a las **fotos en entregas de alumnos y a los adjuntos de actividades**: medido el 2026-08-08 son **511 MB en entregas + 400 MB en adjuntos**, con 581 MB de imágenes sin optimizar entre las dos. Preset más conservador (2000 px, calidad 85) porque puede ser la foto de una hoja escrita que el docente necesita leer. Necesita ventana de mantenimiento (achica el disco de verdad, a diferencia de la compresión del backup).
- **No se puede BORRAR una nota ya puesta** desde la UI: se puede vaciar la devolución, pero no la nota. Con `points` opcional (2026-08-13) ahora sería fácil de agregar.
- **XSS de baja severidad preexistente**: `renderTeacherDetail` interpola `sg.feedback` y `act.description` sin escapar. Es contenido del propio docente visto por él, pero el feedback ahora lo escribe más gente.
- **Etapa 2 de permisos por rol**: las pestañas de adentro de la materia (Novedades, Actividades, Calificaciones, Mis notas, Personas) son tabs client-side sin URL propia, así que ocultarlas no bloquearía nada. Cumplir "oculta y bloquea" ahí exige `requireSection` endpoint por endpoint más un `panel:'course'` en `config/sections.js`. Es lo único que le daría a **Docente** y **Alumno** algo real que configurar. Descartado para la v1 por decisión del usuario.
- ~~**Revisión de UI móvil**~~ ✅ **COMPLETA el 2026-08-17**: los 7 roles con panel propio (alumno, docente, preceptor, directivo, jefe, admin, superadmin); `soe` no tiene panel. Lo que queda es **no reintroducir** los 8 patrones documentados en la memoria del proyecto, fijados por `tests/unit/movil.test.js`.
- **Limpieza de archivos huérfanos** cuando se cancela el creador full-page sin guardar (los adjuntos ya subidos quedan en disco).
- **Relación `Subject` ↔ `Course` por texto** (frágil ante renombrados). Migrar a ObjectId ref.
- **Eliminación de escuela sin cascada** (`POST /superadmin/schools/:id/delete` deja usuarios/cursos huérfanos).
- **Los importadores no validan el rol del docente**: los flujos `cargos`, `sistema` y `alumnos` de `routes/admin.js` y `routes/superadmin.js` crean materias con `owner: teacherId` sin pasar por `resolveCourseTeacher`. Hoy no se explota porque los docentes se crean en el mismo flujo, pero es la puerta que estaba abierta en `edit`.
- **`middleware/admin.js:requireSuperadmin` y `middleware/superadmin.js:requireSuperAdmin` son duplicados exactos** (distinta capitalización). No se consolidaron para no tocar los 5 routers que los usan.
- **El rol `soe` está en el enum pero no tiene panel** ni middleware que lo acepte: en la grilla de Roles su columna sale casi entera en `—`.
- **Terminología confusa en admin-nav** ("Cursos" → Divisions, "Materias" → Courses, "Catálogo" → Subjects).
- **Alta de usuario duplicada en dos vistas**: el modal de `views/admin/users.ejs` y la página `views/admin/user-form.ejs` son el mismo formulario mantenido por separado. Cualquier campo nuevo hay que agregarlo dos veces o queda a medias. Unificar en un partial.
- **`NODE_ENV=production` en el `.env` local**: activa el view cache de Express, así que los cambios en `.ejs` NO se reflejan sin reiniciar el proceso (nodemon tampoco vigila `.ejs`). Es una trampa al desarrollar vistas — parece que el cambio "no se aplicó".

### Datos de producción / del espejo
- **Dos materias sin titular en producción**: hay que asignarles docente desde `/admin/courses` (el borrado del usuario ya ocurrió y no se deshace). No requiere tocar la base.
- **Completar el DNI de las 118 cuentas que no lo tienen** (109 alumnos, 8 docentes, el superadmin). Hasta que estén todas, el DNI no puede marcarse `required` en el schema. Falta decidir entre un listado en `/admin` o un backfill contra los padrones.
- **Alumnos con el mismo DNI que NO comparten curso**: `dni-duplicado-en-curso` ya deja fusionarlos eligiendo cuenta y correo, pero solo dentro de una misma división. Quedan 4 pares sin herramienta; agruparlos por escuela+DNI exige decidir antes en qué curso queda el alumno fusionado, que es justo el dato que no está en la base.
- **Referencias colgadas históricas en `Course.students`**: ids de alumnos borrados antes del fix de 2026-08-03. No rompen nada (Mongoose los descarta al popular) pero **inflan el contador de alumnos** del listado de admin, que usa `students.length` crudo. Falta un diagnóstico en `/superadmin/otros` que los cuente y limpie.

### Tests
- **45 rutas sin ejercitar por ninguna suite** (medido el 2026-08-15, excluyendo el spec `objectid-invalido-da-404` que nombra 384 rutas y falsea la cuenta). Lo más grande: **plantillas de tareas entera** (12 de 14 rutas), 12 rutas de edición del panel admin, 6 de actividades, 5 del superadmin.
- **El smoke deja ~3 cuentas huérfanas por corrida**: los specs de limpieza no cubren los patrones `sinmateria.*`, `scoped.teacher.new.*`, `dnipuntos.*`, `latejoiner.*`, `am.otro.*`. No toca producción, pero infla los contadores del espejo local.
- El spec `suggestions-student-sees-answer-and-badge` depende de `suggestions-superadmin-can-respond` pero no declara su mismo `requiresEnv`: sin credenciales de superadmin falla en cascada en vez de saltearse.
- **Nota operativa**: la máquina de desarrollo se queda sin RAM corriendo suites en paralelo (`node --test` levanta un proceso por archivo). Si aparecen fallos raros con "out of memory", correr con `--test-concurrency=1` antes de sospechar una regresión.

### Funcionalidades faltantes — rápidas
- Editar / eliminar novedades y comentarios (no existen `PUT`/`DELETE` en `Announcement`).
- Agregar / quitar adjuntos de una actividad existente (`PUT /activities/:id` no toca `attachments[]`).
- Mostrar DNI en el perfil del usuario.
- Mostrar `gradedAt` (fecha de calificación) al alumno.

### Funcionalidades faltantes — mediana complejidad
- Export del gradebook completo (todos los alumnos × todas las actividades).
- Deeplink directo a una actividad (URL propia por actividad). **A medias desde el 2026-08-12**: existe `/courses/:id?actividad=<id>`, que abre la solapa Actividades y el detalle al cargar (lo usa el botón "Ver actividad" del chat de la sala). Falta la URL propia de verdad — `/activities/:id` con su vista, para poder compartirla sin depender del curso.
- Vista "Mis entregas" consolidada cross-curso para el alumno.
- Link al perfil del alumno desde el tab Personas.
- ~~Impersonación desde el superadmin.~~ **Ya existe**: `POST /admin/users/:id/impersonate` (el superadmin pasa el chequeo de escuela porque la suya es `null`) y se sale con `GET /exit-impersonate`. Verificado el 2026-08-17. Lo que nunca existió es una ruta bajo `/superadmin`, que era lo que buscaba la auditoría original.

### Funcionalidades faltantes — mayor complejidad
- Notificaciones (in-app / email / push).
- Preview de temas para el admin antes de aceptarlos.

### Pendientes del SOE (v2) — decididos fuera de alcance el 2026-08-18
- **Adjuntos en el legajo** (informes escaneados, certificados). Bloqueado por una razón
  concreta: los adjuntos de hoy van a disco con `diskStorage` y se sirven por una URL
  adivinable. Un informe psicológico de un menor necesita una ruta propia con guarda de
  lectura antes de que exista el botón de subir.
- **"Derivar al SOE" desde la ficha del alumno** para docente y preceptor, con bandeja de
  pedidos pendientes en el panel. Hoy el legajo lo abre solo el gabinete.
- **Alertas automáticas**: sugerir alumnos en riesgo (ausentismo, materias bajas, sin
  entregar) que todavía no tienen legajo. Los datos ya están en `services/soeIndicadores.js`.
- **Export del legajo a PDF** para el pase de escuela o el pedido de un organismo.

> ⚠️ **Nota de mantenimiento**: `agente.md` conserva desactualizaciones anteriores a esta revisión en las secciones de Pantallas, Rutas y Vistas (ej: no documenta los modelos School/Division/Activity/Submission/Suggestion, ni las rutas de superadmin, actividades y sugerencias). Pendiente una pasada completa de actualización del documento.
