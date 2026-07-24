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
| `preceptor` | Preceptor | Preceptor |
| `soe` | SOE | SOE |
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

### 2. Register (`/register`)
- Formulario: nombre, email, contraseña, rol (select — sin admin)
- El primer usuario registrado se crea como `admin`
- JS: `public/js/register.js`

### 3. Dashboard / Tus Clases (`/courses`)
- Header con logo, avatar y menú de usuario
- Drawer lateral con navegación
- Sección "Creadas por ti" — tarjetas azules
- Sección "Unidas por ti" — tarjetas verdes
- Modal "Crear clase": nombre (req), sección, materia, aula
- Modal "Unirse a clase": código de 6 caracteres
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

---

## Backend (API)

### Middleware
| Archivo | Export | Función |
|---|---|---|
| `middleware/auth.js` | `requireAuth` | Verifica JWT en cookie `token`, redirige a `/login` si inválido. Setea `req.userId` |
| `middleware/auth.js` | `checkUser` | Global; setea `res.locals.user`, `res.locals.impersonating`. Actualiza `User.lastSeen` (throttle 5 min) |
| `middleware/admin.js` | `requireAdmin` | Retorna 403 si el rol no es `admin` **ni** `superadmin` (el superadmin también pasa) |
| `middleware/superadmin.js` | `requireSuperAdmin` | Retorna 403 si el rol no es exactamente `superadmin` |

> El mapa de traducción `res.locals.roleNames` (rol → español) se define como middleware global directamente en `server.js`, no en `middleware/auth.js`.

### Modelos (MongoDB/Mongoose)

#### User
| Campo | Tipo | Detalle |
|---|---|---|
| `name` | String | Requerido, trim |
| `email` | String | Requerido, único, lowercase, trim |
| `password` | String | Requerido, minlength **5**, hasheado con bcrypt en pre-save |
| `role` | String | Enum: admin/directivo/teacher/preceptor/soe/student |
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
| GET | `/register` | Renderiza `register.ejs` |
| POST | `/register` | Crea usuario, JWT cookie, JSON `{ user }` |
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
| `register.js` | Submit register → POST `/register` → redirect |
| `dashboard.js` | Modales create/join, escape key, click-outside-close |
| `course.js` | Tabs, formulario anuncio colapsable, post/load announcements |

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

## Notas / Issues Conocidos
1. `GET /courses/create` existe en la ruta pero usa modal en dashboard — no tiene vista propia
2. Archivos subidos a disco local (`public/archivos/` para adjuntos del docente y novedades; `archivos/entregas/` fuera de `public` para entregas de alumnos), sin cloud storage
3. Sin recuperación de contraseña ni verificación de email
4. La relación materia↔curso es por coincidencia de texto (`Subject.name` === `Course.name`), no hay FK. Renombrar una materia rompe la asociación. Mejora futura: `Course.subject` como ObjectId ref
5. Rate limiting (`express-rate-limit`) y Helmet **ya están activos** (ver `server.js`)
6. **Cache por-worker** de usuario y escuela (TTL 45s, ver `middleware/cache.js`): reduce load en Mongo pero no se comparte entre workers de PM2 cluster. Cambios de rol/estado/escuela pueden tardar hasta 45s en aplicar en OTRO worker. Ver mitigaciones en el changelog 2026-07-21.

---

## Historial de Cambios (Changelog)

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

## Plan de Futuras Actualizaciones (Roadmap)

> Backlog completo y detallado en la memoria del proyecto (`audit_backlog.md`). Resumen de lo pendiente:

### Correcciones / deuda técnica pendiente
- Limpieza de archivos huérfanos cuando se cancela el creador full-page sin guardar (los adjuntos ya subidos quedan en disco).
- Relación `Subject` ↔ `Course` por texto (frágil ante renombrados). Migrar a ObjectId ref.
- Eliminación de escuela sin cascada (`POST /superadmin/schools/:id/delete` deja usuarios/cursos huérfanos).
- Terminología confusa en admin-nav ("Cursos" → Divisions, "Materias" → Courses, "Catálogo" → Subjects).

### Funcionalidades faltantes — rápidas
- Editar / eliminar novedades y comentarios (no existen `PUT`/`DELETE` en `Announcement`).
- Agregar / quitar adjuntos de una actividad existente (`PUT /activities/:id` no toca `attachments[]`).
- Mostrar DNI en el perfil del usuario.
- Mostrar `gradedAt` (fecha de calificación) al alumno.

### Funcionalidades faltantes — mediana complejidad
- Export del gradebook completo (todos los alumnos × todas las actividades).
- Deeplink directo a una actividad (URL propia por actividad).
- Vista "Mis entregas" consolidada cross-curso para el alumno.
- Link al perfil del alumno desde el tab Personas.
- Impersonación desde el superadmin.

### Funcionalidades faltantes — mayor complejidad
- Notificaciones (in-app / email / push).
- Preview de temas para el admin antes de aceptarlos.

> ⚠️ **Nota de mantenimiento**: `agente.md` conserva desactualizaciones anteriores a esta revisión en las secciones de Pantallas, Rutas y Vistas (ej: no documenta los modelos School/Division/Activity/Submission/Suggestion, ni las rutas de superadmin, actividades y sugerencias). Pendiente una pasada completa de actualización del documento.
