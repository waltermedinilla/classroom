// El proceso de medios: WebSocket de señalización + una API local mínima para Express.
//
// Arranca con `node media/servidor.js` o, en producción, como la app `classroom-media` de
// ecosystem.config.js — PM2 en modo FORK con instancia única. Ver D2: los routers de mediasoup
// viven en la memoria de UN proceso, así que esto no puede correr en cluster.
//
// ⚠️ ESTE PROCESO NO TIENE ACCESO A MONGO Y NO DEBE TENERLO (D4). No sabe quién es docente, ni
// qué alumno está en qué curso: solo verifica la firma del ticket que le dio Express. Si algún
// día necesita consultar la base, es que una regla de permisos se filtró donde no va.

require('dotenv').config();

const http = require('http');
const jwt  = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const sfu   = require('./sfu');
const aforo = require('./aforo');
const { MEDIA_PORT, WS_PATH, MAX_PULSACION_MS } = require('../config/transmision');

const log = {
  info:  (...a) => console.log(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

if (!process.env.JWT_SECRET) {
  log.error('[medios] falta JWT_SECRET: sin él no se puede verificar ningún ticket. Salgo.');
  process.exit(1);
}

// ⭐ Sin una IP anunciable NO se arranca, y esto es deliberado.
//
// Arrancar igual sería peor que no arrancar: la señalización andaría perfecto, los productores
// se crearían, la aplicación diría "transmitiendo" y NO VIAJARÍA UN SOLO BYTE, sin un error en
// ningún log. Ver el comentario largo de RTC_ANNOUNCED_IP en config/transmision.js.
{
  const { RTC_LISTEN_IP, RTC_ANNOUNCED_IP } = require('../config/transmision');
  const escuchaEnTodas = RTC_LISTEN_IP === '0.0.0.0' || RTC_LISTEN_IP === '::';
  if (escuchaEnTodas && !RTC_ANNOUNCED_IP) {
    log.error('[medios] no se pudo determinar la IP para anunciar en los candidatos ICE.');
    log.error('[medios] Sin ella la transmisión parecería funcionar y no viajaría ningún byte.');
    log.error('[medios] Arreglo: poner RTC_ANNOUNCED_IP=<la IP pública> en el .env. Salgo.');
    process.exit(1);
  }
}

// ── API local para Express ───────────────────────────────────────────────────
//
// Escucha SOLO en 127.0.0.1. No hay autenticación y no hace falta: quien puede hablarle a este
// puerto ya está adentro de la máquina. Exponerlo a internet sería otra cosa, y por eso el
// listen de más abajo fija la interfaz explícitamente.

const api = http.createServer((req, res) => {
  const responder = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/estado') {
    return responder(200, sfu.estado());
  }

  if (req.method === 'GET' && req.url === '/health') {
    return responder(200, { status: 'ok', clases: sfu.salas.size });
  }

  if (req.method === 'POST' && req.url === '/cerrar') {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; if (cuerpo.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { sessionId } = JSON.parse(cuerpo || '{}');
        const cerrada = sfu.cerrarSala(sessionId);
        responder(200, { ok: true, cerrada });
      } catch (e) { responder(400, { error: 'cuerpo inválido' }); }
    });
    return undefined;
  }

  // Hablar: volver a "Solo yo hablo" corta a los alumnos EN EL ACTO (H8 de
  // specs/sala-hablar.spec.md). El ticket se verifica al conectar y no en cada paquete, así que
  // sin esto un alumno que ya estaba hablando seguiría hablando hasta que se le venza.
  if (req.method === 'POST' && req.url === '/cerrar-voces') {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; if (cuerpo.length > 4096) req.destroy(); });
    req.on('end', () => {
      let sessionId, uid;
      try { ({ sessionId, uid } = JSON.parse(cuerpo || '{}')); }
      catch (e) { return responder(400, { error: 'cuerpo inválido' }); }
      const sala = sfu.salas.get(String(sessionId));
      // Con `uid`, solo la de ese alumno: es lo que usa "silenciar" (silenciado = silenciado
      // entero, también la voz). Sin `uid`, la de todos: "Solo yo hablo".
      return responder(200, { ok: true, cerradas: sala ? cerrarVoces(sala, uid) : 0 });
    });
    return undefined;
  }

  return responder(404, { error: 'no existe' });
});

