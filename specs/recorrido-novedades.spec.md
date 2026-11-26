# Novedades guiadas (pantalla oscura que ilumina lo nuevo)

> **Estado:** APROBADA por Walter el 2026-11-26 ("sí, dejalo así, y continuamos"). Texto del
> cartel de Transmitir aprobado tal cual.
> Flujo SDD: arquitecto → **spec aprobada** → tester → implementador → revisor.
> Base de código revisada: `origin/main` v1.0.137.

## Pedido

> "cuando se activa una nueva funcionalidad, la pantalla aparece como obscura, y se ilumina una
> opción o botón para poder 'mostrarle' al usuario lo que puede hacer. Una especie de tutorial,
> en la misma página. En el celular y en la computadora. Quiero que se muestre o ilumine el
> botón de transmitir."
>
> "quiero que se le habilite solamente a los usuarios que están habilitados para eso."
>
> "ten en cuenta que esta opción la quiero si cada vez que pueda generar un nuevo botón pueda
> visualizarse como modo de tutorial para el rol necesario." — "no solo nuevo botón, sino
> puede ser cualquier novedad."

Es decir: **una herramienta general de novedades**, no un cartel para Transmitir. Transmitir es
solo la primera novedad que se carga.

La maqueta aprobada es la del 2026-11-26: fondo oscuro, lo nuevo iluminado con un anillo
amarillo que late, y pegado a lo nuevo un cartel con "Nuevo", título, texto, **Omitir** y
**Entendido**.

## Qué es una novedad

Cualquier cosa que cambie para un rol y convenga mostrar:

