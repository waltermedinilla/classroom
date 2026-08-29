// Lógica de la sala en vivo de una materia: presencia, mensajes y el resumen que consumen
// los paneles de dirección y preceptoría.
//
// Todas las constantes de la feature viven ACÁ, con su fundamento al lado. Si alguna vez hay
// que aflojar el polling o cambiar la retención, se toca este archivo y nada más.
//
// La primera mitad son funciones PURAS (reciben `now`, no leen el reloj ni la base): son las
// que se testean en tests/unit/liveRoom.test.js. La segunda mitad toca Mongo.

const mongoose = require('mongoose');

const RoomSession  = require('../models/RoomSession');
const RoomMessage  = require('../models/RoomMessage');
const RoomPresence = require('../models/RoomPresence');

// ── Constantes ───────────────────────────────────────────────────────────────

// Cada cuánto pollea quien está DENTRO de la sala. 4 s es el equilibrio entre que la
// conversación se sienta viva y no fabricar tráfico: con 30 personas son ~7 req/s, dos
// queries indexadas cada una.
const POLL_MS = 4000;

// Cada cuánto se repintan las tarjetas de los paneles de supervisión. Mucho más lento a
// propósito: mirar qué clases hay en curso es supervisión, no conversación.
const DIRECTIVO_POLL_MS = 15000;

// "Conectado ahora". Son ~3 ciclos de poll: tolera una pestaña trabada o un WiFi que hipa
// sin sacar al chico de la lista de presentes.
const ONLINE_WINDOW_MS = 45 * 1000;

// La misma pregunta, pero para el PERSONAL (docente, preceptoría, dirección): mucho más
// tolerante. No es un capricho, es que la pregunta que contesta cada número es distinta.
//
// El "N de M presentes" de los alumnos es un dato de la clase que se mira segundo a segundo, y
// 45 s es lo que lo mantiene fiel. La presencia del PERSONAL no suma a ese conteo
// (ver presenceSummary): solo dice quién está a cargo de la sala. Y ahí 45 s daba falsos
// negativos permanentes — reclamo del usuario del 2026-08-13: la docente abre la sala, se va a
// Novedades o a Actividades de su propia materia, y a los 45 s desaparece de la sala para todo
// el mundo. Los alumnos lo leen como "cerró la clase", cuando la sala nunca se cerró.
//
// El latido del cliente (views/partials/live-room.ejs) manda un ping cada 20 s mientras la
// docente tenga la materia abierta. Cuando la pestaña del NAVEGADOR pasa a segundo plano,
// Chrome baja esos timers a uno por minuto: la ventana tiene que aguantar un latido
// throttleado sin dejarla parpadear dentro y fuera de la sala.
//
// 3 minutos, subido de 2 por pedido del usuario el 2026-08-13: son ~3 latidos throttleados de
// margen, así que hacen falta tres seguidos perdidos —no uno— para que desaparezca de la sala.
//
// Sigue siendo un dato honesto: dice "pingueó hace menos de 3 minutos", no "está". Una máquina
// apagada cae igual, solo que un rato después.
const STAFF_ONLINE_WINDOW_MS = 3 * 60 * 1000;

// Autocierre por inactividad. Cubre el caso real de la docente que se olvida la sala abierta
// al terminar la clase.
//
// Lo que mide es SALA VACÍA, no "clase sin mensajes": `lastActivityAt` se refresca con
// cualquier poll (cada 4 s por persona adentro) y con el latido de quien gestiona la sala
// (cada 20 s). Que pasen 30 minutos sin tocarlo significa que no quedó NADIE —ni la docente ni
// un solo alumno— en ~450 polls seguidos. Una clase larga en silencio no corre riesgo: mientras
// haya alguien mirando, el reloj se reinicia solo.
//
// Bajado de 3 h a 30 min el 2026-08-17. Las 3 h venían de cuando el autocierre solo se
// evaluaba al entrar a la sala: eran generosas porque el disparador era poco confiable, y en la
// práctica dejaban el panel de dirección lleno de clases terminadas. Con el barrido de
// closeStaleSessions() el disparador ya no depende de que alguien vuelva a la sala, así que el
// número puede decir lo que de verdad quiere decir. 30 min es el doble del recreo más largo:
// una desconexión general del WiFi de la escuela tendría que durar media hora para cerrar una
// clase en curso.
const AUTO_CLOSE_MS = 30 * 60 * 1000;

// Antigüedad a partir de la cual cleanup-rooms.js puede purgar los MENSAJES de una sesión
// cerrada. La presencia (la asistencia) no se purga nunca. Decisión del usuario: 3 meses
// cubre un trimestre completo y mantiene la colección chica.
const PURGE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const MSG_MAX     = 500;   // caracteres por mensaje
const MSG_PER_MIN = 10;    // mensajes por usuario por minuto

// ── Adjuntos ─────────────────────────────────────────────────────────────────
// Solo los sube quien gestiona la materia (el mismo canManage que abre y modera la sala).
// Ni los alumnos ni preceptoría: la sala es de menores y el material de clase lo pone quien
// da la clase. Eso también es lo que mantiene el volumen de disco previsible.

// Extensiones de ARCHIVO (las imágenes van por su propio camino, con EXT_IMAGENES de
// config/imagePresets.js). La lista arranca de la de adjuntos de actividad
// (routes/activities.js) y le suma las de presentación, que en una clase son lo más pedido.
//
// Lo que NO está es tan deliberado como lo que está: nada ejecutable (.exe, .bat, .js) y
// nada que el navegador pueda interpretar como HTML con scripts adentro (.html, .svg). El
// servidor sirve estos archivos con `nosniff`, pero la lista cerrada es la primera defensa
// y no depende de que un header viaje bien.
//
// `.dwg` y `.dxf` (los planos de AutoCAD) entran por la misma puerta que el resto: sin nada
// adentro que el navegador ejecute, y VER_EN_LINEA de routes/rooms.js no los nombra, así que
// se descargan en vez de intentar abrirse. El DXF es texto plano y aun así se sirve como
// `image/vnd.dxf` + `nosniff` + `attachment`. Ver tests/unit/subidaPlanos.test.js.
const EXT_ARCHIVOS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.csv', '.txt', '.zip', '.dwg', '.dxf'];