// ── WebSocket de señalización ────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

// ws → contexto de la conexión. Lo necesita /cerrar-voces para saber de quién es cada
// conexión que escucha (y quitarle el permiso de su ticket aunque todavía no haya producido).
const conexiones = new Map();

api.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith(WS_PATH)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const enviar = (ws, t, datos = {}) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t, ...datos }));
};

// ── Hablar: las voces de los alumnos ────────────────────────────────────────
//
// Ver specs/sala-hablar.spec.md. El alumno con "Todos pueden hablar" trae un ticket con
// `emitir: 'audio'`: produce SOLO audio, y su productor nace PAUSADO. Suena mientras aprieta el
// botón (`hablar` / `callar`), con un tope de voces por sala (media/aforo.js → hayLugar) y un
// máximo por pulsación. Quién habla vive ACÁ y no en Mongo: una pulsación es un momento.

// Todos los que están en la sala: los que escuchan y quien da la clase.
function todosEn(sala) {
  const lista = [...sala.espectadores];
  if (sala.emisor) lista.push(sala.emisor);
  return lista;
}

const avisarSala = (sala, t, datos) => { for (const ws of todosEn(sala)) enviar(ws, t, datos); };

const hablandoEn = (sala) => [...sala.vocesAlumnos.values()].filter(c => c.hablando).length;

// Corta la pulsación de un alumno (soltó, se pasó del máximo, o se cerró la voz).
async function dejarDeHablar(cx, motivo) {
  if (!cx.hablando) return false;
  cx.hablando = false;
  clearTimeout(cx.relojVoz);
  cx.relojVoz = null;
  try { if (cx.voz && !cx.voz.closed) await cx.voz.pause(); } catch (e) { /* ya se cerró */ }
  if (motivo) enviar(cx.ws, 'teCallaron', { motivo });
  avisarSala(cx.sala, 'hablando', { uid: cx.ticket.uid, nom: cx.ticket.nom || '', on: false });
  return true;
}

// Saca la voz de un alumno de la sala: cierra su productor y avisa que se fue.
function quitarVoz(cx) {
  const p = cx.voz;
  cx.voz = null;
  cx.sala.vocesAlumnos.delete(cx.ws);
  if (!p) return;
  cx.sala.productores.delete(p.id);
  try { p.close(); } catch (e) { /* ya estaba cerrado */ }
  for (const ws of todosEn(cx.sala)) if (ws !== cx.ws) enviar(ws, 'productorSeFue', { id: p.id });
}

// "Solo yo hablo": cierra las voces de TODOS los alumnos de la sala. El docente sigue. Esas
// conexiones pierden el permiso de producir: para volver a hablar necesitan un ticket nuevo,
// que es donde Express vuelve a decidir (D4).
function cerrarVoces(sala, uid = null) {
  const esDeEl = (cx) => !uid || String(cx.ticket?.uid) === String(uid);
  const motivo = uid ? 'silenciado' : 'voz-cerrada';

  let cerradas = 0;
  for (const cx of [...sala.vocesAlumnos.values()]) {
    if (!esDeEl(cx)) continue;
    if (cx.hablando) dejarDeHablar(cx, motivo);
    quitarVoz(cx);
    cx.emiteAudio = false;
    cerradas += 1;
  }
  // A los alumnos afectados, tengan voz o no: el botón de pulsar se les apaga ya, sin esperar
  // el poll — que además está cortado si el chico está en otra solapa haciendo la actividad.
  // Las conexiones que nunca produjeron también pierden el permiso de su ticket.
  for (const ws of sala.espectadores) {
    const cx = conexiones.get(ws);
    if (cx && !esDeEl(cx)) continue;
    if (cx) cx.emiteAudio = false;
    enviar(ws, 'modoVoz', { abierta: false });
  }
  return cerradas;
}

