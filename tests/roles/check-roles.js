#!/usr/bin/env node
// Verificador de las configuraciones básicas de CADA ROL.
// Uso: npm run test:roles    (con el server local levantado)
//
// Complementa al smoke: aquel recorre FLUJOS (crear una materia, entregar, calificar);
// este recorre la MATRIZ de roles × pantallas y confirma que cada rol ve exactamente lo
// que tiene que ver, ni una solapa más ni una menos.
//
// Lo que lo hace distinto de mirar el catálogo a ojo: cada rol se deja CONFIGURADO como en
// la vida real antes de evaluarlo — el preceptor con una división a cargo, el jefe con una
// sección, el docente con una materia propia y el alumno matriculado en ella. Sin eso, el
// preceptor y el jefe caen en la vista `no-scope` (que no tiene nav, y es correcto que no
// lo tenga) y medio panel parece roto sin estarlo.
//
// Los 7 pasos:
//   1. Alta, login y configuración del alcance de cada rol.
//   2. Redirect de "/": cada rol tiene que aterrizar en SU panel (server.js).
//   3. Matriz de acceso: GET a todas las secciones de config/sections.js. 200 donde el rol
//      figura en `roles` (que es el espejo de los middlewares de rol) y bloqueo en el resto.
//      Un 200 de más es una FUGA de permisos; un bloqueo de más, algo ROTO. Única excepción
//      documentada: el panel del SOE, donde la puerta la abre School.soeAccess y no el
//      catálogo (ver el comentario en el paso 3).
//   4. Menú: el <nav> del panel (o el drawer del header, para docente y alumno) pinta
//      exactamente las solapas permitidas. Replica la lógica de res.locals.can.
//   5. El header muestra el rol EN ESPAÑOL (res.locals.roleNames).
//   6. Toggle de /superadmin/roles: denegar una solapa la saca del nav Y devuelve 403 por
//      URL directa; reponerla la devuelve. Siempre restaura lo que tocó.
//   7. Limpieza: borra todo lo que creó (usuarios, materia, sección, división).
//
// Env vars: las mismas de tests/smoke (SMOKE_ADMIN_EMAIL/PASSWORD obligatorias,
// SMOKE_SUPERADMIN_EMAIL/PASSWORD para los pasos 6 y el chequeo del superadmin).
// Corre SOLO contra localhost: crea y borra datos reales a través de la API.
require('dotenv').config();
try { require('dotenv').config({ path: '.env.test', override: true }); } catch {}

const { SmokeClient } = require('../smoke/lib');
const { SECTIONS, isAllowed } = require('../../config/sections');
// Módulos opcionales por escuela: la solapa de un módulo apagado no tiene que pintarse.
const { MODULOS } = require('../../config/modulos');

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE)) {
  console.error(`\nBASE_URL "${BASE}" no es local. Este chequeo crea y borra usuarios reales.\n`);
  process.exit(1);
}

const RUN  = Date.now().toString(36);
const PASS = 'RolCheck1234';
const c = new SmokeClient(BASE);

// El superadmin no se crea (no se puede desde el panel de admin, y es único): se usa el
// del .env si está.
const ROLES = ['admin', 'directivo', 'preceptor', 'jefe', 'soe', 'teacher', 'student'];

// `soe` pasó a tener panel propio el 2026-08-18 (specs/soe-orientacion.spec.md). Antes
// aterrizaba en /courses con las solapas generales, como un docente sin materias.
const LANDING = {
  superadmin: '/superadmin', admin: '/admin', directivo: '/directivo', preceptor: '/preceptor',
  jefe: '/jefatura', soe: '/soe', teacher: '/courses', student: '/courses',
};
const PANEL_DE = {
  superadmin: 'superadmin', admin: 'admin', directivo: 'directivo', preceptor: 'preceptor',
  jefe: 'jefatura', soe: 'soe', teacher: 'app', student: 'app',
};
const ROL_ES = {
  superadmin: 'Superadministrador', admin: 'Administrador', directivo: 'Directivo',
  teacher: 'Docente', preceptor: 'Preceptor', jefe: 'Jefe de Sección', soe: 'SOE', student: 'Alumno',
};

