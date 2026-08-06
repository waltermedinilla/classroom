// Ventana temporal de los gráficos de actividad docente.
//
// Se extrajo de routes/directivo.js cuando el panel de Jefatura de Sección necesitó la
// misma serie acotada a una sección: duplicar el armado garantizaba que los dos paneles
// mostraran meses distintos para el mismo docente. Mismo criterio con el que nació
// services/divisionDetail.js.
//
// Contrato:
//   SERIE_MESES          cuántos meses cubre la ventana (incluye el mes en curso)
//   inicioVentanaSerie() → Date del primer instante de la ventana
//   etiquetasMeses(desde) → ['2026-03', ..., '2026-08'], del más viejo al más nuevo
//   mesCorto('2026-08')  → 'ago'  (o 'ago 25' si es de otro año)
//   serieDesdeConteos(etiquetas, mapa) → [n, n, ...] alineado con las etiquetas

const SERIE_MESES = 6;

// Primer instante del mes que abre la ventana. Se normaliza a las 00:00 del día 1 para que
// el $gte no recorte el mes más viejo.
function inicioVentanaSerie() {
  const d = new Date();
  d.setMonth(d.getMonth() - (SERIE_MESES - 1));
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Etiquetas 'YYYY-MM' de la ventana. Se construyen en JS y NO desde los datos para que los
// meses sin actividad aparezcan igual, con cero: si la serie tuviera huecos, un mes sin
// trabajo no se distinguiría de un mes que no entró en la ventana — y ver el bache es
// justamente el objetivo del gráfico.
function etiquetasMeses(desde) {
  return Array.from({ length: SERIE_MESES }, (_, i) => {
    const d = new Date(desde.getFullYear(), desde.getMonth() + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

const NOMBRES_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// 'YYYY-MM' → 'jul' (o 'jul 25' si es de otro año, para que una ventana que cruza diciembre
// no muestre dos meses con el mismo nombre sin distinguirlos).
function mesCorto(clave) {
  const [anio, mes] = clave.split('-').map(Number);
  const nombre = NOMBRES_MES[mes - 1] || clave;
  return anio === new Date().getFullYear() ? nombre : `${nombre} ${String(anio).slice(2)}`;
}

// Alinea un mapa { 'YYYY-MM': n } contra las etiquetas, rellenando con 0 los meses que no
// están. Es el paso que convierte el resultado de un $group en algo que la vista puede
// recorrer sin preguntarse si el mes existe.
function serieDesdeConteos(etiquetas, conteos) {
  return etiquetas.map(k => conteos[k] || 0);
}

module.exports = {
  SERIE_MESES, inicioVentanaSerie, etiquetasMeses, mesCorto, serieDesdeConteos,
};
