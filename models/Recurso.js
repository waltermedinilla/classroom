const mongoose = require('mongoose');
const { Schema } = mongoose;

// Un recurso reservable de la escuela: la sala de computación, el laboratorio, el carro de
// netbooks, el proyector. Los carga el ADMINISTRATIVO desde /admin/recursos.
//
// ── `divisible` ES EL CAMPO QUE PARTE EL MÓDULO EN DOS ──────────────────────────────────
// No es una preferencia de UI: decide con qué mecanismo se garantiza que nadie se pase del
// cupo, y son dos mecanismos distintos e incompatibles.
//
//   divisible: false  (la Sala de Computación)
//     Reservarla es ocuparla ENTERA: un docente por módulo. La guarda es el índice único
//     parcial de models/Reserva.js, que no se puede engañar ni desincronizar.
//
//   divisible: true   (las netbooks)
//     El pool se reparte: uno pide 12 y otro se lleva las 18 que quedan. "No pasarse de 30"
//     es una SUMA, y una suma no cabe en un índice único — la guarda pasa a ser el contador
//     atómico de models/SlotOcupacion.js. Ver services/recursos/cupo.js.
const recursoSchema = new Schema({
  school: { type: Schema.Types.ObjectId, ref: 'School', required: true },
  name:   { type: String, required: [true, 'El nombre del recurso es requerido'], trim: true },
  tipo:   { type: String, enum: ['aula', 'laboratorio', 'equipamiento', 'otro'], default: 'aula' },

  // Cuántas unidades hay. En un recurso NO divisible es informativo y es lo que el docente
  // mira para saber si le entra el curso ("son 20 máquinas"); en uno divisible es el techo
  // duro que aplica el contador.
  capacidad:  { type: Number, default: 1, min: 1 },
  divisible:  { type: Boolean, default: false },

  // Tope de lo que un docente puede PEDIR de una vez. En las netbooks son 15 de 30: la
  // mitad, justamente para que entren dos cursos a la misma hora.
  // No es el tope de lo que se puede OTORGAR: el administrativo lo puede pasar hasta la
  // capacidad al aprobar, porque es su decisión y queda auditada. null = sin tope propio.
  maxPorPedido: { type: Number, default: null },

  ubicacion: { type: String, trim: true, default: '' },
  notas:     { type: String, trim: true, default: '' },

  // true  = el docente pide y el administrativo resuelve (y puede dejarlo autorizado para
  //         las próximas — ver models/RecursoAutorizacion.js).
  // false = todo docente de la escuela reserva directo. Es el proyector del pasillo: pedir
  //         permiso para algo que nadie custodia solo agrega fricción.
  requiereAutorizacion: { type: Boolean, default: true },

  activo: { type: Boolean, default: true },
}, { timestamps: true });

// No puede haber dos recursos con el mismo nombre en la misma escuela. Mismo criterio que
// models/Division.js.
recursoSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Recurso', recursoSchema);
