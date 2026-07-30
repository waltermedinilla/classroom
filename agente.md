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
7. **`public/js/course.js` es compartido por docente y alumno**, pero `views/course.ejs` renderea DOM distinto según el rol (`<% if (course.isTeacher(user._id)) %>`). Todo `document.getElementById(...)` en el **nivel superior** del script debe usar `?.` — si el elemento no existe para ese rol, el `TypeError` corta la ejecución del archivo entero y deja sin inicializar todos los `const`/`let` de más abajo (falla silenciosa, solo visible en la consola del navegador). Ya pasó una vez: ver changelog 2026-07-28 "course.js abortaba entero para el alumno".
8. ~~El smoke test `directivo-sees-courses-with-metrics` falla contra una BD espejada de producción por paginación.~~ **Arreglado el 2026-07-28**: el test ahora busca el curso con `?search=` en vez de esperarlo en la primera página. La suite quedó en **97/97**.
9. Las cuatro rutas de detalle del panel directivo (`/courses/:id`, `/students/:id`, `/teachers/:id`, `/divisions/:id`) devuelven **500 en vez de 404 cuando el `:id` no es un ObjectId válido** — `findById` lanza `CastError` y cae en el `catch` genérico. Con un ID válido pero inexistente sí dan 404 correctamente. Fix: `if (!mongoose.isValidObjectId(req.params.id)) return res.status(404)...` al entrar a cada handler. Conviene revisar si el patrón se repite en `routes/admin.js` y `routes/superadmin.js`.
10. En el listado de divisiones, **la suma de la columna "Alumnos" supera el total de alumnos de la escuela**. No es un error: los alumnos se cuentan únicos *dentro* de cada división, y un alumno puede cursar materias de más de una.

---

## Historial de Cambios (Changelog)

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
- `Course.isTeacher(userId)` — método de instancia, único punto de verdad para "¿es docente de esta materia?" (owner o cualquier coTeacher). Seguro con el campo poblado o sin popular.
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
- **Correr el backfill de imágenes en producción** (`optimize-existing-images.js`). El optimizador ya está activo para las subidas nuevas, pero los ~198 MB históricos siguen en disco. Requiere backup + modo mantenimiento porque actualiza URLs en la base. Ver el changelog de v1.0.7.
- **`npm install` en el servidor antes de desplegar v1.0.7**: `sharp` pasó de `devDependencies` a `dependencies` y el webhook de deploy no corre `npm install`. Sin eso la app arranca igual (degradación prevista) pero no optimiza nada.
- Extender el optimizador a las **fotos en entregas de alumnos** (hoy 0 MB, pero va a crecer). Preset más conservador (2000 px, calidad 85) porque puede ser una foto de una hoja escrita que el docente necesita leer. El spec `entrega-pdf-no-se-toca` ya fija que los PDFs no se toquen.
- El spec `suggestions-student-sees-answer-and-badge` depende de `suggestions-superadmin-can-respond` pero no declara su mismo `requiresEnv`: si se corre el smoke sin credenciales de superadmin, falla en cascada en vez de saltearse.
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
