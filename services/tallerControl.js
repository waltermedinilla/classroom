// Control de los MEP — F2 de specs/jefe-de-taller.spec.md.
//
// Funciones puras: la ruta junta los datos de cada día con filasDelDia (routes/secretaria.js,
// RN-F2-4) y acá se arma la grilla MEP × día con sus totales, y se filtran los renglones del
// horario oficial que son de taller (RN-F2-5).

const { coincideMateria } = require('./secretariaHorarioOficial');
const { sugerirTaller } = require('./tallerAlcance');
const { diaSemana } = require('./secretariaPuntualidad');

const str = (x) => (x == null ? '' : String(x));
const DIAS_SIN_GRILLA = [1, 2, 3, 4, 5];

const aUTC = (f) => { const [y, m, d] = f.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const sumarDia = (f) => { const d = aUTC(f); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

// JT-11. Los días hábiles del período (ventanaDelPeriodo: inicio inclusive, fin exclusivo):
// solo los días de la grilla de la escuela (1 lunes … 6 sábado), y nunca después de hoy.
function diasHabiles(ventana, diasGrilla, hoy) {
  const dias = (Array.isArray(diasGrilla) && diasGrilla.length ? diasGrilla : DIAS_SIN_GRILLA).map(Number);
  const out = [];
  for (let f = ventana.inicio; f < ventana.fin && out.length < 40; f = sumarDia(f)) {
    if (hoy && f > hoy) break;
    if (dias.includes(diaSemana(f))) out.push(f);
  }
  return out;
}

// JT-12. porDia: Map fecha → filas de filasDelDia de ese día. meps: [{ id, name, materias }].
// Devuelve [{ id, name, materias, celdas: { fecha → celda | null }, totales }], por nombre.
function matrizControl({ meps = [], fechas = [], porDia = new Map() }) {
  const filaDe = new Map();
  for (const f of fechas) {
    const m = new Map();
    for (const fila of porDia.get(f) || []) m.set(str(fila.id), fila);
    filaDe.set(f, m);
  }
  return meps.map(mep => {
    const totales = { conClase: 0, actividad: 0, ingreso: 0, sinRegistro: 0, tarde: 0 };
    const celdas = {};
    for (const f of fechas) {
      const fila = filaDe.get(f).get(str(mep.id));
      if (!fila) { celdas[f] = null; continue; }
      const p = (fila.puntualidad && fila.puntualidad.estado) || 'sinClase';
      const conClase = p !== 'sinClase';
      celdas[f] = { estado: fila.estado, puntualidad: p, conClase, nota: !!fila.nota, texto: fila.textoPuntualidad || '' };
      if (!conClase) continue;
      totales.conClase += 1;
      if (totales[fila.estado] != null) totales[fila.estado] += 1;
      if (p === 'tarde') totales.tarde += 1;
    }
    return { id: str(mep.id), name: mep.name, materias: mep.materias || [], celdas, totales };
  }).sort((a, b) => str(a.name).localeCompare(str(b.name), 'es'));
}

// JT-13. Un renglón oficial es de taller si su materia coincide con un taller de esa división
// o si el nombre oficial ya es de taller.
function esRenglonDeTaller(entrada, nombresTalleres = []) {
  const materia = entrada && entrada.materia;
  if (!materia) return false;
  if (nombresTalleres.some(n => coincideMateria(materia, n))) return true;
  return sugerirTaller(materia);
}

function filtrarOficialTaller(oficial, nombresTalleres = []) {
  if (!oficial) return oficial;
  return { ...oficial, entradas: (oficial.entradas || []).filter(e => esRenglonDeTaller(e, nombresTalleres)) };
}

module.exports = { DIAS_SIN_GRILLA, diasHabiles, matrizControl, esRenglonDeTaller, filtrarOficialTaller };
