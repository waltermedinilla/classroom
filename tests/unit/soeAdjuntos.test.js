// Tests del material del legajo: archivos y enlaces (services/soeAdjuntos.js).
// Correr con: npm run test:unit
//
// Por qué acá y no en un smoke HTTP: estas funciones deciden QUÉ archivo entra al servidor y
// QUÉ enlace se le ofrece al gabinete para hacer clic. Probarlo por HTTP obligaría a fabricar
// un archivo por cada extensión imaginable; acá se prueban las tres listas y la lista blanca
// de esquemas en una tarde de nadie.
//
// Cubren los criterios 1 a 12 de specs/soe-adjuntos-y-agenda.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const adj = require('../../services/soeAdjuntos');

describe('qué archivos entran', () => {
  test('⭐ nada ejecutable ni interpretable como HTML (criterio 1)', () => {
    // La tercera de las tres preguntas obligatorias por formato nuevo del proyecto. Un .svg o
    // un .html subido por un usuario y servido de vuelta es código que corre en la sesión de
    // quien lo abre; un .exe es un ejecutable que la escuela distribuye con su propio dominio.
    const prohibidos = [
      '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.sh',
      '.js', '.mjs', '.html', '.htm', '.svg', '.xhtml', '.jar', '.apk',
      // Los macros de AutoCAD, que ya están en la lista negra de subidaPlanos.test.js.
      '.lsp', '.fas', '.vlx', '.dvb',
    ];
    for (const ext of prohibidos) {
      assert.ok(!adj.EXT_ADJUNTOS.includes(ext), `${ext} NO puede estar permitido`);
      assert.ok(!adj.extensionPermitida(`certificado${ext}`), `${ext} tendría que rebotar`);
    }
  });

  test('entra lo que trae la familia: PDF, Word, y sobre todo fotos (criterio 2)', () => {
    // La foto del certificado sacada con el celular en la puerta del consultorio es el caso
    // más frecuente de todos, no una excepción.
    for (const ext of ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp']) {
      assert.ok(adj.extensionPermitida(`papel${ext}`), `${ext} debería entrar`);
    }
  });

  test('el .zip queda afuera a propósito (criterio 3)', () => {
    // En las otras nueve listas del proyecto está, para que el docente suba un trabajo
    // práctico entero. Acá un contenedor opaco es material que nadie va a poder leer dentro
    // de un año sin bajarlo y descomprimirlo, que es lo contrario de para qué existe el legajo.
    assert.ok(!adj.EXT_ADJUNTOS.includes('.zip'));
    // Y los planos de las materias técnicas tampoco: no tienen nada que hacer en un legajo
    // psicopedagógico.
    assert.ok(!adj.EXT_ADJUNTOS.includes('.dwg'));
    assert.ok(!adj.EXT_ADJUNTOS.includes('.dxf'));
  });

  test('la extensión se lee sin distinguir mayúsculas y sin confiar en el resto del nombre', () => {
    assert.strictEqual(adj.extensionDe('CERTIFICADO.PDF'), '.pdf');
    assert.strictEqual(adj.extensionDe('receta.final.JPG'), '.jpg');
    assert.strictEqual(adj.extensionDe('sin_extension'), '');
    // El clásico intento de disfrazar: lo que vale es la ÚLTIMA extensión.
    assert.ok(!adj.extensionPermitida('certificado.pdf.exe'));
    assert.ok(adj.extensionPermitida('informe.exe.pdf'));
  });
});

describe('el accept del formulario', () => {
  test('⭐ .heic y .heif NO van en el accept, aunque el servidor los acepte (criterio 4)', () => {
    // Safari en iOS mira el `accept` para decidir qué manda: con la lista sin HEIC convierte
    // la foto a JPG en el camino. Nombrarlas ahí es pedirle al teléfono justo el formato que
    // después nadie puede abrir desde la computadora del gabinete. Es la misma decisión que
    // documenta config/imagePresets.js, tomada por el usuario el 2026-08-24.
    assert.ok(!adj.ACCEPT_ADJUNTOS.includes('.heic'));
    assert.ok(!adj.ACCEPT_ADJUNTOS.includes('.heif'));

    // Pero del lado del servidor sí entran: un HEIC que llegue igual —desde la app Archivos,
    // desde un navegador de terceros— se guarda, en vez de rebotar con un cartel que no
    // explica nada.
    assert.ok(adj.extensionPermitida('foto.heic'));
    assert.ok(adj.extensionPermitida('foto.HEIF'));
  });

  test('todo lo que ofrece el accept lo acepta el servidor', () => {
    // Al revés sería un rechazo en la cara de alguien que eligió el archivo desde el propio
    // explorador que le abrió el formulario.
    for (const ext of adj.ACCEPT_ADJUNTOS.split(',')) {
      assert.ok(adj.EXT_ADJUNTOS.includes(ext), `${ext} está en el accept pero no en la lista`);
    }
  });
});