- un **botón** nuevo (Transmitir);
- una **solapa** o una **sección** nueva del menú (por ejemplo "Rotación" del Jefe de Taller);
- una **parte** de una pantalla que cambió de lugar o de forma (por ejemplo "Quién está");
- un **cambio general** que no se puede señalar con el dedo ("ahora la sala tiene otro
  diseño"): ahí el cartel va **en el centro**, sin iluminar nada.

Una novedad puede tener **varios pasos** ("1 de 3 · Siguiente"), cada uno iluminando una cosa
distinta de la misma pantalla.

## Decisiones de diseño

### D1 — Una lista única de novedades: `config/novedades.js`

Cada novedad es una entrada. Cargar una novedad nueva es **agregar una entrada**; la pieza
visual no se toca.

```js
{
  id:      'transmitir',                 // único y para siempre; con él se recuerda quién la vio
  desde:   '2026-11-26',                 // la fecha en que salió
  hasta:   null,                         // opcional: después de esta fecha ya no se muestra
  roles:   ['teacher', 'jefe', 'jefetaller', 'directivo', 'admin', 'superadmin'],
  modulo:  'transmision',                // opcional: el módulo que tiene que estar prendido
                                         // (y, si es "por persona", la persona en la lista)
  pantalla: /^\/courses\/[0-9a-f]{24}$/, // en qué páginas puede aparecer
  pasos: [
    { donde: '#txAbrir', titulo: 'Transmití tu clase en vivo', texto: '…' },
    // { donde: null, … }  → cartel centrado, sin iluminar nada
  ],
}
```

### D2 — A quién se le muestra: rol, módulo y lo que ve en pantalla

Las tres condiciones tienen que cumplirse:

1. **Rol.** El rol del usuario está en `roles`.
2. **Habilitado.** Si la novedad tiene `modulo`, se pregunta con la función que ya existe,
   `moduloActivoPara(school, user, modulo)` (`config/modulos.js`). Esa función ya resuelve los
   módulos de escuela y los de "por persona" (como "¿Quiénes pueden transmitir?"). **No se
   escribe una regla nueva:** si mañana el superadmin saca a un docente de la lista, la
   novedad deja de mostrársele sola.
3. **Lo nuevo está a la vista.** En el navegador, cada paso se muestra solo si lo que ilumina
   está visible (`offsetParent !== null`). Si no está (sala cerrada, ya se está transmitiendo,
   la persona no es docente de esa materia y por eso no tiene el botón), ese paso se saltea; si
   no queda ninguno, no aparece nada y **no se marca como vista**: aparecerá cuando lo nuevo
   esté en pantalla.

La tercera condición es la que cubre lo fino sin código extra: el botón Transmitir solo se
dibuja para quien puede transmitir en esa sala (`puedeEmitir`), así que la novedad hereda esa
regla.

### D3 — Una sola vez por persona, guardado en el usuario

Campo nuevo `User.novedadesVistas: [{ id, fecha, como }]`: qué novedad vio, cuándo y cómo la
cerró (`'entendido'` o `'omitir'`; tocar afuera o Esc cuentan como `'omitir'`). Se marca con
`POST /novedades/:id/vista` (body `{ como }`). Al estar en el usuario, no se repite desde otro
equipo, y es lo que cuenta la pantalla del superadmin (D7).

- Si el POST falla, se cierra igual y se recuerda en `sessionStorage` para esa pestaña; se
  vuelve a intentar la próxima vez.
- Si hay **varias novedades** pendientes en la misma pantalla, se muestran **de a una**, de la
  más vieja a la más nueva. Nunca dos carteles a la vez.

### D4 — Funciona en todas las pantallas

- Un middleware (`middleware/novedades.js`) calcula, para cada página, las novedades que
  corresponden (D2, pasos 1 y 2) y todavía no vio, y las deja en `res.locals.novedades`.
- `views/partials/footer.ejs` (que ya está en todas las vistas con header, regla del proyecto)
  las pasa al navegador en un `data-` **escapado** y carga `public/js/novedades.js` solo si hay
  alguna. Las páginas sin novedades no bajan nada.
- No corre para alumnos si ninguna novedad es para alumnos, ni mientras se suplanta a otro
  usuario (impersonación).

### D5 — La pieza visual (`public/js/novedades.js`)

- El fondo oscuro con el "hueco" iluminado y el anillo que late; o, sin `donde`, el cartel en
  el centro.
- El cartel se ubica debajo de lo iluminado si entra; si no, arriba. En el celular ocupa casi
  todo el ancho.
- Se recoloca al cambiar el tamaño de la ventana o al girar el celular.
- Accesible: `role="dialog"`, `aria-modal`, foco en el botón principal, Esc cierra; con
  "reducir movimiento" el anillo no late.
- Mientras está abierto no se puede tocar la página (que nadie transmita sin querer).
- Los textos son **texto**: la negrita se marca con `**…**` y se arma con nodos, nunca con
  `innerHTML`.
- Si algo falla, se cierra y la pantalla sigue igual.

### D7 — Cuántos la vieron (pedido del 2026-11-26)

> "si quiero un botón que me muestre cuántos abrieron la novedad."

En el panel del superadmin, una **solapa "Novedades"** (en `views/partials/superadmin-nav.ejs`,
junto a Usuarios, Sugerencias, Monitor…; pedido del 2026-11-26: "quiero que solapa") abre
`GET /superadmin/novedades`: una fila por novedad, con filtro por escuela.

| Novedad | Desde | Para | Les corresponde | La vieron | Entendido · Omitir | % |
|---|---|---|---|---|---|---|
| Transmití tu clase en vivo | 26/11 | Docentes habilitados para transmitir | 12 | 7 | 6 · 1 | 58 % |

- **Les corresponde**: los usuarios activos de esa escuela con un rol de la novedad y, si tiene
  módulo, habilitados (`moduloActivoPara`, la misma función de D2). Es "a cuántos les podría
  aparecer", no "a cuántos les apareció": a un docente habilitado que todavía no abrió su sala no
  le apareció nunca.
- **La vieron**: los que tienen la novedad en `novedadesVistas`, separados en Entendido y
  Omitir.
- Tocando una fila se ve la lista de nombres: quiénes la vieron (con la fecha) y quiénes todavía
  no.
- Es de solo lectura. La ve solo el superadmin.

### D8 — "Volver a ver las novedades" en Mi perfil (pedido del 2026-11-26)

En **Mi perfil**, que existe para **todos los roles**, un botón **"Volver a ver las
novedades"**. Solo aparece si la persona tiene alguna novedad que le corresponda (D2, pasos 1 y
2). Al tocarlo, pide confirmación y hace `POST /novedades/repetir`, que borra de **su**
`novedadesVistas` las novedades que le corresponden: la próxima vez que esté en la pantalla de
cada una, le vuelve a aparecer.

- Para las cuentas de la pantalla del superadmin (D7), repetir **no borra la historia**: se
  guarda `repetidaEn` en cada entrada en vez de sacarla, y la vuelta a ver actualiza `fecha` y
  `como`. Así "la vieron" no baja porque alguien quiso repasar.
- Solo actúa sobre el usuario que lo pide. Suplantando a otro no se muestra.

### D6 — Regla de trabajo para lo que venga

Desde esta spec, **cada spec que agregue o cambie algo visible para un rol** responde en una
línea: *"¿Lleva novedad guiada? Sí/No"*. Si es sí, la entrada de `config/novedades.js` (roles,
módulo, pantalla, pasos y textos) se escribe en la misma spec y se aprueba junto con ella. Se
agrega esta regla a `agente.md`.

## Primera novedad: `transmitir`

| | |
|---|---|
| Roles | Los que pueden ser docentes de una materia: `teacher`, `jefe`, `jefetaller`, `directivo`, `admin`, `superadmin` |
| Módulo | `transmision` (y la persona en "¿Quiénes pueden transmitir?") |
| Pantalla | La página de una materia (`/courses/:id`), donde vive la sala en vivo |
| Ilumina | `#txAbrir` (el botón **Transmitir**) |
| Título | Transmití tu clase en vivo |
| Texto | Con **Transmitir** tus alumnos te ven y te escuchan desde su casa: podés compartir la cámara, el micrófono o tu pantalla. Para terminar, tocá **Dejar de transmitir** en el mismo lugar. |

