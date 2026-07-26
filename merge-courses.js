// Fusiona materias (Course) duplicadas: dado un curso "winner" y uno o más "losers"
// del mismo nombre dentro de la misma división, migra alumnos, actividades, entregas
// y novedades al winner, agrega los owners de los losers como coTeachers del winner
// (nadie pierde acceso a la materia), y borra los documentos Course perdedores.
//
// Modo DRY-RUN por default — no modifica nada. Pasar --apply para ejecutar de verdad.
//
// Uso:
//   node merge-courses.js <winnerId> <loserId1> [loserId2 ...] [--apply]
//
// Ver analyze-duplicate-courses.js para encontrar los grupos duplicados y sus IDs.

require('dotenv').config();
const mongoose = require('mongoose');

const Course       = require('./models/Course');
const Activity     = require('./models/Activity');
const Submission   = require('./models/Submission');
const Announcement = require('./models/Announcement');
const AuditLog     = require('./models/AuditLog');

const args  = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ids   = args.filter(a => a !== '--apply');

if (ids.length < 2) {
  console.error('Uso: node merge-courses.js <winnerId> <loserId1> [loserId2 ...] [--apply]');
  process.exit(1);
}
if (new Set(ids).size !== ids.length) {
  console.error('Los IDs no pueden repetirse (¿pasaste el mismo curso dos veces?).');
  process.exit(1);
}

const [winnerId, ...loserIds] = ids;

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/classroom-escuela';
  await mongoose.connect(uri);
  console.log(`Conectado a: ${uri}`);
  console.log(APPLY
    ? '══ MODO APLICAR — se van a modificar datos reales ══\n'
    : '══ MODO DRY-RUN — no se modifica nada (pasá --apply para ejecutar) ══\n');

  const winner = await Course.findById(winnerId);
  if (!winner) { console.error(`No existe el curso winner ${winnerId}`); process.exit(1); }

  const losers = await Course.find({ _id: { $in: loserIds } });
  if (losers.length !== loserIds.length) {
    const found   = new Set(losers.map(l => l._id.toString()));
    const missing = loserIds.filter(id => !found.has(id));
    console.error(`No se encontraron estos cursos perdedores: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Salvaguarda: este script fusiona DUPLICADOS (misma materia, misma división),
  // no cursos distintos — aborta si algo no encaja para evitar un merge accidental.
  for (const loser of losers) {
    if (loser.division.toString() !== winner.division.toString()) {
      console.error(`El curso ${loser._id} pertenece a otra división — abortando.`);
      process.exit(1);
    }
    if (loser.name.trim().toLowerCase() !== winner.name.trim().toLowerCase()) {
      console.error(`El curso ${loser._id} ("${loser.name}") no tiene el mismo nombre que el winner ("${winner.name}") — abortando.`);
      process.exit(1);
    }
  }

  console.log(`Winner: ${winner._id} "${winner.name}" (owner actual: ${winner.owner})`);
  console.log(`Losers: ${losers.map(l => l._id).join(', ')}\n`);

  let studentsAdded          = 0;
  let enrollmentDatesCopied  = 0;
  const coTeachersAdded      = [];

  for (const loser of losers) {
    console.log(`── Fusionando ${loser._id} → ${winner._id} ──`);

    // 1. Alumnos: unión con dedup. enrollmentDates: solo copia la fecha del loser
    //    si el winner todavía no tiene una registrada para ese alumno (no pisa).
    for (const studentId of loser.students) {
      const sid     = studentId.toString();
      const already = winner.students.some(s => s.toString() === sid);
      if (!already) {
        winner.students.push(studentId);
        studentsAdded++;
      }
      const loserDate = loser.enrollmentDates.get(sid);
      if (loserDate && !winner.enrollmentDates.get(sid)) {
        winner.enrollmentDates.set(sid, loserDate);
        enrollmentDatesCopied++;
      }
    }

    // 2. coTeachers: el owner del loser (y sus propios coTeachers, si tuviera)
    //    pasan a ser coTeachers del winner — nadie pierde acceso a la materia.
    const candidateTeachers = [loser.owner, ...(loser.coTeachers || [])];
    for (const t of candidateTeachers) {
      const tid             = t.toString();
      const isWinnerOwner   = winner.owner.toString() === tid;
      const alreadyCoTeacher = winner.coTeachers.some(c => c.toString() === tid);
      if (!isWinnerOwner && !alreadyCoTeacher) {
        winner.coTeachers.push(t);
        coTeachersAdded.push(tid);
      }
    }

    // 3. Actividades y novedades: reasignar su `course` al winner. Las Submission
    //    no tienen `course` propio (solo `activity`), así que "viajan" solas al
    //    reasignar la actividad — no hace falta tocarlas directamente.
    const activityIds     = await Activity.find({ course: loser._id }).distinct('_id');
    const submissionCount = activityIds.length
      ? await Submission.countDocuments({ activity: { $in: activityIds } })
      : 0;
    const announcementCount = await Announcement.countDocuments({ course: loser._id });

    console.log(`  alumnos del loser: ${loser.students.length} | actividades: ${activityIds.length} (${submissionCount} entrega(s)) | novedades: ${announcementCount}`);
    console.log(`  docentes que se agregarían como coTeachers: ${candidateTeachers.length ? candidateTeachers.join(', ') : '(ninguno)'}`);

    if (APPLY) {
      if (activityIds.length) {
        await Activity.updateMany({ course: loser._id }, { $set: { course: winner._id } });
      }
      if (announcementCount) {
        await Announcement.updateMany({ course: loser._id }, { $set: { course: winner._id } });
      }
    }
  }

  if (APPLY) {
    await winner.save();
    for (const loser of losers) {
      await Course.findByIdAndDelete(loser._id);
    }

    await AuditLog.create({
      action: 'course.merge',
      actor:  { userId: null, name: 'merge-courses.js (script)', role: 'system', email: '' },
      targets: [
        { type: 'course', id: winner._id, name: winner.name },
        ...losers.map(l => ({ type: 'course', id: l._id, name: l.name })),
      ],
      school: winner.school,
      meta: {
        loserIds: losers.map(l => l._id.toString()),
        studentsAdded,
        enrollmentDatesCopied,
        coTeachersAdded,
      },
    });

    console.log(`\n✓ Fusión aplicada. Winner ${winner._id} ahora tiene ${winner.students.length} alumno(s) y ${winner.coTeachers.length} co-docente(s) en total.`);
  } else {
    console.log(`\nDRY-RUN: no se modificó nada.`);
    console.log(`Se agregarían ${studentsAdded} alumno(s) nuevo(s), se copiarían ${enrollmentDatesCopied} fecha(s) de inscripción,`);
    console.log(`y se agregarían ${coTeachersAdded.length} co-docente(s) nuevo(s) al winner: ${coTeachersAdded.join(', ') || '(ninguno)'}`);
    console.log('Ejecutá con --apply para aplicar de verdad.');
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
