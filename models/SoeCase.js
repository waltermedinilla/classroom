// Legajo del Servicio de Orientación Escolar: la historia de un alumno acompañado por el
// gabinete. Un documento por alumno, para siempre — un legajo se CIERRA y se REABRE, nunca
// se duplica (de ahí el índice único de abajo). Lo que se busca es que el año que viene
// alguien pueda leer lo que pasó el año pasado.
//
// ⚠️ Es el dato más sensible que guarda la plataforma. Quién puede leerlo, y cuánto, NO se
// decide acá: vive en services/soeAcceso.js y se configura por escuela en School.soeAccess.
// Este archivo solo define la forma. Ver specs/soe-orientacion.spec.md.
//
// Las entradas y las derivaciones van EMBEBIDAS y no en colecciones aparte porque:
//   1. un legajo se lee siempre entero — es una historia, no una tabla que se pagina;
//   2. son decenas de entradas por alumno, no miles (lejos del límite de 16 MB del doc);
//   3. y sobre todo: con un solo documento la regla de confidencialidad es UNA sola guarda.
//      Con tres colecciones habría tres lugares donde olvidarse de aplicarla.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const {
  ESTADOS, PRIORIDADES, TIPOS_ENTRADA, ANIMOS, TIPOS_DERIVACION, ESTADOS_DERIVACION,
} = require('../services/soeAcceso');

// ── Una entrada del seguimiento ──────────────────────────────────────────────
// El pulso a lo largo del tiempo: entrevistas, observaciones de aula, contactos con la
// familia, acuerdos con los docentes.
const entrySchema = new Schema({
  // La fecha del HECHO, no la de la carga. Una entrevista del martes cargada el viernes va
  // en su lugar de la línea de tiempo. Por eso la vista ordena por esto y no por createdAt.
  fecha: { type: Date, required: true },
  tipo:  { type: String, enum: TIPOS_ENTRADA, default: 'nota' },

  // "Cómo se encuentra". Opcional a propósito: no toda entrada es una evaluación del ánimo
  // del chico (un acuerdo con docentes no lo es), y forzar el campo llenaría la serie de
  // ruido. null = esta entrada no dice nada sobre cómo estaba.
  animo: { type: String, enum: [...ANIMOS, null], default: null },

  texto: { type: String, trim: true, required: true, maxlength: 4000 },

  // Queda el autor porque un legajo lo pueden escribir dos personas del gabinete a lo largo
  // de los años, y saber quién escribió qué es parte de la responsabilidad profesional.
  autor: { type: Schema.Types.ObjectId, ref: 'User', required: true },

  editedAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

// ── Una devolución del lugar al que se derivó ────────────────────────────────
// El "qué le dicen allá". Es lo que hoy se pierde: el chico va al hospital, alguien cuenta
// algo en un pasillo, y tres meses después nadie se acuerda.
const devolucionSchema = new Schema({
  fecha: { type: Date, required: true },   // cuándo lo dijeron, no cuándo se cargó
  texto: { type: String, trim: true, required: true, maxlength: 2000 },
  registradoPor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// ── Una derivación externa ───────────────────────────────────────────────────
const referralSchema = new Schema({
  destino:  { type: String, trim: true, required: true, maxlength: 200 }, // "Hospital Zonal — Salud Mental"
  tipo:     { type: String, enum: TIPOS_DERIVACION, default: 'otro' },
  motivo:   { type: String, trim: true, default: '', maxlength: 1000 },
  fecha:    { type: Date, required: true },                               // cuándo se derivó
  contacto: { type: String, trim: true, default: '', maxlength: 200 },    // referente del lugar
  estado:   { type: String, enum: ESTADOS_DERIVACION, default: 'derivado' },

  // Cuándo volver a preguntar. Vencida, la derivación se resalta en /soe/derivaciones: es
  // el mecanismo que evita que un chico derivado se pierda entre la derivación y la
  // devolución que nunca llegó.
  proximoSeguimiento: { type: Date, default: null },

  devoluciones: [devolucionSchema],

  creadaPor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

const soeCaseSchema = new Schema({
  student: { type: Schema.Types.ObjectId, ref: 'User',   required: true },
  school:  { type: Schema.Types.ObjectId, ref: 'School', required: true },

  // SNAPSHOT, no fuente de verdad. Un alumno no tiene división propia: se deduce de las
  // materias donde está inscripto (Course.division + Course.students, ver
  // services/attendance.js). Este campo existe para poder LISTAR y FILTRAR sin joins, y se
  // refresca al abrir o editar el legajo.
  //
  // ⚠️ La AUTORIZACIÓN nunca lo lee: middleware/soe.js resuelve las divisiones actuales del
  // alumno con una query. Si al chico lo cambiaron de curso, el que lo tiene que ver es el
  // SOE del curso nuevo, aunque acá siga figurando el viejo.
  division: { type: Schema.Types.ObjectId, ref: 'Division', default: null },

  estado:    { type: String, enum: ESTADOS,     default: 'abierto' },
  prioridad: { type: String, enum: PRIORIDADES, default: 'media' },

  motivo:       { type: String, trim: true, default: '', maxlength: 500 },   // por qué se abrió
  fortalezas:   { type: String, trim: true, default: '', maxlength: 1000 },  // con qué cuenta
  dificultades: { type: String, trim: true, default: '', maxlength: 1000 },  // qué le cuesta
  estrategias:  { type: String, trim: true, default: '', maxlength: 2000 },  // cómo contenerlo en el aula

  entries:   [entrySchema],
  referrals: [referralSchema],

  openedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  openedAt: { type: Date, default: Date.now },

  closedBy:     { type: Schema.Types.ObjectId, ref: 'User', default: null },
  closedAt:     { type: Date, default: null },
  cierreMotivo: { type: String, trim: true, default: '', maxlength: 500 },

  // Denormalizado: la fecha de la última entrada. Permite ordenar la lista del panel por
  // "última novedad" sin abrir los legajos uno por uno. Lo escribe routes/soe.js en cada
  // alta o baja de entrada — si alguna vez se desincroniza, lo peor que pasa es que la
  // lista se ordene raro; ninguna decisión de acceso depende de este campo.
  lastEntryAt: { type: Date, default: null },
}, { timestamps: true });

// UN legajo por alumno. Es la última red del "abrir dos veces": la ruta ya devuelve el
// existente en vez de crear otro, pero dos clicks simultáneos en el botón llegarían los dos
// a la ruta antes de que ninguno guarde.
soeCaseSchema.index({ student: 1 }, { unique: true });

// El listado del panel: los legajos de la escuela por estado y prioridad.
soeCaseSchema.index({ school: 1, estado: 1, prioridad: 1 });

// El alcance acotado (un gabinete por turno) filtra por división.
soeCaseSchema.index({ division: 1 });

// La solapa Derivaciones busca las que tienen seguimiento vencido en toda la escuela.
soeCaseSchema.index({ school: 1, 'referrals.proximoSeguimiento': 1 });

module.exports = mongoose.model('SoeCase', soeCaseSchema);
