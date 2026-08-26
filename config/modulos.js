// Catálogo ÚNICO de los módulos OPCIONALES: funcionalidades completas que una escuela puede
// tener prendidas o apagadas, y que no existen para la que no las usa.
//
// Es el hermano de config/sections.js y sigue su misma filosofía —una sola lista que leen la
// pantalla, el enforcement y la configuración— pero resuelve una pregunta distinta:
//
//   config/sections.js  →  "¿este ROL ve esta solapa?"      restrictivo y FAIL-OPEN
//   config/modulos.js   →  "¿esta ESCUELA tiene esto?"      aditivo y FAIL-CLOSED
//
// La diferencia de default no es un detalle. Las solapas existen para todos y la escuela
// solo puede QUITARLAS, así que lo que no está denegado pasa. Un módulo opcional es al
// revés: no existe hasta que alguien lo prende, y una escuela que nunca oyó hablar de
// reservas de recursos no tiene que ver la solapa ni que la ruta le conteste algo.
//
// QUIÉN LO PRENDE: el superadmin, desde /superadmin/schools. Vive en School.modules, FUERA
// de School.settings, y por el mismo motivo que rolePermissions y soeAccess (ver los
// comentarios largos en models/School.js): `settings` lo edita el ADMIN de la escuela desde
// /admin/tasks, y el admin no puede ser quien se habilita a sí mismo un módulo. Son dos
// dueños distintos, dos campos distintos.
//
// Campos de cada módulo:
//   id         lo que se guarda en School.modules. NO cambiarlo nunca aunque cambie el label.
//   label      nombre visible.
//   icon       material symbol.
//   descripcion una línea, la que lee el superadmin al decidir si prenderlo.
//   localsKey  el nombre de la variable de res.locals que publica si está prendido. Tiene que
//              coincidir con el campo `flag` de las secciones del módulo en config/sections.js
//              (ahí se compara `res.locals[flag] === false` para esconder la solapa).
//   secciones  las claves de config/sections.js que este módulo trae. Sirve para que, al
//              apagarlo, se entienda qué solapas desaparecen.
//
// ⚠️ Un módulo se agrega acá recién CUANDO SU CÓDIGO EXISTE. Listar uno que todavía no está
// implementado le daría al superadmin un interruptor que no prende nada, que es peor que no
// tener el interruptor.
const MODULOS = [
  {
    id:          'recursos',
    label:       'Recursos y reservas',
    icon:        'event_seat',
    localsKey:   'recursosEnabled',
    descripcion: 'Calendario de la sala de computación, netbooks y demás recursos, con pedido '
               + 'del docente y aprobación del administrativo.',
    secciones:   ['admin_recursos', 'app_reservas'],
  },
];

const MODULOS_BY_ID = Object.fromEntries(MODULOS.map(m => [m.id, m]));

// ¿Esta escuela tiene prendido este módulo?
//
// FAIL-CLOSED, al revés que isDenied() de config/sections.js: sin escuela, sin campo, con el
// id equivocado o con la base a medio migrar, la respuesta es NO. Es lo correcto para algo
// que no existía hasta que alguien lo prendió: el error se ve como "la solapa no aparece",
// que se arregla prendiéndola, y nunca como "una escuela vio algo que no le correspondía".
//
// `school` es el doc plano que server.js deja en res.locals.school (viene de un .lean(), así
// que es un objeto común y no un documento de Mongoose).
function moduloActivo(school, id) {
  if (!MODULOS_BY_ID[id]) return false;
  if (!school) return false;
  return school.modules?.[id]?.enabled === true;
}

// Los ids de los módulos prendidos, para pintar el resumen de la escuela.
const modulosActivos = (school) => MODULOS.filter(m => moduloActivo(school, m.id)).map(m => m.id);

module.exports = { MODULOS, MODULOS_BY_ID, moduloActivo, modulosActivos };
