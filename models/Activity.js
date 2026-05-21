const mongoose = require('mongoose');

const gradeSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  points: { type: Number, required: true, min: 0 },
  gradedAt: { type: Date, default: Date.now },
});

const activitySchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: [true, 'El título es requerido'], trim: true },
  description: { type: String, default: '', trim: true },
  dueDate: { type: Date, default: null },
  availableFrom: { type: Date, default: Date.now },
  points: { type: Number, default: null, min: 0 },
  grades: [gradeSchema],
}, { timestamps: true });

module.exports = mongoose.model('Activity', activitySchema);
