// Datos descartables para verificar la fusión de docentes duplicados.
// Uso: node _tmp-seed-dup.js crear | estado | limpiar
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Course = require('./models/Course');
const Division = require('./models/Division');

const MARCA = 'ZZDUP';
const NOMBRE_A = `${MARCA} Docente Personal`;
const NOMBRE_B = `${MARCA} Docente Institucional`;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/classroom-clone');
  const modo = process.argv[2];

  if (modo === 'crear') {
    const division = await Division.findOne().lean();
    const a = await User.create({ name: NOMBRE_A, email: 'zzdup.personal@test.local', password: 'Prueba1234', role: 'teacher', school: division.school, dni: '99999992' });
    const b = await User.create({ name: NOMBRE_B, email: 'zzdup.institucional@test.local', password: 'Prueba1234', role: 'teacher', school: division.school, dni: '99.999.992' });
    await Course.create({ name: `${MARCA} Materia de prueba`, division: division._id, school: division.school, owner: a._id });
    console.log('creado: A(personal, con materia)', a._id.toString(), '| B(institucional, vacía)', b._id.toString());
  }

  if (modo === 'estado') {
    const us = await User.find({ name: { $regex: MARCA } }).select('name email active').lean();
    for (const u of us) {
      const titular = await Course.countDocuments({ owner: u._id });
      console.log(`${u.name} | correo=${u.email} | activo=${u.active} | titular de ${titular}`);
    }
    if (!us.length) console.log('(no quedan cuentas de prueba)');
  }

  if (modo === 'limpiar') {
    await Course.deleteMany({ name: { $regex: MARCA } });
    const r = await User.deleteMany({ name: { $regex: MARCA } });
    console.log('limpiado:', r.deletedCount, 'usuario(s)');
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
