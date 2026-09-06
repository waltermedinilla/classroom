// Normalización de celulares argentinos a E.164 (`+5492615551234`), que es el ÚNICO formato
// que entiende un proveedor de SMS o la API de WhatsApp.
//
// POR QUÉ EXISTE ESTE ARCHIVO Y NO ALCANZA CON sanitizePhone()
// ─────────────────────────────────────────────────────────────────────────────────────────
// `sanitizePhone()` (routes/courses.js) contesta "¿tiene forma de teléfono?" y guarda el texto
// TAL CUAL lo escribió la persona, porque eso es lo que después lee un humano en la ficha y lo
// que arma el link `tel:` / `wa.me/` de views/partials/contact-info.ejs. Todas estas están bien
// para él, y son la misma línea:
//
//     (261) 15 555-1234     261 155551234     0261 15 555 1234     +54 9 261 555 1234
//
// Para mandar un mensaje, en cambio, solo la última existe. Y Argentina es probablemente el
// peor caso del planeta para esta conversión, por DOS particularidades que se pisan entre sí:
//
//   • el «15» que se marca localmente para llamar a un celular y que NO va en el internacional;
//   • el «9» que sí va después del +54 para celulares, y que NO va para fijos.
//
// Con lo cual `+54 261 15 555-1234` está mal de dos formas distintas a la vez — y es exactamente
// lo que la gente escribe, porque mezcla el prefijo internacional con el marcado local.
//
// LA DECISIÓN: `User.phone` NO SE TOCA. Sigue siendo el texto libre que ya es y que ya se
// muestra en media docena de pantallas. Al lado se guarda `User.phoneE164`, que es lo que sale
// de acá, y si sale null NO SE MANDA NADA — la alternativa es pagar por mensajes que no llegan a
// ningún lado o, peor, que llegan al teléfono equivocado.
//
// Módulo PURO y sin dependencias, a propósito: es la pieza más fácil de arruinar de toda la
// feature y la más barata de dejar probada (tests/unit/telefonoAR.test.js, tabla de casos
// reales).

// Largo del número nacional argentino SIN el 0 ni el 15: código de área + abonado.
// Siempre 10 dígitos, tenga el área 2 (11), 3 (261) o 4 (2604) — es una regla del plan de
// numeración, no un promedio: el área más larga tiene el abonado más corto.
const LARGO_NACIONAL_AR = 10;

// Largos de código de área que existen en el país. Se prueban de menor a mayor para ubicar
// dónde puede estar metido el «15».
const LARGOS_DE_AREA = [2, 3, 4];

// E.164 admite entre 8 y 15 dígitos contando el código de país. Es el rango que se le exige a
// un número extranjero, del que no podemos saber nada más.
const MIN_E164 = 8;
const MAX_E164 = 15;

// Saca el «15» del marcado local: viene pegado DESPUÉS del código de área y ANTES del número
// de abonado, y sacarlo tiene que dejar exactamente 10 dígitos. Esa segunda condición es la
// que evita destrozar un número que casualmente tenga un «15» adentro:
//
//   261 15 555-1234  →  2615551234   ✅ el 15 está en el lugar del 15 y quedan 10
//   261 555-1512     →  se deja como está: sacarlo dejaría 8 dígitos, así que no era un 15 local
//
// Si ya vienen 10 dígitos no se toca nada, aunque empiece con 15 (1554… es un número válido
// de Buenos Aires).
function quitarQuinceLocal(digitos) {
  if (digitos.length === LARGO_NACIONAL_AR) return digitos;
  for (const largoArea of LARGOS_DE_AREA) {
    const candidato = digitos.slice(0, largoArea) + digitos.slice(largoArea + 2);
    if (digitos.slice(largoArea, largoArea + 2) === '15' && candidato.length === LARGO_NACIONAL_AR) {
      return candidato;
    }
  }
  return digitos;
}

// Un número nacional (sin código de país) a E.164 argentino.
function nacionalAE164(digitos) {
  // El «0» de larga distancia: se marca para llamar desde otra ciudad y no es parte del número.
  if (digitos.startsWith('0')) digitos = digitos.slice(1);

  digitos = quitarQuinceLocal(digitos);

  if (digitos.length !== LARGO_NACIONAL_AR) return null;
  // El «9» de celular va acá, entre el código de país y el área. No se agrega para fijos, pero
  // este campo es "Celular" en todas las pantallas donde se carga, así que la suposición está
  // tomada a propósito: un fijo cargado como celular se normaliza como celular y el mensaje
  // simplemente no llega. Ver el comentario de normalizar().
  return `+549${digitos}`;
}

/**
 * Normaliza lo que haya escrito una persona a E.164.
 *
 * @param   {string} crudo  el valor tal cual está en `User.phone`
 * @returns {{ e164: string|null, error: string|null }}
 *
 * Los tres resultados posibles, y la diferencia entre los dos últimos importa:
 *   { e164: '+549…', error: null }   se puede mandar
 *   { e164: null,    error: null }   NO HAY NÚMERO CARGADO. No es un error: es alguien que
 *                                    todavía no puso su celular, que es la mitad de la escuela.
 *   { e164: null,    error: '…' }    hay algo escrito y no se entiende. Esto SÍ se le muestra.
 */
function normalizar(crudo) {
  const texto = String(crudo || '').trim();
  if (!texto) return { e164: null, error: null };

  const internacional = texto.startsWith('+');
  const digitos       = texto.replace(/\D/g, '');

  if (!digitos) {
    return { e164: null, error: 'El celular no tiene ningún número' };
  }

  if (internacional) {
    // Argentina se sigue normalizando aunque venga con el +54, porque el +54 no garantiza
    // nada: `+54 261 15 555-1234` mezcla el internacional con el marcado local y es de lo
    // más común que se escribe.
    if (digitos.startsWith('54')) {
      let resto = digitos.slice(2);
      // El «9» de celular, si ya lo pusieron. Se saca acá y lo vuelve a poner nacionalAE164(),
      // así hay un solo lugar que decide cómo se arma el número final.
      if (resto.length > LARGO_NACIONAL_AR && resto.startsWith('9')) resto = resto.slice(1);
      const e164 = nacionalAE164(resto);
      return e164
        ? { e164, error: null }
        : { e164: null, error: 'No pudimos interpretar el número como un celular argentino' };
    }
    // Otro país: no hay forma de saber su plan de numeración, así que se respeta tal cual y
    // solo se valida el largo que exige E.164.
    if (digitos.length < MIN_E164 || digitos.length > MAX_E164) {
      return { e164: null, error: 'El número internacional no tiene un largo válido' };
    }
    return { e164: `+${digitos}`, error: null };
  }

  const e164 = nacionalAE164(digitos);
  return e164
    ? { e164, error: null }
    : { e164: null, error: 'No pudimos interpretar el número como un celular argentino' };
}

// Para mostrar en pantalla de dónde salió el número al que se mandó el código, sin exponerlo
// entero: `+54 9 261 ***-1234`. Se usa en el cartel de "te mandamos un código a …", que tiene
// que ser suficiente para reconocer el propio número y no tanto como para leerle el número a
// otro por encima del hombro.
function enmascarar(e164) {
  if (!e164 || e164.length < 8) return '';
  return `${e164.slice(0, -7)}***${e164.slice(-4)}`;
}

module.exports = { normalizar, enmascarar, LARGO_NACIONAL_AR };