// 20 MB por archivo, el mismo techo que las entregas de alumnos (routes/activities.js). Las
// imágenes tienen el suyo, más bajo (MAX_INPUT_BYTES, 8 MB), porque se recomprimen: lo que
// entra pesado sale de ~100 KB.
const MAX_ARCHIVO_BYTES = 20 * 1024 * 1024;

// Dónde viven los adjuntos: FUERA de /public, para que no haya forma de llegar a ellos sin
// pasar por la ruta autenticada que revalida el permiso de la sala. Ver el comentario largo
// en routes/rooms.js.
//
// Vive acá y no en el router porque tiene DOS dueños: la ruta que los escribe y los sirve, y
// cleanup-rooms.js que los purga. Con la constante duplicada, el día que cambie el directorio
// la purga seguiría borrando en el lugar viejo y nadie se enteraría hasta que el disco se
// llene. Estructura: {SALAS_BASE}/{schoolId}/{courseId}/{sessionId}/{archivo}
const SALAS_BASE = require('path').join(__dirname, '../archivos/salas');

// Subidas por usuario cada 10 minutos. Igual que MSG_PER_MIN, la clave es POR USUARIO y no
// por IP: la escuela entera sale por una sola IP pública NAT, y un límite por IP haría que
// la docente de 2°3° dejara sin subir material a la de 5°1°. Es la lección del 2026-07-28
// (ver la cabecera de middleware/rate-limits.js), que acá se aplica de entrada.
const UPLOADS_PER_10MIN = 20;

// El mismo techo, para un ALUMNO. Cinco fotos cada 10 minutos: alcanza de sobra para mostrar
// la hoja de la carpeta o el ejercicio resuelto —que es para lo que se abrió esto— y corta de
// entrada la clase de 30 chicos descubriendo que pueden llenar el chat de fotos.
//
// Es un número distinto y no el mismo de la docente porque el uso es distinto: ella comparte
// el material de la clase (varias imágenes seguidas del pizarrón es normal), el alumno
// responde con lo suyo. Decisión del usuario, 2026-08-19.
const UPLOADS_ALUMNO_PER_10MIN = 5;

// Paleta cerrada de emojis del selector. Cerrada a propósito: valida la entrada del POST de
// reacciones sin tener que razonar sobre unicode arbitrario, y mantiene el selector de un
// tamaño usable en un celular.
const EMOJIS = ['👋', '👍', '✋', '❓', '😀', '🎉', '✅', '😕', '❤️', '😮', '🙏', '👏'];

// Roles que, estando en la sala, no son "alumnos presentes" sino personal.
const STAFF_ROLES = ['teacher', 'admin', 'superadmin', 'directivo', 'preceptor', 'jefe', 'soe'];

// ── Hora de la sala ──────────────────────────────────────────────────────────

// Zona horaria de la escuela. TODAS las horas de la sala se arman acá, en el servidor y con
// esta zona fija: ni el reloj del navegador ni el del servidor deciden qué hora se muestra.
//
// El bug que esto arregla: la hora de cada mensaje la formateaba el navegador con
// toLocaleTimeString(), es decir con la zona horaria del equipo. Las máquinas del aula tienen
// cualquier zona configurada, así que el MISMO mensaje se veía a una hora distinta en cada
// pantalla. Y el servidor de producción corre en UTC, con lo cual las vistas que ya se
// renderizaban del lado del servidor (clases anteriores, transcripción, CSV) mostraban tres
// horas de más. Una sola fuente de hora resuelve las dos mitades del problema.
const TZ = process.env.SCHOOL_TZ || 'America/Argentina/Buenos_Aires';

