// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO PÚBLICO — CERRADO desde el 2026-08-23 por pedido del usuario.
//
// Regla de la casa a partir de esta fecha: **las cuentas de alumnos y docentes las crea
// un administrador**, desde `/admin/users/create` (o el superadmin desde `/superadmin`).
// Nadie se da de alta a sí mismo, por ninguna puerta.
//
// Había DOS puertas abiertas y las dos se cierran acá:
//
//   1. `/register` — el "Crear cuenta nueva" que colgaba de la pantalla de login.
//      Era la puerta que el usuario nombró explícitamente.
//
//   2. `/register/invite/:token` — el enlace de invitación por escuela que genera el
//      superadmin. No está en la pantalla de login, pero **crea alumnos y docentes sin
//      que intervenga ningún administrador**: cualquiera con el enlace se daba de alta
//      y, además, ELEGÍA SU PROPIO ROL de una lista que incluye `directivo` y `soe`.
//      El rol `soe` abre el legajo psicopedagógico. Dejarla abierta contradecía la regla
//      de arriba de la forma más cara posible, así que se cierra con el mismo criterio.
//
// Se cierra con flags y no borrando las rutas a propósito: esta puerta ya fue y vino
// varias veces en este proyecto (ver services/joinByCode.js y services/selfEnroll.js,
// que se apagan igual). Volver a abrir cualquiera de las dos es cambiar un `false` por
// un `true` acá, sin tocar rutas, vistas ni tests.
//
// Lo que NO cierra este módulo:
//   • `GET /register/lookup` — el "buscá tus datos de acceso con el DNI" del login. No
//     crea nada: le dice a alguien que YA tiene cuenta con qué correo entra.
//   • La automatrícula del alumno (services/selfEnroll.js) y el código de clase
//     (services/joinByCode.js). Esos no crean cuentas: matriculan en materias a un
//     alumno que ya existe. Son otra decisión y siguen con sus propios flags.
// ─────────────────────────────────────────────────────────────────────────────

// Auto-registro abierto desde la pantalla de login (`/register`).
const REGISTRO_ABIERTO = false;

// Alta por enlace de invitación de escuela (`/register/invite/:token`).
const INVITACION_ABIERTA = false;

// Los ÚNICOS roles que una de estas puertas puede dar, si algún día se reabren. Lista BLANCA
// compartida por los dos GET (qué se ofrece en el select) y los dos POST (qué se acepta): hasta
// el 2026-11-11 los GET armaban la lista con una lista NEGRA sobre User.getRoles(), así que todo
// rol nuevo aparecía solo en el formulario —'jefe' ya aparecía— y el POST lo convertía en alumno
// sin avisar. Ver RN-02 de specs/secretaria-docentes-del-dia.spec.md.
// Un rol con alcance o permisos sobre otros (admin, preceptor, jefe, secretaria) NO va acá:
// lo crea un administrador, que es quien además le define qué ve.
const ROLES_AUTOREGISTRO = Object.freeze(['student', 'teacher', 'soe', 'directivo']);

// El mismo texto para las dos puertas: al que llega no le importa por cuál entró, le
// importa saber a quién pedirle la cuenta.
const MENSAJE_CERRADO = 'El registro está cerrado. Las cuentas las crea el administrador '
  + 'de la escuela — pedile a la administración que te dé de alta.';

// Corta un alta con 403. El 403 y no un 404: la ruta existe y la decisión es nuestra,
// que es justo lo que el que integra (o el que lee un log) necesita distinguir.
function rechazarAlta(res) {
  return res.status(403).json({ registroCerrado: true, error: MENSAJE_CERRADO });
}

module.exports = {
  ROLES_AUTOREGISTRO,
  REGISTRO_ABIERTO,
  INVITACION_ABIERTA,
  MENSAJE_CERRADO,
  rechazarAlta,
};
