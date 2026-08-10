// PANEL DE MENSAJES DEL SUPERADMINISTRADOR (/superadmin/messages).
//
// Redactar un mensaje, elegir a quién le llega, ver quién lo leyó y seguir los hilos de los
// que contestaron. El lado del destinatario vive en routes/messagesInbox.js.
//
// Se monta ANTES de /superadmin en server.js, por el mismo motivo que /backup, /otros,
// /tasks y /roles: superadmin.js es catch-all y estas rutas caerían en su 404.

const express = require('express');

const Message          = require('../models/Message');
const MessageRecipient = require('../models/MessageRecipient');
const User             = require('../models/User');
const School           = require('../models/School');

const { requireAuth }        = require('../middleware/auth');
const { requireSuperAdmin }  = require('../middleware/superadmin');
const { logAudit }           = require('../middleware/audit');
const { messageSendLimiter } = require('../middleware/rate-limits');

const {
  ROLES_VALIDOS, construirFiltroGrupo, hayAlgoElegido, resolverDestinatarios,
} = require('../services/messageAudience');
const { hilo, esperaAlDestinatario, cuantosMensajes, MAX_MENSAJES } =
  require('../services/messageThread');

const router = express.Router();

const MAX_BODY    = 2000;
const MAX_SUBJECT = 120;
// Tamaño de lote del insertMany. 500 documentos de ~200 bytes es un paquete cómodo para
// Mongo y deja el pico de memoria acotado aunque el envío sea a toda la comunidad.
const LOTE        = 500;
const POR_PAGINA  = 20;
const DESTINATARIOS_POR_PAGINA = 50;

// Killswitch. Mismo patrón que SUGGESTIONS_INBOX_ENABLED en server.js: se apaga con una env
// var y un reload, sin redeploy. Va acá adentro además del `if` del montaje para que el
// router sea seguro aunque alguien lo monte sin condición.
const habilitado = () => process.env.MESSAGES_ENABLED !== 'false';

router.use(requireAuth, requireSuperAdmin, (req, res, next) => {
  if (!habilitado()) return res.status(404).send('No encontrado');
  next();
});

// Los query params de una lista llegan como string suelto si vino uno solo, y como array si
// vinieron varios. Normalizar acá evita que cada endpoint se acuerde del caso.
const asArray = (v) => (v === undefined || v === null || v === '') ? []
  : (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean);

const leerFiltros = (src) => ({
  everyone: src.everyone === true || src.everyone === 'true',
  roles:    asArray(src.roles),
  schools:  asArray(src.schools),
  userIds:  asArray(src.userIds),
});

// Traduce los filtros a la frase que se muestra en el panel ("Docentes y Preceptores de
// San José, más 3 personas"). Vive acá y no en la vista porque la usan el listado, el
// detalle y el meta de auditoría.
function describirAudiencia(audience, roleNames, escuelasPorId = {}) {
  if (!audience) return 'Sin destinatarios';
  const partes = [];

  if (audience.everyone) {
    partes.push('Toda la comunidad');
  } else if (audience.roles?.length) {
    partes.push(audience.roles.map(r => (roleNames[r] || r) + 's').join(', '));
  }

  if (audience.schools?.length) {
    const nombres = audience.schools.map(id => escuelasPorId[String(id)] || 'una escuela');
    partes.push('de ' + nombres.join(', '));
  }

  if (audience.userIds?.length) {
    const n = audience.userIds.length;
    partes.push(partes.length
      ? `más ${n} persona${n === 1 ? '' : 's'}`
      : `${n} persona${n === 1 ? '' : 's'}`);
  }

  return partes.length ? partes.join(' ') : 'Sin destinatarios';
}

