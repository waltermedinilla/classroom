const mongoose = require('mongoose');

// Sub-schema para los comentarios de una novedad
const commentSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:   { type: String, required: true, trim: true },
}, { timestamps: true }); // createdAt se usa para mostrar la fecha del comentario en la vista

const announcementSchema = new mongoose.Schema({
  // Curso al que pertenece la novedad; se usa para filtrar en GET /announcements/course/:id
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  // Usuario que publicó la novedad (puede ser docente o alumno)
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  text: {
    type: String,
    required: [true, 'Text is required'],
    trim: true,
  },
  // Ruta pública de imagen opcional adjunta a la novedad
  // Formato: /archivos/{schoolId}/novedades/{courseId}/{filename}
  image: {
    type: String,
    default: null,
  },
  // Comentarios anidados: se agregan con ann.comments.push() y se guardan con ann.save()
  comments: [commentSchema],
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
