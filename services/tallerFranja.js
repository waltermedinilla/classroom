// La franja de la rotación en la página de una materia de taller — RN-F4-4 de
// specs/jefe-de-taller.spec.md. Al MEP le dice qué grupo tiene en este período; al alumno, a qué
// estación le toca ir y con quién. Los demás no la ven.
//
// Nunca rompe la página de la materia: ante cualquier error devuelve null.

const GruposTaller   = require('../models/GruposTaller');
const RotacionTaller = require('../models/RotacionTaller');
const Course         = require('../models/Course');
const User           = require('../models/User');
const { queLeToca }  = require('./tallerRotacion');
const S = require('./secretariaDia');

const str = (x) => (x == null ? '' : String(x));
const idDe = (x) => str(x && (x._id || x));

async function franjaDeRotacion(course, user) {
  try {
    if (!course || !course.esTaller || !user || !course.division) return null;
    const esAlumno = user.role === 'student';
    const esMep = [course.owner, ...(course.coTeachers || [])].some(u => idDe(u) === str(user._id));
    if (!esAlumno && !esMep) return null;
    const hoy = S.fechaDe(new Date());
    const division = idDe(course.division);
    const rotaciones = await RotacionTaller.find({
      school: course.school, division, 'estaciones.course': course._id, desde: { $lte: hoy }, hasta: { $gte: hoy },
    }).sort({ desde: -1 }).lean();
    if (!rotaciones.length) return null;
    const grupos = await GruposTaller.findOne({ school: course.school, division }).lean();
    const r = queLeToca({ rotaciones, grupos, courseId: str(course._id), userId: str(user._id), esAlumno, hoy });
    if (!r) return null;
    if (esAlumno && r.estacion) {
      const m = await Course.findById(r.estacion.course).select('owner coTeachers').lean();
      const ids = m ? [m.owner, ...(m.coTeachers || [])].filter(Boolean) : [];
      const us = ids.length ? await User.find({ _id: { $in: ids } }).select('name').lean() : [];
      r.estacion.meps = us.map(u => u.name);
    }
    return { ...r, esAlumno };
  } catch (_) {
    return null;
  }
}

module.exports = { franjaDeRotacion };