/* ─── Pantalla principal: redacción + envíos anteriores ─────────────────────── */

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);

    const [mensajes, total, escuelas] = await Promise.all([
      Message.find({ sender: req.userId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * POR_PAGINA)
        .limit(POR_PAGINA)
        .lean(),
      Message.countDocuments({ sender: req.userId }),
      School.find().select('name').sort({ name: 1 }).lean(),
    ]);

    // Dos contadores por envío: cuántos lo leyeron y cuántas respuestas nuevas hay. Se
    // resuelven con dos aggregates sobre TODOS los mensajes de la página en vez de dos
    // queries por fila — con 20 filas serían 40 idas y vueltas a Mongo.
    const ids = mensajes.map(m => m._id);
    const [leidos, respuestas] = await Promise.all([
      MessageRecipient.aggregate([
        { $match: { message: { $in: ids }, readAt: { $ne: null } } },
        { $group: { _id: '$message', n: { $sum: 1 } } },
      ]),
      MessageRecipient.aggregate([
        { $match: { message: { $in: ids }, unreadForStaff: true } },
        { $group: { _id: '$message', n: { $sum: 1 } } },
      ]),
    ]);
    const leidosPorId     = Object.fromEntries(leidos.map(r => [String(r._id), r.n]));
    const respuestasPorId = Object.fromEntries(respuestas.map(r => [String(r._id), r.n]));
    const escuelasPorId   = Object.fromEntries(escuelas.map(e => [String(e._id), e.name]));

    res.render('superadmin/messages', {
      activePage: 'messages',
      mensajes: mensajes.map(m => ({
        ...m,
        leidos:     leidosPorId[String(m._id)]     || 0,
        respuestas: respuestasPorId[String(m._id)] || 0,
        audienciaTexto: describirAudiencia(m.audience, res.locals.roleNames, escuelasPorId),
      })),
      escuelas,
      roles: ROLES_VALIDOS,
      page,
      totalPages: Math.ceil(total / POR_PAGINA) || 1,
      total,
      MAX_BODY,
      MAX_SUBJECT,
    });
  } catch {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Previsualización del alcance (no envía nada) ──────────────────────────── */

// Es la protección real contra el "quise mandarle a los docentes y le mandé a la escuela":
// devuelve el total, el desglose por rol y una muestra de nombres ANTES de que exista
// ningún documento.
router.get('/preview', async (req, res) => {
  try {
    const filtros = leerFiltros(req.query);
    if (!hayAlgoElegido(filtros)) return res.json({ total: 0, porRol: {}, muestra: [] });

    const destinatarios = await resolverDestinatarios(filtros, req.userId);

    const porRol = {};
    destinatarios.forEach(u => { porRol[u.role] = (porRol[u.role] || 0) + 1; });

    const muestraIds = destinatarios.slice(0, 10).map(u => u._id);
    const muestra = await User.find({ _id: { $in: muestraIds } })
      .select('dni name role').lean();

    res.json({ total: destinatarios.length, porRol, muestra });
  } catch {
    res.status(500).json({ error: 'No se pudo calcular el alcance' });
  }
});

/* ─── Buscador de personas sueltas ──────────────────────────────────────────── */

router.get('/users', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [] });

    // Se escapan los metacaracteres: sin esto un "(" tipeado en el buscador tira una
    // RegExp inválida y el endpoint devuelve 500 en vez de "sin resultados".
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const filtro = { active: true, $or: [{ name: rx }, { dni: rx }, { email: rx }] };
    if (req.query.role && ROLES_VALIDOS.includes(req.query.role)) filtro.role = req.query.role;
    if (req.query.school) filtro.school = req.query.school;

    const users = await User.find(filtro)
      .select('dni name email role school')
      .populate('school', 'name')
      .limit(20)
      .lean();

    res.json({ users });
  } catch {
    res.status(500).json({ error: 'Error al buscar' });
  }
});

/* ─── Enviar ────────────────────────────────────────────────────────────────── */

