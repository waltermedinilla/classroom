// Tests de la lógica pura de la asistencia de preceptoría (services/attendance.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Estas funciones se testean acá y no con un smoke HTTP por dos motivos:
//   - Dependen del PASO DEL TIEMPO (el autocierre al cambiar el día, el vencimiento de la
//     ventana): hay que poder inyectar el `now`, cosa que una request real no permite sin
//     esperar a mañana.
//   - Dependen de la ZONA HORARIA de la escuela, y el bug que más caro sale en esta feature
//     es justamente ese: producción corre en UTC (ver agente.md:451). El smoke corre en la
//     máquina del desarrollador, con su zona; acá se fija.
//
// Cubren los criterios CA-01 a CA-07 de specs/asistencia-preceptoria.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  diaEscolar, normalizarEstado, resumen, shouldAutoClose, puedeAutoMarcarse, esCorreccion,
  rangoValido, rangoDelMes, porcentajeAsistencia, csvAsistenciaDia, csvAsistenciaMes,
  calcularCierre, ESTADOS, CIERRE_MAX_MIN,
} = require('../../services/attendance');

// ── CA-01: el día escolar se calcula en la zona de la escuela ────────────────
//
// Buenos Aires es UTC−3. Los tres casos de abajo son el mismo instante visto de las dos
// formas: si alguien reemplaza diaEscolar() por toISOString().slice(0,10), los dos primeros
// pasan a decir '2026-08-11' y toda la asistencia de una noche se archiva en el día
// equivocado — con el índice único de RN-01 dejando abrir una segunda toma "del mismo día".

test('diaEscolar: las 01:30 UTC todavía son el día anterior en la escuela', () => {
  assert.strictEqual(diaEscolar(new Date('2026-08-11T01:30:00Z')), '2026-08-10');
});

test('diaEscolar: las 02:30 UTC (23:30 local) siguen siendo el día anterior', () => {
  assert.strictEqual(diaEscolar(new Date('2026-08-11T02:30:00Z')), '2026-08-10');
});

test('diaEscolar: las 03:30 UTC ya son el día siguiente en la escuela', () => {
  assert.strictEqual(diaEscolar(new Date('2026-08-11T03:30:00Z')), '2026-08-11');
});

test('diaEscolar: una mañana de clase cualquiera', () => {
  // 07:30 de Buenos Aires = 10:30 UTC. La hora a la que se abre la toma de verdad.
  assert.strictEqual(diaEscolar(new Date('2026-08-10T10:30:00Z')), '2026-08-10');
});

