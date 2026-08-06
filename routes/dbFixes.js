// Panel "Otros" del superadmin — /superadmin/otros
//
// Sanar la base de datos: arreglos de integridad que se diagnostican y se aplican con un
// botón. El catálogo vive en services/dbFixes.js; acá solo están las rutas y las guardas.
//
// Autorización: misma doble capa que backup/restore (rol superadmin + SYSTEM_OWNER_EMAIL).
// Estos arreglos escriben en masa sobre miles de documentos y no hay "deshacer", así que
// no alcanza con el chequeo de rol por si en el futuro se crea otro superadmin.

const express = require('express');
const { requireAuth }       = require('../middleware/auth');
const { requireSuperadmin } = require('../middleware/admin');
const { invalidateAll }     = require('../middleware/cache');
const { logAudit }          = require('../middleware/audit');
const { SYSTEM_OWNER_EMAIL } = require('../config/maintenance');
const { getFix, diagnosticarTodos } = require('../services/dbFixes');

const router = express.Router();

function requireOwner(req, res, next) {
  if (res.locals.user?.email !== SYSTEM_OWNER_EMAIL) {
    return res.status(403).send('Acceso denegado');
  }
  next();
}

router.use(requireAuth, requireSuperadmin, requireOwner);

/* ─── Pantalla principal ─────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const fixes = await diagnosticarTodos();
    res.render('superadmin/otros', {
      fixes,
      pendientes: fixes.filter(f => f.total > 0).length,
      activePage: 'otros',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Re-diagnóstico de un arreglo (para refrescar la tarjeta sin recargar) ─ */
router.get('/:id/diagnostico', async (req, res) => {
  const fix = getFix(req.params.id);
  if (!fix) return res.status(404).json({ error: 'Ese arreglo no existe' });
  try {
    const d = await fix.diagnosticar();
    res.json({ total: d.total, muestra: d.muestra, nota: d.nota || null, grupos: d.grupos || [] });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo diagnosticar: ' + err.message });
  }
});

/* ─── Vista previa de un arreglo que recibe datos cargados a mano ────────── */
// Los compositores ('alta-masiva-materias') escriben lo que la persona escribió, no lo que
// dedujo un diagnóstico: ver el efecto exacto antes de aplicar es la única red que hay,
// porque acá tampoco existe el "deshacer". El plan se recalcula igual dentro de aplicar(),
// así que esta vista previa no es una promesa: es el mismo cálculo, un rato antes.
router.post('/:id/previsualizar', async (req, res) => {
  const fix = getFix(req.params.id);
  if (!fix) return res.status(404).json({ error: 'Ese arreglo no existe' });
  if (typeof fix.previsualizar !== 'function') {
    return res.status(400).json({ error: 'Este arreglo no tiene vista previa.' });
  }
  try {
    res.json(await fix.previsualizar(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.status ? err.message : 'No se pudo calcular la vista previa: ' + err.message,
    });
  }
});

