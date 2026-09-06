// Prueba un canal de salida de la verificación de contacto y muestra el error del proveedor
// TAL CUAL, sin resumir.
//
// Uso:
//   node tools/probar-canal.js --estado                       ← qué está configurado
//   node tools/probar-canal.js --email walter@gmail.com       ← manda un mail de prueba
//   node tools/probar-canal.js --celular "261 15 555-1234"    ← manda un SMS/WhatsApp de prueba
//   node tools/probar-canal.js --email walter@gmail.com --solo-conectar   ← no manda nada
//
// POR QUÉ EXISTE
// ─────────────────────────────────────────────────────────────────────────────────────────
// Es la misma lección que dejó tools/ver-subida.js: sin un instrumento, el primer "no me llegó
// el mail" en producción se diagnostica adivinando. Un fallo de SMTP puede ser la contraseña de
// aplicación vencida, el puerto bloqueado por el proveedor del VPS, el remitente rechazado por
// SPF, o el destinatario que no existe — y los cuatro se ven igual desde la pantalla del
// usuario. El proveedor sabe cuál es y lo dice; esto es lo que hace falta para escucharlo.
//
// No toca la base de datos ni crea ninguna ContactVerification: solo el envío.

require('dotenv').config();

const { CANALES, LIMITES, APP_URL, canalActivo, mensajeEmail, mensajeCelular } = require('../config/verificacion');
const { enviar }     = require('../services/canales');
const { normalizar } = require('../services/telefonoAR');

const argv = process.argv.slice(2);
const flag = (nombre) => {
  const i = argv.indexOf(nombre);
  return i === -1 ? null : (argv[i + 1] || true);
};

const SOLO_CONECTAR = argv.includes('--solo-conectar');

function estado() {
  console.log('\nCanales de verificación de contacto\n');
  for (const def of Object.values(CANALES)) {
    const activo = canalActivo(def.id);
    console.log(`  ${def.label.padEnd(20)} proveedor: ${def.proveedor.padEnd(10)} ${activo ? '✅ activo' : '⛔ apagado'}`);
  }
  console.log(`\n  APP_URL: ${APP_URL || '(sin definir)'}`);
  console.log(`  Tope diario por escuela: ${LIMITES.topeDiarioPorEscuela} envíos de celular`);
  console.log(`  NODE_ENV: ${process.env.NODE_ENV || '(sin definir)'}\n`);

  if (!canalActivo('celular')) {
    console.log('  El celular apagado NO deja la feature a medias: se verifica igual por la vía');
    console.log('  asistida, donde el preceptor confirma el número que ya conoce.\n');
  }
}

async function probarEmail(destino) {
  if (!canalActivo('email')) {
    console.error('\n⛔ El canal de correo está en "off" (VERIF_EMAIL_PROVEEDOR).\n');
    process.exit(1);
  }

  if (SOLO_CONECTAR) {
    const adaptador = require(`../services/canales/${CANALES.email.proveedor}`);
    const r = await adaptador.verificar();
    console.log(r.ok ? '\n✅ El servidor SMTP aceptó las credenciales.\n'
                     : `\n❌ ${r.error || 'no se pudo conectar'}\n`);
    process.exit(r.ok ? 0 : 1);
  }

  const codigo  = '123456';
  const url     = `${APP_URL}/verificacion/email/PRUEBA-no-sirve-para-verificar-nada`;
  const mensaje = mensajeEmail({ nombre: 'Prueba', codigo, url, escuela: null });

  console.log(`\nMandando un mail de prueba a ${destino} por ${CANALES.email.proveedor}…`);
  const r = await enviar('email', { destino, ...mensaje });

  if (r.ok) {
    console.log(`\n✅ Salió. id del proveedor: ${r.id}`);
    console.log('   Si no aparece en la bandeja, mirá spam antes de sospechar del código.\n');
  } else {
    console.error(`\n❌ El proveedor lo rechazó:\n   ${r.error}\n`);
    process.exit(1);
  }
}

async function probarCelular(crudo) {
  if (!canalActivo('celular')) {
    console.error('\n⛔ El canal de celular está en "off" (VERIF_CELULAR_PROVEEDOR).');
    console.error('   Es el default: hasta que se elija un proveedor pago, el celular se');
    console.error('   verifica por la vía asistida desde la ficha del alumno.\n');
    process.exit(1);
  }

  // La normalización primero, siempre: es donde se rompen los números argentinos, y mandarlo
  // sin mirar es pagar por un mensaje que va a ningún lado.
  const { e164, error } = normalizar(crudo);
  if (error || !e164) {
    console.error(`\n❌ "${crudo}" no se pudo interpretar como celular argentino: ${error}\n`);
    process.exit(1);
  }
  console.log(`\n"${crudo}"  →  ${e164}`);

  const mensaje = mensajeCelular({ codigo: '123456', escuela: null });
  console.log(`Mandando por ${CANALES.celular.proveedor}…`);
  const r = await enviar('celular', { destino: e164, ...mensaje });

  if (r.ok) {
    console.log(`\n✅ El proveedor lo aceptó. id: ${r.id}`);
    console.log('   Ojo: "aceptado" no es "entregado" — eso lo sabe el teléfono, no la API.\n');
  } else {
    console.error(`\n❌ El proveedor lo rechazó:\n   ${r.error}\n`);
    process.exit(1);
  }
}

async function main() {
  const email   = flag('--email');
  const celular = flag('--celular');

  if (argv.includes('--estado') || (!email && !celular)) {
    estado();
    if (!email && !celular && !argv.includes('--estado')) {
      console.log('  Nada que probar. Pasá --email <dirección> o --celular <número>.\n');
    }
    return;
  }

  if (email)   await probarEmail(String(email));
  if (celular) await probarCelular(String(celular));
}

main().catch((err) => {
  console.error('\n❌', err.message, '\n');
  process.exit(1);
});
