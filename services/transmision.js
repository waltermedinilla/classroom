// Reglas de la transmisión en vivo. Hermano de services/liveRoom.js y con su misma estructura:
// la primera mitad son funciones PURAS (reciben datos, no leen el reloj ni la base) y la
// segunda toca Mongo. Las puras se testean en tests/unit/transmision.test.js sin levantar nada.
//
// Ver specs/transmision-en-vivo.spec.md. Las constantes viven en config/transmision.js y el
// gobernador de ancho de banda en media/aforo.js.

const RoomSession = require('../models/RoomSession');
const Transmision = require('../models/Transmision');
const live        = require('./liveRoom');
const aforo       = require('../media/aforo');
const { CAPA_MAXIMA_EMISOR, PALABRA_INACTIVA_MS } = require('../config/transmision');

// El subdocumento por defecto, para una sesión guardada antes de que esta feature existiera.
// Mongoose devuelve los defaults del schema, pero una sesión traída con .lean() de un
// documento viejo trae `undefined`, y todo esto se pinta en el camino caliente.
const APAGADA = {
  activa: false, iniciadaAt: null,
  micro: false, pantalla: false, camara: false,
  capaMax: '360p', degradadaPor: '',
  palabra: null, palabraDesde: null, palabraCamara: false,
  manos: [],
};

const tx = (session) => (session && session.transmision) || APAGADA;

// ── Reglas puras ─────────────────────────────────────────────────────────────

// ¿Esta persona puede EMITIR en esta sala?
//
// `ctx.habilitado` es la respuesta de moduloActivoPara() y viene resuelta desde la ruta: acá no
// se consulta la escuela, porque esta función tiene que poder testearse sin base. Ver D10.
//
// ⭐ El alumno con la palabra también emite. Es la única forma en que un alumno publica algo, y
// la da el docente de a uno (D7).
function puedeEmitir(session, ctx) {
  if (!session) return false;
  if (ctx.esGestor) return !!ctx.habilitado;

  const t = tx(session);
  if (!t.activa || !t.palabra) return false;
  return String(t.palabra) === String(ctx.userId);
}

// ¿Esta persona puede VER la transmisión?
//
// Cualquiera que pueda estar en la sala, mientras esté al aire. NO se mira el módulo por
// persona: si se mirara, cada alumno tendría que estar en la lista de habilitados para ver a su
// profesora, que es exactamente el error que advierte config/modulos.js.
function puedeVer(session, ctx) {
  if (!session || !tx(session).activa) return false;
  return !!(ctx.esAlumno || ctx.esGestor || ctx.esPersonal);
}

// ¿Puede este alumno pedir la palabra?
// Silenciado en el chat = silenciado entero. Es la misma regla que ya rige para las imágenes en
// live.puedeCompartirImagen: silenciar a alguien no puede dejarle abierto el micrófono.
function puedeLevantarMano(session, ctx) {
  if (!session || !tx(session).activa) return false;
  if (!ctx.esAlumno) return false;
  return !estaSilenciado(session, ctx.userId);
}

function estaSilenciado(session, userId) {
  return (session.mutedStudents || []).some(u => String(u) === String(userId));
}

// ── La cola de manos ─────────────────────────────────────────────────────────
//
// Todas devuelven un array NUEVO: son puras, y así el llamador decide si guarda o no.

function levantarMano(manos, user, ahora = new Date()) {
  const lista = manos || [];
  // Levantar la mano dos veces no adelanta el turno. Es idempotente a propósito: el doble clic
  // y el reintento de un fetch son lo normal, no la excepción.
  if (lista.some(m => String(m.user) === String(user._id))) return lista;
  return [...lista, { user: user._id, nombre: user.name || '', desde: ahora }];
}

function bajarMano(manos, userId) {
  // Sacar a alguien del medio NO altera el orden de los demás: el que estaba tercero pasa a
  // segundo, no vuelve al final. El orden ES el dato de esta cola.
  return (manos || []).filter(m => String(m.user) !== String(userId));
}

const siguienteEnLaCola = (manos) => (manos && manos.length ? manos[0] : null);

const tieneLaMano = (manos, userId) =>
  (manos || []).some(m => String(m.user) === String(userId));

