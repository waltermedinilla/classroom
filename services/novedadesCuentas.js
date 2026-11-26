// Las cuentas de la solapa "Novedades" del superadmin — D7 de specs/recorrido-novedades.spec.md.
//
// Función pura: recibe los usuarios y las escuelas ya leídos y devuelve, por novedad, a cuántos
// les corresponde y cuántos la vieron (Entendido / Omitir). "Les corresponde" usa la MISMA
// función que decide si se muestra (corresponde, sin la fecha: cuenta a quién le podría tocar).
// "Volver a ver" no resta: una entrada con repetidaEn sigue contando como vista.

const { corresponde, entradaDe } = require('../config/novedades');

const str = (x) => (x == null ? '' : String(x));

function cuentasDeNovedad(nov, { usuarios = [], escuelas = new Map() }) {
  const vieron = [], faltan = [];
  let entendido = 0, omitir = 0;
  for (const u of usuarios) {
    if (u.active === false) continue;
    const school = escuelas.get(str(u.school)) || null;
    if (!corresponde(nov, { user: u, school })) continue;
    const e = entradaDe(u, nov.id);
    const fila = { id: str(u._id), name: u.name, role: u.role, escuela: school ? school.name : '' };
    if (e) {
      vieron.push({ ...fila, fecha: e.fecha || null, como: e.como || 'omitir' });
      if (e.como === 'entendido') entendido++; else omitir++;
    } else faltan.push(fila);
  }
  const porNombre = (a, b) => str(a.name).localeCompare(str(b.name), 'es', { sensitivity: 'base' });
  vieron.sort(porNombre); faltan.sort(porNombre);
  const corresponden = vieron.length + faltan.length;
  return {
    id: nov.id, titulo: nov.titulo || nov.id, para: nov.para || '', desde: nov.desde, hasta: nov.hasta || null,
    corresponden, vieron: vieron.length, entendido, omitir,
    pct: corresponden ? Math.round((vieron.length / corresponden) * 100) : 0,
    listaVieron: vieron, listaFaltan: faltan,
  };
}

module.exports = { cuentasDeNovedad };