// Le recalcula la capa a TODAS las salas cuando cambia el aforo.
//
// Se llama en cada alta y baja de espectador porque el gobernador razona sobre el TOTAL de la
// escuela, no sobre un aula: un alumno que entra en 2°3° puede bajarle la calidad a 5°1°. Es
// exactamente lo que tiene que pasar — el puerto es uno solo.
async function revisarAforo() {
  const e = sfu.estado();
  const d = aforo.decidir(e.espectadores, { clases: e.clases });
  if (!d.capa) return d;

  for (const sala of sfu.salas.values()) {
    if (sala.capaVigente === d.capa) continue;

    // ⚠️ La PRIMERA asignación no es un cambio: es el valor inicial de la sala. Avisarlo le
    // mostraría "cambió tu calidad" a todo el que entra, incluida la primera persona de una
    // escuela vacía — un aviso que no describe nada y que entrena a la gente a ignorarlos.
    // El valor inicial ya viaja en el 'bienvenido'.
    const esElPrimero = sala.capaVigente === undefined;
    sala.capaVigente = d.capa;
    await sfu.aplicarCapa(sala, d.capa);
    if (esElPrimero) continue;

    // Se le avisa a todo el mundo en la sala, no solo al docente: el alumno también tiene
    // derecho a saber por qué se le puso borrosa la pantalla.
    const aviso = { capa: d.capa, motivo: d.motivo, mensaje: d.mensaje };
    for (const ws of sala.espectadores) enviar(ws, 'capaCambiada', aviso);
    if (sala.emisor) enviar(sala.emisor, 'capaCambiada', aviso);
  }
  return d;
}

