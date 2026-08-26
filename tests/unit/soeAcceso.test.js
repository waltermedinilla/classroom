// Tests de las reglas de confidencialidad del SOE (services/soeAcceso.js).
// Correr con: npm run test:unit
//
// Por qué acá y no en un smoke HTTP: esta es la regla que decide quién puede leer la
// historia psicopedagógica de un menor. Tiene que poder probarse con la escuela en TODOS
// sus estados (sin el campo, con el campo a medias, con un valor escrito a mano en la base
// que la pantalla nunca habría permitido guardar), y eso por HTTP significaría fabricar una
// escuela distinta por caso. El smoke igual cubre las rutas — ver tests/smoke/specs.js.
//
// Cubren los criterios 1 a 7 de specs/soe-orientacion.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  NINGUNO, RESUMEN, COMPLETO,
  nivelAcceso,
  puedeEscribir,
  puedeVer,
  camposVisibles,
  sanitizarLegajo,
  tieneDerivacionActiva,
  legajoNecesitaRepaso,
} = require('../../services/soeAcceso');

// Una escuela como las que hay hoy en producción: sin el campo soeAccess, porque nació
// después que ellas. Es EL caso que no se puede romper.
const ESCUELA_VIEJA = { _id: 'esc1', name: 'Escuela 4118' };

const conAcceso = (soeAccess) => ({ ...ESCUELA_VIEJA, soeAccess });

describe('nivelAcceso', () => {
  test('escuela sin soeAccess → nadie ve nada (criterio 1)', () => {
    // El default cerrado es lo que hace que agregar esta feature no le abra el legajo a
    // nadie en las escuelas que ya existen. Si alguna vez esto devuelve otra cosa, la
    // migración silenciosa expone historias clínicas.
    assert.strictEqual(nivelAcceso(ESCUELA_VIEJA, 'directivo'), NINGUNO);
    assert.strictEqual(nivelAcceso(ESCUELA_VIEJA, 'admin'),     NINGUNO);
    assert.strictEqual(nivelAcceso(ESCUELA_VIEJA, 'preceptor'), NINGUNO);
    assert.strictEqual(nivelAcceso(ESCUELA_VIEJA, 'teacher'),   NINGUNO);
    // Y los que ni figuran en la configuración tampoco.
    assert.strictEqual(nivelAcceso(ESCUELA_VIEJA, 'student'),   NINGUNO);
    assert.strictEqual(nivelAcceso(ESCUELA_VIEJA, 'jefe'),      NINGUNO);
  });

  test('soeAccess presente pero con el rol ausente → none', () => {
    const escuela = conAcceso({ directivo: COMPLETO });
    assert.strictEqual(nivelAcceso(escuela, 'directivo'), COMPLETO);
    assert.strictEqual(nivelAcceso(escuela, 'admin'),     NINGUNO);
    assert.strictEqual(nivelAcceso(escuela, 'preceptor'), NINGUNO);
  });

  test('el SOE ve completo siempre, aunque la escuela no tenga el campo (criterio 2)', () => {
    assert.strictEqual(nivelAcceso(ESCUELA_VIEJA, 'soe'), COMPLETO);
    assert.strictEqual(nivelAcceso(conAcceso({}), 'soe'), COMPLETO);
    // Ni siquiera se le puede sacar desde la configuración: no es un rol configurable.
    assert.strictEqual(nivelAcceso(conAcceso({ soe: NINGUNO }), 'soe'), COMPLETO);
  });

  test('usuario sin escuela → none (criterio 3)', () => {
    assert.strictEqual(nivelAcceso(null,      'soe'),       NINGUNO);
    assert.strictEqual(nivelAcceso(undefined, 'soe'),       NINGUNO);
    assert.strictEqual(nivelAcceso(null,      'directivo'), NINGUNO);
  });

  test('sin rol → none', () => {
    assert.strictEqual(nivelAcceso(conAcceso({ directivo: COMPLETO }), null), NINGUNO);
    assert.strictEqual(nivelAcceso(conAcceso({ directivo: COMPLETO }), ''),   NINGUNO);
  });

  test('el techo del rol gana sobre lo guardado en la base (criterio 4)', () => {
    // 'completo' para preceptor o docente NO se puede guardar desde la pantalla (el enum
    // del schema no lo admite), pero sí se puede escribir a mano con mongosh o quedar de
    // una importación vieja. La regla no confía en que la validación de arriba haya andado.
    assert.strictEqual(nivelAcceso(conAcceso({ preceptor: COMPLETO }), 'preceptor'), RESUMEN);
    assert.strictEqual(nivelAcceso(conAcceso({ teacher:   COMPLETO }), 'teacher'),   RESUMEN);
    // Y el directivo sí puede llegar a completo: su techo es ese.
    assert.strictEqual(nivelAcceso(conAcceso({ directivo: COMPLETO }), 'directivo'), COMPLETO);
  });

  test('un valor basura en la base se lee como none, no como acceso', () => {
    // Fail-closed ante lo desconocido: si mañana alguien inventa un nivel, no se concede.
    assert.strictEqual(nivelAcceso(conAcceso({ directivo: 'total' }),  'directivo'), NINGUNO);
    assert.strictEqual(nivelAcceso(conAcceso({ directivo: true }),     'directivo'), NINGUNO);
    assert.strictEqual(nivelAcceso(conAcceso({ directivo: '' }),       'directivo'), NINGUNO);
  });

  test('el superadmin ve completo aunque no tenga escuela propia', () => {
    // Tiene la base entera con mongosh: negarle la pantalla sería teatro. Lo que sí cambia
    // es que su lectura queda auditada (criterio 22, se verifica en el smoke).
    assert.strictEqual(nivelAcceso(null, 'superadmin'), COMPLETO);
  });
});

