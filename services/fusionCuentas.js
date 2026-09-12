// La DECISIÓN de la fusión de cuentas duplicadas, sin base de datos.
//
// Qué resuelve: dadas dos (o más) cuentas que son la misma persona —mismo DNI, misma
// escuela—, cuál se conserva, cuáles se deshabilitan, y si eso lo puede hacer un botón o
// tiene que mirarlo alguien.
//
// Por qué vive acá y no en services/dbFixes.js, que es quien la usa: ahí estaba enterrada
// entre dos barridos de Mongo y 419 materias, así que la única forma de probarla era montar
// un smoke test con fixtures. Acá son objetos, y tests/unit/fusionCuentas.test.js los recorre
// con las cuatro formas que aparecen de verdad en producción.
//
// Spec: specs/fusion-de-cuentas.spec.md (RN-01, RN-02, RN-12, RN-13, RN-14).
//
// ⚠️ REGLA QUE NO SE NEGOCIA (RN-12, decidida por el usuario el 2026-09-12): la resolución
// automática DESHABILITA. No hay ninguna rama que elimine una cuenta, y por eso el campo se
// llama `deshabilitar` y no `sobrante`: para que agregar un borrado exija cambiarle el nombre
// y no pase por descuido.

// Por qué los motivos son constantes y no strings sueltos: la pantalla los traduce a un
// cartel, el test los compara, y un typo en cualquiera de los dos lados haría que un grupo
// no elegible pareciera elegible.
const MOTIVOS = {
  // Las dos cuentas tienen trabajo propio: lo mira una persona (RN-14).
  DISPUTADA:      'disputada',
  // La cuenta que sobraría está cursando en algún lado: deshabilitarla le saca ese acceso.
  SOBRANTE_CURSA: 'sobrante-cursa',
  // Alguien usó la cuenta que sobraría: no se apaga sin avisarle (RN-13).
  NECESITA_AVISO: 'necesita-aviso',
  // Ninguna de las dos tiene nada: no hay dato del que deducir cuál es la real.
  SIN_DATOS:      'sin-datos',
  // Ya está resuelto: las sobrantes están deshabilitadas y sin materias. No es trabajo
  // pendiente, y sin esto el grupo seguiría apareciendo para siempre.
  YA_RESUELTO:    'ya-resuelto',
};

// DNI normalizado para COMPARAR dos cuentas, no para validar uno nuevo.
//
// Es lo que explica por qué el índice único { school, dni } nunca frenó estos duplicados:
// compara el string crudo, así que "12.345.678" y "12345678" conviven sin que Mongo se queje.
// Devuelve '' cuando no queda nada comparable — incluido el DNI "0", que no es un DNI.
function normalizarDni(dni) {
  if (dni == null) return '';
  const limpio = String(dni).replace(/\D/g, '').replace(/^0+/, '');
  return limpio;
}

// La clave del grupo: escuela + DNI, SIN la división.
//
// ⭐ Este es el cambio de la Fase 1. Antes la clave llevaba la división y el diagnóstico
// exigía que las dos cuentas estuvieran en materias de la MISMA, con lo cual los 41 casos
// donde la cuenta sobrante no tiene ninguna materia —que son justamente los fáciles— no se
// veían. Medido el 2026-09-12: la pantalla mostraba 3 de 59 grupos.
//
// Entre escuelas NO se agrupa: una persona puede trabajar legítimamente en dos.
function claveDeGrupo({ schoolId, dni }) {
  return `${schoolId}|${normalizarDni(dni)}`;
}

// "Trabajo propio" = lo que solo pudo haber generado una persona usando ESA cuenta.
//
// Las aperturas de tarea, la presencia en sala y las asistencias entran con peso chico porque
// se generan casi sin querer: entrar una vez a la plataforma deja aperturas y una marca de
// asistencia. Una entrega o una nota, no: eso es trabajo, o alguien que corrigió.
const PESO = { entregas: 100, notas: 100, comentarios: 10, sala: 5, aperturas: 1, asistencias: 1 };

function pesoDeCuenta(c) {
  const t = c.trabajo || {};
  return Object.entries(PESO).reduce((acc, [k, p]) => acc + (t[k] || 0) * p, 0);
}

// 10 en la escala de PESO: p. ej. 2 mensajes de sala, o 10 aperturas. Las 8 cuentas del caso
// que explica tieneTrabajoPropio() quedan abajo (1 o 2 aperturas = 1 o 2 puntos); una cuenta
// con 12 mensajes de sala y 40 aperturas queda arriba, que es lo correcto: esa la usó alguien.
const UMBRAL_ACTIVIDAD = 10;