wss.on('connection', (ws) => {
  // Lo que sabemos de esta conexión. Se llena en el 'hola' y NO se cree nada de lo que el
  // navegador diga después: el ticket es la única fuente.
  const cx = {
    ws, sala: null, ticket: null, transportes: new Set(), esEmisor: false,
    // Hablar: puede producir SOLO una voz, que nace pausada (ticket con emitir: 'audio').
    emiteAudio: false, voz: null, hablando: false, relojVoz: null,
  };
  conexiones.set(ws, cx);

  // ⭐ Los mensajes de UNA conexión se atienden DE A UNO, en orden.
  //
  // EL BUG QUE ESTO EVITA: 'hola' es asincrónico (crea el router de la sala), así que un
  // cliente que mande 'hola' y 'crearTransporte' seguidos —lo normal, van en el mismo tick—
  // entraba al segundo handler antes de que el primero hubiera dejado `cx.sala`, y se comía un
  // "falta el saludo" siendo un cliente perfectamente correcto. Lo encontró
  // tests/unit/mediaServidor.test.js.
  //
  // La cadena de promesas es todo lo que hace falta: cada mensaje espera al anterior. No hay
  // riesgo de que crezca sin control porque el orden de magnitud son diez mensajes por
  // conexión, en el arranque.
  let cola = Promise.resolve();
  ws.on('message', (crudo) => {
    cola = cola.then(() => atender(crudo)).catch((err) => {
      log.error('[medios] error no atrapado:', err.message);
    });
  });

  async function atender(crudo) {
    let m;
    try { m = JSON.parse(crudo); } catch (e) { return enviar(ws, 'error', { error: 'json inválido' }); }

    try {
      // ── hola: el único mensaje que se acepta sin sala ───────────────────
      if (m.t === 'hola') {
        let dat;
        try {
          dat = jwt.verify(m.ticket, process.env.JWT_SECRET);
        } catch (e) {
          // Firma mala o vencido: son lo mismo desde acá, y las dos significan "volvé a
          // pedirle un ticket a Express". No se renueva desde este proceso a propósito: es lo
          // que hace que revocarle el acceso a alguien surta efecto en 60 segundos.
          return enviar(ws, 'error', { error: 'ticket inválido o vencido', recuperable: true });
        }

        // Un segundo 'hola' en la MISMA conexión, con un ticket nuevo de la misma sala, renueva
        // los permisos sin cortar lo que se está escuchando. Es el camino del alumno que ya
        // escuchaba y a quien el docente le abre la voz: pide otro ticket a Express y lo manda
        // acá. Un ticket de OTRA sala por la misma conexión no se acepta.
        if (cx.sala) {
          if (String(dat.sid) !== cx.sala.id) {
            return enviar(ws, 'error', { error: 'ese ticket es de otra sala' });
          }
          cx.ticket     = dat;
          cx.emiteAudio = dat.emitir === 'audio';
          return enviar(ws, 'permisos', { emitir: dat.emitir, video: dat.video === true });
        }

        cx.ticket     = dat;
        cx.esEmisor   = dat.emitir === true;
        cx.emiteAudio = dat.emitir === 'audio';
        cx.sala       = await sfu.salaDe(dat.sid);

        if (cx.esEmisor) {
          cx.sala.emisor = ws;
          // El docente que entra por "Hablar" no trae video: la sala es de solo voz y sus
          // oyentes no cuentan para el gobernador del video (ver sfu.estado()).
          if (dat.rol !== 'student') cx.sala.soloVoz = dat.video !== true;
        } else {
          cx.sala.espectadores.add(ws);
          cx.sala.picoEspectadores = Math.max(cx.sala.picoEspectadores, cx.sala.espectadores.size);
        }

        const d = await revisarAforo();

        return enviar(ws, 'bienvenido', {
          rtpCapabilities: cx.sala.router.rtpCapabilities,
          emitir: dat.emitir === 'audio' ? 'audio' : cx.esEmisor,
          video:  dat.video === true,
          capa:   d.capa || '180p',
          // Los productores que YA están al aire, para que un alumno que llega tarde vea la
          // clase que empezó hace veinte minutos sin esperar a que el docente vuelva a publicar.
          productores: [...cx.sala.productores.values()].map(p => ({ id: p.id, kind: p.kind })),
        });
      }

      // A partir de acá hace falta haber saludado.
      if (!cx.sala) return enviar(ws, 'error', { error: 'falta el saludo' });

      // ── transporte ──────────────────────────────────────────────────────
      if (m.t === 'crearTransporte') {
        const { transporte, parametros } = await sfu.crearTransporte(cx.sala);
        cx.transportes.add(transporte.id);
        return enviar(ws, 'transporte', { proposito: m.proposito, parametros });
      }

      if (m.t === 'conectarTransporte') {
        const tr = cx.sala.transportes.get(m.transportId);
        if (!tr || !cx.transportes.has(m.transportId)) {
          return enviar(ws, 'error', { error: 'transporte desconocido' });
        }
        await tr.connect({ dtlsParameters: m.dtlsParameters });
        return enviar(ws, 'transporteListo', { transportId: m.transportId });
      }

      // ── producir: solo quien el TICKET dice que puede ───────────────────
      if (m.t === 'producir') {
        // ⭐ Acá se apoya toda la seguridad de la feature. El navegador puede pedir lo que
        // quiera; lo que decide es el ticket que firmó Express, y un alumno sin la palabra
        // simplemente no tiene uno con `emitir`.
        if (!cx.esEmisor && !cx.emiteAudio) {
          return enviar(ws, 'error', { error: 'no tenés permiso para transmitir' });
        }
        // La voz del alumno es SOLO voz, diga lo que diga el ticket sobre el video.
        if (m.kind === 'video' && (cx.emiteAudio || cx.ticket.video !== true)) {
          return enviar(ws, 'error', { error: 'no tenés permiso para transmitir video' });
        }
        if (cx.emiteAudio && m.kind !== 'audio') {
          return enviar(ws, 'error', { error: 'solo se puede transmitir la voz' });
        }
        if (cx.emiteAudio && cx.voz) {
          return enviar(ws, 'error', { error: 'ya tenés el micrófono listo' });
        }

        const tr = cx.sala.transportes.get(m.transportId);
        if (!tr || !cx.transportes.has(m.transportId)) {
          return enviar(ws, 'error', { error: 'transporte desconocido' });
        }

        const p = await tr.produce({
          kind: m.kind,
          rtpParameters: m.rtpParameters,
          appData: { uid: cx.ticket.uid, fuente: m.fuente || '' },
          // H3: la voz del alumno nace CALLADA y suena solo mientras aprieta el botón.
          paused: cx.emiteAudio,
        });
        cx.sala.productores.set(p.id, p);
        if (cx.emiteAudio) {
          cx.voz = p;
          cx.sala.vocesAlumnos.set(ws, cx);
        }

        p.on('transportclose', () => {
          cx.sala.productores.delete(p.id);
          if (cx.voz === p) { cx.voz = null; cx.sala.vocesAlumnos.delete(ws); }
          for (const e of todosEn(cx.sala)) if (e !== ws) enviar(e, 'productorSeFue', { id: p.id });
        });

        // Se le avisa a todos los demás. También a quien da la clase: con "Todos pueden hablar"
        // el docente tiene que escuchar a los alumnos.
        for (const e of todosEn(cx.sala)) {
          if (e !== ws) enviar(e, 'productorNuevo', { id: p.id, kind: p.kind, fuente: m.fuente || '' });
        }
        return enviar(ws, 'produciendo', { id: p.id, kind: p.kind, pausado: cx.emiteAudio });
      }

      // ── hablar / callar: pulsar para hablar (Hablar, H3 y H4) ───────────
      if (m.t === 'hablar') {
        if (!cx.emiteAudio || !cx.voz || cx.voz.closed) {
          return enviar(ws, 'error', { error: 'no tenés el micrófono habilitado en esta sala' });
        }
        // Idempotente: el doble toque y el reintento son lo normal en un celular, y apretar
        // dos veces no puede ocupar dos lugares.
        if (cx.hablando) return enviar(ws, 'hablarOk', {});

        if (!aforo.hayLugar(hablandoEn(cx.sala), false)) {
          cx.sala.rechazadasPorTope += 1;
          return enviar(ws, 'lleno', {
            mensaje: 'Esperá un momento: ya están hablando dos compañeros.',
          });
        }

        // ⚠️ Se marca ANTES del await: los mensajes de conexiones distintas se atienden en
        // paralelo, y si dos alumnos aprietan a la vez los dos verían "hay lugar" durante el
        // resume. Marcar primero hace que el segundo ya cuente al primero.
        cx.hablando = true;
        try { await cx.voz.resume(); }
        catch (e) { cx.hablando = false; return enviar(ws, 'error', { error: 'no se pudo abrir el micrófono' }); }

        cx.sala.alumnosQueHablaron.add(String(cx.ticket.uid));
        // La defensa contra el touchend perdido: ninguna pulsación dura más que esto.
        cx.relojVoz = setTimeout(() => { dejarDeHablar(cx, 'tiempo').catch(() => {}); }, MAX_PULSACION_MS);

        avisarSala(cx.sala, 'hablando', { uid: cx.ticket.uid, nom: cx.ticket.nom || '', on: true });
        return enviar(ws, 'hablarOk', {});
      }

      if (m.t === 'callar') {
        await dejarDeHablar(cx, null);
        return enviar(ws, 'callado', {});
      }

      // ── consumir ────────────────────────────────────────────────────────
      if (m.t === 'consumir') {
        const tr = cx.sala.transportes.get(m.transportId);
        if (!tr || !cx.transportes.has(m.transportId)) {
          return enviar(ws, 'error', { error: 'transporte desconocido' });
        }
        const r = await sfu.crearConsumidor(cx.sala, tr, m.producerId, m.rtpCapabilities);
        if (!r) return enviar(ws, 'error', { error: 'no se puede consumir ese flujo' });
        return enviar(ws, 'consumiendo', { parametros: r.parametros });
      }

      if (m.t === 'reanudar') {
        const c = cx.sala.consumidores.get(m.consumerId);
        if (c) await c.resume();
        return enviar(ws, 'reanudado', { consumerId: m.consumerId });
      }

      return enviar(ws, 'error', { error: 'mensaje desconocido' });
    } catch (err) {
      log.error('[medios]', m.t, err.message);
      return enviar(ws, 'error', { error: 'no se pudo completar la operación' });
    }
  }

  ws.on('close', async () => {
    conexiones.delete(ws);
    if (!cx.sala) return;

    // Si estaba hablando, se avisa que dejó de hablar: el indicador no puede quedar prendido
    // con el nombre de alguien que ya se fue.
    if (cx.hablando) await dejarDeHablar(cx, null).catch(() => {});
    clearTimeout(cx.relojVoz);
    cx.sala.vocesAlumnos.delete(ws);

    cx.sala.espectadores.delete(ws);
    if (cx.sala.emisor === ws) cx.sala.emisor = null;

    // Los transportes de esta conexión se cierran con ella. Sin esto, los puertos UDP quedarían
    // tomados hasta que mediasoup los recolecte, y son 200 en total.
    for (const id of cx.transportes) {
      const tr = cx.sala.transportes.get(id);
      if (tr) { try { tr.close(); } catch (e) {} cx.sala.transportes.delete(id); }
    }

    // Una sala sin emisor y sin espectadores no tiene por qué seguir existiendo.
    if (!cx.sala.emisor && cx.sala.espectadores.size === 0) sfu.cerrarSala(cx.sala.id);

    await revisarAforo().catch(() => {});
  });
});

