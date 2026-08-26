// Enforcement de los módulos opcionales que el superadmin prende por escuela en
// /superadmin/schools. Ver config/modulos.js para el catálogo y el porqué del diseño.
//
// POR QUÉ NO ALCANZA CON config/sections.js: el campo `flag` de una sección solo esconde la
// solapa del nav (lo evalúa res.locals.can en server.js), y sectionGuard —la única capa que
// hoy bloquea rutas por escuela— es RESTRICTIVA y fail-open: solo deniega lo que está
// explícitamente denegado. Un módulo apagado no está "denegado", simplemente no existe, así
// que sectionGuard lo dejaría pasar y la URL escrita a mano funcionaría igual.
//
// Y tampoco sirve el otro camino que usa el proyecto para los flags: montar el router
// condicionalmente en server.js (como hace /superadmin/tasks con TASK_TEMPLATES_ENABLED).
// Eso funciona para un flag GLOBAL de variable de entorno, y no para uno por escuela: el
// montaje ocurre una sola vez al arrancar el proceso, y para entonces todavía no hay request
// del que sacar la escuela.
const { MODULOS_BY_ID, moduloActivo } = require('../config/modulos');

// Mismo status y mismo texto que middleware/admin.js y middleware/sections.js, para que el
// usuario vea siempre la misma pantalla de rechazo. La rama JSON existe porque los paneles
// están llenos de fetch(): sin ella, un botón rechazado recibiría HTML donde espera JSON.
function denegar(req, res) {
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return res.status(403).send('Acceso denegado');
}

// Guarda de MÓDULO. Se monta una vez por router, arriba de todo:
//
//   router.use(requireAuth, requireAdmin, requireModulo('recursos'), sectionGuard('admin'));
//
// El superadmin NO es excepción acá, y es deliberado: no tiene escuela propia (school: null),
// así que no hay ningún School.modules contra el cual evaluar y la pantalla no tendría qué
// mostrar. Es la misma razón por la que `needsSchool` de config/sections.js le esconde Tema,
// Tareas y Plantillas — no es una restricción de privilegio, es no ofrecer una puerta que da
// a una pared. Para ver el módulo de una escuela concreta tiene la impersonación
// (POST /admin/users/:id/impersonate).
const requireModulo = (id) => {
  if (!MODULOS_BY_ID[id]) {
    // Un id mal escrito dejaría la ruta abierta para siempre sin que nadie lo note. Que
    // reviente al arrancar el proceso, que es cuando se puede arreglar.
    throw new Error(`requireModulo: no existe el módulo "${id}" en config/modulos.js`);
  }
  return (req, res, next) =>
    moduloActivo(res.locals.school, id) ? next() : denegar(req, res);
};

module.exports = { requireModulo };