describe('qué se abre adentro del navegador', () => {
  test('el .txt se descarga y no se muestra en línea (criterio 5)', () => {
    // Es texto plano subido por un usuario y servido de vuelta: la familia de la que hay que
    // desconfiar. Servido como adjunto no puede ser otra cosa que un archivo que se baja.
    assert.ok(adj.EXT_ADJUNTOS.includes('.txt'));
    assert.ok(!adj.seVeEnLinea('.txt'));
  });

  test('el PDF y las imágenes sí (es lo que el gabinete espera al tocarlas)', () => {
    for (const ext of ['.pdf', '.jpg', '.png', '.webp']) {
      assert.ok(adj.seVeEnLinea(ext), `${ext} debería verse en línea`);
    }
    // Un .docx no se abre en el navegador: forzar la descarga evita cualquier discusión
    // sobre qué hace el visor con él.
    assert.ok(!adj.seVeEnLinea('.docx'));
  });

  test('todo lo que se ve en línea está permitido', () => {
    for (const ext of adj.VER_EN_LINEA) {
      assert.ok(adj.EXT_ADJUNTOS.includes(ext), `${ext} se serviría inline sin poder subirse`);
    }
  });
});

describe('enlaces', () => {
  test('⭐ solo http y https (criterio 6)', () => {
    // `javascript:` y `data:` convierten un enlace guardado en la base en código que corre en
    // la sesión de quien lo toca. Un legajo dura años y esta lista blanca cuesta cuatro líneas.
    for (const malo of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
    ]) {
      assert.strictEqual(adj.normalizarEnlace(malo), '', `debería rechazar: ${malo}`);
    }
  });

  test('sin esquema se asume https', () => {
    // La gente pega "hospital.gob.ar/turnos". Esperar que escriba el https:// es pedirle que
    // sepa algo que no tiene por qué saber.
    assert.strictEqual(adj.normalizarEnlace('hospital.gob.ar/turnos'), 'https://hospital.gob.ar/turnos');
    assert.strictEqual(adj.normalizarEnlace('  hospital.gob.ar  '), 'https://hospital.gob.ar/');
    assert.ok(adj.normalizarEnlace('http://intranet.local/informe').startsWith('http://'));
  });

  test('vacío, basura y desmesurado devuelven cadena vacía', () => {
    // '' y no null ni el original: el llamador lo trata como "no vino ningún enlace", que es
    // el mismo camino que un campo en blanco.
    assert.strictEqual(adj.normalizarEnlace(''), '');
    assert.strictEqual(adj.normalizarEnlace(null), '');
    assert.strictEqual(adj.normalizarEnlace(undefined), '');
    assert.strictEqual(adj.normalizarEnlace('https://' + 'a'.repeat(3000)), '');
  });

  test('el dominio se muestra sin el www', () => {
    assert.strictEqual(adj.dominioDe('https://www.hospital.gob.ar/turnos'), 'hospital.gob.ar');
    assert.strictEqual(adj.dominioDe('no es una url'), '');
  });
});

describe('agrupar por actuación', () => {
  const CERT   = { _id: 'a1', titulo: 'Certificado', fecha: new Date('2026-05-10'), ancla: { tipo: 'devolucion', id: 'v1' } };
  const RECETA = { _id: 'a2', titulo: 'Receta',      fecha: new Date('2026-05-20'), ancla: { tipo: 'devolucion', id: 'v1' } };
  const NOTA   = { _id: 'a3', titulo: 'Nota',        fecha: new Date('2026-03-01'), ancla: { tipo: 'entrada', id: 'e1' } };
  const SUELTO = { _id: 'a4', titulo: 'Informe',     fecha: new Date('2026-04-01'), ancla: { tipo: 'legajo', id: null } };

  test('cada papel queda bajo la clave de su actuación (criterio 7)', () => {
    const mapa = adj.agruparPorAncla([CERT, NOTA, RECETA, SUELTO]);
    assert.strictEqual(mapa.get(adj.claveAncla('devolucion', 'v1')).length, 2);
    assert.strictEqual(mapa.get(adj.claveAncla('entrada', 'e1')).length, 1);
    assert.strictEqual(mapa.get(adj.claveAncla('legajo', null)).length, 1);
  });

  test('la clave incluye el TIPO y no solo el id (criterio 8)', () => {
    // Los ids de subdocumento son únicos por array, no por documento: nada impide que una
    // entrada y una citación compartan el mismo _id. Con la clave por id pelado, el acta de
    // la citación aparecería colgada de la entrevista.
    const choque = [
      { _id: 'x1', fecha: new Date('2026-01-01'), ancla: { tipo: 'entrada',  id: 'MISMO' } },
      { _id: 'x2', fecha: new Date('2026-01-02'), ancla: { tipo: 'citacion', id: 'MISMO' } },
    ];
    const mapa = adj.agruparPorAncla(choque);
    assert.strictEqual(mapa.get(adj.claveAncla('entrada', 'MISMO')).length, 1);
    assert.strictEqual(mapa.get(adj.claveAncla('citacion', 'MISMO')).length, 1);
  });

  test('adentro de cada grupo, lo más nuevo primero', () => {
    const mapa = adj.agruparPorAncla([CERT, RECETA]);
    const grupo = mapa.get(adj.claveAncla('devolucion', 'v1'));
    assert.strictEqual(grupo[0].titulo, 'Receta');  // 20 de mayo
    assert.strictEqual(grupo[1].titulo, 'Certificado');
  });

  test('un adjunto sin ancla cae en el cajón del legajo, no se pierde', () => {
    const mapa = adj.agruparPorAncla([{ _id: 'z', fecha: new Date('2026-01-01') }]);
    assert.strictEqual(mapa.get(adj.claveAncla('legajo', null)).length, 1);
  });

  test('lista vacía o ausente no rompe', () => {
    assert.strictEqual(adj.agruparPorAncla([]).size, 0);
    assert.strictEqual(adj.agruparPorAncla(null).size, 0);
    assert.strictEqual(adj.agruparPorAncla([null, undefined]).size, 0);
  });
});