// ── Arranque ─────────────────────────────────────────────────────────────────

(async () => {
  try {
    const n = await sfu.iniciar(log);
    // El chequeo de R3: si el rango UDP está cerrado en ufw, la señalización va a andar
    // perfecto y NO VA A HABER AUDIO — el síntoma más difícil de diagnosticar de todos. Que
    // quede escrito en el log al arrancar es la mitad del diagnóstico futuro.
    const { RTC_MIN_PORT, RTC_MAX_PORT } = require('../config/transmision');
    const { RTC_ANNOUNCED_IP, RTC_LISTEN_IP } = require('../config/transmision');
    log.info(`[medios] ${n} workers de mediasoup listos`);
    // Que la IP anunciada quede escrita en el arranque es la mitad del diagnóstico del día que
    // "se ve que transmite y no se escucha nada".
    log.info(`[medios] escucho en ${RTC_LISTEN_IP} y ANUNCIO ${RTC_ANNOUNCED_IP || '(la misma)'}`);
    if (!process.env.RTC_ANNOUNCED_IP) {
      const { ipsCandidatas } = require('../config/transmision');
      log.info(`[medios] la elegí sola entre: ${ipsCandidatas().join(', ')}`);
      log.info('[medios] si es la equivocada no va a viajar audio: fijá RTC_ANNOUNCED_IP en el .env.');
    }
    log.info(`[medios] el media viaja por UDP ${RTC_MIN_PORT}-${RTC_MAX_PORT} y TCP como red.`);
    log.info('[medios] si hay señalización pero no hay audio, mirá ufw ANTES que WebRTC.');

    api.listen(MEDIA_PORT, '127.0.0.1', () => {
      log.info(`[medios] escuchando en 127.0.0.1:${MEDIA_PORT}, WebSocket en ${WS_PATH}`);
    });
  } catch (err) {
    log.error('[medios] no se pudo arrancar:', err.message);
    process.exit(1);
  }
})();

// Cierre ordenado: PM2 manda SIGINT antes de matar. Cerrar los routers a mano les avisa a los
// navegadores en vez de dejarlos esperando un flujo que ya no viene.
for (const señal of ['SIGINT', 'SIGTERM']) {
  process.on(señal, () => {
    log.info(`[medios] ${señal}: cerrando ${sfu.salas.size} salas`);
    for (const id of [...sfu.salas.keys()]) sfu.cerrarSala(id);
    process.exit(0);
  });
}
