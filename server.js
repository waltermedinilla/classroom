require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const connectDB = require('./config/db');
const { checkUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const courseRoutes = require('./routes/courses');
const announcementRoutes = require('./routes/announcements');
const activityRoutes = require('./routes/activities');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

connectDB();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use('*', checkUser);

app.use((req, res, next) => {
  res.locals.roleNames = {
    admin: 'Administrador',
    directivo: 'Directivo',
    teacher: 'Docente',
    preceptor: 'Preceptor',
    soe: 'SOE',
    student: 'Alumno',
  };
  next();
});

app.get('/', (req, res) => {
  if (!res.locals.user) return res.redirect('/login');
  res.redirect('/courses');
});

app.use('/', authRoutes);
app.use('/courses', courseRoutes);
app.use('/announcements', announcementRoutes);
app.use('/activities', activityRoutes);
app.use('/admin', adminRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
