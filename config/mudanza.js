// Cartel de mudanza: la plataforma se mudó de servidor y esta instalación ya no es la buena.
//
// Se prende poniendo MUDANZA_URL en el .env con la dirección NUEVA, y recargando los workers
// (`pm2 reload classroom --update-env`). Sin esa variable, todo este archivo no hace nada:
// se despliega apagado y no cambia el comportamiento de nadie.
//
// Por qué una variable de entorno y no un archivo de estado como maintenance.json: el modo
// mantenimiento se prende y se apaga seguido desde el panel, así que necesita algo que se
// pueda tocar en caliente. La mudanza pasa UNA vez en la vida del servidor y es definitiva —
// conviene que requiera entrar por SSH y sea imposible de disparar por accidente desde una
// pantalla.
//
// ⚠️ NO es lo mismo que el modo mantenimiento y no hay que reemplazarlo por él: mantenimiento
// dice "volvemos en un rato" y hace esperar; la mudanza dice "ya no es acá" y manda a otro
// lado. Prometer una vuelta que no va a pasar es peor que no poner nada.

// Rutas que siguen funcionando aunque la mudanza esté prendida.
//
// `/deploy` es la más importante y la menos obvia: es el webhook que aplica los despliegues.
// Si lo tapáramos, este mismo servidor quedaría sin forma de recibir un cambio que APAGUE la
// mudanza, y haría falta entrar por SSH sí o sí. Es la escalera que uno deja apoyada antes de
// subir al techo.
//
// `/health` queda afuera para que el watchdog y cualquier monitor externo puedan seguir
// distinguiendo "la app está viva" de "la app se cayó" después de la mudanza.
const RUTAS_EXENTAS = ['/health', '/deploy', '/favicon.png', '/Logo.jpg'];
const PREFIJOS_EXENTOS = ['/css/', '/js/'];

// La dirección nueva, o null si la mudanza está apagada. Se normaliza sin barra final para
// poder concatenarle el path del visitante sin generar '//'.
function destinoMudanza(env = process.env) {
  const url = (env.MUDANZA_URL || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null; // una URL sin esquema no redirige a ningún lado
  return url.replace(/\/+$/, '');
}

// ¿Esta ruta sigue atendiéndose normalmente aunque la mudanza esté prendida?
function estaExenta(path) {
  if (RUTAS_EXENTAS.includes(path)) return true;
  return PREFIJOS_EXENTOS.some(p => path.startsWith(p));
}

// A dónde mandamos a quien entró por la dirección vieja.
//
// Se conserva el path: quien tenía guardado el enlace a una materia aterriza en esa misma
// materia del servidor nuevo, no en la portada. Si no tiene sesión allá, el propio servidor
// nuevo lo manda al login — que es lo que ya hace con cualquier visitante.
//
// La query se descarta a propósito: puede traer tokens de un solo uso emitidos por ESTE
// servidor, que en el nuevo no valen y solo generan un error confuso.
function urlDestino(destino, path) {
  const limpio = typeof path === 'string' && path.startsWith('/') ? path : '/';
  return destino + limpio;
}

module.exports = { destinoMudanza, estaExenta, urlDestino, RUTAS_EXENTAS };
