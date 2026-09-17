// Lo que se le DICE a una persona cuando una fusión de cuentas le apaga una de las dos.
// Sin base de datos: services/dbFixes.js escribe, routes/auth.js contesta, y esto decide el texto.
//
// Spec: specs/fusion-de-cuentas.spec.md, Fase 1b (RN-16 y RN-17).
// Tests: tests/unit/avisoFusion.test.js.
//
// El aviso va por DOS lados porque la persona puede llegar por dos lados. Si entra por la cuenta
// que se conservó, lee el mensaje. Si prueba con la que se apagó —que es lo más probable: es la
// que venía usando—, choca con el login. Hasta la Fase 1b ese login contestaba "Contactá al
// administrador" y nada más, y el mensaje quedaba en una bandeja que no podía abrir.

// El texto de siempre para una cuenta deshabilitada. Es el que siguen viendo todas las que NO
// vienen de una fusión: cambiarlo de paso sería un cambio que nadie pidió.
const TEXTO_DESHABILITADA = 'Tu cuenta está deshabilitada. Contactá al administrador.';

const ASUNTO = 'Tus dos cuentas quedaron unificadas';

// `l••••@gmail.com`. Decisión aprobada el 2026-09-16 (RN-13): el muro lo ve cualquiera que
// acierte la contraseña de la cuenta apagada, y para reconocer "ah, mi gmail" alcanza con la
// primera letra y el dominio.
//
// - El dominio va ENTERO: es justo lo que distingue "mi gmail" de "la institucional", que es la
//   duda que tiene el chico.
// - Los puntos son siempre cuatro: si fueran uno por letra, el largo delataría el usuario.
// - Un usuario de una sola letra no deja la letra: "primera letra + ••••" lo mostraría entero.
function enmascararCorreo(correo) {
  const limpio = String(correo || '').trim().toLowerCase();
  const arroba = limpio.indexOf('@');
  if (arroba <= 0) return '••••';
  const usuario = limpio.slice(0, arroba);
  const dominio = limpio.slice(arroba + 1);
  const inicio  = usuario.length > 1 ? usuario[0] : '';
  return `${inicio}••••@${dominio}`;
}

// Lo que contesta POST /login a una cuenta deshabilitada, con la contraseña correcta.
//
// `conservada` es la cuenta a la que apunta `mergedInto` ({ email, active }), o null si la
// cuenta no viene de una fusión o si esa cuenta ya no existe. El muro solo habla cuando puede
// mandar a la persona a un lugar donde SÍ va a poder entrar: mandarla a una cuenta que también
// está deshabilitada es peor que no decirle nada.
function textoLoginDeshabilitada(conservada) {
  if (!conservada || conservada.active === false || !conservada.email) return TEXTO_DESHABILITADA;
  return 'Esta cuenta se unificó con otra que tiene tu mismo DNI. ' +
         `Desde ahora entrá con ${enmascararCorreo(conservada.email)}.`;
}

// El mensaje que recibe la cuenta que se conserva. Acá los correos van COMPLETOS: lo lee el
// dueño, ya logueado en su cuenta.
//
// `correoConservada` es el correo FINAL, el que quedó después de un intercambio de correos si lo
// hubo: es el que el chico tiene que escribir en el login.
//
// `correoApagada` es un correo, o una lista cuando la fusión apaga más de una cuenta usada (un
// grupo de tres). Es texto plano: la mensajería no interpreta Markdown, así que nada de `**`.
//
// `cuentasEnElGrupo` es cuántas cuentas tenía la persona. Hace falta porque en un grupo de tres
// puede avisarse por una sola (la otra ya estaba apagada de antes): sin el dato, el texto decía
// "Tenías dos cuentas… La otra (x)", y eran tres. Si no se pasa, se asume que se avisa por todas
// las que no son la conservada.
function mensajeDeFusion({ correoConservada, correoApagada, cuentasEnElGrupo } = {}) {
  const apagadas = [].concat(correoApagada || []).filter(Boolean);
  if (!correoConservada || !apagadas.length) {
    throw new Error('El aviso de fusión necesita los dos correos: el de la cuenta que queda y el de la que se apagó.');
  }
  const total = Math.max(cuentasEnElGrupo || 0, apagadas.length + 1);
  const tenias = total === 2 ? 'dos cuentas' : `${total} cuentas`;
  // "La otra" solo cuando de verdad son TODAS las demás; si no, se nombra sin artículo.
  const sonTodas = apagadas.length === total - 1;
  const otras = sonTodas
    ? (apagadas.length === 1
        ? `La otra (${apagadas[0]}) quedó deshabilitada y ya no deja entrar. `
        : `Las otras (${apagadas.join(' y ')}) quedaron deshabilitadas y ya no dejan entrar. `)
    : (apagadas.length === 1
        ? `Se deshabilitó ${apagadas[0]}, que ya no deja entrar. `
        : `Se deshabilitaron ${apagadas.join(' y ')}, que ya no dejan entrar. `);
  return {
    subject: ASUNTO,
    body:
      `Tenías ${tenias} en la plataforma con tu mismo DNI. ` +
      `Desde ahora usás solo esta: entrás con ${correoConservada}. ` +
      otras +
      'No se borró nada. Si algo no te cierra, respondé este mensaje.',
  };
}

module.exports = {
  TEXTO_DESHABILITADA,
  ASUNTO,
  enmascararCorreo,
  textoLoginDeshabilitada,
  mensajeDeFusion,
};