// ── La palabra ───────────────────────────────────────────────────────────────

// ¿Se le puede dar la palabra a esta persona? Devuelve null si sí, o el motivo del rechazo.
function porQueNoLaPalabra(session, alumnoId) {
  if (!session)             return 'La sala no está abierta';
  if (!tx(session).activa)  return 'La transmisión no está al aire';
  if (estaSilenciado(session, alumnoId)) {
    return 'Esa persona está silenciada en la sala. Sacale el silencio primero.';
  }
  return null;
}

// ¿Hay que cortarle la palabra por inactividad? El micrófono abierto y olvidado en la casa de
// un chico es lo peor que puede pasar en una sala de menores, así que se corta solo.
function palabraVencida(session, ahora = Date.now()) {
  const t = tx(session);
  if (!t.activa || !t.palabra || !t.palabraDesde) return false;
  return ahora - new Date(t.palabraDesde).getTime() > PALABRA_INACTIVA_MS;
}

// ── El estado que consume el poll ────────────────────────────────────────────

// La clave `transmision` que se agrega al JSON de estadoDeSala(). Una forma SOLA, siempre: la
// transmisión apagada devuelve el mismo objeto con los campos en su default, igual que hace la
// sala cerrada. Un cliente que reciba dos formas distintas termina lleno de `if (x && x.y)`.
function estadoParaCliente(session, ctx, extra = {}) {
  const t = tx(session);
  const activa = !!t.activa && !!session;

  return {
    activa,
    micro:    !!t.micro,
    pantalla: !!t.pantalla,
    camara:   !!t.camara,
    docente:  extra.docenteNombre || '',
    desde:    activa && t.iniciadaAt ? live.hora(t.iniciadaAt) : '',

    capaMax:      t.capaMax || '360p',
    degradadaPor: t.degradadaPor || '',

    // Lo que decide qué botones se pintan. Va calculado en el SERVIDOR y no en el navegador,
    // por lo mismo que `puedoEscribir` en la sala: es el MISMO cálculo que autoriza el POST,
    // así que el botón no puede quedar prometiendo algo que el servidor va a rechazar.
    puedoVer:    puedeVer(session, ctx),
    puedoEmitir: puedeEmitir(session, ctx),
    puedoPedirLaPalabra: puedeLevantarMano(session, ctx),

    miMano: tieneLaMano(t.manos, ctx.userId),
    manos:  (t.manos || []).map(m => ({
      uid:    String(m.user),
      nombre: m.nombre || '—',
      desde:  live.hora(m.desde),
    })),

    palabra: t.palabra ? {
      uid:    String(t.palabra),
      nombre: (t.manos || []).find(m => String(m.user) === String(t.palabra))?.nombre
              || extra.palabraNombre || '—',
      camara: !!t.palabraCamara,
      mia:    String(t.palabra) === String(ctx.userId),
    } : null,

    // Cuántos están mirando. Lo sabe el proceso de medios, no la base: se inyecta desde la
    // ruta. Sin dato, 0 — nunca `undefined`, que en la vista se pinta como "undefined mirando".
    espectadores: extra.espectadores || 0,
  };
}

// ── Mongo ────────────────────────────────────────────────────────────────────

// Prende la transmisión. Devuelve { ok, transmision, error }.
//
// El gobernador corre ACÁ y no en el navegador: es el único lugar donde se sabe cuánta gente
// hay mirando en TODA la escuela, y es el que puede decir que no.
async function abrir(session, course, docente, { espectadores = 0, clases = 0, modo = {} } = {}) {
  const decision = aforo.decidir(espectadores, { clases });
  if (!decision.capa) {
    return { ok: false, error: decision.mensaje, motivo: decision.motivo };
  }

  // El emisor nunca sube más alto que el techo, aunque el gobernador permita más.
  const capa = decision.capa === '360p' ? CAPA_MAXIMA_EMISOR : decision.capa;

  const registro = await Transmision.create({
    session:  session._id,
    course:   course._id,
    school:   course.school,
    division: course.division?._id || course.division,
    docente:  docente._id,
    docenteNombre: docente.name || '',
    capaMaxAlcanzada: capa,
  });

  await RoomSession.updateOne({ _id: session._id }, {
    $set: {
      'transmision.activa':       true,
      'transmision.iniciadaAt':   new Date(),
      // El micrófono y la pantalla arrancan prendidos y la cámara apagada (D6): el modo por
      // defecto de una clase es lo que el docente muestra, no su cara.
      'transmision.micro':        modo.micro    !== false,
      'transmision.pantalla':     modo.pantalla !== false,
      'transmision.camara':       modo.camara   === true,
      'transmision.capaMax':      capa,
      'transmision.degradadaPor': decision.motivo,
      'transmision.palabra':      null,
      'transmision.palabraDesde': null,
      'transmision.palabraCamara': false,
      'transmision.manos':        [],
      // La transmisión ES actividad: sin esto, una clase expositiva de 35 minutos sin un solo
      // mensaje de chat se autocerraría en el medio (RN-4).
      lastActivityAt: new Date(),
    },
  });

  return { ok: true, transmision: registro, capa, aviso: decision.mensaje };
}

