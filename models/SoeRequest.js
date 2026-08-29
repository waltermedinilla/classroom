// Pedido de derivación de Preceptoría al Servicio de Orientación Escolar.
//
// El preceptor es el que ve al chico todos los días —llega tarde, faltó tres veces seguidas,
// se peleó en el recreo— y hasta el 2026-08-27 no tenía ninguna forma de avisarle al gabinete
// dentro de la plataforma: el aviso viajaba por WhatsApp o en un pasillo, y se perdía.
//
// ⚠️ POR QUÉ ES UNA COLECCIÓN PROPIA Y NO UN CAMPO DE SoeCase.
// SoeCase existe solo cuando el gabinete YA abrió el legajo. El pedido es justamente lo que
// llega ANTES de que exista, sobre un alumno que puede no tener legajo nunca. Embeberlo
// obligaría a crear el legajo para poder recibir el pedido, que es exactamente el filtro que
// esta feature quiere conservar: el SOE lo TOMA o lo DESCARTA.
// Y además se lee cruzando alumnos ("qué pedidos tengo pendientes en la escuela"), que es lo
// contrario de cómo se lee un legajo (entero, de un solo chico). El argumento de
// models/SoeCase.js para embeber —"un legajo se lee siempre entero"— acá no aplica.
//
// Ver specs/soe-derivacion-y-linea-de-tiempo.spec.md, decisiones D1 a D4.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { URGENCIAS, ESTADOS_PEDIDO } = require('../services/soeAcceso');

const soeRequestSchema = new Schema({
  student: { type: Schema.Types.ObjectId, ref: 'User',   required: true },
  school:  { type: Schema.Types.ObjectId, ref: 'School', required: true },

  // SNAPSHOT para poder listar la bandeja sin joins, igual que SoeCase.division.
  // ⚠️ La AUTORIZACIÓN nunca lo lee: las rutas resuelven las divisiones ACTUALES del alumno
  // con una query (middleware/soe.js). Si al chico lo cambiaron de curso, el que tiene que
  // atender el pedido es el gabinete del curso nuevo, aunque acá siga figurando el viejo.
  division: { type: Schema.Types.ObjectId, ref: 'Division', default: null },

  // Lo que vio el preceptor. Es el texto que, si el pedido se toma, entra al legajo como
  // primer hito de la línea de tiempo — firmado por él, no por el gabinete.
  motivo:   { type: String, trim: true, required: true, maxlength: 2000 },
  urgencia: { type: String, enum: URGENCIAS,      default: 'media' },
  estado:   { type: String, enum: ESTADOS_PEDIDO, default: 'pendiente' },

  solicitadaPor: { type: Schema.Types.ObjectId, ref: 'User', required: true },

  resueltaPor: { type: Schema.Types.ObjectId, ref: 'User',    default: null },
  resueltaEl:  { type: Date,                                  default: null },
  // A qué legajo fue a parar. null en los descartados: descartar no crea ningún legajo.
  soeCase:     { type: Schema.Types.ObjectId, ref: 'SoeCase', default: null },

  // ⚠️ EL ÚNICO TEXTO DEL GABINETE QUE LEE EL PRECEPTOR (decisión D4). El formulario del SOE
  // lo rotula así en la pantalla, para que nadie escriba acá un dato clínico creyendo que
  // queda adentro del gabinete. Opcional al tomar, OBLIGATORIO al descartar: un pedido que
  // se descarta sin decir por qué le enseña al preceptor a no volver a derivar.
  respuesta: { type: String, trim: true, default: '', maxlength: 500 },
}, { timestamps: true });

// UN pedido pendiente por alumno. Dos preceptores de turnos distintos pueden derivar al
// mismo chico la misma semana y el gabinete terminaría con dos pedidos idénticos.
//
// El índice es PARCIAL: solo chocan los 'pendiente'. Tomado o descartado un pedido, se puede
// volver a derivar al mismo alumno el mes que viene, que es el caso legítimo.
// Mismo patrón que Reserva (specs/recursos-reservas.spec.md). La ruta chequea antes y avisa
// con un mensaje claro; esto es la red para los dos clicks simultáneos, no la primera barrera.
soeRequestSchema.index(
  { student: 1 },
  { unique: true, partialFilterExpression: { estado: 'pendiente' } },
);

// La bandeja del gabinete: los pedidos de la escuela por estado.
soeRequestSchema.index({ school: 1, estado: 1, createdAt: -1 });

// "Mis pedidos", del lado del preceptor.
soeRequestSchema.index({ solicitadaPor: 1, createdAt: -1 });

module.exports = mongoose.model('SoeRequest', soeRequestSchema);