describe('puedeEscribir', () => {
  test('solo el SOE escribe — el superadmin tampoco (criterio 5)', () => {
    assert.strictEqual(puedeEscribir('soe'), true);
    for (const rol of ['superadmin', 'admin', 'directivo', 'preceptor', 'jefe', 'teacher', 'student', null]) {
      assert.strictEqual(puedeEscribir(rol), false, `${rol} no debería poder escribir`);
    }
  });
});

describe('puedeVer', () => {
  test('es el complemento de nivelAcceso', () => {
    assert.strictEqual(puedeVer(ESCUELA_VIEJA, 'soe'), true);
    assert.strictEqual(puedeVer(ESCUELA_VIEJA, 'directivo'), false);
    assert.strictEqual(puedeVer(conAcceso({ directivo: RESUMEN }), 'directivo'), true);
  });
});

// ── El legajo de prueba ──────────────────────────────────────────────────────
// Textos únicos e inconfundibles: el criterio 7 los busca en el JSON serializado, así que
// tienen que ser strings que no puedan aparecer por casualidad en ninguna otra clave.
const SECRETO_MOTIVO       = 'MOTIVO-CONFIDENCIAL-XYZ';
const SECRETO_DIFICULTADES = 'DIFICULTADES-CONFIDENCIALES-XYZ';
const SECRETO_ENTRADA      = 'TEXTO-DE-LA-ENTREVISTA-XYZ';
const SECRETO_DESTINO      = 'HOSPITAL-DESTINO-XYZ';
const SECRETO_DEVOLUCION   = 'LO-QUE-DIJO-EL-HOSPITAL-XYZ';

const LEGAJO = {
  _id: 'caso1',
  student: 'alu1',
  school: 'esc1',
  division: 'div1',
  estado: 'seguimiento',
  prioridad: 'alta',
  motivo: SECRETO_MOTIVO,
  fortalezas: 'Muy buena con las manos, la respetan los compañeros',
  dificultades: SECRETO_DIFICULTADES,
  estrategias: 'Consignas cortas, que las lea en voz alta antes de arrancar',
  proximoRepaso: new Date('2026-09-10'),
  entries: [
    { _id: 'e1', fecha: new Date('2026-08-10'), tipo: 'entrevista', animo: 'preocupante', texto: SECRETO_ENTRADA, autor: 'soe1' },
  ],
  referrals: [
    {
      _id: 'r1', destino: SECRETO_DESTINO, tipo: 'salud_mental', motivo: 'Evaluación',
      fecha: new Date('2026-08-12'), estado: 'en_tratamiento', contacto: 'Lic. Pérez',
      devoluciones: [{ fecha: new Date('2026-08-15'), texto: SECRETO_DEVOLUCION, registradoPor: 'soe1' }],
    },
  ],
  openedBy: 'soe1',
  openedAt: new Date('2026-08-01'),
  lastEntryAt: new Date('2026-08-10'),
};

