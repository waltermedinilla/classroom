// Lista curada de intereses para el perfil (User.interests).
//
// Es una lista CERRADA a propósito, no texto libre: los alumnos de la escuela son menores
// y lo que cargan en el perfil lo ve el equipo directivo, así que un campo abierto obligaría
// a moderar. Con opciones predefinidas no hay nada que moderar, se ve prolijo sin esfuerzo
// del usuario, y a futuro permite agrupar ("alumnos con interés en tecnología").
//
// El mismo array se usa en los dos lados:
//   - backend  (routes/courses.js, PATCH /profile/about) para RECHAZAR lo que no esté acá
//   - frontend (views/profile.ejs) para pintar los chips
// Si se agrega una opción nueva, aparece automáticamente en ambos.
//
// `id` es lo que se guarda en la base (estable, no cambiarlo nunca aunque cambie el label).
// `label` y `icon` son solo presentación.
const INTERESTS = [
  { id: 'deportes',     label: 'Deportes',            icon: 'sports_soccer' },
  { id: 'musica',       label: 'Música',              icon: 'music_note' },
  { id: 'tecnologia',   label: 'Tecnología',          icon: 'memory' },
  { id: 'programacion', label: 'Programación',        icon: 'code' },
  { id: 'arte',         label: 'Arte y dibujo',       icon: 'palette' },
  { id: 'lectura',      label: 'Lectura',             icon: 'menu_book' },
  { id: 'escritura',    label: 'Escritura',           icon: 'edit_note' },
  { id: 'videojuegos',  label: 'Videojuegos',         icon: 'sports_esports' },
  { id: 'teatro',       label: 'Teatro',              icon: 'theater_comedy' },
  { id: 'cine',         label: 'Cine y series',       icon: 'movie' },
  { id: 'fotografia',   label: 'Fotografía',          icon: 'photo_camera' },
  { id: 'cocina',       label: 'Cocina',              icon: 'restaurant' },
  { id: 'naturaleza',   label: 'Naturaleza',          icon: 'park' },
  { id: 'animales',     label: 'Animales',            icon: 'pets' },
  { id: 'ciencia',      label: 'Ciencia',             icon: 'science' },
  { id: 'matematica',   label: 'Matemática',          icon: 'calculate' },
  { id: 'historia',     label: 'Historia',            icon: 'history_edu' },
  { id: 'idiomas',      label: 'Idiomas',             icon: 'translate' },
  { id: 'mecanica',     label: 'Mecánica',            icon: 'build' },
  { id: 'electricidad', label: 'Electricidad',        icon: 'bolt' },
  { id: 'construccion', label: 'Construcción',        icon: 'foundation' },
  { id: 'voluntariado', label: 'Voluntariado',        icon: 'volunteer_activism' },
];

// Máximo de intereses por persona. Sin tope, un perfil con las 22 opciones marcadas
// no comunica nada — obligar a elegir es lo que hace útil el dato.
const MAX_INTERESTS = 6;

const INTEREST_IDS = INTERESTS.map(i => i.id);

// id → label, para renderizar en las vistas read-only sin recorrer el array
const INTEREST_LABELS = Object.fromEntries(INTERESTS.map(i => [i.id, i.label]));
const INTEREST_ICONS  = Object.fromEntries(INTERESTS.map(i => [i.id, i.icon]));

module.exports = { INTERESTS, INTEREST_IDS, INTEREST_LABELS, INTEREST_ICONS, MAX_INTERESTS };
