// Cuenta la "actividad como autor" de un conjunto de usuarios para las columnas
// Nov/Act/Msg de los listados admin y superadmin. Todo en 3 aggregations bulk
// (no una query por usuario) para que sea barato aun con 100 filas por página.
//
// Semántica ("docente-centered", elegida por el usuario):
//   - novedades:   Announcement.author === userId  (novedades que publicó)
//   - actividades: Activity.author     === userId  (tareas que creó)
//   - mensajes:    Announcement.comments[].author === userId  (comentarios que escribió)
//
// Devuelve un Map<string, {novedades, actividades, mensajes}> con string keys
// (userId.toString()) para lookup directo desde la vista.

const Announcement = require('../models/Announcement');
const Activity     = require('../models/Activity');

async function getUserActivityStats(userIds) {
  const map = new Map();
  if (!Array.isArray(userIds) || userIds.length === 0) return map;
  userIds.forEach(id => map.set(id.toString(), { novedades: 0, actividades: 0, mensajes: 0 }));

  const [novedades, actividades, mensajes] = await Promise.all([
    Announcement.aggregate([
      { $match: { author: { $in: userIds } } },
      { $group: { _id: '$author', count: { $sum: 1 } } },
    ]),
    Activity.aggregate([
      { $match: { author: { $in: userIds } } },
      { $group: { _id: '$author', count: { $sum: 1 } } },
    ]),
    // Los comentarios viven anidados en Announcement.comments — hay que $unwind.
    // $match previo para acotar el pipeline a los anuncios que contienen al menos
    // un comentario de alguno de los usuarios (aunque el $unwind lo re-filtra igual).
    Announcement.aggregate([
      { $match: { 'comments.author': { $in: userIds } } },
      { $unwind: '$comments' },
      { $match: { 'comments.author': { $in: userIds } } },
      { $group: { _id: '$comments.author', count: { $sum: 1 } } },
    ]),
  ]);

  for (const row of novedades)   map.get(row._id.toString()).novedades   = row.count;
  for (const row of actividades) map.get(row._id.toString()).actividades = row.count;
  for (const row of mensajes)    map.get(row._id.toString()).mensajes    = row.count;

  return map;
}

module.exports = { getUserActivityStats };
