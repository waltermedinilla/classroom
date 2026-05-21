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
| `middleware/auth.js` | `requireAuth` | Verifica JWT en cookie `token`, redirige a `/login` si inválido |
| `middleware/auth.js` | `checkUser` | Global; setea `res.locals.user`, `res.locals.impersonating`, `res.locals.roleNames` |
| `middleware/admin.js` | `requireAdmin` | Retorna 403 si no es admin |

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
| `name` | String | Requerido, trim |
| `section` | String | Default `''` |
| `subject` | String | Default `''` — nombre de la materia (texto libre) |
| `room` | String | Default `''` |
| `code` | String | Único, auto-generado (UUID 6 chars uppercase) en default |
| `owner` | ObjectId (ref: User) | Requerido — docente del curso |
| `students` | [ObjectId (ref: User)] | Alumnos inscriptos |

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
2. `connect-mongo` y `express-session` en package.json pero no usados
3. Archivos subidos a disco local (`public/uploads/`), sin cloud storage
4. Sin recuperación de contraseña ni verificación de email
5. Sin rate limiting ni Helmet
6. `Course.subject` es string libre — no hay FK hacia `Subject.name`; una futura mejora sería usar ObjectId ref
