// Panel de Recursos — /admin/recursos
//
// El lado del ADMINISTRATIVO: carga el horario escolar, da de alta los recursos y resuelve
// los pedidos de los docentes. El lado del docente —el calendario y el pedido— vive en
// routes/reservas.js, aparte a propósito: son dos oficios distintos y mezclarlos repetiría
// la deuda de routes/rooms.js que el usuario pidió explícitamente no volver a generar.
//
// ── LAS TRES GUARDAS, EN ESTE ORDEN Y POR ESTE MOTIVO ──────────────────────────────────
//   requireAdmin            quién es (rol). La puerta de calle.
//   requireModulo('recursos') si la ESCUELA tiene el módulo. Fail-CLOSED: una escuela que no
//                           lo prendió no llega ni al 404, y la URL escrita a mano tampoco.
//   requireSection(...)     si el superadmin le apagó la solapa a este rol. Fail-open, solo
//                           puede quitar lo que las dos de arriba ya concedieron.
//
// El orden no es estético: requireModulo va antes que requireSection para no pagar la lectura
// de permisos en un request que la escuela no tiene habilitado de entrada.

const express = require('express');

const Recurso             = require('../models/Recurso');
const Reserva             = require('../models/Reserva');
const Horario             = require('../models/Horario');
const RecursoAutorizacion = require('../models/RecursoAutorizacion');
const User                = require('../models/User');

const { requireAuth }    = require('../middleware/auth');
const { requireAdmin }   = require('../middleware/admin');
const { requireModulo }  = require('../middleware/modulos');
const { requireSection } = require('../middleware/sections');
const { logAudit }       = require('../middleware/audit');
const { idMalo }         = require('../middleware/objectId');
const { logDeRuta }      = require('../middleware/route-log');

const horarioSvc = require('../services/recursos/horario');
const reservaSvc = require('../services/recursos/reservas');
const disp       = require('../services/recursos/disponibilidad');
const live       = require('../services/liveRoom');

const router = express.Router();
router.use(requireAuth, requireAdmin, requireModulo('recursos'), requireSection('admin_recursos'));

// El admin siempre tiene escuela (requireModulo ya rechazó al superadmin sin escuela, que es
// el único caso de school null que llega hasta acá).
const escuelaDe = (res) => res.locals.user.school;

const TIPOS = ['aula', 'laboratorio', 'equipamiento', 'otro'];