router.post('/', messageSendLimiter, async (req, res) => {
  let creado = null;
  try {
    const body    = (req.body.body    || '').trim();
    const subject = (req.body.subject || '').trim();

    if (!body)                    return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    if (body.length > MAX_BODY)   return res.status(400).json({ error: `El mensaje no puede superar los ${MAX_BODY} caracteres` });
    if (subject.length > MAX_SUBJECT) return res.status(400).json({ error: `El asunto no puede superar los ${MAX_SUBJECT} caracteres` });

    const filtros = leerFiltros(req.body);
    // Se corta acá, sin tocar Mongo, cuando no se eligió nada.
    if (!hayAlgoElegido(filtros)) {
      return res.status(400).json({ error: 'El mensaje no tiene destinatarios' });
    }

    const destinatarios = await resolverDestinatarios(filtros, req.userId);
    if (!destinatarios.length) {
      return res.status(400).json({ error: 'El mensaje no tiene destinatarios' });
    }

    creado = await Message.create({
      subject,
      body,
      sender:       req.userId,
      allowReplies: req.body.allowReplies === true || req.body.allowReplies === 'true',
      audience: {
        everyone: filtros.everyone,
        // Con "toda la comunidad" no se guardan roles: la memoria del envío tiene que
        // decir lo que realmente pasó, y lo que pasó es que fue a todos.
        roles:    filtros.everyone ? [] : filtros.roles.filter(r => ROLES_VALIDOS.includes(r)),
        schools:  filtros.schools,
        userIds:  filtros.userIds,
      },
    });

    // El rol y la escuela se congelan acá: es el rol que la persona TENÍA cuando se le
    // mandó. Si mañana cambia de rol, el panel tiene que seguir explicando por qué le llegó.
    const filas = destinatarios.map(u => ({
      message:      creado._id,
      user:         u._id,
      roleAtSend:   u.role   || null,
      schoolAtSend: u.school || null,
    }));

    let insertados = 0;
    for (let i = 0; i < filas.length; i += LOTE) {
      // ordered:false → un duplicado (índice único { message, user }) no corta el lote.
      // Es lo que hace que un reintento sea inofensivo en vez de dejar el envío a medias.
      const r = await MessageRecipient.insertMany(filas.slice(i, i + LOTE), { ordered: false });
      insertados += r.length;
    }

    // Se escribe DESPUÉS, con lo realmente insertado: es el denominador de "leído por X de Y"
    // y tiene que coincidir con las filas que existen, no con las que se intentaron.
    creado.recipientCount = insertados;
    await creado.save();

    logAudit(req, 'message.send',
      [{ type: 'message', id: creado._id, name: (subject || body).slice(0, 60) }],
      {
        destinatarios: insertados,
        audiencia:     describirAudiencia(creado.audience, res.locals.roleNames),
        respuestas:    creado.allowReplies ? 'habilitadas' : 'deshabilitadas',
      },
    );

    res.status(201).json({ ok: true, id: creado._id, destinatarios: insertados });
  } catch {
    // Un envío sin destinatarios no sirve para nada y ensucia el panel: si el insert falló,
    // el mensaje se va con él.
    if (creado) {
      try {
        await MessageRecipient.deleteMany({ message: creado._id });
        await Message.deleteOne({ _id: creado._id });
      } catch { /* si tampoco se puede limpiar, queda el 500 igual */ }
    }
    res.status(500).json({ error: 'No se pudo enviar el mensaje' });
  }
});

/* ─── Detalle de un envío ───────────────────────────────────────────────────── */

router.get('/:id', async (req, res) => {
  try {
    const mensaje = await Message.findOne({ _id: req.params.id, sender: req.userId }).lean();
    if (!mensaje) return res.status(404).send('Mensaje no encontrado');

    // 'todos' | 'leidos' | 'no-leidos' | 'respondieron'
    const filtro = req.query.filtro || 'todos';
    const page   = Math.max(1, parseInt(req.query.page) || 1);

    const q = { message: mensaje._id };
    if (filtro === 'leidos')       q.readAt = { $ne: null };
    if (filtro === 'no-leidos')    q.readAt = null;
    if (filtro === 'respondieron') q['thread.0'] = { $exists: true };

    const [destinatarios, total, leidos, respondieron] = await Promise.all([
      MessageRecipient.find(q)
        .populate('user', 'dni name email role active')
        .populate('schoolAtSend', 'name')
        .sort({ updatedAt: -1 })
        .skip((page - 1) * DESTINATARIOS_POR_PAGINA)
        .limit(DESTINATARIOS_POR_PAGINA)
        .lean(),
      MessageRecipient.countDocuments(q),
      MessageRecipient.countDocuments({ message: mensaje._id, readAt: { $ne: null } }),
      MessageRecipient.countDocuments({ message: mensaje._id, 'thread.0': { $exists: true } }),
    ]);

    res.render('superadmin/message-detail', {
      activePage: 'messages',
      mensaje,
      destinatarios: destinatarios.map(d => ({
        ...d,
        hilo: hilo(mensaje, d),
        esperaAlDestinatario: esperaAlDestinatario(mensaje, d),
        puedeSeguir: mensaje.allowReplies && cuantosMensajes(mensaje, d) < MAX_MENSAJES,
      })),
      filtro,
      leidos,
      respondieron,
      page,
      totalPages: Math.ceil(total / DESTINATARIOS_POR_PAGINA) || 1,
      total,
      audienciaTexto: describirAudiencia(mensaje.audience, res.locals.roleNames),
      MAX_BODY,
    });
  } catch {
    res.status(500).send('Error del servidor');
  }
});