/* ─── Resolver UN grupo de un arreglo interactivo ────────────────────────── */
// Los arreglos interactivos (hoy solo 'docentes-dni-duplicado') no tienen un botón único:
// cada grupo se resuelve por separado porque la elección —cuál de las dos cuentas se
// conserva— es de la escuela, no derivable de los datos. El servicio recalcula el grupo
// desde la base antes de tocar nada, así que un panel viejo en otra pestaña no puede
// fusionar contra un estado que ya cambió.
router.post('/:id/fusionar', async (req, res) => {
  const fix = getFix(req.params.id);
  if (!fix) return res.status(404).json({ error: 'Ese arreglo no existe' });
  if (typeof fix.fusionar !== 'function') {
    return res.status(400).json({ error: 'Este arreglo no se resuelve grupo por grupo.' });
  }

  const { clave, keepId, sobrante, emailId } = req.body || {};
  if (!clave || !keepId) {
    return res.status(400).json({ error: 'Falta indicar el grupo y la cuenta que se conserva.' });
  }

  try {
    const r = await fix.fusionar({ clave, keepId, sobrante, emailId });

    // Las cuentas tocadas viven cacheadas 45s por worker (middleware/cache.js): sin limpiar,
    // la que quedó deshabilitada podría seguir entrando hasta que expire el TTL.
    invalidateAll();

    logAudit(req, 'user.merge',
      [
        { type: 'user', id: r.conservada.id, name: r.conservada.nombre },
        ...r.sobrantes.map(c => ({ type: 'user', id: c.id, name: c.nombre })),
      ],
      {
        arreglo: fix.id,
        conservada: r.conservada.email,
        sobrante: r.sobrantes.map(c => c.email).join(', '),
        destino_sobrante: r.accion,
        ...(r.correo.cambiado ? { correo_final: r.correo.final, correo_anterior: r.correo.anterior } : {}),
        materias_titular: r.resumen.titular,
        materias_suplente: r.resumen.suplente,
        actividades: r.resumen.actividades,
        novedades: r.resumen.novedades,
      },
      // La clave del grupo es `${schoolId}|${dni}`: sin esto el evento queda con school:null
      // y no lo ve el admin de la escuela en su propio panel de auditoría.
      { schoolId: String(clave).split('|')[0] || null },
    );

    const despues = await fix.diagnosticar();
    const { titular, suplente, actividades, novedades, comentarios, matriculas } = r.resumen;
    const movido = [
      titular     ? `${titular} materia(s) como titular` : null,
      suplente    ? `${suplente} como suplente`          : null,
      actividades ? `${actividades} actividad(es)`       : null,
      novedades   ? `${novedades} novedad(es)`           : null,
      comentarios ? `${comentarios} novedad(es) con comentarios suyos` : null,
      matriculas  ? `${matriculas} matrícula(s) sueltas quitadas`      : null,
    ].filter(Boolean);

    res.json({
      ok: true,
      mensaje:
        `Listo: ${r.conservada.nombre} (${r.correo.final}) se queda con todo. ` +
        (movido.length ? `Se transfirió: ${movido.join(', ')}. ` : 'No había nada que transferir. ') +
        (r.correo.cambiado
          ? `El correo pasó de ${r.correo.anterior} a ${r.correo.final}` +
            (r.correo.intercambiadoCon
              ? ` (la cuenta deshabilitada se quedó con ${r.correo.intercambiadoCon}). `
              : '. ')
          : '') +
        (r.accion === 'eliminar'
          ? 'La cuenta sobrante se eliminó.'
          : 'La cuenta sobrante quedó deshabilitada' +
            (r.forzadoDeshabilitar
              ? ' (no se pudo eliminar: tiene entregas propias, borrarla dejaría esas entregas sin dueño).'
              : '.')),
      restantes: despues.total,
      grupos: despues.grupos || [],
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ─── Aplicar ────────────────────────────────────────────────────────────── */
router.post('/:id/aplicar', async (req, res) => {
  const fix = getFix(req.params.id);
  if (!fix) return res.status(404).json({ error: 'Ese arreglo no existe' });
  if (!fix.aplicable || typeof fix.aplicar !== 'function') {
    return res.status(400).json({
      error: typeof fix.fusionar === 'function'
        ? 'Este arreglo se resuelve grupo por grupo: elegí qué cuenta se conserva en cada caso.'
        : 'Este arreglo es solo de diagnóstico: no hay una regla automática que lo resuelva sin inventar datos.',
    });
  }

  try {
    // El conteo previo va al log de auditoría: es lo que permite después saber sobre
    // cuántos registros se corrió, aunque el diagnóstico ya dé cero.
    const antes = await fix.diagnosticar();
    const resultado = await fix.aplicar(req.body || {});

    // Varios arreglos tocan documentos de User (escuela, alcance de preceptor) que viven
    // cacheados 45s por worker. Sin limpiar, el efecto no se ve hasta que expire el TTL.
    invalidateAll();

    logAudit(req, 'system.db_fix',
      [],
      {
        arreglo: fix.id,
        detectados: antes.total,
        afectados: resultado.afectados,
        // Los compositores mandan en el body todo lo que se cargó a mano (decenas de cursos
        // por decenas de materias): eso no entra en un renglón de auditoría, así que el
        // arreglo devuelve su propio resumen y el body crudo se corta.
        ...(resultado.meta || {}),
        ...(req.body && Object.keys(req.body).length
          ? { parametros: JSON.stringify(req.body).slice(0, 1000) }
          : {}),
      },
      // El superadmin no tiene escuela propia: sin esto el evento queda con school:null y no
      // lo ve el admin de la escuela en su panel de auditoría, aunque el cambio sea suyo.
      resultado.schoolId ? { schoolId: resultado.schoolId } : {},
    );

    const despues = await fix.diagnosticar();
    res.json({
      ok: true,
      afectados: resultado.afectados,
      mensaje: resultado.mensaje,
      restantes: despues.total,
    });
  } catch (err) {
    // `status` lo pone el propio arreglo cuando el problema es el dato cargado (un curso sin
    // elegir, un docente que no es de la escuela): eso es 400 con el mensaje tal cual, no un
    // 500 que haga pensar que se rompió el servidor.
    res.status(err.status || 500).json({
      error: err.status ? err.message : 'No se pudo aplicar: ' + err.message,
    });
  }
});

module.exports = router;
