// Datos de prueba para renderizar la sala en vivo en los tests de diseños
// (tests/unit/salaDisenos.test.js). No es un test: lo comparten el test y el script que generó
// tests/fixtures/sala-clasico-antes.json (la sala Clásica tal como era ANTES de los diseños).
const path = require('path');
const raiz = path.join(__dirname, '..', '..');
const live = require(path.join(raiz, 'services', 'liveRoom'));

function sala(rol, diseno) {
  const esGestor = rol === 'docente';
  return {
    estado: 'abierta', sessionId: 's1', seq: 3, puedoEscribir: true, puedoCompartirImagen: true,
    settings: { studentsCanWrite: true, reactionsOn: true, studentsCanShareImages: true, sonido: false, sonidoDe: 'docente', diseno },
    apertura: { dia: 'jueves 24/09', desde: '08:02', hoy: true },
    presencia: { presentes: 1, total: 2, asistieron: 1,
      conectados: [{ id: 'u1', nombre: 'GÓMEZ, Laura', inicial: 'G', avatar: null, rol: 'teacher', etiqueta: 'Docente' }],
      estuvieron: [], ausentes: [{ id: 'a1', nombre: 'AGUIRRE, Nora', inicial: 'A' }] },
    mensajes: [{ id: 'm1', seq: 1, kind: 'text', autor: 'Laura Gómez', rol: 'teacher', esMio: esGestor,
      puedoBorrar: esGestor, texto: 'Hola', hora: '08:03', reacciones: [] }],
    transmision: { activa: false, micro: false, pantalla: false, camara: false, docente: '', desde: '', capaMax: '360p',
      degradadaPor: '', puedoVer: false, puedoEmitir: esGestor, soloVoz: false, vozAbierta: false, puedoHablar: esGestor,
      puedoPedirLaPalabra: false, miMano: false, manos: [], palabra: null, espectadores: 0,
      puedoAbrirVoz: esGestor, puedoAbrirVideo: esGestor },
  };
}

function locals(rol, diseno, salaDisenos) {
  const esGestor = rol === 'docente';
  return {
    course: { _id: 'c1', name: 'Matemática', students: [] }, sala: sala(rol, diseno), modo: 'visible',
    esGestor, esAlumno: !esGestor, emojis: live.EMOJIS, pollMs: 4000, enLaMateria: true,
    user: { role: esGestor ? 'teacher' : 'student', name: 'X' },
    salaDisenos,
  };
}

module.exports = { sala, locals };