/* ─── El superadmin sigue el hilo de UN destinatario ────────────────────────── */

router.post('/:id/reply', async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text)                  return res.status(400).json({ error: 'La respuesta no puede estar vacía' });
    if (text.length > MAX_BODY) return res.status(400).json({ error: `La respuesta no puede superar los ${MAX_BODY} caracteres` });

    const mensaje = await Message.findOne({ _id: req.params.id, sender: req.userId });
    if (!mensaje) return res.status(404).json({ error: 'Mensaje no encontrado' });

    const rec = await MessageRecipient.findOne({
      _id: req.body.recipientId, message: mensaje._id,
    });
    if (!rec) return res.status(404).json({ error: 'Destinatario no encontrado' });

    if (cuantosMensajes(mensaje, rec) >= MAX_MENSAJES) {
      return res.status(400).json({ error: `Esta conversación llegó a los ${MAX_MENSAJES} mensajes.` });
    }

    rec.thread.push({ from: 'staff', author: req.userId, text });
    // Le toca al destinatario: se le enciende el badge y se apaga el aviso del panel.
    rec.unreadForUser  = true;
    rec.unreadForStaff = false;
    await rec.save();

    logAudit(req, 'message.staff_reply',
      [{ type: 'message', id: mensaje._id, name: (mensaje.subject || mensaje.body).slice(0, 60) }],
      { mensajes: cuantosMensajes(mensaje, rec) },
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'No se pudo enviar la respuesta' });
  }
});

/* ─── Prender/apagar las respuestas de un envío ya hecho ────────────────────── */

router.patch('/:id/replies', async (req, res) => {
  try {
    const allowReplies = req.body.allowReplies === true || req.body.allowReplies === 'true';

    const mensaje = await Message.findOneAndUpdate(
      { _id: req.params.id, sender: req.userId },
      { $set: { allowReplies } },
      { new: true },
    );
    if (!mensaje) return res.status(404).json({ error: 'Mensaje no encontrado' });

    // Apagar CIERRA la caja de texto, no borra nada: lo que alguien ya escribió se conserva
    // y se sigue viendo de los dos lados. Perder mensajes de gente no es una opción.
    logAudit(req, 'message.toggle_replies',
      [{ type: 'message', id: mensaje._id, name: (mensaje.subject || mensaje.body).slice(0, 60) }],
      { respuestas: allowReplies ? 'habilitadas' : 'deshabilitadas' },
    );

    res.json({ ok: true, allowReplies });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Borrar un envío ───────────────────────────────────────────────────────── */

router.delete('/:id', async (req, res) => {
  try {
    const mensaje = await Message.findOne({ _id: req.params.id, sender: req.userId });
    if (!mensaje) return res.status(404).json({ error: 'Mensaje no encontrado' });

    // Primero los destinatarios: si se borrara el Message antes y fallara esto, quedarían
    // filas huérfanas apuntando a un mensaje que ya no existe, y la bandeja de esa gente
    // mostraría un hueco. Al revés, el peor caso es un mensaje sin destinatarios, que el
    // panel muestra como "0 personas" y se puede volver a borrar.
    await MessageRecipient.deleteMany({ message: mensaje._id });
    await Message.deleteOne({ _id: mensaje._id });

    logAudit(req, 'message.delete',
      [{ type: 'message', id: mensaje._id, name: (mensaje.subject || mensaje.body).slice(0, 60) }],
      { destinatarios: mensaje.recipientCount },
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'No se pudo eliminar el mensaje' });
  }
});

module.exports = router;
