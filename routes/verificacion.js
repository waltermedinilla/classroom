// Verificación de contacto — /verificacion
//
// Confirma que el correo y el celular que figuran en una cuenta son realmente de esa persona.
// Ver specs/verificacion-de-contacto.spec.md.
//
// DOS COSAS QUE ESTE ROUTER NO HACE, Y SON DECISIONES:
//
//  1. No bloquea NADA. No hay ningún middleware acá ni en ningún otro lado que consulte
//     `emailVerifiedAt` para dejar pasar. El estado de verificación es un atributo del DATO, no
//     un permiso de la persona. Los usuarios son adolescentes de una escuela pública, muchos con
//     correo de fantasía creado para el trámite y sin celular propio: una plataforma que se les
//     cierra por eso es una plataforma que dejan de usar. Ver D1.
//
//  2. No inicia sesión. El enlace del correo verifica y manda a /login; no es un login mágico.
//
// La única ruta sin `requireAuth` es la del enlace, y es a propósito: el mail se abre en el
// celular mientras la sesión está en la netbook del aula (ver D4).

const express = require('express');

const User = require('../models/User');

const { requireAuth }         = require('../middleware/auth');
const { requireModulo }       = require('../middleware/modulos');
const { loadPreceptorScope }  = require('../middleware/preceptor');
const { logAudit }            = require('../middleware/audit');
const { idMalo }              = require('../middleware/objectId');
const { logDeRuta }           = require('../middleware/route-log');
const {
  verificacionEnvioLimiter, verificacionCodigoLimiter,
} = require('../middleware/rate-limits');

const { CANALES, LIMITES, canalActivo } = require('../config/verificacion');
const verif = require('../services/verificacionContacto');

const router = express.Router();

// Roles que pueden confirmar el contacto de OTRA persona (verificación asistida, D6). El
// preceptor va acotado a sus divisiones más abajo; los otros tres ya tienen alcance de escuela.
const ROLES_QUE_VERIFICAN = ['admin', 'superadmin', 'directivo', 'preceptor'];

const canalValido = (c) => Object.prototype.hasOwnProperty.call(CANALES, c);

// ─────────────────────────────────────────────────────────────────────────────
// El ENLACE del correo. Va PRIMERO y sin requireAuth.
// ─────────────────────────────────────────────────────────────────────────────
// Y va antes del `router.use(requireAuth, ...)` de más abajo a propósito: en Express gana el
// primero que matchea, así que montarlo después lo dejaría atrás de la guarda de sesión y el
// enlace del mail contestaría "iniciá sesión" a alguien que solo quiere confirmar su correo.

