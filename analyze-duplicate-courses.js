// Análisis de materias (Course) duplicadas: mismo nombre (case-insensitive) dentro
// de la misma División. Solo lectura — no modifica nada. Sirve para corroborar el
// estado actual antes de decidir fusiones (ver merge-courses.js) y para volver a
// correrlo si el mirror local cambió (pull-from-prod / sync-prod.ps1).
//
// Uso: node analyze-duplicate-courses.js
//
// Un grupo se resuelve solo cuando exactamente UNA de sus copias tiene actividades
// y el resto tiene cero — ahí no hace falta preguntarle nada al usuario, la que
// tiene actividades es la que se queda. El resto queda "ambiguo": requiere criterio
// humano (ver PENDIENTE en la memoria materias-duplicadas-consolidacion).

require('dotenv').config();
const mongoose = require('mongoose');

const Course       = require('./models/Course');
const Activity     = require('./models/Activity');
const Announcement = require('./models/Announcement');
const Division     = require('./models/Division');
const User         = require('./models/User');

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/classroom-escuela';
  await mongoose.connect(uri);
  console.log(`Conectado a: ${uri}\n`);

  const courses = await Course.find({})
    .select('name division school owner coTeachers students createdAt')
    .lean();

  // Agrupa por (division, nombre normalizado)
  const groups = new Map();
  for (const c of courses) {
    const key = `${c.division}::${c.name.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const dupGroups = [...groups.values()].filter(g => g.length > 1);
  console.log(`Cursos totales: ${courses.length}`);
  console.log(`Grupos duplicados (mismo nombre, misma división): ${dupGroups.length}\n`);

  if (dupGroups.length === 0) {
    console.log('No hay materias duplicadas — nada que fusionar.');
    await mongoose.connection.close();
    process.exit(0);
  }

  const divisionCache = new Map();
  async function divisionName(id) {
    const key = id.toString();
    if (!divisionCache.has(key)) {
      const d = await Division.findById(id).select('name').lean();
      divisionCache.set(key, d?.name || key);
    }
    return divisionCache.get(key);
  }

  const resolved  = [];
  const ambiguous = [];

  for (const group of dupGroups) {
    const divName = await divisionName(group[0].division);

    const enriched = await Promise.all(group.map(async c => {
      const [activityCount, announcementCount, studentCount, owner] = await Promise.all([
        Activity.countDocuments({ course: c._id }),
        Announcement.countDocuments({ course: c._id }),
        Promise.resolve((c.students || []).length),
        User.findById(c.owner).select('name dni active').lean(),
      ]);
      return {
        id: c._id.toString(),
        name: c.name,
        createdAt: c.createdAt,
        studentCount,
        activityCount,
        announcementCount,
        owner: owner ? { id: c.owner.toString(), name: owner.name, dni: owner.dni || '', active: owner.active !== false } : null,
        coTeachers: c.coTeachers || [],
      };
    }));

    const withActivities = enriched.filter(c => c.activityCount > 0);

    if (withActivities.length === 1) {
      resolved.push({ division: divName, name: group[0].name, courses: enriched, winner: withActivities[0] });
    } else {
      ambiguous.push({ division: divName, name: group[0].name, courses: enriched });
    }
  }

  console.log(`── Resueltos automáticamente (una sola copia con actividades): ${resolved.length} ──`);
  for (const g of resolved) {
    console.log(`  [${g.division}] "${g.name}" → se queda ${g.winner.id} (${g.winner.activityCount} actividad(es)), perdedoras: ${g.courses.filter(c => c.id !== g.winner.id).map(c => c.id).join(', ')}`);
  }

  console.log(`\n── Ambiguos (requieren decisión manual): ${ambiguous.length} ──`);
  for (const g of ambiguous) {
    console.log(`\n  [${g.division}] "${g.name}" — ${g.courses.length} copias:`);
    for (const c of g.courses) {
      const docente = c.owner ? `${c.owner.name} (DNI ${c.owner.dni || '?'}${c.owner.active ? '' : ', INACTIVO'})` : '(sin owner)';
      console.log(`    - ${c.id} | docente: ${docente} | alumnos: ${c.studentCount} | actividades: ${c.activityCount} | novedades: ${c.announcementCount} | creado: ${c.createdAt?.toISOString?.() || c.createdAt}`);
    }
  }

  console.log(`\n\nResumen: ${resolved.length} resueltos automáticamente, ${ambiguous.length} requieren revisión manual (de ${dupGroups.length} grupos totales).`);

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