describe('la baja deja rastro', () => {
  test('⭐ el adjunto dado de baja NO desaparece de la lista (criterio 9)', () => {
    // Es la mitad de lo que hace que esto sea un registro y no una carpeta: un legajo del que
    // se puede sacar material sin dejar rastro no es un registro completo. Lo que desaparece
    // es el archivo del disco, no el renglón.
    const lista = [
      { _id: 'a1', titulo: 'Vigente', fecha: new Date('2026-01-02') },
      { _id: 'a2', titulo: 'De baja', fecha: new Date('2026-01-01'), eliminadoEl: new Date('2026-02-01') },
    ];
    assert.strictEqual(adj.ordenarAdjuntos(lista).length, 2);
    assert.strictEqual(adj.vigentes(lista).length, 1);
    assert.strictEqual(adj.vigentes(lista)[0].titulo, 'Vigente');
    // Y el legajo con SOLO material dado de baja no cuenta como que tiene material.
    assert.strictEqual(adj.tieneMaterial([lista[1]]), false);
    assert.strictEqual(adj.tieneMaterial(lista), true);
  });
});

describe('catálogos', () => {
  test('cada categoría tiene etiqueta e ícono', () => {
    // Sin ícono el chip sale con el nombre del icono en inglés al lado del control, que es el
    // modo de falla silencioso de la fuente recortada (ver tests/unit/iconos.test.js).
    for (const c of adj.CATEGORIAS) {
      assert.ok(adj.CATEGORIA_LABELS[c], `falta la etiqueta de ${c}`);
      assert.ok(adj.CATEGORIA_ICONS[c],  `falta el ícono de ${c}`);
    }
  });

  test('cada origen tiene etiqueta, y dicen QUIÉN LO PRODUJO', () => {
    for (const o of adj.ORIGENES) {
      assert.ok(adj.ORIGEN_LABELS[o], `falta la etiqueta de ${o}`);
      assert.ok(adj.ORIGEN_ICONS[o],  `falta el ícono de ${o}`);
    }
    // El profesional externo y la familia tienen que estar: son las dos formas en que llega
    // un certificado a la escuela, y confundirlas con el gabinete haría que dentro de un año
    // el legajo dijera que el certificado lo escribió la psicopedagoga.
    assert.ok(adj.ORIGENES.includes('profesional'));
    assert.ok(adj.ORIGENES.includes('familia'));
    assert.ok(adj.ORIGENES.includes('alumno'));
  });

  test('las anclas cubren las cuatro actuaciones más el legajo (criterio 10)', () => {
    assert.deepStrictEqual(adj.ANCLAS.slice().sort(),
      ['citacion', 'derivacion', 'devolucion', 'entrada', 'legajo']);
    for (const a of adj.ANCLAS) assert.ok(adj.ANCLA_LABELS[a], `falta la etiqueta de ${a}`);
  });
});

describe('peso legible', () => {
  test('con coma decimal, como se escribe en castellano', () => {
    assert.strictEqual(adj.pesoLegible(2500000), '2,4 MB');
    assert.strictEqual(adj.pesoLegible(120000), '117 KB');
    assert.strictEqual(adj.pesoLegible(800), '800 B');
  });

  test('un tamaño ausente o absurdo no imprime "NaN"', () => {
    // Estos textos van directo a la pantalla: un enlace no tiene tamaño y no puede mostrar
    // "undefined B" al lado del título.
    for (const v of [0, -1, null, undefined, 'grande', NaN]) {
      assert.strictEqual(adj.pesoLegible(v), '');
    }
  });
});

describe('el techo de tamaño', () => {
  test('20 MB, el mismo que el resto del proyecto (criterio 11)', () => {
    assert.strictEqual(adj.MAX_ADJUNTO_BYTES, 20 * 1024 * 1024);
  });
});
