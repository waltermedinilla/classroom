const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
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
  image: {
    type: String,
    default: null,
  },
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
