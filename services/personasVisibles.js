// La lista de alumnos de la solapa Personas de /courses/:id, según quién mira
// (specs/personas-privacidad-alumno.spec.md).
//
// Por qué existe: la solapa le mostraba a CUALQUIER alumno matriculado el DNI de cada compañero,
// y el DNI es la contraseña inicial de las cuentas (importaciones y reseteo del admin, en
// routes/admin.js). Correo + DNI en la misma pantalla era entregar la cuenta del compañero.
//
// Es una lista de PERMITIDOS: cada campo se lee por su nombre. Nunca `{ ...s }` ni
// Object.keys(s): un documento populado de Mongoose no expone sus campos como propiedades
// propias, y un campo que se sume al populate mañana tiene que quedar afuera por defecto.
//
// El que gestiona la materia (canManage: docente titular o suplente, admin, superadmin) la ve
// como siempre. El resto —que en esta pantalla solo puede ser un alumno matriculado, ver
// canView en services/cursoPermisos.js— ve nombre, correo y foto, y no ve a los compañeros con
// la cuenta deshabilitada (P2 = B). `active` ausente es una cuenta vieja: se muestra, el
// default del esquema es true.

function personasVisibles(students, esGestor) {
  const lista = students || [];
  if (esGestor) {
    return lista.map(s => ({
      _id: s._id, name: s.name, email: s.email, dni: s.dni, active: s.active, avatar: s.avatar,
    }));
  }
  return lista
    .filter(s => s.active !== false)
    .map(s => ({ _id: s._id, name: s.name, email: s.email, avatar: s.avatar }));
}

module.exports = { personasVisibles };