// Lo que llega del formulario, convertido en un recurso válido. Devuelve { datos, error }.
//
// `divisible` decide con qué mecanismo se protege el cupo (índice único vs contador atómico),
// así que su coherencia con `capacidad` se valida acá y no en la vista: un recurso divisible
// de capacidad 1 no es divisible, es exclusivo con un nombre confuso.
function normalizarRecurso(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Poné un nombre para el recurso.' };

  const tipo = TIPOS.includes(body.tipo) ? body.tipo : 'aula';
  const divisible = body.divisible === 'on' || body.divisible === true || body.divisible === 'true';

  const capacidad = Math.trunc(Number(body.capacidad));
  if (!Number.isInteger(capacidad) || capacidad < 1) {
    return { error: 'La capacidad tiene que ser un número de 1 en adelante.' };
  }
  if (divisible && capacidad < 2) {
    return { error: 'Un recurso que se reparte necesita al menos 2 unidades.' };
  }

  let maxPorPedido = null;
  if (divisible && String(body.maxPorPedido || '').trim() !== '') {
    maxPorPedido = Math.trunc(Number(body.maxPorPedido));
    if (!Number.isInteger(maxPorPedido) || maxPorPedido < 1 || maxPorPedido > capacidad) {
      return { error: `El máximo por pedido tiene que estar entre 1 y ${capacidad}.` };
    }
  }

  return {
    datos: {
      name, tipo, capacidad, divisible, maxPorPedido,
      ubicacion: String(body.ubicacion || '').trim(),
      notas:     String(body.notas || '').trim(),
      requiereAutorizacion: body.requiereAutorizacion !== 'off' && body.requiereAutorizacion !== 'false',
      activo:    body.activo !== 'off' && body.activo !== 'false',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resumen
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const school = escuelaDe(res);
    const [recursos, horario, pendientes] = await Promise.all([
      Recurso.find({ school }).sort({ activo: -1, tipo: 1, name: 1 }).lean(),
      reservaSvc.horarioDe(school),
      Reserva.countDocuments({ school, status: 'pendiente' }),
    ]);

    res.render('admin/recursos/index', {
      activePage: 'recursos',
      recursos,
      horario,
      horarioCargado: horarioSvc.horarioCargado(horario),
      pendientes,
      error: req.query.error || null,
      ok:    req.query.ok || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('No se pudo cargar la pantalla de recursos');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// El horario escolar
// ─────────────────────────────────────────────────────────────────────────────

router.get('/horario', async (req, res) => {
  try {
    const horario = await reservaSvc.horarioDe(escuelaDe(res));
    res.render('admin/recursos/horario', {
      activePage: 'recursos',
      // Escuela sin horario: se ofrece el preset precargado como PUNTO DE PARTIDA editable.
      // Mostrar una grilla vacía y pedirle al administrativo que tipee nueve filas es la
      // forma más segura de que la pantalla no se use nunca.
      horario: horario || horarioSvc.PRESET_4118(),
      esPreset: !horario,
      NOMBRE_DIA: horarioSvc.NOMBRE_DIA,
      error: req.query.error || null,
      ok:    req.query.ok || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('No se pudo cargar el horario');
  }
});

router.post('/horario', async (req, res) => {
  try {
    const school = escuelaDe(res);
    // El editor manda el horario entero como JSON: es una grilla, no un formulario de campos
    // sueltos, y armarlo con inputs con nombre `turnos[0].franjas[3].desde` sería peor de
    // mantener que parsear un JSON validado.
    let propuesto;
    try {
      propuesto = JSON.parse(req.body.horario || '{}');
    } catch {
      return res.status(400).json({ error: 'No se pudo leer el horario enviado.' });
    }

    const { ok, errores } = horarioSvc.validarHorario(propuesto);
    if (!ok) return res.status(400).json({ error: errores[0], errores });

    const anterior = await Horario.findOne({ school }).lean();

    // ⚠️ Borrar un módulo que tiene reservas confirmadas las deja huérfanas: la reserva sigue
    // apuntando a "5ª hora" de un turno que ya no la tiene, y no se puede pintar en ninguna
    // grilla. No se bloquea el cambio —la escuela puede tener un motivo— pero NO puede pasar
    // en silencio.
    const huerfanas = await reservasQueQuedanHuerfanas(school, anterior, propuesto);
    if (huerfanas.length && req.body.confirmar !== 'si') {
      return res.status(409).json({
        error: `Este cambio deja ${huerfanas.length} reserva(s) confirmada(s) sin módulo.`,
        requiereConfirmacion: true,
        huerfanas: huerfanas.slice(0, 20),
      });
    }

    await Horario.findOneAndUpdate(
      { school },
      { $set: { turnos: propuesto.turnos, dias: propuesto.dias.map(Number) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    logAudit(req, 'resource.schedule_edit', [], {
      turnos: propuesto.turnos.length,
      modulos: propuesto.turnos.reduce((n, t) => n + horarioSvc.modulosDeClase(t).length, 0),
      huerfanas: huerfanas.length,
    });

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar el horario' });
  }
});

// Reservas confirmadas y futuras que apuntan a un {turno, módulo} que el horario nuevo ya no
// tiene. Solo mira de hoy en adelante: las de ayer ya ocurrieron y romperles la referencia no
// le cambia el día a nadie.
async function reservasQueQuedanHuerfanas(school, anterior, propuesto) {
  if (!anterior) return [];
  const hoy = live.diaEscolar();
  const futuras = await Reserva.find({
    school, status: 'confirmada', date: { $gte: hoy },
  }).populate('recurso', 'name').lean();

  return futuras
    .filter(r => !horarioSvc.moduloDe(propuesto, r.turno, r.modulo))
    .map(r => ({ date: r.date, turno: r.turno, modulo: r.modulo, recurso: r.recurso?.name || '' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Alta, edición y baja de recursos
// ─────────────────────────────────────────────────────────────────────────────

router.post('/crear', async (req, res) => {
  try {
    const { datos, error } = normalizarRecurso(req.body);
    if (error) return res.status(400).json({ error });

    const recurso = await Recurso.create({ ...datos, school: escuelaDe(res) });
    logAudit(req, 'resource.create', [{ type: 'recurso', id: recurso._id, name: recurso.name }], {
      tipo: recurso.tipo, capacidad: recurso.capacidad, divisible: recurso.divisible,
    });
    res.json({ ok: true, id: recurso._id });
  } catch (err) {
    if (err?.code === 11000) return res.status(400).json({ error: 'Ya existe un recurso con ese nombre.' });
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo crear el recurso' });
  }
});

router.post('/:id/editar', async (req, res) => {
  if (idMalo(req, res, 'Recurso no encontrado')) return;
  try {
    const recurso = await Recurso.findOne({ _id: req.params.id, school: escuelaDe(res) });
    if (!recurso) return res.status(404).json({ error: 'Recurso no encontrado' });

    const { datos, error } = normalizarRecurso(req.body);
    if (error) return res.status(400).json({ error });

    // ⚠️ Cambiar `divisible` NO reescribe las reservas ya hechas: cada una guarda su propio
    // `exclusiva` (ver models/Reserva.js) y se sigue rigiendo por la regla que había cuando
    // se creó. Es lo correcto, pero tiene que decirse — si no, se descubre el día que una
    // reserva vieja no respeta el cupo nuevo y parece un bug.
    const cambiaModo = recurso.divisible !== datos.divisible;
    if (cambiaModo && req.body.confirmar !== 'si') {
      const activas = await Reserva.countDocuments({
        recurso: recurso._id, status: 'confirmada', date: { $gte: live.diaEscolar() },
      });
      if (activas) {
        return res.status(409).json({
          requiereConfirmacion: true,
          error: `Hay ${activas} reserva(s) confirmada(s) con el modo anterior. `
               + 'Van a seguir funcionando como estaban; solo las nuevas usan el modo nuevo.',
        });
      }
    }

    Object.assign(recurso, datos);
    await recurso.save();
    logAudit(req, 'resource.edit', [{ type: 'recurso', id: recurso._id, name: recurso.name }], {
      capacidad: recurso.capacidad, divisible: recurso.divisible, cambiaModo,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err?.code === 11000) return res.status(400).json({ error: 'Ya existe un recurso con ese nombre.' });
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar el recurso' });
  }
});

// Baja LÓGICA (activo: false), nunca borrado. Un recurso con historial de reservas no se
// puede borrar sin dejar huérfano todo lo que pasó — y "quién usó la sala en marzo" es
// justamente la pregunta que este módulo existe para contestar.
router.post('/:id/borrar', async (req, res) => {
  if (idMalo(req, res, 'Recurso no encontrado')) return;
  try {
    const recurso = await Recurso.findOne({ _id: req.params.id, school: escuelaDe(res) });
    if (!recurso) return res.status(404).json({ error: 'Recurso no encontrado' });

    // Las reservas futuras se cancelan por el camino normal (liberar), que es lo que devuelve
    // el cupo. Marcar el recurso inactivo y dejarlas confirmadas dejaría contadores ocupados
    // para siempre — es la fuga que describe models/SlotOcupacion.js.
    const futuras = await Reserva.find({
      recurso: recurso._id, status: { $in: ['pendiente', 'confirmada'] }, date: { $gte: live.diaEscolar() },
    });
    for (const r of futuras) {
      await reservaSvc.liberar(r, {
        status: 'cancelada',
        motivoRechazo: 'El recurso se dio de baja.',
        porUsuario: res.locals.user._id,
      });
    }

    recurso.activo = false;
    await recurso.save();
    logAudit(req, 'resource.delete', [{ type: 'recurso', id: recurso._id, name: recurso.name }],
      { reservasCanceladas: futuras.length });
    res.json({ ok: true, canceladas: futuras.length });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo dar de baja el recurso' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// La bandeja de pedidos
// ─────────────────────────────────────────────────────────────────────────────

router.get('/pedidos', async (req, res) => {
  try {
    const school = escuelaDe(res);
    const hoy = live.diaEscolar();

    // Solo los pedidos de hoy en adelante. Un pendiente de la semana pasada ya no se puede
    // aprobar —la clase pasó— y llenaría la bandeja de decisiones imposibles.
    const pedidos = await Reserva.find({ school, status: 'pendiente', date: { $gte: hoy } })
      .populate('docente', 'name email')
      .populate('recurso', 'name tipo capacidad divisible maxPorPedido requiereAutorizacion')
      .populate('course', 'name')
      .populate('division', 'name')
      .sort({ date: 1, turno: 1, modulo: 1 })
      .lean();

    // ⚠️ El cupo se muestra AL MOMENTO DE MIRAR LA BANDEJA, no al momento del pedido. Un
    // pendiente no bloquea el casillero (ver models/Reserva.js), así que entre que el docente
    // pidió y el administrativo abre esto, el módulo pudo llenarse. Decidir sobre el número
    // viejo es decidir sobre algo que ya no existe.
    for (const p of pedidos) {
      const confirmadas = await Reserva.find({
        recurso: p.recurso._id, date: p.date, turno: p.turno, modulo: p.modulo, status: 'confirmada',
      }).select('unidades').lean();
      const tomadas = confirmadas.reduce((n, r) => n + (r.unidades || 1), 0);
      const capacidad = p.recurso.divisible ? (p.recurso.capacidad || 1) : 1;
      p.libresAhora = Math.max(0, capacidad - tomadas);
      p.capacidadAhora = capacidad;
    }

    const horario = await reservaSvc.horarioDe(school);
    res.render('admin/recursos/pedidos', {
      activePage: 'recursos', pedidos, horario,
      // Fechas de calendario, no instantes: se formatean en UTC. Ver el comentario largo en
      // services/recursos/disponibilidad.js — `fmt` de liveRoom.js las correría un día.
      diaCorto: disp.diaCorto, diaLargo: disp.diaLargo,
      fmtModulo: (turno, modulo) => {
        const f = horarioSvc.moduloDe(horario, turno, modulo);
        return f ? `${f.label} (${f.desde}-${f.hasta})` : `Módulo ${modulo}`;
      },
      nombreTurno: (id) => horarioSvc.turnoDe(horario, id)?.label || id,
      error: req.query.error || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('No se pudo cargar la bandeja de pedidos');
  }
});

// Aprobar. El administrativo puede EDITAR la cantidad otorgada (darle menos o más de lo que
// pidió) y, con el mismo clic, dejar al docente autorizado para las próximas.
router.post('/pedidos/:id/aprobar', async (req, res) => {
  if (idMalo(req, res, 'Pedido no encontrado')) return;
  try {
    const school  = escuelaDe(res);
    const reserva = await Reserva.findOne({ _id: req.params.id, school, status: 'pendiente' });
    if (!reserva) return res.status(404).json({ error: 'Ese pedido ya no está pendiente.' });

    const recurso = await Recurso.findById(reserva.recurso).lean();
    if (!recurso) return res.status(404).json({ error: 'El recurso ya no existe.' });

    // La cantidad otorgada. Puede pasar `maxPorPedido` —ese tope es del PEDIDO, no del
    // otorgamiento— pero nunca la capacidad física: no hay 40 netbooks en un carro de 30.
    let unidades = 1;
    if (recurso.divisible) {
      unidades = Math.trunc(Number(req.body.unidades || reserva.unidadesPedidas));
      if (!Number.isInteger(unidades) || unidades < 1 || unidades > recurso.capacidad) {
        return res.status(400).json({ error: `La cantidad tiene que estar entre 1 y ${recurso.capacidad}.` });
      }
    }

    const r = await reservaSvc.confirmar(reserva, recurso, unidades);
    if (!r.ok) {
      // Perdió la carrera contra otra aprobación. NO es un 500: es la respuesta normal a algo
      // que el diseño permite (los pendientes no bloquean el casillero — ver el índice en
      // models/Reserva.js). El mensaje tiene que decir qué pasó y qué se puede hacer.
      //
      // Las dos ramas se resuelven distinto, y la diferencia importa:
      //
      //   'tomado' (recurso exclusivo) → NO HAY NADA QUE HACER. Ese módulo ya es de otro y no
      //     se va a liberar solo, así que el pedido se AUTO-RECHAZA con el motivo. Dejarlo
      //     pendiente lo devolvería a la bandeja mañana, y pasado, para siempre: una fila que
      //     el administrativo no puede resolver y que solo le enseña a ignorar la bandeja.
      //
      //   'sincupo' (recurso divisible) → SÍ hay algo que hacer: quedan `libres` unidades y el
      //     administrativo puede confirmar por menos. Ahí el pedido se deja PENDIENTE y la
      //     pantalla le ofrece ese número.
      if (r.motivo === 'tomado') {
        await reservaSvc.liberar(reserva, {
          status: 'rechazada',
          motivoRechazo: 'Mientras estaba pendiente, otro docente confirmó ese módulo.',
          porUsuario: res.locals.user._id,
        });
        logAudit(req, 'booking.reject', [{ type: 'user', id: reserva.docente, name: '' }],
          { fecha: reserva.date, turno: reserva.turno, modulo: reserva.modulo, motivo: 'casillero tomado' });
      }

      return res.status(409).json({
        error: r.motivo === 'sincupo'
          ? `Mientras estaba pendiente se ocuparon. Quedan ${r.libres} disponibles.`
          : 'Mientras estaba pendiente, otro docente confirmó ese módulo.',
        libres: r.libres ?? 0,
        // true = el pedido ya salió de la bandeja; la pantalla recarga en vez de ofrecer nada.
        resuelto: r.motivo === 'tomado',
      });
    }

    reserva.resueltaPor = res.locals.user._id;
    reserva.resueltaEl  = new Date();
    await reserva.save();

    // "Aceptar y autorizar": el botón que hace que el calendario se autocomplete. De acá en
    // más este docente entra directo a este recurso.
    let autorizado = false;
    if (req.body.autorizar === 'si') {
      await RecursoAutorizacion.findOneAndUpdate(
        { recurso: recurso._id, docente: reserva.docente },
        {
          $set: { school, revocadaEl: null, revocadaPor: null,
                  otorgadaPor: res.locals.user._id, otorgadaEl: new Date() },
        },
        { upsert: true },
      );
      autorizado = true;
      logAudit(req, 'booking.authorize',
        [{ type: 'recurso', id: recurso._id, name: recurso.name },
         { type: 'user', id: reserva.docente, name: '' }], {});
    }

    logAudit(req, 'booking.approve',
      [{ type: 'recurso', id: recurso._id, name: recurso.name },
       { type: 'user', id: reserva.docente, name: '' }],
      // Las DOS cifras: es lo que permite responder después "¿por qué me dieron 8 si pedí 15?".
      { fecha: reserva.date, turno: reserva.turno, modulo: reserva.modulo,
        pedidas: reserva.unidadesPedidas, otorgadas: unidades, autorizado });

    res.json({ ok: true, autorizado, unidades });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo aprobar el pedido' });
  }
});

router.post('/pedidos/:id/rechazar', async (req, res) => {
  if (idMalo(req, res, 'Pedido no encontrado')) return;
  try {
    const school  = escuelaDe(res);
    const reserva = await Reserva.findOne({ _id: req.params.id, school, status: 'pendiente' });
    if (!reserva) return res.status(404).json({ error: 'Ese pedido ya no está pendiente.' });

    await reservaSvc.liberar(reserva, {
      status: 'rechazada',
      motivoRechazo: String(req.body.motivo || '').trim().slice(0, 300),
      porUsuario: res.locals.user._id,
    });

    logAudit(req, 'booking.reject', [{ type: 'user', id: reserva.docente, name: '' }],
      { fecha: reserva.date, turno: reserva.turno, modulo: reserva.modulo });
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo rechazar el pedido' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Autorizaciones por recurso
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/autorizaciones', async (req, res) => {
  if (idMalo(req, res, 'Recurso no encontrado')) return;
  try {
    const school  = escuelaDe(res);
    const recurso = await Recurso.findOne({ _id: req.params.id, school }).lean();
    if (!recurso) return res.status(404).send('Recurso no encontrado');

    const [autorizaciones, docentes] = await Promise.all([
      RecursoAutorizacion.find({ recurso: recurso._id, revocadaEl: null })
        .populate('docente', 'name email role')
        .populate('otorgadaPor', 'name')
        .sort({ otorgadaEl: -1 }).lean(),
      // Los mismos roles que pueden pedir (config/sections.js → app_reservas), menos el
      // alumno. Se listan activos nada más: autorizar una cuenta deshabilitada no hace nada.
      User.find({
        school, active: true,
        role: { $in: ['teacher', 'preceptor', 'directivo', 'jefe', 'admin'] },
      }).select('name email role').sort({ name: 1 }).lean(),
    ]);

    const yaAutorizados = new Set(autorizaciones.map(a => String(a.docente?._id)));
    res.render('admin/recursos/autorizaciones', {
      activePage: 'recursos', recurso, autorizaciones,
      candidatos: docentes.filter(d => !yaAutorizados.has(String(d._id))),
      error: req.query.error || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('No se pudo cargar la pantalla de autorizaciones');
  }
});

router.post('/:id/autorizaciones/otorgar', async (req, res) => {
  if (idMalo(req, res, 'Recurso no encontrado')) return;
  try {
    const school  = escuelaDe(res);
    const recurso = await Recurso.findOne({ _id: req.params.id, school }).lean();
    if (!recurso) return res.status(404).json({ error: 'Recurso no encontrado' });

    const docente = await User.findOne({ _id: req.body.docente, school, active: true }).lean();
    if (!docente) return res.status(404).json({ error: 'Ese docente no existe en la escuela.' });

    await RecursoAutorizacion.findOneAndUpdate(
      { recurso: recurso._id, docente: docente._id },
      { $set: { school, revocadaEl: null, revocadaPor: null,
                otorgadaPor: res.locals.user._id, otorgadaEl: new Date() } },
      { upsert: true },
    );
    logAudit(req, 'booking.authorize',
      [{ type: 'recurso', id: recurso._id, name: recurso.name },
       { type: 'user', id: docente._id, name: docente.name }], {});
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo autorizar' });
  }
});

// Revocar NO cancela las reservas que ese docente ya tenía confirmadas: se le quita la llave
// para las próximas, no se le saca la clase de la semana que viene sin avisar. Si hay que
// cancelarlas, es una decisión aparte y se hace desde el pedido.
router.post('/:id/autorizaciones/revocar', async (req, res) => {
  if (idMalo(req, res, 'Recurso no encontrado')) return;
  try {
    const school  = escuelaDe(res);
    const recurso = await Recurso.findOne({ _id: req.params.id, school }).lean();
    if (!recurso) return res.status(404).json({ error: 'Recurso no encontrado' });

    const r = await RecursoAutorizacion.findOneAndUpdate(
      { recurso: recurso._id, docente: req.body.docente, revocadaEl: null },
      { $set: { revocadaEl: new Date(), revocadaPor: res.locals.user._id } },
    );
    if (!r) return res.status(404).json({ error: 'Esa autorización ya no estaba vigente.' });

    logAudit(req, 'booking.revoke',
      [{ type: 'recurso', id: recurso._id, name: recurso.name },
       { type: 'user', id: req.body.docente, name: '' }], {});
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo revocar' });
  }
});

module.exports = router;