// ¿Esta cuenta tiene trabajo PROPIO, del que obliga a que decida una persona?
//
// El umbral existe por un caso real y medido: de los 11 grupos donde las dos cuentas tienen
// algo, 8 tienen en la segunda una o dos aperturas sueltas y nada más — el chico entró una
// vez por la cuenta equivocada. Tratarlos como disputados mandaría 8 casos a revisión manual
// sin que haya nada que revisar.
//
// Una entrega o una nota NO tienen umbral: alcanza una.
function tieneTrabajoPropio(c) {
  const t = c.trabajo || {};
  if ((t.entregas || 0) > 0 || (t.notas || 0) > 0) return true;
  // Sin entregas ni notas, hace falta actividad sostenida para considerarla "usada de verdad".
  return pesoDeCuenta(c) >= UMBRAL_ACTIVIDAD;
}

// La decisión completa de un grupo.
//
// `cuentas` es una lista de, al menos, dos:
//   { id, activa, lastSeen, createdAt, materias, divisiones: [...], trabajo: {...} }
//
// Devuelve { orden, sugeridaId, ambigua, masiva }.
// `masiva.elegible` dice si el botón puede resolverlo solo; si no, `masiva.motivo` dice por qué
// —y ese motivo es lo que la pantalla tiene que mostrar, porque "no se puede" sin el motivo
// obliga a la persona a adivinar qué mirar.
function clasificarGrupo(cuentas, { avisoDisponible = false } = {}) {
  if (!Array.isArray(cuentas) || cuentas.length < 2) {
    throw new Error('Un grupo de duplicados tiene al menos dos cuentas');
  }

  // Orden: primero la que tiene el trabajo hecho (es la real). Si empatan, la que más "vive":
  // habilitada, en más materias, con conexión más reciente, y más antigua.
  //
  // El desempate final por `createdAt` no es decorativo: sin un criterio total, dos cuentas
  // igual de vacías se ordenarían según lo que devolvió Mongo y la pantalla sugeriría una
  // distinta en cada recarga.
  const orden = [...cuentas].sort((a, b) =>
    pesoDeCuenta(b) - pesoDeCuenta(a) ||
    (b.activa !== false) - (a.activa !== false) ||
    (b.materias || 0) - (a.materias || 0) ||
    new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0) ||
    new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );

  const conservada = orden[0];
  const sobrantes  = orden.slice(1);
  const conTrabajo = orden.filter(tieneTrabajoPropio);
  const ambigua    = conTrabajo.length > 1;

  const masiva = (() => {
    const no = (motivo) => ({ elegible: false, motivo, keepId: null, deshabilitar: [], avisar: [] });

    // El orden de estos cortes es el orden en que hay que leerlos, del más caro de equivocarse
    // al más barato.

    // 1. Las dos tienen trabajo: no hay regla, la mira una persona (RN-14).
    if (ambigua) return no(MOTIVOS.DISPUTADA);

    // 2. Nadie tiene nada: no hay dato del que deducir cuál es la real.
    if (conTrabajo.length === 0) return no(MOTIVOS.SIN_DATOS);

    // 3. Ya resuelto: las sobrantes están deshabilitadas y sin materias. Se chequea ANTES de
    //    los dos cortes que siguen, porque si no un grupo ya resuelto quedaría reportado para
    //    siempre con el motivo equivocado.
    if (sobrantes.every(c => c.activa === false && !(c.materias || 0))) {
      return no(MOTIVOS.YA_RESUELTO);
    }

    // 4. Alguna sobrante está cursando: deshabilitarla le saca un acceso que sí usa, y eso no
    //    se ve mirando el duplicado (CA-05).
    if (sobrantes.some(c => (c.materias || 0) > 0)) return no(MOTIVOS.SOBRANTE_CURSA);

    // 5. Alguien usó la cuenta que se va a apagar: no se apaga sin avisarle (RN-13). Mientras
    //    el aviso no exista, el botón no la toca.
    const usadas = sobrantes.filter(c => c.lastSeen);
    if (usadas.length && !avisoDisponible) return no(MOTIVOS.NECESITA_AVISO);

    return {
      elegible: true,
      motivo: null,
      keepId: conservada.id,
      // RN-12: se deshabilitan. Las que ya lo están no hace falta volver a tocarlas.
      deshabilitar: sobrantes.filter(c => c.activa !== false).map(c => c.id),
      // El aviso va a la cuenta CONSERVADA, que es la única a la que la persona va a poder
      // entrar. Una sobrante que nadie usó no genera aviso: no hay a quién avisarle nada.
      avisar: usadas.map(c => ({ paraId: conservada.id, porqueSeDeshabilito: c.id })),
    };
  })();

  return {
    orden: orden.map(c => c.id),
    sugeridaId: conservada.id,
    ambigua,
    masiva,
  };
}

module.exports = {
  MOTIVOS,
  UMBRAL_ACTIVIDAD,
  normalizarDni,
  claveDeGrupo,
  pesoDeCuenta,
  tieneTrabajoPropio,
  clasificarGrupo,
};
