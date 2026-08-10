// A QUIÉN LE LLEGA UN MENSAJE del superadministrador.
//
// Tres formas de elegir, combinables:
//   • toda la comunidad (`everyone`)
//   • por rol (uno o varios), opcionalmente acotado por escuela
//   • personas sueltas, elegidas a mano en el buscador
//
// Los filtros de GRUPO se INTERSECTAN entre sí (rol ∩ escuela); las personas elegidas a mano
// se SUMAN al resultado. Es lo que espera cualquiera que haya usado un filtro y una lista de
// invitados a la vez: el filtro acota, la lista agrega.
//
// La audiencia se resuelve UNA VEZ, al enviar, y queda congelada en los MessageRecipient.
// Nunca se re-evalúa al leer — ver el comentario de models/Message.js sobre `audience`.
//
// El recorte por curso/división NO está: quedó explícitamente para más adelante. Cuando se
// sume entra acá, en una rama que resuelva los ids vía Course (`students` para alumnos,
// `owner` + `coTeachers` para docentes, `assignedDivisions` para preceptores) y decida qué
// hacer con los roles que no tienen curso. Nada más de este archivo cambia.

const User = require('../models/User');

// Se lee del modelo en vez de duplicar la lista: si mañana nace un rol, la pantalla de envío
// lo acepta sin que haya que acordarse de tocar este archivo.
const ROLES_VALIDOS = User.getRoles();

// El filtro Mongo del GRUPO, o null si no se eligió ningún grupo.
//
// `everyone` gana sobre `roles`: es "sin filtro de rol", no un rol más. Si el usuario tildó
// "toda la comunidad" y además dejó marcado Docente, quiso decir toda la comunidad.
//
// La escuela ACOTA, no selecciona: una escuela sola —sin rol y sin everyone— devuelve null.
// Es a propósito. Que tildar una escuela mandara a la escuela entera es justo el accidente
// que la previsualización y la confirmación tratan de evitar; para eso está "toda la
// comunidad", que hay que elegir a sabiendas.
function construirFiltroGrupo(filtros) {
  const { everyone, roles, schools } = filtros || {};

  const rolesLimpios = [...new Set(
    (Array.isArray(roles) ? roles : []).filter(r => ROLES_VALIDOS.includes(r))
  )];

  if (!everyone && rolesLimpios.length === 0) return null;

  // active:true no es un detalle: una cuenta deshabilitada no puede loguearse, así que su
  // fila solo inflaría el denominador de "leído por X de Y" con gente que no puede leer.
  const filtro = { active: true };
  if (!everyone) filtro.role = { $in: rolesLimpios };

  const escuelas = (Array.isArray(schools) ? schools : []).filter(Boolean);
  if (escuelas.length) filtro.school = { $in: escuelas };

  return filtro;
}

// El filtro de las personas elegidas a mano. Lleva el MISMO active:true que el grupo: elegir
// a alguien de la lista no puede ser una puerta trasera para mandarle a una cuenta dada de baja.
function filtroSueltos(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : []).filter(Boolean);
  if (!ids.length) return null;
  return { _id: { $in: ids }, active: true };
}

// Une los dos conjuntos, saca al remitente y deduplica.
//
// Todo se normaliza con String() porque un ObjectId de Mongoose no es === a su string ni a
// otro ObjectId con el mismo valor: sin esto, la misma persona entrando por el grupo y por la
// lista a mano generaría dos filas y el índice único { message, user } haría fallar el envío.
function combinarIds(idsGrupo, idsSueltos, remitenteId) {
  const fuera = remitenteId ? String(remitenteId) : null;
  const vistos = new Set();

  [...(idsGrupo || []), ...(idsSueltos || [])].forEach(id => {
    if (id === null || id === undefined) return;
    const s = String(id);
    if (s === fuera) return;
    vistos.add(s);
  });

  return [...vistos];
}

// ¿Tiene sentido siquiera consultar la base? Lo usan el POST (para responder 400 sin tocar
// Mongo) y la previsualización.
function hayAlgoElegido(filtros) {
  return construirFiltroGrupo(filtros) !== null || filtroSueltos(filtros?.userIds) !== null;
}

// Resuelve la audiencia real contra la base.
// Devuelve los USUARIOS (no solo los ids): el envío necesita `role` y `school` de cada uno
// para congelarlos en roleAtSend / schoolAtSend.
async function resolverDestinatarios(filtros, remitenteId) {
  const grupo   = construirFiltroGrupo(filtros);
  const sueltos = filtroSueltos(filtros?.userIds);
  if (!grupo && !sueltos) return [];

  // Las dos queries van en paralelo: son independientes y ambas pegan sobre el mismo índice.
  const [delGrupo, aMano] = await Promise.all([
    grupo   ? User.find(grupo).select('_id role school').lean()   : [],
    sueltos ? User.find(sueltos).select('_id role school').lean() : [],
  ]);

  const permitidos = new Set(combinarIds(
    delGrupo.map(u => u._id),
    aMano.map(u => u._id),
    remitenteId,
  ));

  // Se recorre el conjunto unido una sola vez conservando el documento completo. Un Map por
  // id evita que quien entró por los dos caminos aparezca dos veces.
  const porId = new Map();
  [...delGrupo, ...aMano].forEach(u => {
    const s = String(u._id);
    if (permitidos.has(s) && !porId.has(s)) porId.set(s, u);
  });

  return [...porId.values()];
}

module.exports = {
  ROLES_VALIDOS,
  construirFiltroGrupo,
  filtroSueltos,
  combinarIds,
  hayAlgoElegido,
  resolverDestinatarios,
};
