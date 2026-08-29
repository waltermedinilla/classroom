// Reglas del Servicio de Orientación Escolar: quién puede leer un legajo, cuánto de él, y
// qué alumnos entran en su alcance.
//
// TODO lo de este archivo es PURO: no requiere mongoose ni toca la base. Es a propósito —
// lo consumen tres lugares que no se pueden contradecir nunca:
//   - middleware/soe.js   → decide si la request pasa
//   - routes/soe.js       → decide qué objeto se le arma a la vista
//   - views/soe/*.ejs     → decide qué se dibuja
// y además los tests unitarios, que pueden probar la escuela en estados que por HTTP
// costaría fabricar (sin el campo, con un valor escrito a mano con mongosh, etc.).
//
// La spec completa está en specs/soe-orientacion.spec.md.

// ── Los tres niveles ─────────────────────────────────────────────────────────
const NINGUNO  = 'none';
const RESUMEN  = 'resumen';
const COMPLETO = 'completo';

const NIVELES = [NINGUNO, RESUMEN, COMPLETO];

// Orden para poder comparar: min(configurado, techo del rol).
const ORDEN = { [NINGUNO]: 0, [RESUMEN]: 1, [COMPLETO]: 2 };

// TECHO por rol: hasta dónde puede llegar, aunque la base diga otra cosa.
//
// ⚠️ ESTA TABLA ES LA QUE VALE. El enum de models/School.js filtra del lado del guardado,
// pero un documento viejo, una importación o un mongosh no pasan por la validación de
// Mongoose, y la guarda no puede depender de que arriba haya andado todo bien.
//
// **Recorte del 2026-08-27** (decisión D5 de specs/soe-derivacion-y-linea-de-tiempo.spec.md):
// hasta esa fecha la tabla tenía además `admin: COMPLETO` y `preceptor`/`teacher: RESUMEN`.
// Pedido explícito del usuario: el legajo lo ven SOLO el gabinete y el equipo directivo.
//
// Sacarlos de acá es lo que cierra la puerta de verdad: un rol sin entrada en esta tabla
// recibe NINGUNO más abajo, aunque la escuela conserve el valor viejo escrito en Mongo (que
// es exactamente lo que pasa al desplegar: el dato no se migra, deja de leerse).
const TECHO_POR_ROL = {
  directivo: COMPLETO,
};

// Los roles que aparecen en la pantalla de configuración de /superadmin/roles, en ese orden.
// La vista itera esta lista: un rol que sale de acá deja de tener fila, sin tocar el .ejs.
const ROLES_CONFIGURABLES = ['directivo'];

// Qué niveles se le ofrecen a cada rol en esa pantalla (nunca por encima de su techo).
//
// Un rol SIN techo no devuelve ['none'] sino [] — lista vacía. La diferencia importa: con
// ['none' ] una pantalla que dibujara el <select> sin chequear antes ROLES_CONFIGURABLES le
// mostraría al admin una fila con una sola opción, como si fuera configurable y alguien se
// la hubiera puesto en "Sin acceso". Vacío dice la verdad: ese rol no se configura acá.
const nivelesPara = (role) => (TECHO_POR_ROL[role]
  ? NIVELES.filter(n => ORDEN[n] <= ORDEN[TECHO_POR_ROL[role]])
  : []);

const NIVEL_LABELS = {
  [NINGUNO]:  'Sin acceso',
  [RESUMEN]:  'Solo resumen',
  [COMPLETO]: 'Legajo completo',
};