describe('camposVisibles', () => {
  test('resumen expone lo del aula y nada de lo clínico (criterio 6)', () => {
    const campos = camposVisibles(RESUMEN);
    for (const c of ['estado', 'prioridad', 'fortalezas', 'estrategias', 'tieneDerivacionActiva']) {
      assert.ok(campos.includes(c), `resumen debería incluir ${c}`);
    }
    for (const c of ['motivo', 'dificultades', 'entries', 'referrals']) {
      assert.ok(!campos.includes(c), `resumen NO debería incluir ${c}`);
    }
  });

  test('completo incluye todo lo del resumen y además lo clínico', () => {
    const campos = camposVisibles(COMPLETO);
    for (const c of camposVisibles(RESUMEN)) {
      assert.ok(campos.includes(c), `completo debería incluir ${c}`);
    }
    for (const c of ['motivo', 'dificultades', 'entries', 'referrals']) {
      assert.ok(campos.includes(c), `completo debería incluir ${c}`);
    }
  });

  test('none no expone ningún campo', () => {
    assert.deepStrictEqual(camposVisibles(NINGUNO), []);
  });
});

describe('sanitizarLegajo', () => {
  test('none devuelve null: no hay legajo que mostrar', () => {
    assert.strictEqual(sanitizarLegajo(LEGAJO, NINGUNO), null);
  });

  test('resumen no filtra ni un texto clínico, en ninguna profundidad (criterio 7)', () => {
    const visto = sanitizarLegajo(LEGAJO, RESUMEN);
    const json  = JSON.stringify(visto);

    // La prueba de fuego: buscar los secretos en el objeto SERIALIZADO. Una clave anidada
    // que se coló, un spread de más o un `referrals` que viajó "solo para contar cuántos
    // hay" aparecen acá aunque la vista no los dibuje. El leak que importa es el del HTML
    // que llega al navegador, no el de la pantalla.
    for (const secreto of [SECRETO_MOTIVO, SECRETO_DIFICULTADES, SECRETO_ENTRADA, SECRETO_DESTINO, SECRETO_DEVOLUCION]) {
      assert.ok(!json.includes(secreto), `el resumen filtró: ${secreto}`);
    }

    // Y lo que sí tiene que estar, está.
    assert.strictEqual(visto.estado, 'seguimiento');
    assert.strictEqual(visto.prioridad, 'alta');
    assert.ok(visto.fortalezas.includes('las manos'));
    assert.ok(visto.estrategias.includes('Consignas cortas'));
    assert.strictEqual(visto.tieneDerivacionActiva, true);
    // Sabe QUE hay una derivación en curso, pero no a dónde.
    assert.strictEqual(visto.referrals, undefined);
    assert.strictEqual(visto.entries, undefined);
  });

  test('completo devuelve la historia entera', () => {
    const visto = sanitizarLegajo(LEGAJO, COMPLETO);
    const json  = JSON.stringify(visto);
    for (const secreto of [SECRETO_MOTIVO, SECRETO_DIFICULTADES, SECRETO_ENTRADA, SECRETO_DESTINO, SECRETO_DEVOLUCION]) {
      assert.ok(json.includes(secreto), `completo debería incluir: ${secreto}`);
    }
    assert.strictEqual(visto.entries.length, 1);
    assert.strictEqual(visto.referrals[0].devoluciones.length, 1);
  });

  test('un legajo sin entradas ni derivaciones no rompe el sanitizado', () => {
    const vacio = { _id: 'c2', student: 'a2', estado: 'abierto', prioridad: 'baja' };
    const visto = sanitizarLegajo(vacio, RESUMEN);
    assert.strictEqual(visto.tieneDerivacionActiva, false);
    assert.strictEqual(visto.fortalezas, '');
    assert.strictEqual(sanitizarLegajo(null, COMPLETO), null);
  });

  test('sanitizar no muta el documento original', () => {
    // Si sanitizarLegajo borrara claves del doc de Mongoose en vez de copiar, el legajo
    // quedaría mutilado para el resto del request — y el próximo save() lo escribiría así.
    const copia = JSON.parse(JSON.stringify(LEGAJO));
    sanitizarLegajo(LEGAJO, RESUMEN);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(LEGAJO)), copia);
  });
});