// Los formatters se construyen UNA sola vez. Intl.DateTimeFormat es caro de instanciar y esto
// corre por cada mensaje de cada poll: 100 mensajes × 30 personas cada 4 segundos.
const opts = (o) => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, ...o });
// hourCycle h23 y no hour12:false — con hour12 algunos locales imprimen "24:15" a medianoche.
const F_HORA   = opts({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const F_DIA    = opts({ weekday: 'long', day: 'numeric', month: 'long' });
const F_LARGA  = opts({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const F_CORTA  = opts({ day: '2-digit', month: '2-digit', year: 'numeric' });
const F_FECHAH = opts({ day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
// Las formas que usaban las vistas cuando cada una llamaba a toLocaleDateString por su cuenta.
// Se agregan aca, y no en cada .ejs, por la misma razon que las de arriba: un segundo
// Intl.DateTimeFormat en otro archivo es como vuelve el bug de las tres horas de mas.
const F_HORA_S = opts({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const F_DM     = opts({ day: 'numeric', month: 'short' });
const F_DMA    = opts({ day: 'numeric', month: 'short', year: 'numeric' });
const F_DMH    = opts({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const F_DMAH   = opts({ day: 'numeric', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const F_DML    = opts({ day: 'numeric', month: 'long', year: 'numeric' });
// El anio solo, para la columna de fecha de la linea de tiempo del legajo (soe/legajo.ejs),
// que lo imprime en su propio renglon debajo del dia. Va aca y no en la vista por la regla
// del archivo: un segundo Intl.DateTimeFormat en otro lado es como vuelve el bug de las tres
// horas de mas.
const F_ANIO   = opts({ year: 'numeric' });
const F_DMLH   = opts({ day: 'numeric', month: 'long', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Día escolar 'YYYY-MM-DD' en la zona de la escuela. A diferencia de los de arriba, este no
// es un texto de pantalla: es la CLAVE con la que se archiva la asistencia
// (models/AttendanceSession.js) y parte de su índice único. Vive acá, y no en
// services/attendance.js, porque la zona horaria de la escuela tiene que tener un solo dueño
// —un segundo Intl.DateTimeFormat en otro archivo es exactamente cómo vuelve el bug de las
// tres horas de más—. Con toISOString(), que es UTC, una toma abierta a las 21:30 de Buenos
// Aires quedaría fechada al día siguiente.
//
// Se arma con formatToParts y no con un locale que casualmente imprime ISO (en-CA): el
// formato de un locale puede cambiar con la versión de ICU, y esto es una clave de base de
// datos, no un texto.
const F_ISO = opts({ year: 'numeric', month: '2-digit', day: '2-digit' });
function diaEscolar(d = new Date()) {
  const partes = Object.fromEntries(F_ISO.formatToParts(d).map(p => [p.type, p.value]));
  return `${partes.year}-${partes.month}-${partes.day}`;
}

// Una fecha nula o basura devuelve '' en vez de "Invalid Date": estos textos van directo a la
// pantalla y a los CSV.
function formatear(f, d) {
  if (!d) return '';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : f.format(t);
}

const hora       = (d) => formatear(F_HORA, d);    // 14:05
const fechaDia   = (d) => formatear(F_DIA, d);     // jueves, 6 de agosto
const fechaLarga = (d) => formatear(F_LARGA, d);   // jueves, 6 de agosto de 2026
const fechaCorta = (d) => formatear(F_CORTA, d);   // 06/08/2026
const fechaHora  = (d) => formatear(F_FECHAH, d);  // 06/08/2026, 14:05:00
const horaSegundos    = (d) => formatear(F_HORA_S, d); // 14:05:00
const diaMes          = (d) => formatear(F_DM, d);     // 6 sept
const diaMesAnio      = (d) => formatear(F_DMA, d);    // 6 sept 2026
const diaMesHora      = (d) => formatear(F_DMH, d);    // 6 sept, 14:05
const diaMesAnioHora  = (d) => formatear(F_DMAH, d);   // 6 sept 2026, 14:05
const diaMesLargo     = (d) => formatear(F_DML, d);    // 6 de agosto de 2026
const diaMesLargoHora = (d) => formatear(F_DMLH, d);   // 6 de agosto de 2026, 14:05
const anio            = (d) => formatear(F_ANIO, d);   // 2026

// Se pasa entero a las vistas como `fmt` (ver routes/rooms.js): así ninguna plantilla vuelve a
// llamar a toLocaleTimeString por su cuenta.
const fmt = { TZ, hora, fechaDia, fechaLarga, fechaCorta, fechaHora,
              horaSegundos, diaMes, diaMesAnio, diaMesHora, diaMesAnioHora,
              diaMesLargo, diaMesLargoHora, anio };

// Etiqueta que acompaña al círculo de quien no es alumno.
const ROLE_LABELS = {
  teacher:    'Docente',
  admin:      'Administración',
  superadmin: 'Administración',
  directivo:  'Dirección',
  preceptor:  'Preceptoría',
  jefe:       'Jefatura',
  soe:        'Orientación',
};

// ── Funciones puras ──────────────────────────────────────────────────────────

// ¿El último ping entra en la ventana de "conectado ahora"?
// El borde es INCLUSIVO: exactamente 45 s todavía cuenta como presente. Con la comparación
// estricta, un ping que llega justo en el límite sacaría al alumno de la lista por un
// milisegundo de diferencia de reloj.
//
// La ventana es un parámetro porque no es la misma para todos: ver STAFF_ONLINE_WINDOW_MS.
function isOnline(lastPingAt, now = new Date(), windowMs = ONLINE_WINDOW_MS) {
  if (!lastPingAt) return false;
  const t = new Date(lastPingAt).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= windowMs;
}

const initial = (name) => (String(name || '—').trim().charAt(0) || '—').toUpperCase();

// Arma el resumen de presencia que consume la vista.
//   presences: documentos de RoomPresence de la sesión (lean u objetos con las mismas claves)
//   roster:    alumnos matriculados en la materia [{ _id, name, avatar }] — el universo del
//              "N de M". Puede venir vacío (materia sin alumnos): eso NO es un error.
//
// `presentes` cuenta SOLO alumnos: si el docente sumara, "18 de 25" pasaría a decir 19 sin
// que haya un chico más en la clase. El personal aparece igual en `conectados`, primero y
// con su etiqueta, porque ver quién está a cargo es justamente el punto de la pantalla.
function presenceSummary(presences = [], roster = [], now = new Date()) {
  const onlineById = new Map();
  for (const p of presences) {
    // Dos ventanas, una por audiencia (ver STAFF_ONLINE_WINDOW_MS). El personal aguanta más
    // sin pinguear porque su presencia no alimenta ningún conteo: solo dice quién está a cargo.
    const ventana = STAFF_ROLES.includes(p.userRole) ? STAFF_ONLINE_WINDOW_MS : ONLINE_WINDOW_MS;
    if (isOnline(p.lastPingAt, now, ventana)) onlineById.set(String(p.user), p);
  }

  const conectados = [];
  const ausentes   = [];

  // Personal primero, en el orden en que llegó.
  const staff = [...onlineById.values()]
    .filter(p => STAFF_ROLES.includes(p.userRole))
    .sort((a, b) => new Date(a.firstSeenAt) - new Date(b.firstSeenAt));
  for (const p of staff) {
    conectados.push({
      id:      String(p.user),
      nombre:  p.userName || '—',
      inicial: initial(p.userName),
      avatar:  null,
      rol:     p.userRole,
      etiqueta: ROLE_LABELS[p.userRole] || '',
    });
  }

  // Después los alumnos, en el orden del roster (alfabético, como llega de la ruta).
  let presentes = 0;
  for (const alumno of roster) {
    const id = String(alumno._id);
    const p  = onlineById.get(id);
    if (p) {
      presentes += 1;
      conectados.push({
        id,
        nombre:  alumno.name,
        inicial: initial(alumno.name),
        avatar:  alumno.avatar || null,
        rol:     'student',
        etiqueta: '',
      });
    } else {
      ausentes.push({ id, nombre: alumno.name, inicial: initial(alumno.name) });
    }
  }

  return { presentes, total: roster.length, conectados, ausentes };
}

// ¿Esta sesión quedó abierta y sin actividad más allá del límite?
// Solo aplica a sesiones ABIERTAS: una ya cerrada nunca vuelve a evaluarse.
function shouldAutoClose(session, now = new Date()) {
  if (!session || session.closedAt) return false;
  const last = new Date(session.lastActivityAt || session.openedAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last > AUTO_CLOSE_MS;
}

// A qué hora terminó realmente una clase que se cierra sola.
//
// Es su ÚLTIMA señal de vida, no el momento en que el sistema se dio cuenta. La diferencia se
// ve: una sala que quedó abierta el martes y se barre el jueves tiene que figurar como cerrada
// el martes a las 10:40 —que es cuando se fue el último—, no el jueves a las 8:03. Si no, el
// pie "Cerradas hoy" del panel se llena de clases de la semana pasada y las horas del historial
// y del CSV mienten.
//
// Para el cierre a mano no aplica: ahí la hora es cuando la persona apretó el botón.
function horaDeCierre(session, now = new Date(), { auto = false } = {}) {
  if (!auto) return now;
  const t = new Date(session?.lastActivityAt || session?.openedAt);
  if (Number.isNaN(t.getTime())) return now;

  // Nunca antes de la apertura: una clase que "terminó" antes de empezar sale con duración
  // negativa en el historial y en el CSV. En la práctica lastActivityAt siempre va después
  // —nace en la apertura y solo avanza—, pero un dato viejo o retocado a mano no puede
  // producir un registro imposible.
  const abrio = new Date(session?.openedAt);
  return !Number.isNaN(abrio.getTime()) && abrio > t ? abrio : t;
}

// ¿Hay alguien A CARGO de esta sala conectado ahora mismo?
//
// `gestorIds` son la titular y sus suplentes (Course.owner + coTeachers). Preceptoría y
// dirección NO cuentan: que un preceptor esté mirando la sala no significa que se esté
// dictando la clase, y el panel de dirección pregunta justamente eso.
//
// Usa la ventana del personal (3 min), no la de los alumnos: es la misma pregunta que contesta
// presenceSummary y tiene que contestarla igual en las dos pantallas.
function gestorEnLinea(presences = [], gestorIds = [], now = new Date()) {
  const gestores = new Set(gestorIds.map(String));
  return presences.some(p =>
    gestores.has(String(p.user)) && isOnline(p.lastPingAt, now, STAFF_ONLINE_WINDOW_MS));
}

// Normaliza el texto de un mensaje antes de guardarlo.
// No escapa HTML: eso lo hace la vista con <%= %>, que es el único lugar donde el escapado
// es correcto. Guardar el texto ya escapado rompería el export a CSV y la búsqueda.
function sanitizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')       // normaliza saltos de Windows
    .replace(/\n{3,}/g, '\n\n')    // colapsa cascadas de Enter a un renglón en blanco
    .trim()
    .slice(0, MSG_MAX);
}

// Minutos estimados de permanencia. pings × POLL_MS, no lastPingAt − firstSeenAt (ver el
// comentario de models/RoomPresence.js).
function minutosPresente(presence) {
  const ms = (presence?.pings || 0) * POLL_MS;
  return Math.max(1, Math.round(ms / 60000));
}

// Peso de un adjunto, listo para imprimir: "840 KB", "1,4 MB".
// Con coma decimal, que es como se escribe en español. Un archivo de 0 bytes no debería
// existir (multer y las rutas lo rechazan), pero si llega igual muestra "0 KB" y no "NaN".
function pesoLegible(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

// Extensión en mayúsculas para la card de archivo: '.docx' → 'DOCX'. Es lo que el alumno lee
// para saber con qué se abre antes de tocarlo.
function etiquetaExt(ext) {
  return String(ext || '').replace(/^\./, '').toUpperCase() || 'ARCHIVO';
}

// Cómo se nombra un adjunto en un contexto de SOLO TEXTO: la transcripción de la clase y el
// CSV. Sin esto, una clase donde la docente compartió cinco imágenes exporta cinco filas
// vacías y el registro miente por omisión — no dice que hubo material compartido.
function textoAdjunto(m) {
  if (!m || (m.kind !== 'image' && m.kind !== 'file')) return '';
  const a = m.attachment || {};
  const etiqueta = m.kind === 'image' ? 'Imagen' : 'Archivo';
  const nombre   = a.name || 'sin nombre';
  return a.bytes ? `[${etiqueta}] ${nombre} (${pesoLegible(a.bytes)})` : `[${etiqueta}] ${nombre}`;
}

// ── Quién puede qué, dentro de la sala ───────────────────────────────────────
//
// Las tres reglas viven ACÁ y no en routes/rooms.js —donde estaba `puedeEscribir` hasta el
// 2026-08-19— porque se componen entre ellas: compartir una foto exige poder escribir, y
// borrar lo propio exige que la sala siga abierta. Con una regla en el router y sus dos
// hermanas en otro lado, la próxima que se agregue va a quedar en un tercero y ninguna de las
// tres se va a poder testear sin levantar Express.
//
// Reciben un CONTEXTO plano (no `req`): eso es lo que las hace puras y testeables en
// tests/unit/salaChat.test.js sin base ni servidor. El router arma ese contexto.
//
//   ctx = { esGestor, esAlumno, modo, userId }
//   session = el documento de RoomSession, o null si no hay sala abierta

// ¿Puede escribir un mensaje, ahora?
function puedeEscribir(session, ctx = {}) {
  if (!session || session.closedAt) return false;
  if (ctx.modo === 'observacion') return false;   // mirar sin aparecer implica no hablar
  if (ctx.esGestor) return true;                  // la docente escribe siempre
  if (!ctx.esAlumno) return true;                 // preceptoría y dirección presentada
  if (!session.settings || session.settings.studentsCanWrite === false) return false;
  return !(session.mutedStudents || []).some(id => String(id) === String(ctx.userId));
}

// ¿Puede compartir una IMAGEN, ahora?
//
// Solo los dos lados del mostrador de esta materia: quien la gestiona y quien la cursa.
// Preceptoría y dirección entran a mirar la clase, no a dejar material en ella (RN-A2), así
// que el `return false` del final no es un olvido — es la regla.
//
// Para el alumno son TRES condiciones y todas a la vez (RN-A3): sala abierta, interruptor
// prendido y poder escribir. La tercera es la que pidió el usuario: silenciar a alguien lo
// silencia entero, no lo deja seguir hablando por foto.
//
// `!== false` y no `=== true`: una sesión abierta ANTES de que existiera el interruptor no
// tiene el campo, y esa clase tiene que seguir comportándose como venía (permitido).
function puedeCompartirImagen(session, ctx = {}) {
  if (!session || session.closedAt) return false;
  if (ctx.modo === 'observacion') return false;
  if (ctx.esGestor) return true;
  if (!ctx.esAlumno) return false;
  if (session.settings && session.settings.studentsCanShareImages === false) return false;
  return puedeEscribir(session, ctx);
}

// ¿Puede borrar ESTE mensaje?
//
// La docente borra cualquier cosa y en cualquier momento: es moderación, y una clase que ya
// terminó es justo cuando aparece el problema de convivencia que hay que sacar de la vista.
//
// El autor borra lo suyo SOLO con la sala abierta (RN-B1). El límite temporal es lo que
// separa "me equivoqué de foto" —el caso real que esto viene a cubrir— de volver sobre una
// clase de la semana pasada a limpiar el rastro de lo que uno dijo. Un mensaje del sistema no
// es de nadie: no tiene autor a quien devolverle el permiso.
function puedeBorrarMensaje(msg, ctx = {}, { salaAbierta = false } = {}) {
  if (!msg || msg.deletedAt) return false;
  if (ctx.esGestor) return true;
  if (msg.kind === 'system') return false;
  if (!salaAbierta) return false;
  return String(msg.author) === String(ctx.userId);
}

// ── La cita de una respuesta ─────────────────────────────────────────────────

// Cuánto del mensaje citado se copia. 90 caracteres son ~dos renglones en un celular: lo
// suficiente para reconocer a qué se contesta, no tanto como para que la cita compita con la
// respuesta. El resto se corta con puntos suspensivos.
const EXTRACTO_MAX = 90;

// Arma el snapshot de la cita a partir del mensaje original. Ver replySchema en
// models/RoomMessage.js: se copia el texto en vez de resolverlo con populate porque el poll
// pinta 100 mensajes cada 4 segundos.
//
// Devuelve null —y el mensaje sale SIN cita, sin error en la cara (RN-C7)— cuando no hay a
// qué contestarle: un aviso del sistema (no es de nadie) o un mensaje ya borrado (citarlo
// sería devolverle el texto que la moderación acaba de sacar).
function citaDeMensaje(msg) {
  if (!msg || msg.kind === 'system' || msg.deletedAt) return null;

  // Un adjunto no lleva texto: su contenido ES el archivo. La cita muestra de qué se trata,
  // que es lo mismo que ya hace la transcripción en CSV.
  let extracto = '';
  if (msg.kind === 'image')      extracto = '📷 Imagen';
  else if (msg.kind === 'file')  extracto = '📎 ' + (msg.attachment?.name || 'Archivo');
  else {
    const t = String(msg.text || '').replace(/\s+/g, ' ').trim();
    extracto = t.length > EXTRACTO_MAX ? t.slice(0, EXTRACTO_MAX - 1) + '…' : t;
  }

  return {
    to:       msg._id,
    seq:      msg.seq,
    autor:    msg.authorName || '—',
    extracto,
    kind:     msg.kind || 'text',
    borrado:  false,
  };
}

// ── Funciones con base de datos ──────────────────────────────────────────────

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// Abre la sala de una materia. IDEMPOTENTE: si ya hay una sesión abierta devuelve esa misma.
// Dos docentes de la misma materia tocando "Abrir" a la vez es un caso real, no teórico.
async function openSession(course, user, title = '') {
  const abierta = await RoomSession.findOne({ course: course._id, closedAt: null });
  if (abierta) return { session: abierta, creada: false };

  const session = await RoomSession.create({
    course:   course._id,
    school:   course.school?._id || course.school,
    division: course.division?._id || course.division,
    openedBy: user._id,
    title:    String(title || '').trim().slice(0, 80),
  });

  await systemMessage(session, `${user.name} abrió la sala.`);
  return { session, creada: true };
}

// Cierra la sala. `auto` distingue el cierre por inactividad del que hace una persona.
//
// El cierre se escribe con un findOneAndUpdate condicionado a `closedAt: null` y NO con
// save(): es lo que lo hace seguro con los dos workers de PM2. Dos barridos simultáneos (o un
// barrido y la docente apretando "Cerrar") leen los dos la sesión abierta, pero solo uno gana
// la escritura; el que pierde se va sin tocar nada. Con save() ganaban los dos y la clase
// terminaba con el aviso de cierre repetido en la transcripción.
//
// Por eso el mensaje de sistema va DESPUÉS de ganar la carrera, y no antes como estaba.
async function closeSession(session, user = null, { auto = false, now = new Date() } = {}) {
  if (!session || session.closedAt) return session;

  const cierre = horaDeCierre(session, now, { auto });

  const cerrada = await RoomSession.findOneAndUpdate(
    { _id: session._id, closedAt: null },
    { $set: { closedAt: cierre, closedBy: user?._id || null, autoClosed: !!auto } },
    { new: true }
  );
  if (!cerrada) return session;   // otro worker la cerró primero

  await systemMessage(
    cerrada,
    auto ? 'La sala se cerró automáticamente por inactividad.'
         : `${user?.name || 'La docente'} cerró la sala.`
  );

  // El mensaje anterior pasó por nextSeq, que refresca lastActivityAt: sin esto una sesión
  // cerrada quedaría con su última actividad DESPUÉS de su propio cierre.
  await RoomSession.updateOne({ _id: cerrada._id }, { $set: { lastActivityAt: cierre } });
  cerrada.lastActivityAt = cierre;

  return cerrada;
}

// Barrido de salas que quedaron abiertas sin nadie adentro.
//
// Por qué existe: hasta el 2026-08-17 el autocierre se evaluaba en UN solo lugar —al pedir la
// sala de una materia (routes/rooms.js)—, así que una clase que terminaba y a la que nadie
// volvía a entrar se quedaba abierta para siempre. Nada la miraba. En el espejo de producción
// había 40 salas "en vivo" sin un solo ping desde hacía entre 3 y 6 días, y los paneles de
// dirección y preceptoría las listaban todas como clases en curso.
//
// Sigue siendo perezoso (no hay setInterval: con 2 workers en cluster un timer correría dos
// veces), pero ahora los paneles de supervisión también son disparador, que es exactamente
// donde el problema se ve. `match` es el MISMO filtro con el que el panel lista: el barrido
// cierra lo que esa pantalla mostraría, ni una sesión de más.
//
// Devuelve cuántas cerró. No lanza: que falle un barrido no puede tumbar el panel.
async function closeStaleSessions(match, now = new Date()) {
  try {
    const abiertas = await RoomSession.find({ ...match, closedAt: null })
      .select('_id course openedAt lastActivityAt closedAt');

    const vencidas = abiertas.filter(s => shouldAutoClose(s, now));
    for (const s of vencidas) await closeSession(s, null, { auto: true, now });

    return vencidas.length;
  } catch (err) {
    console.error('[liveRoom] barrido de salas vencidas:', err.message);
    return 0;
  }
}

// Asigna el `seq` siguiente de la sesión de forma ATÓMICA y crea el mensaje.
// El $inc es lo que hace que esto sea seguro con los dos workers de PM2 en cluster: dos
// mensajes simultáneos reciben números distintos y consecutivos, sin coordinación entre
// procesos y sin que ninguno se pierda del cursor.
async function nextSeq(sessionId) {
  const s = await RoomSession.findByIdAndUpdate(
    sessionId,
    { $inc: { lastSeq: 1 }, $set: { lastActivityAt: new Date() } },
    { new: true, select: 'lastSeq' }
  );
  return s ? s.lastSeq : null;
}

async function postMessage(session, user, text, { reply = null } = {}) {
  const limpio = sanitizeText(text);
  if (!limpio) return null;

  const seq = await nextSeq(session._id);
  if (seq === null) return null;

  return RoomMessage.create({
    session:    session._id,
    course:     session.course,
    author:     user._id,
    authorName: user.name,
    authorRole: user.role,
    kind:       'text',
    text:       limpio,
    seq,
    reply,
  });
}

// Resuelve el `replyTo` que mandó el cliente y devuelve la cita lista para guardar.
//
// Acotado a la SESIÓN abierta (RN-C3): no se cita un mensaje de la clase del martes en la del
// jueves, y ese filtro es además lo que impide que alguien cite —y con eso copie a la vista de
// todos— un mensaje de una sala en la que no estuvo, mandando un id a mano.
//
// Cualquier cosa rara (id inválido, mensaje inexistente, de otra sesión, del sistema, ya
// borrado) devuelve null y el mensaje sale sin cita. NUNCA un error: el alumno quiso mandar un
// mensaje, y perder la citita no es motivo para no mandárselo (RN-C7).
async function resolverCita(session, replyToId) {
  if (!replyToId || !mongoose.isValidObjectId(replyToId)) return null;
  const original = await RoomMessage.findOne({ _id: replyToId, session: session._id })
    .select('_id seq authorName kind text attachment deletedAt').lean();
  return citaDeMensaje(original);
}

// Apaga las citas que apuntan a un mensaje recién borrado (RN-B4).
//
// Es la contraparte del snapshot: el texto citado está COPIADO en cada respuesta, así que sin
// esto la docente borra un mensaje ofensivo y el texto sigue leyéndose en las tres respuestas
// que lo citaban. La moderación no moderaría nada.
//
// Se paga acá —al borrar, que pasa de a uno y cada tanto— y no en cada poll, que corre cada 4
// segundos por cada persona de la sala. La query va acotada por `session`, que está indexado.
async function apagarCitasDe(msg) {
  if (!msg) return 0;
  const r = await RoomMessage.updateMany(
    { session: msg.session, 'reply.to': msg._id },
    { $set: { 'reply.borrado': true, 'reply.extracto': '' } }
  );
  return r.modifiedCount || 0;
}

// Publica un adjunto ya guardado en disco como un mensaje más de la conversación.
//
// El archivo se escribe ANTES de llamar acá (la ruta lo hace: optimiza la imagen o recibe el
// archivo, y recién con el disco resuelto crea el documento). El orden importa: si se creara
// el mensaje primero y la escritura fallara, la clase vería una card rota — y un poll ya la
// habría repartido a los 30 dispositivos. Al revés, un archivo escrito cuyo documento no se
// creó es basura silenciosa que barre cleanup-files.js.
//
// `kind` es 'image' o 'file'. Es el mismo camino que postMessage —mismo $inc atómico sobre
// lastSeq— para que un adjunto y un mensaje enviados a la vez no se peleen el número.
async function postAttachment(session, user, kind, attachment, { reply = null } = {}) {
  if (kind !== 'image' && kind !== 'file') return null;

  const seq = await nextSeq(session._id);
  if (seq === null) return null;

  return RoomMessage.create({
    session:    session._id,
    course:     session.course,
    author:     user._id,
    authorName: user.name,
    authorRole: user.role,
    kind,
    text:       '',
    seq,
    attachment,
    reply,
  });
}

// Mensaje automático de la propia sala (abrió, cerró, entró preceptoría). Se guarda como un
// mensaje más para que la transcripción se lea en orden con un solo cursor.
//
// `activity` es opcional: lo manda el aviso de "se creó una actividad" para que la sala pueda
// pintar el botón "Ver actividad" (ver models/RoomMessage.js). El resto de los avisos lo
// omiten y el campo queda en null, que es como se leen todos los mensajes anteriores.
async function systemMessage(session, text, { activity = null } = {}) {
  const seq = await nextSeq(session._id);
  if (seq === null) return null;
  return RoomMessage.create({
    session: session._id,
    course:  session.course,
    author:  session.openedBy,
    authorName: '',
    authorRole: 'system',
    kind:    'system',
    text:    sanitizeText(text),
    activity,
    seq,
  });
}

// Registra (o refresca) la presencia de alguien en la sala.
// $setOnInsert en firstSeenAt: una reconexión no puede pisar el primer ingreso. $inc en
// pings: es de donde sale el tiempo estimado de permanencia.
// Devuelve { creada } para que la ruta sepa si tiene que anunciar el ingreso — sin eso, cada
// F5 del preceptor metería otro "ingresó a la sala" en el chat.
async function touchPresence(session, user) {
  const antes = await RoomPresence.findOne({ session: session._id, user: user._id }).select('_id');
  await RoomPresence.updateOne(
    { session: session._id, user: user._id },
    {
      $setOnInsert: { course: session.course, firstSeenAt: new Date() },
      $set:         { lastPingAt: new Date(), userName: user.name, userRole: user.role },
      $inc:         { pings: 1 },
    },
    { upsert: true }
  );
  await RoomSession.updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date() } });
  return { creada: !antes };
}

// Tarjetas de "clases en curso" para los paneles de supervisión.
// UN solo aggregate para toda la pantalla, no una query por tarjeta.
//   divisionIds: undefined = toda la escuela (dirección). Un array = solo esas divisiones
//   (preceptoría). Un array VACÍO significa "ninguna", nunca "todas": es la regla fail-closed
//   del alcance del preceptor (ver models/User.js y middleware/preceptor.js).
async function getOpenSessions(schoolId, { divisionIds = undefined, now = new Date() } = {}) {
  if (!schoolId) return [];
  if (Array.isArray(divisionIds) && divisionIds.length === 0) return [];

  const match = { school: oid(schoolId), closedAt: null };
  if (Array.isArray(divisionIds)) match.division = { $in: divisionIds.map(oid) };

  // Antes de listar, cerrar lo que ya terminó: sin esto el panel muestra como "en vivo"
  // cualquier clase vieja a cuya sala nadie volvió a entrar. Va acá y no en la ruta para que
  // valga igual en los dos paneles (dirección y preceptoría) y en su poll.
  await closeStaleSessions(match, now);

  // La ventana ancha (la del personal) es la que se pide a la base; los alumnos se filtran
  // después con la suya. Al revés —pidiendo 45 s— la docente que pingueó hace 1 minuto no
  // vendría en el resultado y la tarjeta la daría por desconectada. Ver STAFF_ONLINE_WINDOW_MS.
  const cutoff     = new Date(now.getTime() - Math.max(ONLINE_WINDOW_MS, STAFF_ONLINE_WINDOW_MS));
  const cutoffStud = new Date(now.getTime() - ONLINE_WINDOW_MS);

  const rows = await RoomSession.aggregate([
    { $match: match },
    { $sort:  { openedAt: 1 } },
    { $lookup: { from: 'courses',   localField: 'course',   foreignField: '_id', as: 'curso' } },
    { $unwind: '$curso' },
    { $lookup: { from: 'divisions', localField: 'division', foreignField: '_id', as: 'div' } },
    { $lookup: { from: 'users',     localField: 'curso.owner', foreignField: '_id', as: 'doc' } },
    // Presentes ahora: se cuentan en el pipeline del $lookup para no traer los documentos.
    { $lookup: {
        from: 'roompresences',
        let:  { s: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$session', '$$s'] }, lastPingAt: { $gte: cutoff } } },
          { $sort:  { firstSeenAt: 1 } },
          { $project: { user: 1, userName: 1, userRole: 1, lastPingAt: 1 } },
        ],
        as: 'presentes',
    } },
    { $lookup: {
        from: 'roommessages',
        let:  { s: '$_id' },
        pipeline: [
          // Cuenta lo que ESCRIBIÓ o COMPARTIÓ la clase, no los avisos automáticos de la sala
          // ('system': se abrió, entró preceptoría). Los adjuntos suman: una clase donde la
          // docente compartió el material y nadie escribió está muy viva, y con solo 'text'
          // la tarjeta decía "0 mensajes · sin actividad" — o sea, parecía una sala muerta
          // justo cuando había algo para mirar.
          { $match: { $expr: { $eq: ['$session', '$$s'] }, kind: { $in: ['text', 'image', 'file'] } } },
          { $group: { _id: null, n: { $sum: 1 }, ultimo: { $max: '$createdAt' } } },
        ],
        as: 'msgs',
    } },
  ]);

  return rows.map((r) => {
    const alumnos  = (r.curso.students || []).length;
    const presStud = r.presentes.filter(p =>
      !STAFF_ROLES.includes(p.userRole) && new Date(p.lastPingAt) >= cutoffStud);
    const msg      = r.msgs[0] || { n: 0, ultimo: null };
    const gestores = [r.curso.owner, ...(r.curso.coTeachers || [])].filter(Boolean);
    return {
      sessionId: String(r._id),
      courseId:  String(r.curso._id),
      materia:   r.curso.name,
      division:  r.div[0]?.name || '—',
      docente:   r.doc[0]?.name || 'Sin docente',
      aula:      r.curso.room || '',
      titulo:    r.title || '',
      desdeMin:  Math.max(0, Math.round((now - new Date(r.openedAt)) / 60000)),
      presentes: presStud.length,
      total:     alumnos,
      // Sala abierta NO es lo mismo que docente dando clase: puede haberse ido hace 10 minutos
      // y la sala todavía no vencer. La tarjeta lo dice en vez de dejar que dirección lo
      // suponga, que es de donde salía el reclamo "aparecen clases que ya deberían estar
      // cerradas". Solo cuentan titular y suplentes: ver gestorEnLinea.
      docenteEnLinea: gestorEnLinea(r.presentes, gestores, now),
      mensajes:  msg.n,
      ultimoMensajeHace: msg.ultimo
        ? Math.max(0, Math.round((now - new Date(msg.ultimo)) / 1000))
        : null,
      // Iniciales para los circulitos de la tarjeta. Se usan las del snapshot de presencia
      // en vez de hacer otro $lookup a users: en una tarjeta de resumen, la inicial alcanza.
      avatares: presStud.slice(0, 4).map(p => ({ inicial: initial(p.userName) })),
    };
  });
}

// Sesiones cerradas HOY, para el pie de los paneles de supervisión.
async function getTodayClosed(schoolId, { divisionIds = undefined, now = new Date() } = {}) {
  if (!schoolId) return [];
  if (Array.isArray(divisionIds) && divisionIds.length === 0) return [];

  const desde = new Date(now); desde.setHours(0, 0, 0, 0);
  const match = { school: oid(schoolId), closedAt: { $gte: desde } };
  if (Array.isArray(divisionIds)) match.division = { $in: divisionIds.map(oid) };

  const rows = await RoomSession.aggregate([
    { $match: match },
    { $sort:  { closedAt: -1 } },
    { $limit: 12 },
    { $lookup: { from: 'courses',   localField: 'course',   foreignField: '_id', as: 'curso' } },
    { $unwind: '$curso' },
    { $lookup: { from: 'divisions', localField: 'division', foreignField: '_id', as: 'div' } },
    { $lookup: {
        from: 'roompresences',
        let:  { s: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$session', '$$s'] } } },
          { $project: { userRole: 1 } },
        ],
        as: 'pres',
    } },
  ]);

  return rows.map(r => ({
    sessionId: String(r._id),
    courseId:  String(r.curso._id),
    materia:   r.curso.name,
    division:  r.div[0]?.name || '—',
    desde:     r.openedAt,
    hasta:     r.closedAt,
    // Ya formateadas por el servidor: la tarjeta del panel las imprime tal cual.
    desdeHora: hora(r.openedAt),
    hastaHora: hora(r.closedAt),
    presentes: r.pres.filter(p => !STAFF_ROLES.includes(p.userRole)).length,
    total:     (r.curso.students || []).length,
  }));
}

// ── Export a CSV ─────────────────────────────────────────────────────────────

// Escapa una celda de CSV. Punto y coma como separador y BOM al principio del archivo porque
// el destino real es Excel en español, que con la coma arma una sola columna.
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRows = (rows) => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');

// Fecha y hora del CSV: también en la zona de la escuela. Un export que dijera la hora en UTC
// serviría para lo contrario de lo que se pide (saber a qué hora entró cada chico a clase).
const fecha = fechaHora;

// CSV de asistencia: una fila por alumno del curso, haya entrado o no.
function csvAsistencia(roster, presences) {
  const byUser = new Map(presences.map(p => [String(p.user), p]));
  const rows = [['Alumno', 'DNI', 'Estado', 'Primer ingreso', 'Último registro', 'Minutos estimados']];
  for (const a of roster) {
    const p = byUser.get(String(a._id));
    rows.push([
      a.name,
      a.dni || '',
      p ? 'Presente' : 'Ausente',
      p ? fecha(p.firstSeenAt) : '',
      p ? fecha(p.lastPingAt)  : '',
      p ? minutosPresente(p)   : 0,
    ]);
  }
  return csvRows(rows);
}

// CSV de transcripción. Los eliminados se incluyen marcados como tales: una transcripción
// con huecos silenciosos no sirve para lo único para lo que se pide.
//
// Los adjuntos van como "[Imagen] pizarron.webp (240 KB)" en la columna del mensaje: el CSV
// no puede llevar el archivo, pero sí tiene que dejar constancia de que se compartió, cuál y
// cuándo. Una transcripción que los omitiera diría que la docente estuvo callada.
function csvTranscripcion(messages) {
  const rows = [['#', 'Hora', 'Autor', 'Rol', 'Responde a', 'Mensaje', 'Estado']];
  for (const m of messages) {
    const esAdjunto = m.kind === 'image' || m.kind === 'file';
    rows.push([
      m.seq,
      fecha(m.createdAt),
      m.kind === 'system' ? '(sistema)' : (m.authorName || '—'),
      m.kind === 'system' ? '' : (m.authorRole || ''),
      // A quién le contestaba. En la pantalla la cita se ve; en el CSV, sin esta columna, una
      // clase entera de "sí", "dale", "yo tampoco" no dice a qué contestaba cada uno — y el
      // CSV es justo lo que se lee cuando hay que reconstruir un episodio.
      m.reply?.to ? `#${m.reply.seq ?? '?'} ${m.reply.autor || ''}`.trim() : '',
      esAdjunto ? textoAdjunto(m) : m.text,
      m.deletedAt ? 'Eliminado' : '',
    ]);
  }
  return csvRows(rows);
}

module.exports = {
  // constantes
  POLL_MS, DIRECTIVO_POLL_MS, ONLINE_WINDOW_MS, STAFF_ONLINE_WINDOW_MS, AUTO_CLOSE_MS, PURGE_AFTER_MS,
  MSG_MAX, MSG_PER_MIN, EMOJIS, STAFF_ROLES, ROLE_LABELS, TZ,
  EXT_ARCHIVOS, MAX_ARCHIVO_BYTES, UPLOADS_PER_10MIN, UPLOADS_ALUMNO_PER_10MIN, SALAS_BASE,
  EXTRACTO_MAX,
  // hora (zona fija de la escuela)
  fmt, hora, fechaDia, fechaLarga, fechaCorta, fechaHora, diaEscolar,
  horaSegundos, diaMes, diaMesAnio, diaMesHora, diaMesAnioHora, diaMesLargo, diaMesLargoHora,
  anio,
  // puras
  isOnline, presenceSummary, shouldAutoClose, horaDeCierre, gestorEnLinea, sanitizeText,
  minutosPresente, initial, pesoLegible, etiquetaExt, textoAdjunto,
  // permisos dentro de la sala (puros: reciben un contexto plano, no `req`)
  puedeEscribir, puedeCompartirImagen, puedeBorrarMensaje, citaDeMensaje,
  // con base
  openSession, closeSession, closeStaleSessions, postMessage, postAttachment, systemMessage,
  resolverCita, apagarCitasDe,
  touchPresence, getOpenSessions, getTodayClosed,
  // export
  csvAsistencia, csvTranscripcion,
  // El "dialecto" de CSV del proyecto (punto y coma + BOM, para el Excel en español). Se
  // exporta para que services/attendance.js arme sus planillas con el MISMO, en vez de
  // redefinir el separador y volver a discutir por qué un export abre en una sola columna.
  csvCell, csvRows,
};
