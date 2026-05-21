const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity');
const Course = require('../models/Course');
const { requireAuth } = require('../middleware/auth');

// List activities for a course
router.get('/course/:courseId', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    const userId = res.locals.user._id.toString();
    const isOwner = course.owner.toString() === userId;

    const query = { course: req.params.courseId };
    if (!isOwner) query.availableFrom = { $lte: new Date() };

    const activities = await Activity.find(query)
      .populate('author', 'name')
      .sort({ createdAt: -1 });

    const result = activities.map(act => {
      const obj = act.toObject();
      if (!isOwner) {
        const myGrade = act.grades.find(g => g.student.toString() === userId);
        obj.myGrade = myGrade ? { points: myGrade.points } : null;
        delete obj.grades;
      }
      return obj;
    });

    res.json({ activities: result, isOwner });
  } catch {
    res.status(500).json({ error: 'Error al cargar actividades' });
  }
});

// Create activity (owner only)
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { courseId, title, description, dueDate, availableFrom, points } = req.body;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Solo el docente puede crear actividades' });
    }

    const activity = await Activity.create({
      course: courseId,
      author: res.locals.user._id,
      title: title?.trim(),
      description: description?.trim() || '',
      dueDate: dueDate || null,
      availableFrom: availableFrom || new Date(),
      points: points !== '' && points != null ? Number(points) : null,
    });

    await activity.populate('author', 'name');
    res.status(201).json({ activity });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al crear actividad' });
  }
});

// Get activity detail + grades per student (owner only)
router.get('/:id/grades', requireAuth, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id).populate('author', 'name');
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course).populate('students', 'name email');
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const gradeMap = {};
    activity.grades.forEach(g => { gradeMap[g.student.toString()] = g.points; });

    const studentGrades = course.students.map(s => ({
      _id: s._id,
      name: s.name,
      email: s.email,
      points: gradeMap[s._id.toString()] ?? null,
    }));

    res.json({ activity, studentGrades });
  } catch {
    res.status(500).json({ error: 'Error al cargar calificaciones' });
  }
});

// Save grade for a student (owner only)
router.post('/:id/grade', requireAuth, async (req, res) => {
  try {
    const { studentId, points } = req.body;
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const existing = activity.grades.find(g => g.student.toString() === studentId);
    if (existing) {
      existing.points = Number(points);
      existing.gradedAt = new Date();
    } else {
      activity.grades.push({ student: studentId, points: Number(points) });
    }

    await activity.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
