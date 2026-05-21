require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const User = require('./models/User');
const Course = require('./models/Course');
const Announcement = require('./models/Announcement');

const teachersData = [
  { name: 'María García', email: 'maria@example.com', password: '123456', role: 'teacher' },
  { name: 'Carlos López', email: 'carlos@example.com', password: '123456', role: 'teacher' },
];

const studentsData = [
  { name: 'Ana Martínez', email: 'ana@example.com', password: '123456', role: 'student' },
  { name: 'Luis Rodríguez', email: 'luis@example.com', password: '123456', role: 'student' },
  { name: 'Sofía Pérez', email: 'sofia@example.com', password: '123456', role: 'student' },
  { name: 'Diego Fernández', email: 'diego@example.com', password: '123456', role: 'student' },
  { name: 'Valentina Gómez', email: 'valentina@example.com', password: '123456', role: 'student' },
  { name: 'Mateo Álvarez', email: 'mateo@example.com', password: '123456', role: 'student' },
];

const coursesData = [
  { name: 'Matemáticas Avanzadas', section: 'A', subject: 'Matemáticas', room: '101' },
  { name: 'Historia Universal', section: 'B', subject: 'Historia', room: '203' },
  { name: 'Programación Web', section: 'A', subject: 'Computación', room: 'Lab 3' },
  { name: 'Física General', section: 'C', subject: 'Física', room: '305' },
];

async function seed() {
  try {
    await connectDB();

    console.log('Limpiando datos existentes...');
    await Announcement.deleteMany({});
    await Course.deleteMany({});

    const existingNonSeed = await User.countDocuments({
      email: { $nin: [...teachersData.map(t => t.email), ...studentsData.map(s => s.email)] }
    });
    if (existingNonSeed > 0) {
      console.log(`Manteniendo ${existingNonSeed} usuarios existentes (no seed)`);
    }

    await User.deleteMany({
      email: { $in: [...teachersData.map(t => t.email), ...studentsData.map(s => s.email)] }
    });

    console.log('Creando profesores...');
    const teachers = await User.create(teachersData);

    console.log('Creando alumnos...');
    const students = await User.create(studentsData);

    console.log('Creando cursos...');
    const course1 = await Course.create({ ...coursesData[0], owner: teachers[0]._id });
    const course2 = await Course.create({ ...coursesData[1], owner: teachers[0]._id });
    const course3 = await Course.create({ ...coursesData[2], owner: teachers[1]._id });
    const course4 = await Course.create({ ...coursesData[3], owner: teachers[1]._id });

    console.log('Matriculando alumnos en cursos...');
    course1.students = [students[0]._id, students[1]._id, students[2]._id, students[3]._id, students[4]._id, students[5]._id];
    course2.students = [students[0]._id, students[2]._id, students[4]._id];
    course3.students = [students[1]._id, students[3]._id, students[5]._id];
    course4.students = [students[0]._id, students[1]._id, students[5]._id];

    await Promise.all([course1.save(), course2.save(), course3.save(), course4.save()]);

    console.log('\n--- Resumen ---');
    console.log(`Profesores: ${teachers.map(t => t.name).join(', ')}`);
    console.log(`Alumnos: ${students.map(s => s.name).join(', ')}`);
    console.log('\nCursos creados:');
    console.log(`  "${course1.name}" (${course1.subject}) — Código: ${course1.code} — Alumnos: ${course1.students.length}`);
    console.log(`  "${course2.name}" (${course2.subject}) — Código: ${course2.code} — Alumnos: ${course2.students.length}`);
    console.log(`  "${course3.name}" (${course3.subject}) — Código: ${course3.code} — Alumnos: ${course3.students.length}`);
    console.log(`  "${course4.name}" (${course4.subject}) — Código: ${course4.code} — Alumnos: ${course4.students.length}`);
    console.log('\nAlumnos por curso:');
    const allCourses = [course1, course2, course3, course4];
    for (const s of students) {
      const enrolled = allCourses.filter(c => c.students.some(st => st.toString() === s._id.toString())).map(c => c.name);
      console.log(`  ${s.name}: ${enrolled.join(', ')}`);
    }
    console.log('\nSeed completado exitosamente ✅');
  } catch (err) {
    console.error('Error en seed:', err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

seed();