const hallazgos = [];
const anotar = (tipo, rol, detalle) => hallazgos.push({ tipo, rol, detalle });
const linea  = (rol, txt) => console.log(`   ${String(rol).padEnd(11)} ${txt}`);

// Los links que el usuario REALMENTE ve en el menú: el <nav> del panel, o el drawer del
// header para los roles sin panel propio. Mirar el HTML entero daría falsos positivos —
// los dashboards linkean a sus propias secciones desde las tarjetas del cuerpo.
function linksVisibles(html, panel) {
  if (panel === 'app') {
    return [...(html.matchAll(/<a href="([^"]+)" class="drawer-item"/g))].map(m => m[1]);
  }
  // admin y superadmin usan "admin-nav admin-nav-2filas"; el resto, "admin-nav" a secas.
  const nav = (html.match(/<nav class="admin-nav[^"]*">[\s\S]*?<\/nav>/) || [''])[0];
  return [...(nav.matchAll(/href="([^"]+)"/g))].map(m => m[1]);
}

// Espejo de res.locals.can (server.js): rol + permisos de la escuela + feature flag +
// needsSchool. Si esto y aquello se separan, el test deja de valer — por eso está acá al
// lado y no repartido por el archivo.
function deberiaVerla(sec, rol, escuela, tieneEscuela) {
  if (sec.flag === 'taskTemplatesEnabled' && process.env.TASK_TEMPLATES_ENABLED === 'false') return false;
  // Los flags que salen de config/modulos.js dependen de la ESCUELA, no del entorno: si el
  // módulo está apagado, la solapa NO se pinta y eso es lo correcto. Sin esta rama, cualquier
  // módulo opcional apagado se reportaría como "falta en el menú".
  const mod = MODULOS.find(m => m.localsKey === sec.flag);
  if (mod && !escuela.modules?.[mod.id]?.enabled) return false;
  if (sec.needsSchool && !tieneEscuela) return false;
  return isAllowed(escuela, rol, sec.key);
}

async function main() {
  const creados = [];
  let schoolId = null, divisionId = null, courseId = null, seccionId = null;

  try {
    if (!process.env.SMOKE_ADMIN_EMAIL) throw new Error('falta SMOKE_ADMIN_EMAIL en .env / .env.test');
    await c.post('admin0', '/login', {
      body: { email: process.env.SMOKE_ADMIN_EMAIL, password: process.env.SMOKE_ADMIN_PASSWORD }, expectStatus: 200,
    });
    const haySuper = !!process.env.SMOKE_SUPERADMIN_EMAIL;
    if (haySuper) {
      await c.post('superadmin', '/login', {
        body: { email: process.env.SMOKE_SUPERADMIN_EMAIL, password: process.env.SMOKE_SUPERADMIN_PASSWORD }, expectStatus: 200,
      });
    }

    // ── 1) Alta, login y alcance ─────────────────────────────────────────────
    console.log('\n1) Alta, login y configuración del alcance de cada rol\n');
    const div = await c.post('admin0', '/admin/divisions/create', { body: { name: `ROLCHK-${RUN}` }, expectStatus: 201 });
    divisionId = div.json.division._id;

    const actores = {};
    for (const [i, rol] of ROLES.entries()) {
      const email = `rolcheck.${rol}.${RUN}@example.com`;
      const r = await c.post('admin0', '/admin/users/create', {
        body: { name: `RolCheck ${ROL_ES[rol]}`, email, password: PASS, role: rol, dni: `77${String(Date.now()).slice(-5)}${i}` },
        expectStatus: 201,
      });
      creados.push(r.json.user._id);
      schoolId = schoolId || r.json.user.school;
      actores[rol] = { actor: `a_${rol}`, id: r.json.user._id, email, tieneEscuela: !!r.json.user.school };
      await c.post(actores[rol].actor, '/login', { body: { email, password: PASS }, expectStatus: 200 });
    }
    // El superadmin no tiene escuela propia: es justo lo que hace falta para verificar que
    // el nav de /admin no le ofrezca las pantallas por escuela (needsSchool).
    if (haySuper) actores.superadmin = { actor: 'superadmin', email: process.env.SMOKE_SUPERADMIN_EMAIL, tieneEscuela: false };
    else console.log('   superadmin  SIN PROBAR (falta SMOKE_SUPERADMIN_EMAIL)');

    await c.post('admin0', `/admin/users/${actores.preceptor.id}/divisions`, {
      body: { divisionIds: [divisionId], allDivisions: false }, expectStatus: 200,
    });
    // La materia la da de alta el ADMIN y le asigna el titular. Antes la creaba el propio
    // docente por POST /courses/create; desde el 2026-08-14 ese endpoint es lista blanca y
    // el docente quedó afuera (no crea materias ni cursos). El escenario no cambia: la
    // materia sigue quedando con el docente como titular, que es lo que el resto mide.
    const curso = await c.post('admin0', '/admin/courses/create', {
      body: {
        name: `Materia RolCheck ${RUN}`, divisionId,
        teacherId: actores.teacher.id, room: 'R1',
      },
      expectStatus: 201,
    });
    courseId = curso.json.course._id;
    await c.post(actores.teacher.actor, `/courses/${courseId}/add-student`, {
      body: { email: actores.student.email }, expectStatus: 200,
    });
    const sec = await c.post('admin0', '/admin/secciones/create', {
      body: { name: `Sección RolCheck ${RUN}`, divisionIds: [divisionId], courseIds: [], headIds: [actores.jefe.id] },
      expectStatus: 201,
    });
    seccionId = sec.json.seccion._id;

    for (const rol of Object.keys(actores)) {
      const extra = { preceptor: '+ 1 división a cargo', jefe: '+ 1 sección a cargo',
                      teacher: '+ 1 materia propia', student: '+ matriculado en la materia' }[rol] || '';
      linea(rol, `alta + login OK ${extra}`);
    }

    // ── 2) Redirect de "/" ───────────────────────────────────────────────────
    console.log('\n2) Redirect de "/" según el rol\n');
    for (const [rol, a] of Object.entries(actores)) {
      const r = await c.get(a.actor, '/');
      const dest = r.headers.get('location');
      const ok = r.status === 302 && dest === LANDING[rol];
      linea(rol, `${r.status} → ${dest || '(sin redirect)'} ${ok ? '✓' : `✗ esperaba ${LANDING[rol]}`}`);
      if (!ok) anotar('ROTO', rol, `GET / → ${r.status} ${dest}, esperaba 302 → ${LANDING[rol]}`);
    }

    // ── 3) Matriz de acceso ──────────────────────────────────────────────────
    console.log(`\n3) Acceso a las ${SECTIONS.length} secciones del catálogo\n`);
    for (const [rol, a] of Object.entries(actores)) {
      let ok = 0, fugas = 0, rotas = 0, err500 = 0; const notas = [];
      for (const s of SECTIONS) {
        const r = await c.get(a.actor, s.path);
        const abierto = r.status === 200;

        if (r.status >= 500) { err500++; anotar('ERROR', rol, `${s.path} → ${r.status}`); continue; }

        // Excepciones DOCUMENTADAS en el código, no fallas:
        //  - /activities/my-pending redirige a /courses si el rol no es alumno
        //    (routes/activities.js).
        //  - backup y otros están atados al email del dueño (config/maintenance.js).
        //  - las plantillas se apagan con TASK_TEMPLATES_ENABLED → 404 a propósito.
        //  - needsSchool: sin escuela propia esas pantallas no tienen qué mostrar. El nav
        //    ya no las ofrece (paso 4); por URL directa siguen contestando el error.
        if (s.key === 'app_pending' && rol !== 'student') {
          if (r.status === 302) ok++;
          else { rotas++; anotar('ROTO', rol, `${s.path} → ${r.status}, se esperaba 302 a /courses`); }
          continue;
        }
        if (!abierto && s.ownerOnly)                { ok++; notas.push(`${s.key}: ${r.status} (ownerOnly)`); continue; }
        // Un `flag` apagado bloquea de dos formas distintas según de dónde salga el flag, y
        // las dos son correctas:
        //   404 → flag GLOBAL de variable de entorno (taskTemplatesEnabled): server.js no
        //         monta el router, así que no hay ruta que contestar.
        //   403 → flag POR ESCUELA (config/modulos.js): el router está montado siempre y
        //         requireModulo rechaza, porque la escuela decide recién en el request.
        if (!abierto && s.flag && [403, 404].includes(r.status)) {
          ok++; notas.push(`${s.key}: ${r.status} (flag ${s.flag} apagado)`); continue;
        }
        if (!abierto && s.needsSchool && !a.tieneEscuela) {
          ok++; notas.push(`${s.key}: ${r.status} (needsSchool y este usuario no tiene escuela)`); continue;
        }

        // El panel del SOE es la ÚNICA excepción a la regla "figura en `roles` → entra".
        // `directivo` y `admin` están en el catálogo para que /superadmin/roles pueda
        // pintarles la celda, pero la puerta la abre School.soeAccess, que arranca en 'none'
        // para todos (models/School.js). Con una escuela recién creada —que es lo que arma
        // este chequeo— lo CORRECTO es que reciban 403.
        if (s.panel === 'soe' && !['soe', 'superadmin'].includes(rol)) {
          if (!abierto) { ok++; notas.push(`${s.key}: ${r.status} (soeAccess en 'none', el default)`); }
          else { fugas++; anotar('FUGA', rol, `${s.path} devolvió 200 sin que la escuela le diera soeAccess`); }
          continue;
        }

        // El panel 'app' son los accesos del menú lateral y, salvo excepción, los ve todo el
        // mundo: `app_courses` no lista al superadmin en `roles` y sin embargo entra.
        //
        // La excepción son las secciones de un MÓDULO opcional (las que declaran `flag`, ver
        // config/modulos.js): esas no son universales ni por asomo — reservar la sala de
        // computación es de quien da clase, no del alumno ni del gabinete. Ahí manda `roles`,
        // igual que en cualquier panel.
        const universal = s.panel === 'app' && !s.flag;
        const esperado = universal ? true : s.roles.includes(rol);
        if (abierto === esperado) { ok++; continue; }
        if (abierto) { fugas++; anotar('FUGA', rol, `${s.path} devolvió 200 y ese rol no debería entrar`); }
        else { rotas++; anotar('ROTO', rol, `${s.path} devolvió ${r.status} y ese rol sí debería entrar`); }
      }
      linea(rol, `${ok}/${SECTIONS.length} como se espera · fugas: ${fugas} · rotas: ${rotas} · 500: ${err500}`);
      notas.forEach(n => console.log(`               ${n}`));
    }

    // ── 4) Menú ──────────────────────────────────────────────────────────────
    console.log('\n4) Solapas del menú (espejo de res.locals.can)\n');
    // Qué módulos opcionales tiene prendidos ESTA escuela. Se MIDE contra el servidor en vez
    // de leerse de la base: un 403 en la primera sección del módulo es exactamente lo que
    // hace requireModulo cuando está apagado, así que la sonda mide lo mismo que el usuario
    // va a ver. `admin0` es el admin real de la escuela, con el que corre todo el chequeo.
    const modules = {};
    for (const m of MODULOS) {
      const primera = SECTIONS.find(s => s.key === m.secciones[0]);
      if (!primera) continue;
      const r = await c.get('admin0', primera.path);
      modules[m.id] = { enabled: r.status !== 403 };
    }
    const prendidos = MODULOS.filter(m => modules[m.id]?.enabled).map(m => m.id);
    console.log(`   módulos opcionales prendidos en esta escuela: ${prendidos.join(', ') || '(ninguno)'}
`);

    const escuela = { _id: schoolId, rolePermissions: {}, modules };
    for (const [rol, a] of Object.entries(actores)) {
      const home = await c.get(a.actor, LANDING[rol]);
      if (home.status !== 200) {
        linea(rol, `no se pudo leer ${LANDING[rol]} (${home.status})`);
        anotar('ROTO', rol, `su pantalla de inicio ${LANDING[rol]} devolvió ${home.status}`);
        continue;
      }
      const panel = PANEL_DE[rol];
      const links = linksVisibles(home.text || '', panel);
      const delPanel = SECTIONS.filter(s => s.panel === panel);
      let bien = 0; const mal = [];
      for (const s of delPanel) {
        const deberia = deberiaVerla(s, rol, escuela, a.tieneEscuela);
        // El drawer manda "Mis clases" a "/" (que redirige a /courses), no al path literal.
        const esta = links.includes(s.path) || (s.key === 'app_courses' && links.includes('/'));
        if (deberia === esta) bien++;
        else { mal.push(`${s.key}: ${esta ? 'visible de más' : 'falta'}`); anotar('NAV', rol, `${s.key} ${esta ? 'visible de más' : 'falta en el menú'}`); }
      }
      linea(rol, `${bien}/${delPanel.length} solapas correctas${mal.length ? ' · ' + mal.join(' · ') : ''}`);
    }

    // ── 4b) El superadmin visitando el panel de OTRO rol ─────────────────────
    // El superadmin entra a /admin (su rol está en `roles`), pero no tiene escuela: el nav
    // no puede ofrecerle Tema, Tareas ni Plantillas, que son por escuela y terminaban en
    // "Escuela no encontrada". Es el caso que motivó needsSchool.
    if (haySuper) {
      console.log('\n4b) El superadmin en /admin: sin solapas que den a una pared\n');
      const r = await c.get('superadmin', '/admin', { expectStatus: 200 });
      const links = linksVisibles(r.text || '', 'admin');
      const conPared = SECTIONS.filter(s => s.panel === 'admin' && s.needsSchool && links.includes(s.path));
      linea('superadmin', `${links.length} solapas · por escuela ofrecidas: ${conPared.length} ${conPared.length === 0 ? '✓' : '✗ ' + conPared.map(s => s.key).join(', ')}`);
      if (conPared.length) anotar('NAV', 'superadmin', `el nav de /admin le ofrece ${conPared.map(s => s.key).join(', ')} y esas pantallas necesitan escuela`);
      // Y las que SÍ funcionan sin escuela tienen que seguir estando.
      const utiles = ['/admin/users', '/admin/courses', '/admin/audit'].filter(p => !links.includes(p));
      if (utiles.length) anotar('NAV', 'superadmin', `desaparecieron del nav solapas que sí le sirven: ${utiles.join(', ')}`);
    }

    // ── 5) Rol en español ────────────────────────────────────────────────────
    console.log('\n5) El header muestra el rol en español\n');
    for (const [rol, a] of Object.entries(actores)) {
      const home = await c.get(a.actor, LANDING[rol]);
      const tiene = (home.text || '').includes(`>${ROL_ES[rol]}<`);
      linea(rol, `${tiene ? '✓' : '✗'} "${ROL_ES[rol]}"`);
      if (!tiene) anotar('I18N', rol, `el header no muestra "${ROL_ES[rol]}"`);
    }

    // ── 6) Toggle de permisos ────────────────────────────────────────────────
    console.log('\n6) Denegar y reponer solapas desde /superadmin/roles\n');
    if (!haySuper) console.log('   (salteado: falta SMOKE_SUPERADMIN_EMAIL)');
    else {
      const casos = [
        { rol: 'directivo', key: 'directivo_courses', path: '/directivo/courses' },
        { rol: 'admin',     key: 'admin_audit',       path: '/admin/audit' },
        { rol: 'preceptor', key: 'preceptor_envivo',  path: '/preceptor/en-vivo' },
        { rol: 'preceptor', key: 'preceptor_asistencia', path: '/preceptor/asistencia' },
        { rol: 'preceptor', key: 'preceptor_actividades', path: '/preceptor/actividades' },
        { rol: 'directivo', key: 'directivo_actividades', path: '/directivo/actividades-diarias' },
      ];
      for (const caso of casos) {
        const a = actores[caso.rol].actor;
        // Se prueba sobre una solapa que HOY esté habilitada: así reponerla no depende de
        // adivinar cómo estaba configurada la escuela antes de correr esto.
        const antes = await c.get(a, caso.path);
        if (antes.status !== 200) { console.log(`   ${caso.key}: ya venía denegada (${antes.status}) — no se toca`); continue; }

        await c.post('superadmin', '/superadmin/roles/toggle', {
          body: { schoolId, role: caso.rol, key: caso.key, enabled: false }, expectStatus: 200,
        });
        const bloqueada = await c.get(a, caso.path);
        const oculta = !linksVisibles((await c.get(a, LANDING[caso.rol])).text || '', PANEL_DE[caso.rol]).includes(caso.path);

        await c.post('superadmin', '/superadmin/roles/toggle', {
          body: { schoolId, role: caso.rol, key: caso.key, enabled: true }, expectStatus: 200,
        });
        const repuesta = await c.get(a, caso.path);
        const vuelve = linksVisibles((await c.get(a, LANDING[caso.rol])).text || '', PANEL_DE[caso.rol]).includes(caso.path);

        const ok = bloqueada.status === 403 && oculta && repuesta.status === 200 && vuelve;
        console.log(`   ${caso.key.padEnd(20)} denegada:${bloqueada.status} nav:${oculta ? 'oculta' : 'SIGUE VISIBLE'} · repuesta:${repuesta.status} nav:${vuelve ? 'vuelve' : 'NO VUELVE'} ${ok ? '✓' : '✗'}`);
        if (!ok) anotar('ROTO', caso.rol, `el toggle de ${caso.key} no se comportó como debe`);
      }
    }
  } finally {
    // ── 7) Limpieza ──────────────────────────────────────────────────────────
    // En finally: si algo falla a mitad de camino, los usuarios de prueba no quedan vivos
    // en la base. La materia va antes que el docente (el borrado de un titular da 409).
    console.log('\n7) Limpieza\n');
    const borrar = async (etiqueta, fn) => {
      try { await fn(); console.log(`   ${etiqueta} ✓`); }
      catch (e) { console.log(`   ${etiqueta} ✗ ${e.message}`); }
    };
    if (seccionId)  await borrar('sección',  () => c.post('admin0', `/admin/secciones/${seccionId}/delete`, { expectStatus: 200 }));
    if (courseId)   await borrar('materia',  () => c.post('admin0', `/admin/courses/${courseId}/delete`,    { expectStatus: [200, 204] }));
    let n = 0;
    for (const id of creados) {
      try { await c.post('admin0', `/admin/users/${id}/delete`, { expectStatus: [200, 204] }); n++; }
      catch (e) { console.log(`   usuario ${id}: ${e.message}`); }
    }
    console.log(`   ${n}/${creados.length} usuarios borrados`);
    if (divisionId) await borrar('división', () => c.post('admin0', `/admin/divisions/${divisionId}/delete`, { expectStatus: [200, 204] }));
  }

  console.log('\n' + '─'.repeat(72));
  if (!hallazgos.length) {
    console.log('SIN HALLAZGOS: cada rol se comporta como dice config/sections.js.');
  } else {
    console.log(`${hallazgos.length} hallazgo(s):\n`);
    for (const h of hallazgos) console.log(`  [${h.tipo}] ${h.rol}: ${h.detalle}`);
  }
  console.log('');
  // Solo una fuga de permisos o un 500 rompen la corrida. Un NAV o un I18N se reportan
  // pero no frenan un deploy: molestan, no dejan entrar a nadie donde no debe.
  process.exit(hallazgos.some(h => h.tipo === 'FUGA' || h.tipo === 'ERROR') ? 1 : 0);
}

main().catch(err => { console.error('\nError inesperado:', err.message); process.exit(1); });