## Reglas

- **RN-1** Una novedad se muestra solo si cumple D2 completo.
- **RN-2** Cada persona ve cada novedad una vez (D3). Una novedad que nunca llegó a estar a la
  vista no se marca.
- **RN-3** `POST /novedades/:id/vista` solo acepta ids de `config/novedades.js` (otro → 400),
  requiere sesión y no duplica: hay una sola entrada por novedad y usuario. Si estaba pedida
  para repetir (D8), se actualizan `fecha` y `como` y se limpia `repetidaEn`; si no, no cambia.
- **RN-3b** Una novedad está "pendiente" para alguien si no tiene entrada, o si tiene
  `repetidaEn`.
- **RN-4** El `id` de una novedad no se cambia ni se reutiliza: cambiarlo haría que todos la
  vuelvan a ver.
- **RN-5** Con `hasta` vencido, la novedad deja de mostrarse aunque no se haya visto.
- **RN-6** Nunca dos carteles a la vez (D3).
- **RN-7** Un error del script nunca deja la pantalla oscura ni bloqueada.

## Lugares a tocar

| Archivo | Qué |
|---|---|
| `models/User.js` | `novedadesVistas: [{ id: String, fecha: Date, como: 'entendido' \| 'omitir', repetidaEn: Date \| null }]`, default `[]` |
| `config/novedades.js` (nuevo) | La lista, con la validación de cada entrada al arrancar |
| `middleware/novedades.js` (nuevo) + `server.js` | Calcular `res.locals.novedades` |
| `routes/novedades.js` (nuevo) + `server.js` | `POST /novedades/:id/vista` |
| `public/js/novedades.js` (nuevo) | La pieza visual |
| `views/partials/footer.ejs` | Pasar las novedades y cargar el script solo si hay |
| `middleware/auth.js` | Que `novedadesVistas` venga en el usuario cacheado |
| `routes/superadmin.js`, `views/superadmin/novedades.ejs` (nuevo), `views/partials/superadmin-nav.ejs` | La pantalla de D7 y su solapa |
| `views/profile.ejs` + `routes/` del perfil | "Volver a ver las novedades" (D8) |
| `agente.md` | La regla D6 |

## Criterios de aceptación

- **NV-01** Un docente **habilitado** para transmitir, en su materia con la sala abierta, ve la
  novedad la primera vez; después de "Entendido" no la ve más, tampoco desde otro equipo.
- **NV-02** Un docente **no habilitado** nunca la ve; con el módulo apagado en la escuela,
  nadie la ve.
- **NV-03** Un alumno, un preceptor o una secretaria nunca la ven (rol).
- **NV-04** Con la sala cerrada o mientras se transmite (el botón no está a la vista) no
  aparece y **no se marca**; aparece la próxima vez que el botón esté.
- **NV-05** Una novedad de prueba con `donde: null` muestra el cartel centrado.
- **NV-06** Una novedad de prueba de 3 pasos muestra "1 de 3 · Siguiente" y saltea el paso
  cuyo elemento no está.
- **NV-07** Dos novedades pendientes en la misma pantalla salen de a una.
- **NV-08** `POST /novedades/inventada/vista` → 400; sin sesión → login.
- **NV-09** `config/novedades.js` rechaza al arrancar un `id` repetido, un rol inexistente o un
  módulo que no existe.
- **NV-10** Los textos se muestran como texto (un `<b>` escrito en el texto no se interpreta).
- **NV-12** `/superadmin/novedades` cuenta bien: con 3 docentes habilitados, 1 no habilitado
  y 2 que la vieron (uno Entendido, uno Omitir), muestra 3 · 2 · 1 · 1 · 67 %. Cualquier otro
  rol recibe 403.
- **NV-13** En Mi perfil, con cualquier rol que tenga novedades, aparece "Volver a ver las
  novedades"; sin novedades que le correspondan, no aparece. Después de usarlo, la novedad
  vuelve a salir en su pantalla y la cuenta del superadmin no baja.
- **NV-11** En la computadora y en el celular (parado y de costado) el cartel queda dentro de la
  pantalla y la luz sobre lo nuevo.

## Plan de migración

Un campo nuevo en `User` con default `[]`. No toca documentos existentes, no hay colecciones
nuevas, nada que avisar antes del deploy.

## Preguntas abiertas

1. ¿El texto del cartel de Transmitir queda como está en la tabla?
2. ~~¿"Volver a ver las novedades" en Mi perfil?~~ **Sí, para cada rol** (2026-11-26): D8.
3. ~~¿Pantalla del superadmin?~~ **Sí** (2026-11-26): D7.
