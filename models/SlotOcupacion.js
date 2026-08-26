const mongoose = require('mongoose');
const { Schema } = mongoose;

// Cuántas unidades de un recurso DIVISIBLE están tomadas en un casillero (recurso × día ×
// turno × módulo). Existe por una sola razón: hacer que "no pasarse de 30 netbooks" sea una
// operación atómica. Ver services/recursos/cupo.js, que es el único archivo que lo escribe.
//
// ── POR QUÉ NO ALCANZA CON SUMAR LAS RESERVAS ──────────────────────────────────────────
// El cupo de un recurso divisible es una SUMA, y una suma no cabe en un índice único. La
// versión intuitiva —leer el total, comparar, crear— es una carrera abierta: con los 2
// workers de PM2, dos aprobaciones simultáneas leen 20 las dos y confirman 15 cada una.
// Con este documento la decisión y la escritura son UNA operación sobre UN documento, que es
// lo único que Mongo garantiza atómico sin transacciones.
//
// ── ⚠️ ESTO ES ESTADO DERIVADO, Y EL ESTADO DERIVADO SE DESINCRONIZA ────────────────────
// `ocupadas` tiene que BAJAR en cada camino de salida: cancelar, rechazar, que el
// administrativo edite la cantidad otorgada, que se borre el recurso, que se borre un módulo
// del horario. Olvidar uno solo filtra cupo para siempre: las netbooks figuran ocupadas y no
// las tiene nadie, y nadie puede saber por qué.
//
// Por eso nace con su antídoto y no después: el diagnóstico `ocupacion-descuadrada` de
// /superadmin/otros recalcula este número sumando las reservas confirmadas y muestra las
// diferencias ANTES de arreglarlas (services/dbFixes.js).
//
// LA VERDAD VIVE EN LAS RESERVAS. Esto es solo la forma de decidir rápido y sin carreras.
const slotOcupacionSchema = new Schema({
  recurso:  { type: Schema.Types.ObjectId, ref: 'Recurso', required: true },
  date:     { type: String, required: true },   // 'YYYY-MM-DD', igual que Reserva.date
  turno:    { type: String, required: true },
  modulo:   { type: Number, required: true },
  ocupadas: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true });

// Único: un casillero, un contador. Además es lo que convierte el "insertar si no existe" de
// services/recursos/cupo.js en algo seguro — si dos requests intentan crear el mismo
// casillero a la vez, el segundo recibe E11000 y reintenta contra el camino del $inc.
slotOcupacionSchema.index({ recurso: 1, date: 1, turno: 1, modulo: 1 }, { unique: true });

module.exports = mongoose.model('SlotOcupacion', slotOcupacionSchema);