// ⚠️ EL PREFIJO ES `/enlace/` Y NO `/email/`, Y NO ES COSMÉTICO.
//
// Con `/email/:token`, el path `/verificacion/email/enviar` —la ruta para PEDIR un código, que
// está más abajo como `/:canal/enviar`— entraba acá primero, con token = "enviar": en Express
// gana el primero que matchea y los dos tienen dos segmentos. El resultado era que pedir un
// código devolvía 200 con la PÁGINA HTML del enlace, y el navegador fallaba al parsear JSON.
// Lo mismo le pasaba a `/email/codigo`. Encontrado probando en el navegador (los tests unitarios
// no lo veían: es una colisión de ruteo, no de lógica).
//
// GET: MUESTRA UN BOTÓN, NO VERIFICA NADA.
//
// Es la mitad menos obvia de toda la feature. Los antivirus de los servidores de correo hacen
// GET a todas las URLs que ven, antes de que la persona toque nada: si el GET verificara, el
// enlace llegaría quemado y el usuario vería "este enlace ya se usó" sin haber hecho clic. Por
// eso el GET solo mira (`soloMirar: true`) y el POST es el que confirma.
router.get('/enlace/:token', async (req, res) => {
  try {
    const r = await verif.confirmarToken(req.params.token, { soloMirar: true });
    res.render('verificacion/resultado', {
      estado:  r.estado,
      token:   req.params.token,
      usuario: r.usuario || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).render('verificacion/resultado', { estado: 'error', token: null, usuario: null });
  }
});

router.post('/enlace/:token', async (req, res) => {
  try {
    const r = await verif.confirmarToken(req.params.token);
    if (r.ok && r.estado === 'verificado' && r.usuario) {
      logAudit(req, 'verificacion.ok',
        [{ type: 'user', id: r.usuario._id, name: r.usuario.name }],
        { canal: 'correo', via: 'enlace' },
        // El actor no está autenticado (el enlace va sin sesión), así que la escuela del evento
        // se toma de la persona verificada y no de res.locals.user, que acá no existe.
        { schoolId: r.usuario.school || null },
      );
    }
    res.render('verificacion/resultado', {
      estado:  r.estado,
      token:   null,
      usuario: r.usuario || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).render('verificacion/resultado', { estado: 'error', token: null, usuario: null });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// De acá para abajo: sesión + módulo prendido para la escuela.
// ─────────────────────────────────────────────────────────────────────────────
router.use(requireAuth, requireModulo('verificacion'));

// GET /verificacion/estado — lo que la pantalla necesita para dibujarse.
// Sirve para refrescar los chips después de verificar sin recargar la página entera.
router.get('/estado', async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .select('email phone phoneE164 emailVerifiedAt emailVerifiedVia phoneVerifiedAt phoneVerifiedVia')
      .lean();
    if (!user) return res.status(404).json({ error: 'No se encontró tu cuenta.' });

    res.json({
      ok: true,
      user,
      canales: {
        email:   { activo: canalActivo('email') },
        celular: { activo: canalActivo('celular') },
      },
      esperaSegundos: LIMITES.segundosEntreEnvios,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /verificacion/:canal/enviar — pedir un código (y, para el correo, un enlace).
router.post('/:canal/enviar', verificacionEnvioLimiter, async (req, res) => {
  try {
    const { canal } = req.params;
    if (!canalValido(canal)) return res.status(400).json({ error: 'Canal desconocido' });

    const user = await User.findById(req.userId)
      .select('_id name email phone phoneE164 school emailVerifiedAt phoneVerifiedAt');
    if (!user) return res.status(404).json({ error: 'No se encontró tu cuenta.' });

    const r = await verif.pedirVerificacion({ user, canal, escuela: res.locals.school });
    if (!r.ok) {
      return res.status(r.status || 400).json({ error: r.error, esperaSegundos: r.esperaSegundos });
    }

    // Se audita el PEDIDO y no cada reintento: el mismo criterio por el que no se auditan las 30
    // marcas de asistencia de un pase de lista. Lo que importa después es que hubo un intento de
    // verificación, no cuántas veces se apretó el botón.
    logAudit(req, 'verificacion.enviada',
      [{ type: 'user', id: user._id, name: user.name }],
      { canal: CANALES[canal].label },
    );

    res.json({ ok: true, destino: r.destino, expiraEn: r.expiraEn, esperaSegundos: r.esperaSegundos });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /verificacion/:canal/codigo — confirmar con los 6 dígitos.
router.post('/:canal/codigo', verificacionCodigoLimiter, async (req, res) => {
  try {
    const { canal } = req.params;
    if (!canalValido(canal)) return res.status(400).json({ error: 'Canal desconocido' });

    const user = await User.findById(req.userId).select('_id name email phone phoneE164 school');
    if (!user) return res.status(404).json({ error: 'No se encontró tu cuenta.' });

    const r = await verif.confirmarCodigo({ user, canal, codigo: req.body.codigo });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });

    logAudit(req, 'verificacion.ok',
      [{ type: 'user', id: user._id, name: user.name }],
      { canal: CANALES[canal].label, via: 'código' },
    );

    res.json({ ok: true, canal, verificadoEn: r.verificadoEn });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /verificacion/:canal — "este ya no es mío".
router.delete('/:canal', async (req, res) => {
  try {
    const { canal } = req.params;
    if (!canalValido(canal)) return res.status(400).json({ error: 'Canal desconocido' });

    const r = await verif.quitarVerificacion({ userId: req.userId, canal });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });

    logAudit(req, 'verificacion.revocada',
      [{ type: 'user', id: req.userId, name: res.locals.user?.name }],
      { canal: CANALES[canal].label, via: 'el propio usuario' },
    );

    res.json({ ok: true, canal });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Verificación ASISTIDA (D6) — alguien de la escuela confirma el dato de otro.
// ─────────────────────────────────────────────────────────────────────────────

// Alcance: además del rol, el preceptor solo llega a los alumnos de SUS divisiones.
//
// El alcance NO se recalcula acá: lo resuelve loadPreceptorScope (middleware/preceptor.js), que
// deja req.scopeDivisionIds, y la pertenencia la contesta alumnoEnAlcance() —la misma función
// que usa el panel de preceptoría, importada, no copiada—. Es fail-closed a propósito (alcance
// vacío = no ve nada, nunca "ve todo"), y dos implementaciones de una barrera terminan siendo
// una sola barrera.
//
// Un alumno no tiene división en su documento: pertenece a las materias (Course.students) y la
// división sale de ahí. Por eso la comprobación es una consulta y no una comparación de campos.
const { alumnoEnAlcance } = require('./preceptor');

async function puedeVerificarA(req, res, target) {
  const rol = res.locals.user?.role;
  if (!ROLES_QUE_VERIFICAN.includes(rol)) return false;

  // El superadmin no tiene escuela propia; los demás solo tocan gente de la suya.
  if (rol !== 'superadmin') {
    if (!res.locals.user?.school) return false;
    if (String(target.school || '') !== String(res.locals.user.school)) return false;
  }

  // admin, directivo y superadmin ven la escuela entera: loadPreceptorScope ya les puso todas
  // las divisiones y res.locals.scopeAll en true, así que no hay nada más que preguntar.
  if (rol !== 'preceptor') return true;

  // El preceptor, en cambio, solo llega a los ALUMNOS de sus divisiones. Sobre un docente o un
  // administrativo no tiene alcance por ningún lado.
  if (target.role !== 'student') return false;
  return alumnoEnAlcance(target._id, req.scopeDivisionIds || []);
}

router.post('/staff/:id/:canal', loadPreceptorScope, async (req, res) => {
  try {
    const { canal } = req.params;
    if (idMalo(req, res, 'Usuario no encontrado')) return;
    if (!canalValido(canal)) return res.status(400).json({ error: 'Canal desconocido' });

    const target = await User.findById(req.params.id).select('_id name email phone school role');
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (!(await puedeVerificarA(req, res, target))) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const r = await verif.verificarPorStaff({ target, canal, actorId: req.userId });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });

    logAudit(req, 'verificacion.staff',
      [{ type: 'user', id: target._id, name: target.name }],
      { canal: CANALES[canal].label },
    );

    res.json({ ok: true, canal });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.delete('/staff/:id/:canal', loadPreceptorScope, async (req, res) => {
  try {
    const { canal } = req.params;
    if (idMalo(req, res, 'Usuario no encontrado')) return;
    if (!canalValido(canal)) return res.status(400).json({ error: 'Canal desconocido' });

    const target = await User.findById(req.params.id).select('_id name school role');
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (!(await puedeVerificarA(req, res, target))) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (String(target._id) === String(req.userId)) {
      return res.status(403).json({ error: 'No podés tocar tus propios datos por esta vía.' });
    }

    const r = await verif.quitarVerificacion({ userId: target._id, canal });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });

    logAudit(req, 'verificacion.revocada',
      [{ type: 'user', id: target._id, name: target.name }],
      { canal: CANALES[canal].label },
    );

    res.json({ ok: true, canal });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /verificacion/cobertura — "¿a cuántos les llega un correo?".
// La pregunta que hay que poder contestar ANTES de mandar el primer comunicado.
router.get('/cobertura', async (req, res) => {
  try {
    const rol = res.locals.user?.role;
    if (!['admin', 'superadmin', 'directivo'].includes(rol)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    const schoolId = res.locals.school?._id;
    if (!schoolId) return res.status(400).json({ error: 'Sin escuela' });

    res.json({ ok: true, ...(await verif.cobertura(schoolId)) });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