// ── ¿Cuánto ve este rol en esta escuela? ─────────────────────────────────────
//
// Fail-closed en todos los caminos desconocidos: sin rol, sin escuela, con un valor que no
// está en NIVELES o con un rol que no es configurable, devuelve NINGUNO. Lo contrario de
// config/sections.js (que es fail-open a propósito) y por un motivo simple: allá lo que se
// escapa es una solapa, acá es la historia psicopedagógica de un menor.
function nivelAcceso(school, role) {
  if (!role) return NINGUNO;

  // El SOE es el dueño del legajo: ve todo y no es configurable. Necesita escuela igual —
  // sin escuela no hay alumnos que atender.
  if (role === 'soe') return school ? COMPLETO : NINGUNO;

  // El superadmin entra siempre, con o sin escuela propia: tiene la base entera con
  // mongosh, negarle la pantalla sería teatro. Lo que sí cambia es que su lectura queda
  // auditada como soe.view_case (ver routes/soe.js).
  if (role === 'superadmin') return COMPLETO;

  if (!school) return NINGUNO;

  const techo = TECHO_POR_ROL[role];
  if (!techo) return NINGUNO;               // rol que no es configurable (student, jefe…)

  const configurado = school.soeAccess && school.soeAccess[role];
  if (!NIVELES.includes(configurado)) return NINGUNO;  // ausente, basura o null

  return ORDEN[configurado] <= ORDEN[techo] ? configurado : techo;
}

// Escribir en el legajo lo hace SIEMPRE y SOLO el SOE. Ni el superadmin: un legajo firmado
// por el dueño técnico de la plataforma no significa nada y ensucia la responsabilidad
// profesional de lo que quedó escrito.
const puedeEscribir = (role) => role === 'soe';

const puedeVer = (school, role) => nivelAcceso(school, role) !== NINGUNO;

// ── Qué campos expone cada nivel ─────────────────────────────────────────────
//
// 'resumen' es lo que un docente necesita para dar clase mejor —con qué cuenta el chico y
// qué se acordó hacer en el aula— SIN el motivo de intervención, sin las dificultades, sin
// las entrevistas y sin saber a dónde se lo derivó. Es la línea entre acompañar y chusmear.
const CAMPOS_RESUMEN = ['estado', 'prioridad', 'fortalezas', 'estrategias', 'tieneDerivacionActiva'];

const CAMPOS_COMPLETO = [
  ...CAMPOS_RESUMEN,
  'motivo', 'dificultades', 'entries', 'referrals', 'proximoRepaso',
  'openedBy', 'openedAt', 'closedBy', 'closedAt', 'cierreMotivo', 'lastEntryAt',
];

function camposVisibles(nivel) {
  if (nivel === COMPLETO) return [...CAMPOS_COMPLETO];
  if (nivel === RESUMEN)  return [...CAMPOS_RESUMEN];
  return [];
}

// Estados de derivación que ya NO cuentan como "en curso".
const DERIVACION_TERMINADA = ['alta', 'cerrado'];

const tieneDerivacionActiva = (referrals) =>
  Array.isArray(referrals) && referrals.some(r => r && !DERIVACION_TERMINADA.includes(r.estado));

// Devuelve una COPIA del legajo con lo que corresponde al nivel. Copia y no borrado in
// place: el documento que llega puede ser un doc de Mongoose vivo, y mutilarlo lo dejaría
// así para el resto del request (y para el próximo save()).
//
// Los campos de identidad (_id, student, division) van siempre que haya algún acceso: sin
// ellos no se puede ni linkear la ficha. Nunca son confidenciales por sí mismos — que un
// alumno tenga legajo es justamente lo que el nivel 'resumen' está autorizado a saber.
function sanitizarLegajo(legajo, nivel) {
  if (!legajo || nivel === NINGUNO || !NIVELES.includes(nivel)) return null;

  const plano = typeof legajo.toObject === 'function' ? legajo.toObject() : legajo;

  const base = {
    _id:      plano._id,
    student:  plano.student,
    division: plano.division,
    estado:    plano.estado    || 'abierto',
    prioridad: plano.prioridad || 'media',
    fortalezas:  plano.fortalezas  || '',
    estrategias: plano.estrategias || '',
    tieneDerivacionActiva: tieneDerivacionActiva(plano.referrals),
  };

  if (nivel === RESUMEN) return base;

  return {
    ...base,
    motivo:       plano.motivo       || '',
    dificultades: plano.dificultades || '',
    entries:      plano.entries      || [],
    referrals:    plano.referrals    || [],
    openedBy:     plano.openedBy,
    openedAt:     plano.openedAt,
    closedBy:     plano.closedBy,
    closedAt:     plano.closedAt,
    cierreMotivo: plano.cierreMotivo || '',
    lastEntryAt:  plano.lastEntryAt,

    // La agenda del gabinete: va en el bloque de completo y no en `base`, por el criterio 34.
    // Que un docente sepa que al chico lo vuelven a ver el martes no le sirve para dar clase.
    proximoRepaso: plano.proximoRepaso || null,
  };
}