describe('tieneDerivacionActiva', () => {
  test('una derivación con alta o cerrada ya no cuenta como activa', () => {
    assert.strictEqual(tieneDerivacionActiva([{ estado: 'alta' }]), false);
    assert.strictEqual(tieneDerivacionActiva([{ estado: 'cerrado' }]), false);
    assert.strictEqual(tieneDerivacionActiva([{ estado: 'alta' }, { estado: 'derivado' }]), true);
    assert.strictEqual(tieneDerivacionActiva([{ estado: 'sin_respuesta' }]), true);
    assert.strictEqual(tieneDerivacionActiva([]), false);
    assert.strictEqual(tieneDerivacionActiva(undefined), false);
  });
});

// ── La fecha de repaso del legajo (criterios 32 a 38) ────────────────────────
//
// La hermana de derivacionNecesitaAtencion, para el chico al que se acompaña SIN derivarlo
// a ningún lado: hasta que existió este campo, ese legajo no tenía ninguna fecha que hiciera
// sonar una alarma y se enfriaba en silencio.

describe('legajoNecesitaRepaso', () => {
  const AYER = new Date('2026-08-25T10:00:00Z');
  const HOY  = new Date('2026-08-26T10:00:00Z');
  const MANANA = new Date('2026-08-27T10:00:00Z');

  test('sin fecha de repaso no pide nada', () => {
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'abierto' }, HOY), false);
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'abierto', proximoRepaso: null }, HOY), false);
  });

  test('la fecha vencida lo pone en la lista', () => {
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'abierto', proximoRepaso: AYER }, HOY), true);
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'seguimiento', proximoRepaso: AYER }, HOY), true);
  });

  test('la fecha futura todavía no molesta', () => {
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'abierto', proximoRepaso: MANANA }, HOY), false);
  });

  test('la fecha de HOY ya cuenta como vencida', () => {
    // Un <input type="date"> llega como medianoche: si "hoy" no contara, el repaso pedido
    // para hoy recién aparecería mañana. Misma regla que derivacionNecesitaAtencion.
    const medianoche = new Date('2026-08-26T00:00:00Z');
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'abierto', proximoRepaso: medianoche }, HOY), true);
  });

  test('un legajo cerrado no vuelve solo, aunque tenga la fecha vencida (criterio 38)', () => {
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'cerrado', proximoRepaso: AYER }, HOY), false);
  });

  test('tolera basura sin romper', () => {
    assert.strictEqual(legajoNecesitaRepaso(null, HOY), false);
    assert.strictEqual(legajoNecesitaRepaso(undefined, HOY), false);
    assert.strictEqual(legajoNecesitaRepaso({ estado: 'abierto', proximoRepaso: '' }, HOY), false);
  });
});

describe('el repaso es dato de nivel completo (criterio 34)', () => {
  test('resumen no recibe la fecha de repaso', () => {
    const visto = sanitizarLegajo(LEGAJO, RESUMEN);
    assert.strictEqual(visto.proximoRepaso, undefined,
      'la agenda del gabinete no es lo que un docente necesita para dar clase');
    assert.ok(!JSON.stringify(visto).includes('2026-09-10'),
      'la fecha se coló igual en el objeto serializado');
    assert.ok(!camposVisibles(RESUMEN).includes('proximoRepaso'));
  });

  test('completo sí la recibe', () => {
    const visto = sanitizarLegajo(LEGAJO, COMPLETO);
    assert.ok(visto.proximoRepaso, 'el gabinete tiene que ver su propia fecha');
    assert.strictEqual(new Date(visto.proximoRepaso).toISOString().slice(0, 10), '2026-09-10');
    assert.ok(camposVisibles(COMPLETO).includes('proximoRepaso'));
  });

  test('un legajo sin la fecha no rompe el sanitizado', () => {
    // El caso de TODOS los legajos que ya existían antes del campo.
    const viejo = { _id: 'c3', student: 'a3', estado: 'abierto', prioridad: 'media' };
    assert.strictEqual(sanitizarLegajo(viejo, COMPLETO).proximoRepaso, null);
  });
});
