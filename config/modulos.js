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
//   alcance    'escuela'         → la escuela lo prende y vale para TODOS los que corresponda.
//              'escuela+persona' → la escuela lo prende Y ADEMÁS elige a qué personas.
//              Ausente equivale a 'escuela', que es como se comportaban los módulos antes de
//              que existiera este campo.
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
    alcance:     'escuela',
  },
  {
    id:          'transmision',
    label:       'Transmisión en vivo',
    icon:        'cast',
    localsKey:   'transmisionEnabled',
    descripcion: 'La o el docente transmite voz, pantalla y cámara dentro de la sala en vivo '
               + 'de su materia. Se habilita docente por docente.',
    // Sin solapas propias A PROPÓSITO: la transmisión vive adentro de la solapa "En vivo", que
    // ya existe y ya tiene resueltos sus permisos por rol en config/sections.js. Un módulo con
    // `secciones: []` es legítimo — significa "agrega capacidades, no pantallas".
    secciones:   [],
    // El eje nuevo. Ver D10 de specs/transmision-en-vivo.spec.md: la transmisión consume el
    // puerto de salida de TODAS las escuelas del servidor, así que lo sensato es arrancar con
    // dos o tres docentes y mirar qué pasa, no repartirla de golpe.
    alcance:     'escuela+persona',
  },
  {
    id:          'verificacion',
    label:       'Verificación de contacto',
    icon:        'verified',
    localsKey:   'verificacionEnabled',
    descripcion: 'Cada persona confirma su correo (por enlace o código) y su celular desde su '
               + 'perfil, y la escuela ve quién es contactable de verdad.',
    // Sin solapas propias, mismo caso que la transmisión: los botones viven en "Mi perfil" —que
    // ya existe para todos los roles— y los chips en las pantallas de usuarios que ya existen.
    secciones:   [],
    // Alcance de ESCUELA y no 'escuela+persona': verificar no consume ningún recurso compartido
    // ni hay razón para dárselo a unos docentes sí y a otros no. El segundo eje que sí tiene
    // esta feature es otro y no se configura acá — es que la verificación NUNCA bloquea a nadie
    // (ver D1 de specs/verificacion-de-contacto.spec.md).
    //
    // ⚠️ Prenderlo con los dos canales en 'off' (config/verificacion.js) deja los chips y la
    // verificación asistida —que es útil por sí sola— pero sin botón de "mandame un código".
    // El botón no se dibuja si el canal no puede mandar: un botón que no hace nada es peor que
    // no tener el botón.
    alcance:     'escuela',
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

// ¿Esta PERSONA puede usar este módulo?
//
// Es el segundo eje, y NO reemplaza a moduloActivo(): lo compone. Primero tiene que estar
// prendido para la escuela; recién después se mira la lista de personas.
//
// ⭐ LA SUTILEZA QUE HAY QUE ENTENDER O LA FEATURE QUEDA AL REVÉS: en `transmision` esta
// pregunta se le hace a QUIEN EMITE, nunca a quien mira. Si se le hiciera al que mira, cada
// alumno tendría que estar en la lista para poder ver a su profesora, que es absurdo. Para el
// alumno la transmisión simplemente está prendida o no está, y eso ya lo dice el estado de la
// sala. Ver D10 de specs/transmision-en-vivo.spec.md.
//
// FAIL-CLOSED igual que su hermana, y con un motivo extra: sin `user` la respuesta es NO. Un
// llamado sin usuario es un bug de quien llama, y el default seguro es no habilitar a nadie.
function moduloActivoPara(school, user, id) {
  if (!moduloActivo(school, id)) return false;

  const mod = MODULOS_BY_ID[id];
  // Un módulo de un solo eje ya contestó todo lo que tenía que contestar.
  if (mod.alcance !== 'escuela+persona') return true;

  const cfg = school.modules[id];
  if (cfg.alcance === 'todos') return true;

  // 'lista' (el default): hay que estar adentro. Sin usuario, no.
  if (!user?._id) return false;
  return (cfg.personas || []).some(p => String(p) === String(user._id));
}

// Los ids de los módulos prendidos, para pintar el resumen de la escuela.
const modulosActivos = (school) => MODULOS.filter(m => moduloActivo(school, m.id)).map(m => m.id);

module.exports = { MODULOS, MODULOS_BY_ID, moduloActivo, moduloActivoPara, modulosActivos };