// ── Alcance: qué alumnos ─────────────────────────────────────────────────────
//
// ⚠️ ACÁ SE INVIERTE LA REGLA DE LA CASA, A PROPÓSITO.
//
// middleware/preceptor.js y middleware/jefatura.js son fail-CLOSED: alcance vacío = no ve
// nada. Tienen que serlo porque esos roles se asignan por caminos que no preguntan por
// divisiones (cambio de rol en lote desde /admin y /superadmin), y "vacío = todas" les
// entregaría la escuela entera por omisión.
//
// El SOE es fail-OPEN: sin divisiones asignadas ve TODA su escuela. Porque el gabinete es
// uno solo por escuela y mira a todos — acotarlo es la excepción (escuelas con un gabinete
// por turno), no la regla. Lo que gana un SOE sin configurar es el LISTADO de alumnos de su
// propia escuela; los legajos ajenos no, porque los legajos los escribe él mismo.
//
// `divisionesDeLaEscuela` ya viene filtrado por escuela desde el middleware: es la lista
// contra la que se validan las asignadas.
function resolverAlcance(user, divisionesDeLaEscuela) {
  const vacio = { todas: false, divisionIds: [] };
  if (!user || !user.school) return vacio;

  const todas = (divisionesDeLaEscuela || []).map(String);

  // El que no es SOE no se acota por divisiones: se acota por soeAccess, que ya resolvió
  // requireSoe antes de llegar hasta acá. Un directivo puede tener assignedDivisions
  // cargadas de cuando fue preceptor; acá no aplican.
  if (user.role !== 'soe') return { todas: true, divisionIds: todas };

  if (user.allDivisions === true) return { todas: true, divisionIds: todas };

  // El fail-open mira las asignadas ORIGINALES, no las filtradas. Si mirara las filtradas,
  // un usuario al que le movieron la escuela (y le quedaron divisiones zombi de la
  // anterior) daría "filtrado vacío" → "ve todo", que es exactamente al revés de lo que
  // se quiere: ese caso tiene que ver NADA hasta que un admin lo reconfigure.
  const asignadas = user.assignedDivisions || [];
  if (!asignadas.length) return { todas: true, divisionIds: todas };

  const permitidas = new Set(todas);
  return {
    todas: false,
    divisionIds: asignadas.map(String).filter(id => permitidas.has(id)),
  };
}

// ¿Este alumno está dentro del alcance del request? Es la barrera de TODA ruta con un
// :studentId — sin esto, cambiar el id en la barra de direcciones alcanzaría para leer el
// legajo de un chico de otro curso (o de otra escuela).
//
// `alumno.divisiones` son las divisiones ACTUALES del alumno, resueltas por el middleware
// contra Course.students. Nunca el snapshot SoeCase.division: si al alumno lo cambiaron de
// curso, el que lo tiene que ver es el SOE del curso nuevo.
function alumnoEnAlcance(alcance, alumno, userSchoolId) {
  if (!alcance || !alumno || !userSchoolId) return false;

  // La escuela se chequea SIEMPRE y primero: con alcance total no habría ninguna división
  // que comparar, y un id de otra escuela pasaría derecho.
  if (String(alumno.school || '') !== String(userSchoolId)) return false;

  if (alcance.todas) return true;

  const suyas = new Set((alumno.divisiones || []).map(String));
  return (alcance.divisionIds || []).some(id => suyas.has(String(id)));
}

// ── Catálogos ────────────────────────────────────────────────────────────────
// Fuente única de los enums del modelo y de las etiquetas de las vistas: si viven en dos
// lados, tarde o temprano el <select> ofrece un valor que el schema rechaza.

const ESTADOS = ['abierto', 'seguimiento', 'cerrado'];
const ESTADO_LABELS = {
  abierto:     'Abierto',
  seguimiento: 'En seguimiento',
  cerrado:     'Cerrado',
};

