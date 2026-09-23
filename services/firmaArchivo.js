// La URL firmada de la previsualización de Office — specs/correccion-de-entregas.spec.md, RN-15.
//
// ── Por qué existe ────────────────────────────────────────────────────────────
// `view.officeapps.live.com` NO muestra el archivo que le mandamos: lo DESCARGA desde sus
// propios servidores, sin nuestra cookie de sesión. Como `GET /activities/submission-file/
// :filename` está detrás de requireAuth —y requireAuth REDIRIGE a /login—, Microsoft recibe
// un 302 a una página HTML y muestra su error genérico. Por eso hoy, en producción, ninguno
// de los 296 `.docx` entregados se previsualiza.
//
// ── Ruta separada, no un `if` adentro de la ruta con guarda ───────────────────
// El enlace firmado lo sirve `GET /activities/entrega-firmada/:filename`, que no pasa por
// requireAuth. Un bypass condicional adentro de una ruta autenticada es como nacen los
// agujeros de auth: la próxima persona que edite esa ruta no tiene por qué saber que el
// `if` de arriba desactiva la guarda.
//
// ⚠️ La contrapartida, escrita: durante esos 5 minutos, cualquiera que tenga el enlace exacto
// baja el archivo sin estar logueado. Se acota con TTL corto, UN archivo por enlace (el
// filename entra en la firma) y auditoría de cada emisión. El archivo es de un menor, así que
// el TTL no se estira sin volver a discutirlo.
const crypto = require('crypto');

const TTL_POR_DEFECTO_MS = 5 * 60 * 1000;

// La clave se DERIVA de JWT_SECRET en vez de usarlo crudo: dos usos distintos del mismo
// secreto no comparten material de clave.
//
// Si JWT_SECRET no está (un clon nuevo, un test suelto), se usa una clave aleatoria de este
// proceso. Es lo correcto y no un parche: un default fijo sería una clave pública, y lo único
// que se pierde con la aleatoria es que los enlaces no sobreviven a un reinicio — duran 5
// minutos, así que no sobrevivían igual. Rotar JWT_SECRET tiene el mismo efecto inofensivo.
let claveCache = null;
function clave() {
  if (!claveCache) {
    const secreto = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
    claveCache = crypto.createHash('sha256').update('firma-archivo:' + secreto).digest();
  }
  return claveCache;
}

function hmac(filename, exp, quien) {
  return crypto.createHmac('sha256', clave())
    .update(`${filename}.${exp}.${quien}`)
    .digest('hex');
}

// Quién pidió el enlace, en opaco. El `docenteId` entra en la firma como manda RN-15, pero
// NO en claro: la URL se le entrega a Microsoft, y el ObjectId de una persona no tiene por
// qué viajar a un tercero para que una firma se pueda verificar (decisión del usuario,
// 2026-09-21). El token cumple la misma función —dos docentes producen firmas distintas para
// el mismo archivo, y reusar el enlace del otro no sirve— y no se puede volver atrás para
// sacar el id.
//
// Trazabilidad: quién emitió cada enlace ya queda en la auditoría (`submission.preview_link`),
// que es donde se lo busca. Acá no se pierde nada.
function tokenDeDocente(docenteId) {
  return crypto.createHmac('sha256', clave())
    .update('docente:' + String(docenteId || ''))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Firma el acceso a UN archivo, para UN docente, por 5 minutos.
 *
 * @param   {string} filename    el nombre único en disco (entra en la firma: la firma de A no
 *                               sirve para pedir B)
 * @param   {string} docenteId   quién pidió el enlace; entra en la firma y viaja en ella
 * @param   {number} ttlMs       opcional
 * @returns {{url: string, expiraEn: string, exp: number, sig: string}}
 */
function firmar(filename, docenteId, ttlMs = TTL_POR_DEFECTO_MS) {
  const exp = Date.now() + ttlMs;
  const quien = tokenDeDocente(docenteId);
  // El token del docente viaja DENTRO de `sig` y no como parámetro aparte: la ruta pública no
  // recibe ningún dato que haya que validar por su cuenta, y verificar() no necesita saber a
  // quién preguntarle — recupera el insumo de la propia firma y la recalcula entera. Mentir
  // el token cambia el HMAC, así que no hay nada que ganar alterándolo.
  const sig = `${quien}.${hmac(filename, exp, quien)}`;
  const url = `/activities/entrega-firmada/${encodeURIComponent(filename)}`
            + `?exp=${exp}&sig=${encodeURIComponent(sig)}`;
  return { url, expiraEn: new Date(exp).toISOString(), exp, sig };
}

/**
 * ¿Este enlace sirve para este archivo, ahora?
 *
 * @param   {object} pedido              { filename, exp, sig } tal como llegan de la query
 * @param   {object} [opciones]          { comoDocenteId } para exigir que sea de un docente
 * @returns {{ok: true, quien: string} | {ok: false, motivo: string}}
 *          motivo: 'FIRMA_INVALIDA' | 'ENLACE_VENCIDO'
 */
function verificar(pedido, opciones = {}) {
  const p = pedido || {};
  const filename = String(p.filename || '');
  const exp = Number(p.exp);
  const sig = String(p.sig || '');

  const corte = sig.indexOf('.');
  if (!filename || !Number.isFinite(exp) || corte <= 0) {
    return { ok: false, motivo: 'FIRMA_INVALIDA' };
  }

  const quien     = sig.slice(0, corte);
  const recibida  = Buffer.from(sig.slice(corte + 1), 'utf8');
  const esperada  = Buffer.from(hmac(filename, exp, quien), 'utf8');

  // timingSafeEqual TIRA si los buffers no miden lo mismo, así que el largo se compara antes
  // (precedente: models/ContactVerification.js). Una `sig` corta o mal formada tiene que dar
  // un 403 prolijo, no una excepción sin capturar.
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) {
    return { ok: false, motivo: 'FIRMA_INVALIDA' };
  }
  if (opciones.comoDocenteId && tokenDeDocente(opciones.comoDocenteId) !== quien) {
    return { ok: false, motivo: 'FIRMA_INVALIDA' };
  }
  // El vencimiento se mira DESPUÉS de la firma: un `exp` alterado nunca llega hasta acá, así
  // que "venció" solo se contesta cuando el enlace era de verdad nuestro.
  if (exp < Date.now()) return { ok: false, motivo: 'ENLACE_VENCIDO' };

  // `quien` es el token, no el id: sirve para comparar dos enlaces entre sí, no para saber
  // de quién es. Para eso está la auditoría.
  return { ok: true, quien };
}

module.exports = { firmar, verificar, TTL_POR_DEFECTO_MS };
