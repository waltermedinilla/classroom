// Los dos barridos que verifican un árbol de código SIN ejecutarlo.
//
// Para qué. Antes de pushear hay que arrancar el árbol COMMITEADO (`git archive HEAD`), no la
// carpeta de trabajo — el 502 del 2026-08-29 fue un `require` a un archivo que existía solo en
// la copia local. Pero arrancarlo prueba únicamente los `require` del arranque: uno perezoso,
// adentro de un handler, no se ejecuta al levantar el server y se descubre recién cuando un
// usuario entra a esa pantalla. Estos dos barridos los miran todos, en segundos.
//
// El CLI que los usa es tools/verificar-arbol.js  (npm run verificar:arbol).

const fs = require('fs');
const path = require('path');
const Module = require('module');

// No se despliegan, o no corren en el server: sus require pueden apuntar a devDependencies.
const SOLO_DESARROLLO = ['tests', 'tools', 'docker'];

// Nada de esto es código propio del proyecto. Las carpetas que empiezan con punto se saltean
// todas: `.claude/worktrees/` guarda COPIAS enteras del repo, y sin este corte el barrido
// informa cada hallazgo repetido una vez por worktree, con rutas que no existen en el deploy.
const IGNORADAS = ['node_modules', 'uploads', 'backups'];
const seSaltea = (nombre) => nombre.startsWith('.') || IGNORADAS.includes(nombre);

function recorrer(dir, aceptar, alEncontrar) {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (seSaltea(entrada.name)) continue;
      recorrer(p, aceptar, alEncontrar);
    } else if (aceptar(entrada.name)) {
      alEncontrar(p);
    }
  }
}

// ── Barrido 1: toda referencia a un archivo propio existe ────────────────────
// Resuelve como resuelve Node: tal cual, con .js/.json, o carpeta con index.js.
function resuelveComoNode(desde, ref) {
  const abs = path.resolve(path.dirname(desde), ref);
  return [abs, abs + '.js', abs + '.json', path.join(abs, 'index.js')].some(c => fs.existsSync(c));
}

function revisarReferencias(raiz) {
  raiz = path.resolve(raiz);
  const faltantes = [];
  let jsVistos = 0, ejsVistos = 0, refsJs = 0, refsEjs = 0;

  recorrer(raiz, n => n.endsWith('.js') || n.endsWith('.ejs'), (archivo) => {
    const src = fs.readFileSync(archivo, 'utf8');
    const rel = path.relative(raiz, archivo).replace(/\\/g, '/');

    // Los tests quedan afuera de ESTE barrido —no del de paquetes— por una razón concreta: un
    // test que arma un árbol de mentira escribe `require('../models/SoeRequest')` como TEXTO,
    // y el barrido no puede distinguir ese literal de uno de verdad. Además, un test que
    // referencia un módulo borrado no llega a producción: lo grita `npm run test:unit`.
    if (rel.startsWith('tests/')) return;

    if (archivo.endsWith('.js')) {
      jsVistos++;
      for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        refsJs++;
        if (!resuelveComoNode(archivo, m[1])) faltantes.push({ archivo: rel, ref: m[1], tipo: 'require' });
      }
    } else {
      ejsVistos++;
      for (const m of src.matchAll(/include\(\s*['"]([^'"]+)['"]/g)) {
        refsEjs++;
        const ref = m[1];
        if (/^https?:/.test(ref)) continue;
        const desde = path.dirname(archivo);
        const views = path.join(raiz, 'views');
        // EJS resuelve relativo al archivo y también desde la raíz de views/.
        const candidatos = [
          path.resolve(desde, ref), path.resolve(desde, ref + '.ejs'),
          path.join(views, ref), path.join(views, ref + '.ejs'),
        ];
        if (!candidatos.some(c => fs.existsSync(c))) faltantes.push({ archivo: rel, ref, tipo: 'include' });
      }
    }
  });

  return { jsVistos, ejsVistos, refsJs, refsEjs, faltantes };
}

// ── Barrido 2: todo paquete requerido está declarado en package.json ─────────
// El junction a node_modules (o el node_modules de tu máquina) esconde este agujero: un
// paquete que está instalado por ser transitivo, o a mano, anda en local y NO lo trae el
// `npm install --omit=dev` del VPS. El server muere al arrancar y PM2 reintenta en loop.
function nombreDePaquete(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

function revisarDependencias(raiz) {
  raiz = path.resolve(raiz);
  const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  const declaradas = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ]);
  const builtin = new Set(Module.builtinModules);
  const porPaquete = new Map();
  let vistos = 0, refs = 0;

  recorrer(raiz, n => n.endsWith('.js'), (archivo) => {
    // public/ es JS de navegador: no tiene require de Node.
    const rel = path.relative(raiz, archivo).replace(/\\/g, '/');
    if (rel.startsWith('public/')) return;
    vistos++;
    const esDeDesarrollo = SOLO_DESARROLLO.some(d => rel.startsWith(d + '/'));
    const src = fs.readFileSync(archivo, 'utf8');

    for (const m of src.matchAll(/require\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g)) {
      const spec = m[1];
      // `require('${APP_DIR}/package.json')` es texto de shell dentro del deployCmd de
      // server.js, no un require de verdad. Cualquier interpolación se descarta igual.
      if (spec.includes('${')) continue;
      refs++;
      const nombre = nombreDePaquete(spec);
      if (nombre.startsWith('node:') || builtin.has(nombre) || declaradas.has(nombre)) continue;
      if (!porPaquete.has(nombre)) porPaquete.set(nombre, []);
      porPaquete.get(nombre).push({ archivo: rel, esDeDesarrollo });
    }
  });

  const sinDeclarar = [...porPaquete].map(([nombre, usos]) => ({
    nombre,
    usos,
    seDespliega: usos.some(u => !u.esDeDesarrollo),
    // Distingue las dos gravedades. Si el paquete NO resuelve, el deploy muere seguro. Si
    // resuelve sin estar declarado es porque llega transitivo (a `mongodb` lo traen mongoose y
    // connect-mongo): anda hoy, pero se rompe el día que esa dependencia intermedia lo suelte.
    resuelveHoy: resuelvePaquete(raiz, nombre),
  }));

  return { vistos, refs, declaradas: declaradas.size, sinDeclarar };
}

function resuelvePaquete(raiz, nombre) {
  try {
    require.resolve(nombre, { paths: [raiz] });
    return true;
  } catch {
    // package.json sin "exports" del subpath, paquete solo-tipos, etc.: si la carpeta está,
    // npm lo instaló igual.
    return fs.existsSync(path.join(raiz, 'node_modules', nombre));
  }
}

module.exports = {
  revisarReferencias, revisarDependencias, resuelvePaquete, nombreDePaquete, SOLO_DESARROLLO,
};