const PRIORIDADES = ['baja', 'media', 'alta'];
const PRIORIDAD_LABELS = { baja: 'Baja', media: 'Media', alta: 'Alta' };
const PRIORIDAD_COLORS = { baja: '#137333', media: '#ea8600', alta: '#ea4335' };

// ⚠️ DOS LISTAS, y la diferencia importa (decisión D3 de
// specs/soe-derivacion-y-linea-de-tiempo.spec.md):
//
//   TIPOS_ENTRADA          → el enum del schema: todo lo que el modelo acepta guardar.
//   TIPOS_ENTRADA_MANUALES → lo que ofrece el <select> del formulario, y contra lo que
//                            valida deLista() en POST /soe/legajo/:id/entrada.
//
// `derivacion` está en la primera y NO en la segunda. Lo escribe únicamente
// POST /soe/pedidos/:id/tomar, con el motivo que redactó el preceptor y firmado por él. Si
// estuviera en la lista manual, el gabinete podría fabricar a mano una derivación de
// preceptoría que nunca existió, y la línea de tiempo la mostraría igual de firme que la
// real. Es el mismo razonamiento por el que deLista() no confía en el <select> del cliente.
const TIPOS_ENTRADA = [
  'entrevista', 'observacion', 'familia', 'acuerdo_docente', 'seguimiento', 'nota',
  'derivacion',
];
const TIPOS_ENTRADA_MANUALES = TIPOS_ENTRADA.filter(t => t !== 'derivacion');

const TIPO_ENTRADA_LABELS = {
  entrevista:      'Entrevista',
  observacion:     'Observación en el aula',
  familia:         'Contacto con la familia',
  acuerdo_docente: 'Acuerdo con docentes',
  seguimiento:     'Seguimiento',
  nota:            'Nota',
  derivacion:      'Derivación de Preceptoría',
};
const TIPO_ENTRADA_ICONS = {
  entrevista:      'record_voice_over',
  observacion:     'visibility',
  familia:         'family_restroom',
  acuerdo_docente: 'handshake',
  seguimiento:     'update',
  nota:            'sticky_note_2',
  derivacion:      'move_to_inbox',
};

// "Cómo se lo vio" — el pulso a lo largo del tiempo, que es lo que una foto no muestra.
const ANIMOS = ['bien', 'altibajos', 'preocupante'];
const ANIMO_LABELS = {
  bien:        'Bien',
  altibajos:   'Con altibajos',
  preocupante: 'Preocupante',
};
const ANIMO_COLORS = { bien: '#137333', altibajos: '#ea8600', preocupante: '#ea4335' };

const TIPOS_DERIVACION = [
  'salud_mental', 'fonoaudiologia', 'psicopedagogia', 'neurologia',
  'servicio_social', 'equipo_orientacion', 'otro',
];
const TIPO_DERIVACION_LABELS = {
  salud_mental:       'Salud mental',
  fonoaudiologia:     'Fonoaudiología',
  psicopedagogia:     'Psicopedagogía',
  neurologia:         'Neurología',
  servicio_social:    'Servicio social',
  equipo_orientacion: 'Equipo de orientación',
  otro:               'Otro',
};

const ESTADOS_DERIVACION = [
  'derivado', 'con_turno', 'en_tratamiento', 'sin_respuesta', 'no_asistio', 'alta', 'cerrado',
];
const ESTADO_DERIVACION_LABELS = {
  derivado:       'Derivado',
  con_turno:      'Con turno',
  en_tratamiento: 'En tratamiento',
  sin_respuesta:  'Sin respuesta',
  no_asistio:     'No asistió',
  alta:           'Alta',
  cerrado:        'Cerrado',
};
// Los dos estados que piden acción del gabinete: son los que se resaltan en la lista.
const ESTADOS_DERIVACION_ALERTA = ['sin_respuesta', 'no_asistio'];

// ¿Esta derivación necesita que alguien la mire hoy? Sin respuesta, el chico no fue, o se
// pasó la fecha en que había que volver a preguntar. Es la regla que evita que un alumno
// derivado se pierda entre la derivación y la devolución que nunca llegó.
function derivacionNecesitaAtencion(ref, ahora = new Date()) {
  if (!ref || DERIVACION_TERMINADA.includes(ref.estado)) return false;
  if (ESTADOS_DERIVACION_ALERTA.includes(ref.estado)) return true;
  return !!ref.proximoSeguimiento && new Date(ref.proximoSeguimiento) <= ahora;
}


