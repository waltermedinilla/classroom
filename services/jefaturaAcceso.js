// Reglas de la Jefatura de Sección: quién entra a /jefatura, con qué alcance, y quién puede
// quedar a cargo de una sección.
//
// TODO lo de este archivo es PURO: no requiere mongoose ni toca la base ni el reloj. Mismo
// patrón que services/soeAcceso.js, y por el mismo motivo — lo consumen lugares que no se
// pueden contradecir:
//   - middleware/jefatura.js → decide si la request pasa y con qué alcance
//   - routes/sections.js     → decide quién queda en Section.heads al guardar
// y los tests unitarios, que prueban usuarios en estados que por HTTP costaría fabricar (un
// jefe deshabilitado, un id de otra escuela, un headIds que llega roto).
//
// La spec completa está en specs/docente-jefe-de-seccion.spec.md.

// ── Cómo entra cada rol ──────────────────────────────────────────────────────
// Sin límite: ven todas las secciones de su escuela sin que nadie los ponga a cargo de nada.
// Se mudó acá desde middleware/jefatura.js, que lo reexporta con su nombre de siempre.
const ROLES_JEFATURA_SIN_LIMITE = ['directivo', 'admin', 'superadmin'];

// Por rol: el Jefe de Sección entra siempre. Sin secciones ve "Todavía no tenés secciones a
// cargo", que le habla a alguien que espera que le asignen una.
const ROLES_JEFATURA_POR_ROL = ['jefe'];

// Por sección: el Docente entra SOLO si figura en Section.heads (decisión D2). Para él la
// jefatura no es un rol, es una capacidad que le da la sección. ⚠️ config/sections.js tiene
// `teacher` en `roles` de jefe_dashboard, jefe_teachers y admin_sections por esto mismo:
// si se cambia uno sin el otro, el test de CA-52 falla.
const ROLES_JEFATURA_POR_SECCION = ['teacher'];

// Lo que el admin puede AGREGAR a heads (DA-3). No es lo mismo que "quién entra": directivo
// y admin ya ven todo por su rol, y ponerlos a cargo solo ensuciaría la columna "A cargo de".
// Un preceptor a cargo sería multirrol, que es de specs/identidad-multiescuela.spec.md.
const ROLES_ELEGIBLES_JEFE = ['jefe', 'teacher'];

function modoJefatura(role) {
  if (ROLES_JEFATURA_SIN_LIMITE.includes(role))  return 'sin-limite';
  if (ROLES_JEFATURA_POR_ROL.includes(role))     return 'por-rol';
  if (ROLES_JEFATURA_POR_SECCION.includes(role)) return 'por-seccion';
  return null;
}

// ¿Entra a /jefatura, y ve la escuela entera o solo sus secciones?
//
// scopeAll es true SOLO para los roles sin límite. Nunca para el Docente, con ningún
// argumento: un error acá le entregaría la escuela entera a un docente a cargo de una sola
// sección.
function decidirAccesoJefatura(user, cantidadSecciones) {
  const modo = user ? modoJefatura(user.role) : null;
  if (modo === 'sin-limite') return { entra: true, scopeAll: true };
  if (modo === 'por-rol')    return { entra: true, scopeAll: false };
  if (modo === 'por-seccion' && user.school && cantidadSecciones >= 1) {
    return { entra: true, scopeAll: false };
  }
  return { entra: false, scopeAll: false };
}

// Por String() y no con equals(): lo que llega puede ser un ObjectId, un string del body o
// el school de res.locals.user, que viene cacheado.
const esDeLaEscuela = (usuario, school) =>
  !!usuario && usuario.school != null && school != null && String(usuario.school) === String(school);

// ¿Se lo puede AGREGAR como jefe? Solo cuentas activas (DA-1), mismo criterio que los
// selectores de docente del admin: los deshabilitados no se ofrecen.
function esElegibleComoJefe(usuario, school) {
  return esDeLaEscuela(usuario, school)
      && usuario.active !== false
      && ROLES_ELEGIBLES_JEFE.includes(usuario.role);
}

// La regla de guardado del admin (RN-22). Existe para cerrar la trampa del editor viejo: la
// lista de candidatos era solo `role: 'jefe'`, así que un Docente a cargo no tenía checkbox,
// el formulario salía sin él y el servidor lo sacaba de heads con un 200.
//
// ⚠️ Un jefe que YA estaba se conserva sin revalidar su rol ni su estado. Es tentador
// "limpiar" acá al preceptor o a la cuenta deshabilitada que quedó en heads: eso es
// exactamente la expulsión silenciosa que esta función vino a cerrar. Se los saca
// destildándolos, a la vista del admin. Los únicos que se quitan solos son los que ya no
// existen o son de otra escuela — y el formulario lo avisa antes (RN-21).
//
// usuarios: Map id → { _id, name, role, school, active } con todos los ids de pedidos ∪
// actuales que existen. El que falta en el Map no existe.
function resolverHeads({ pedidos, actuales, usuarios, school }) {
  const idsPedidos  = [...new Set((Array.isArray(pedidos) ? pedidos : []).map(String))];
  const idsActuales = [...new Set((actuales || []).map(String))];
  const setPedidos  = new Set(idsPedidos);
  const setActuales = new Set(idsActuales);

  const heads = [], agregados = [], quitados = [], descartados = [], rechazados = [];

  for (const id of idsPedidos) {
    const u = usuarios.get(id);
    if (setActuales.has(id)) {
      // Si ya no existe o se fue de la escuela, lo cuenta el recorrido de abajo.
      if (esDeLaEscuela(u, school)) heads.push(u._id);
      continue;
    }
    if (esElegibleComoJefe(u, school)) {
      heads.push(u._id);
      agregados.push(u.name);
    } else {
      // El nombre solo si es de la escuela: el admin no ve datos de otra institución.
      rechazados.push({ id, nombre: esDeLaEscuela(u, school) ? u.name : null });
    }
  }

  for (const id of idsActuales) {
    const u = usuarios.get(id);
    if (!esDeLaEscuela(u, school)) descartados.push(id);
    else if (!setPedidos.has(id))  quitados.push(u.name);
  }

  return { heads, agregados, quitados, descartados, rechazados };
}

module.exports = {
  ROLES_JEFATURA_SIN_LIMITE, ROLES_JEFATURA_POR_ROL, ROLES_JEFATURA_POR_SECCION, ROLES_ELEGIBLES_JEFE,
  modoJefatura, decidirAccesoJefatura, esElegibleComoJefe, resolverHeads,
};