test('diaEscolar: el formato es siempre YYYY-MM-DD, con ceros a la izquierda', () => {
  assert.strictEqual(diaEscolar(new Date('2026-03-05T15:00:00Z')), '2026-03-05');
  assert.match(diaEscolar(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});

// ── CA-02: normalización del estado que llega del body ───────────────────────

test('normalizarEstado: acepta los cuatro estados válidos', () => {
  for (const e of ESTADOS) assert.strictEqual(normalizarEstado(e), e);
});

test('normalizarEstado: rechaza todo lo demás con null', () => {
  const basura = ['PRESENTE', 'Presente', '', '   ', 'ausenteee', 'presente; DROP',
                  null, undefined, 0, 1, {}, [], true];
  for (const v of basura) {
    assert.strictEqual(normalizarEstado(v), null, `debería rechazar ${JSON.stringify(v)}`);
  }
});

// ── CA-03 y CA-04: el resumen de la grilla ───────────────────────────────────

const marca = (status) => ({ status });
const nomina = (conteos) => Object.entries(conteos)
  .flatMap(([estado, n]) => Array.from({ length: n }, () => marca(estado === 'null' ? null : estado)));

test('resumen: cuenta cada estado y el total', () => {
  const marcas = nomina({ presente: 18, tarde: 2, justificado: 1, null: 4 });
  const r = resumen(marcas);

  assert.strictEqual(r.presentes,    18);
  assert.strictEqual(r.tarde,        2);
  assert.strictEqual(r.ausentes,     0);
  assert.strictEqual(r.justificados, 1);
  assert.strictEqual(r.sinMarcar,    4);
  assert.strictEqual(r.total,        25);
});

test('resumen: la suma de los estados es siempre el total', () => {
  const marcas = nomina({ presente: 10, tarde: 3, ausente: 5, justificado: 2, null: 1 });
  const r = resumen(marcas);
  assert.strictEqual(
    r.presentes + r.tarde + r.ausentes + r.justificados + r.sinMarcar, r.total);
});

test('resumen: una nómina vacía da todo en cero, sin NaN', () => {
  const r = resumen([]);
  for (const [clave, valor] of Object.entries(r)) {
    assert.strictEqual(valor, 0, `${clave} debería ser 0`);
    assert.ok(!Number.isNaN(valor), `${clave} no puede ser NaN`);
  }
});

test('resumen: sin argumento tampoco rompe', () => {
  assert.strictEqual(resumen().total, 0);
});

// ── CA-05: autocierre al cambiar el día ──────────────────────────────────────

const toma = (extra = {}) => ({ date: '2026-08-10', closedAt: null, ...extra });

test('shouldAutoClose: una toma de ayer se cierra sola', () => {
  assert.strictEqual(shouldAutoClose(toma({ date: '2026-08-09' }), '2026-08-10'), true);
});

test('shouldAutoClose: la toma de hoy sigue abierta', () => {
  assert.strictEqual(shouldAutoClose(toma(), '2026-08-10'), false);
});

test('shouldAutoClose: una toma ya cerrada nunca se vuelve a evaluar', () => {
  const cerrada = toma({ date: '2026-08-09', closedAt: new Date('2026-08-09T20:00:00Z') });
  assert.strictEqual(shouldAutoClose(cerrada, '2026-08-10'), false);
});

test('shouldAutoClose: sin toma no rompe', () => {
  assert.strictEqual(shouldAutoClose(null, '2026-08-10'), false);
  assert.strictEqual(shouldAutoClose(undefined, '2026-08-10'), false);
});

// ── CA-06: ¿el alumno puede marcarse ahora? ──────────────────────────────────
//
// Es la guarda de RN-07. Se testea con `now` inyectado porque el caso que importa —la
// ventana que venció mientras el preceptor no estaba— no se puede provocar en una request.

const AHORA = new Date('2026-08-10T10:30:00Z');   // 07:30 en la escuela
const enMin = (m) => new Date(AHORA.getTime() + m * 60000);

const ventana = (extra = {}) => ({
  date: '2026-08-10', closedAt: null, mode: 'ventana',
  settings: { selfCheckin: true }, closesAt: null, ...extra,
});

test('puedeAutoMarcarse: ventana abierta sin hora de cierre', () => {
  assert.strictEqual(puedeAutoMarcarse(ventana(), AHORA), true);
});

test('puedeAutoMarcarse: ventana abierta con cierre todavía futuro', () => {
  assert.strictEqual(puedeAutoMarcarse(ventana({ closesAt: enMin(45) }), AHORA), true);
});

test('puedeAutoMarcarse: la hora de cierre ya pasó', () => {
  // La ventana se cierra sola para el alumno aunque el preceptor no haya apretado "Cerrar".
  assert.strictEqual(puedeAutoMarcarse(ventana({ closesAt: enMin(-1) }), AHORA), false);
});

test('puedeAutoMarcarse: la toma está cerrada', () => {
  assert.strictEqual(puedeAutoMarcarse(ventana({ closedAt: AHORA }), AHORA), false);
});

test('puedeAutoMarcarse: la autoasistencia está apagada (modo pase de lista)', () => {
  assert.strictEqual(
    puedeAutoMarcarse(ventana({ mode: 'pase', settings: { selfCheckin: false } }), AHORA), false);
});

test('puedeAutoMarcarse: sin toma, o sin settings, no rompe', () => {
  assert.strictEqual(puedeAutoMarcarse(null, AHORA), false);
  assert.strictEqual(puedeAutoMarcarse({ closedAt: null }, AHORA), false);
});

// ── CA-07: ¿marcar esto es una corrección? ───────────────────────────────────
//
// Decide qué se audita (RN-13): pisar una marca ya puesta sí, poner la primera no.

test('esCorreccion: una marca sin estado no es corrección', () => {
  assert.strictEqual(esCorreccion({ status: null }), false);
  assert.strictEqual(esCorreccion({}), false);
  assert.strictEqual(esCorreccion(null), false);
});

test('esCorreccion: pisar cualquiera de los cuatro estados sí lo es', () => {
  for (const e of ESTADOS) {
    assert.strictEqual(esCorreccion({ status: e }), true, `${e} debería contar como corrección`);
  }
});

test('esCorreccion: el ausente que dejó el cierre NO es una corrección', () => {
  // Nadie lo decidió: es el valor por defecto de quien no fue marcado. Si contara, pasar
  // lista otra vez a la tarde generaría 30 eventos de auditoría por curso.
  assert.strictEqual(esCorreccion({ status: 'ausente', source: 'cierre' }), false);
  assert.strictEqual(esCorreccion({ status: 'ausente', source: 'preceptor' }), true);
  assert.strictEqual(esCorreccion({ status: 'presente', source: 'alumno' }), true);
});

// ── La hora de cierre de la ventana ──────────────────────────────────────────
//
// Se pide en MINUTOS, no como hora del reloj: un "08:15" tipeado en el navegador se
// interpreta con la zona de esa máquina, y las del aula tienen cualquiera configurada.

const T0 = new Date('2026-08-10T10:30:00Z').getTime();   // 07:30 en la escuela
const enMinutos = (d) => Math.round((d.getTime() - T0) / 60000);

test('calcularCierre: los minutos pedidos se suman a la hora actual', () => {
  assert.strictEqual(enMinutos(calcularCierre('45', T0)), 45);
  assert.strictEqual(enMinutos(calcularCierre(120, T0)), 120);
});

test('calcularCierre: el tope son 6 horas', () => {
  assert.strictEqual(CIERRE_MAX_MIN, 360);
  assert.strictEqual(enMinutos(calcularCierre('360', T0)), 360);
});

test('calcularCierre: pedir más del tope RECORTA, no deja la ventana sin cierre', () => {
  // Es la diferencia que importa: ignorar el valor dejaría la ventana abierta hasta el
  // cambio de día, o sea lo contrario de lo que quiso quien pidió 10 horas.
  assert.strictEqual(enMinutos(calcularCierre('600', T0)), 360);
  assert.strictEqual(enMinutos(calcularCierre(99999, T0)), 360);
});

test('calcularCierre: vacío o basura = "no cerrarla sola"', () => {
  for (const v of ['', null, undefined, 'ninguna', 0, -30, {}, []]) {
    assert.strictEqual(calcularCierre(v, T0), null, `debería no cerrar sola con ${JSON.stringify(v)}`);
  }
});

// ── CA-47: el rango del historial y del export ───────────────────────────────
//
// Es la guarda que impide disparar una consulta sin límites contra la colección más grande
// del sistema (una marca por alumno, por día, por año).

test('rangoValido: acepta un rango bien escrito', () => {
  assert.deepStrictEqual(rangoValido('2026-08-01', '2026-08-31'),
    { desde: '2026-08-01', hasta: '2026-08-31' });
});

test('rangoValido: un solo día es un rango válido', () => {
  assert.deepStrictEqual(rangoValido('2026-08-10', '2026-08-10'),
    { desde: '2026-08-10', hasta: '2026-08-10' });
});

test('rangoValido: rechaza el rango invertido', () => {
  assert.strictEqual(rangoValido('2026-08-31', '2026-08-01'), null);
});

test('rangoValido: rechaza cualquier cosa que no sea YYYY-MM-DD', () => {
  const basura = ['10/08/2026', '2026-8-1', '', null, undefined, 20260810, {},
                  '2026-08-01T00:00:00Z', "2026-08-01'; DROP"];
  for (const v of basura) {
    assert.strictEqual(rangoValido(v, '2026-08-31'), null, `debería rechazar ${JSON.stringify(v)}`);
    assert.strictEqual(rangoValido('2026-08-01', v), null, `debería rechazar ${JSON.stringify(v)}`);
  }
});

test('rangoDelMes: del primero del mes al día de hoy', () => {
  assert.deepStrictEqual(rangoDelMes('2026-08-10'), { desde: '2026-08-01', hasta: '2026-08-10' });
  assert.deepStrictEqual(rangoDelMes('2026-01-01'), { desde: '2026-01-01', hasta: '2026-01-01' });
});

// ── Porcentaje de asistencia ─────────────────────────────────────────────────

test('porcentajeAsistencia: la llegada tarde cuenta como que asistió', () => {
  // 8 presentes + 2 tarde de 10 días = 100%: el chico estuvo en la escuela los 10 días.
  assert.strictEqual(
    porcentajeAsistencia({ presentes: 8, tarde: 2, ausentes: 0, justificados: 0 }), 100);
});

test('porcentajeAsistencia: el justificado NO cuenta como asistencia', () => {
  // Justificado es una falta con motivo, no una presencia.
  assert.strictEqual(
    porcentajeAsistencia({ presentes: 8, tarde: 0, ausentes: 1, justificados: 1 }), 80);
});

test('porcentajeAsistencia: sin días tomados da 0, no NaN', () => {
  const r = porcentajeAsistencia({ presentes: 0, tarde: 0, ausentes: 0, justificados: 0 });
  assert.strictEqual(r, 0);
  assert.ok(!Number.isNaN(r));
});

// ── Los dos CSV ──────────────────────────────────────────────────────────────
//
// El destino real es Excel en español: separador `;` y BOM al principio. Con coma, todo el
// archivo abre en una sola columna — es el mismo criterio que los CSV de la sala en vivo.

const BOM = '﻿';

test('csvAsistenciaDia: BOM, punto y coma, y una fila por alumno', () => {
  const csv = csvAsistenciaDia([
    { studentName: 'PEREZ, Ana', studentDni: '50111222', status: 'presente',
      markedAt: new Date('2026-08-10T10:42:00Z'), source: 'alumno', note: '' },
    { studentName: 'GOMEZ, Luis', studentDni: '50333444', status: 'justificado',
      markedAt: new Date('2026-08-10T11:00:00Z'), source: 'preceptor', note: 'Certificado' },
    { studentName: 'SIN MARCAR, Juan', studentDni: '', status: null,
      markedAt: null, source: null, note: '' },
  ]);

  assert.ok(csv.startsWith(BOM), 'el CSV tiene que empezar con BOM');
  const filas = csv.slice(1).split('\r\n');
  assert.strictEqual(filas.length, 4, 'encabezado + 3 alumnos');
  assert.ok(filas[0].startsWith('Alumno;DNI;Estado;'), `encabezado inesperado: ${filas[0]}`);
  assert.ok(filas[1].includes('El propio alumno'), 'debería decir quién puso la marca');
  assert.ok(filas[1].includes('07:42'), 'la hora va en la zona de la escuela, no en UTC');
  assert.ok(filas[2].includes('Justificado') && filas[2].includes('Certificado'));
  assert.ok(filas[3].includes('Sin marcar'), 'el que no tiene estado se dice con todas las letras');
});

test('csvAsistenciaDia: una celda con punto y coma se escapa con comillas', () => {
  const csv = csvAsistenciaDia([
    { studentName: 'PEREZ, Ana', studentDni: '1', status: 'justificado',
      markedAt: null, source: 'preceptor', note: 'Turno médico; vuelve el lunes' },
  ]);
  assert.ok(csv.includes('"Turno médico; vuelve el lunes"'),
    'sin comillas, el punto y coma de la nota partiría la fila en dos columnas');
});

test('csvAsistenciaMes: una columna por día y los totales al final', () => {
  const historial = {
    fechas: ['2026-08-03', '2026-08-04', '2026-08-05'],
    alumnos: [
      { nombre: 'PEREZ, Ana', dni: '50111222',
        porDia: { '2026-08-03': 'presente', '2026-08-04': 'tarde', '2026-08-05': 'ausente' },
        presentes: 1, tarde: 1, ausentes: 1, justificados: 0, porcentaje: 66.7 },
      { nombre: 'GOMEZ, Luis', dni: '50333444',
        porDia: { '2026-08-03': 'presente' },   // no estuvo en las otras dos tomas
        presentes: 1, tarde: 0, ausentes: 0, justificados: 0, porcentaje: 100 },
    ],
  };
  const filas = csvAsistenciaMes(historial).slice(1).split('\r\n');
  const cols = (f) => f.split(';');

  assert.deepStrictEqual(cols(filas[0]).slice(0, 5),
    ['Alumno', 'DNI', '2026-08-03', '2026-08-04', '2026-08-05']);
  assert.deepStrictEqual(cols(filas[1]).slice(2, 5), ['P', 'T', 'A']);
  assert.strictEqual(cols(filas[1])[9], '66,7',
    'el porcentaje va con coma decimal, que es lo que espera el Excel en español');
  assert.deepStrictEqual(cols(filas[2]).slice(2, 5), ['P', '', ''],
    'un día sin marca para ese alumno queda vacío, no en cero');
  assert.ok(filas.some(f => f.includes('P = presente')), 'falta la referencia al pie');
});

test('csvAsistenciaMes: sin alumnos no rompe y conserva el encabezado', () => {
  const csv = csvAsistenciaMes({ fechas: [], alumnos: [] });
  assert.ok(csv.startsWith(BOM));
  assert.ok(csv.includes('Alumno;DNI;Presentes'));
});