// ¿Hay que volver a mirar este legajo hoy? La hermana de la de arriba, para el chico al que
// se acompaña SIN derivarlo a ningún lado: hasta que existió `proximoRepaso`, ese legajo no
// tenía ninguna fecha que hiciera sonar una alarma y se enfriaba en silencio.
//
// Un legajo CERRADO nunca pide repaso, aunque le haya quedado la fecha vencida: cerrar no
// borra el dato (reabrirlo lo devuelve tal cual), pero mientras está cerrado no molesta.
//
// La comparación es `<=` igual que en las derivaciones: un <input type="date"> llega como
// medianoche, así que el repaso pedido para hoy tiene que contar hoy y no mañana.
function legajoNecesitaRepaso(legajo, ahora = new Date()) {
  if (!legajo || legajo.estado === 'cerrado') return false;
  return !!legajo.proximoRepaso && new Date(legajo.proximoRepaso) <= ahora;
}

// ── El pedido de derivación de Preceptoría ───────────────────────────────────
// Catálogos de models/SoeRequest.js. Viven acá por el mismo motivo que los de arriba: si el
// <select> del preceptor y el enum del schema se escriben en dos archivos, tarde o temprano
// la pantalla ofrece un valor que la base rechaza.

const URGENCIAS = ['baja', 'media', 'alta'];
const URGENCIA_LABELS = { baja: 'Puede esperar', media: 'Normal', alta: 'Urgente' };
const URGENCIA_COLORS = { baja: '#137333', media: '#ea8600', alta: '#ea4335' };
// Peso para ordenar la bandeja: lo urgente primero.
const URGENCIA_PESO = { alta: 0, media: 1, baja: 2 };

const ESTADOS_PEDIDO = ['pendiente', 'tomada', 'descartada'];
const ESTADO_PEDIDO_LABELS = {
  pendiente:  'Esperando al gabinete',
  tomada:     'Tomada por el gabinete',
  descartada: 'No se abrió seguimiento',
};

// El orden de la bandeja: primero lo urgente y, dentro de cada urgencia, LO MÁS VIEJO
// arriba. Al revés que el resto del proyecto, y a propósito: en una bandeja lo que hay que
// evitar es que un pedido se quede abajo para siempre.
function ordenarPedidos(pedidos) {
  return (pedidos || []).slice().sort((a, b) =>
    (URGENCIA_PESO[a.urgencia] ?? 1) - (URGENCIA_PESO[b.urgencia] ?? 1)
    || new Date(a.createdAt) - new Date(b.createdAt));
}

module.exports = {
  // niveles
  NINGUNO, RESUMEN, COMPLETO, NIVELES, NIVEL_LABELS,
  ROLES_CONFIGURABLES, TECHO_POR_ROL, nivelesPara,
  // reglas de acceso
  nivelAcceso, puedeEscribir, puedeVer,
  camposVisibles, sanitizarLegajo, tieneDerivacionActiva,
  // alcance
  resolverAlcance, alumnoEnAlcance,
  // catálogos
  ESTADOS, ESTADO_LABELS,
  PRIORIDADES, PRIORIDAD_LABELS, PRIORIDAD_COLORS,
  TIPOS_ENTRADA, TIPOS_ENTRADA_MANUALES, TIPO_ENTRADA_LABELS, TIPO_ENTRADA_ICONS,
  ANIMOS, ANIMO_LABELS, ANIMO_COLORS,
  // pedidos de derivación (Preceptoría → SOE)
  URGENCIAS, URGENCIA_LABELS, URGENCIA_COLORS, URGENCIA_PESO,
  ESTADOS_PEDIDO, ESTADO_PEDIDO_LABELS, ordenarPedidos,
  TIPOS_DERIVACION, TIPO_DERIVACION_LABELS,
  ESTADOS_DERIVACION, ESTADO_DERIVACION_LABELS, ESTADOS_DERIVACION_ALERTA,
  DERIVACION_TERMINADA, derivacionNecesitaAtencion, legajoNecesitaRepaso,
};