// Apaga la transmisión y cierra su registro histórico.
async function cerrar(session, { cerradaPor = 'docente', metricas = {} } = {}) {
  await RoomSession.updateOne({ _id: session._id }, {
    $set: {
      'transmision.activa':        false,
      'transmision.micro':         false,
      'transmision.pantalla':      false,
      'transmision.camara':        false,
      'transmision.palabra':       null,
      'transmision.palabraDesde':  null,
      'transmision.palabraCamara': false,
      'transmision.manos':         [],
      'transmision.degradadaPor':  '',
    },
  });

  // Se cierra la ÚLTIMA abierta de esta sesión. Si no hay ninguna —porque el proceso de medios
  // se cayó y ya la cerró— no pasa nada: cerrar es idempotente.
  await Transmision.findOneAndUpdate(
    { session: session._id, terminadaAt: null },
    { $set: { terminadaAt: new Date(), cerradaPor, ...metricas } },
    { sort: { iniciadaAt: -1 } },
  );
}

// Prende o apaga micrófono, pantalla o cámara sin cortar la emisión.
async function cambiarModo(session, cambios) {
  const set = { lastActivityAt: new Date() };
  for (const k of ['micro', 'pantalla', 'camara']) {
    if (k in cambios) set[`transmision.${k}`] = cambios[k] === true;
  }
  await RoomSession.updateOne({ _id: session._id }, { $set: set });
  return set;
}

// Aplica una decisión del gobernador a una transmisión ya abierta. La usa el proceso de medios
// cuando el aforo cambia: las clases YA abiertas también bajan de calidad (criterio 20).
async function aplicarCapa(sessionId, capa, motivo) {
  await RoomSession.updateOne({ _id: sessionId }, {
    $set: { 'transmision.capaMax': capa, 'transmision.degradadaPor': motivo || '' },
  });
  if (motivo) {
    await Transmision.findOneAndUpdate(
      { session: sessionId, terminadaAt: null },
      { $inc: { degradaciones: 1 } },
      { sort: { iniciadaAt: -1 } },
    );
  }
}

async function guardarManos(sessionId, manos) {
  await RoomSession.updateOne({ _id: sessionId }, { $set: { 'transmision.manos': manos } });
}

async function darLaPalabra(sessionId, alumnoId, { camara = false } = {}) {
  await RoomSession.updateOne({ _id: sessionId }, {
    $set: {
      'transmision.palabra':       alumnoId,
      'transmision.palabraDesde':  new Date(),
      'transmision.palabraCamara': camara === true,
    },
  });
}

async function quitarLaPalabra(sessionId) {
  await RoomSession.updateOne({ _id: sessionId }, {
    $set: {
      'transmision.palabra':       null,
      'transmision.palabraDesde':  null,
      'transmision.palabraCamara': false,
    },
  });
}

module.exports = {
  // puras
  puedeEmitir, puedeVer, puedeLevantarMano, estaSilenciado,
  levantarMano, bajarMano, siguienteEnLaCola, tieneLaMano,
  porQueNoLaPalabra, palabraVencida, estadoParaCliente, APAGADA,
  // mongo
  abrir, cerrar, cambiarModo, aplicarCapa, guardarManos,
  darLaPalabra, quitarLaPalabra,
};
