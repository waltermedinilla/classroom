// La mecánica de la verificación de contacto: crear un pedido, mandarlo, y confirmarlo por
// código o por enlace. Ver specs/verificacion-de-contacto.spec.md.
//
// Vive acá y no en routes/verificacion.js para que las reglas que importan —el destino
// congelado, los intentos, la expiración, el tope diario— se puedan probar sin levantar Express
// ni fabricar sesiones, y para que la ruta quede siendo lo que tiene que ser: traducir HTTP.
//
// TODAS las funciones devuelven `{ ok, error, ... }` en vez de tirar. Un throw acá terminaría en
// el 500 genérico y el usuario vería "Error del servidor" ante cosas que tienen explicación
// (el código venció, cambiaste el correo en el medio, ya está verificado).

const ContactVerification = require('../models/ContactVerification');
const User                = require('../models/User');
const logger              = require('../config/logger');
const { invalidateUser }  = require('../middleware/cache');

const {
  CANALES, LIMITES, canalActivo, urlDeVerificacion, mensajeEmail, mensajeCelular,
} = require('../config/verificacion');
const { enviar }      = require('./canales');
const { enmascarar }  = require('./telefonoAR');

// El dato al que se le manda el mensaje, por canal. Para el celular NO es `phone` (el texto que
// escribió la persona) sino `phoneE164`: mandar a un número sin normalizar es pagar por un
// mensaje que va a ningún lado, o peor, que llega al teléfono equivocado.
function destinoDe(user, canal) {
  return canal === 'email' ? (user.email || null) : (user.phoneE164 || null);
}

// Lo que se le muestra al usuario en el cartel de "te mandamos un código a…". Suficiente para
// reconocer lo propio, no tanto como para leérselo a otro por encima del hombro.
function destinoVisible(user, canal) {
  return canal === 'email' ? (user.email || '') : enmascarar(user.phoneE164);
}

/**
 * Pide una verificación: genera los secretos, los manda y guarda el pedido.
 *
 * Invalida cualquier verificación anterior viva del mismo canal — "las últimas 3 valen" es
 * justo la clase de regla que después nadie puede razonar.
 */
async function pedirVerificacion({ user, canal, escuela = null }) {
  const def = CANALES[canal];
  if (!def) return { ok: false, status: 400, error: 'Canal desconocido' };

  if (!canalActivo(canal)) {
    // 503 y no 400: no es culpa de quien pidió, es que el servidor no tiene por dónde mandarlo.
    return {
      ok: false, status: 503,
      error: canal === 'celular'
        ? 'Por ahora el envío al celular no está habilitado. Pedile a tu preceptor o a un administrador que confirme tu número.'
        : 'Por ahora no podemos enviar correos. Probá más tarde.',
    };
  }

  const destino = destinoDe(user, canal);
  if (!destino) {
    return {
      ok: false, status: 400,
      error: canal === 'email'
        ? 'No tenés un correo cargado.'
        : 'Revisá el número: no pudimos interpretarlo como un celular argentino.',
    };
  }

  const yaVerificado = canal === 'email' ? user.emailVerifiedAt : user.phoneVerifiedAt;
  if (yaVerificado) {
    return { ok: false, status: 400, error: `Tu ${def.label.toLowerCase()} ya está verificado.` };
  }

  const ahora = new Date();

  // Cooldown de 60s. Se mide contra la última verificación de este canal, viva o no: si no, el
  // que confirma y vuelve a pedir esquivaría la espera. Es lo que corta el doble click, que es
  // el 90% del "abuso" real.
  const ultima = await ContactVerification
    .findOne({ user: user._id, canal })
    .sort({ enviadoEn: -1 })
    .select('enviadoEn');

  if (ultima) {
    const pasados = (ahora - ultima.enviadoEn) / 1000;
    if (pasados < LIMITES.segundosEntreEnvios) {
      return {
        ok: false, status: 429,
        esperaSegundos: Math.ceil(LIMITES.segundosEntreEnvios - pasados),
        error: `Esperá ${Math.ceil(LIMITES.segundosEntreEnvios - pasados)} segundos antes de pedir otro.`,
      };
    }
  }

  // Tope diario por escuela: la única red que evita que un bug o un script suelto se convierta
  // en una factura. Cuenta por canal — el correo no le come el cupo al celular ni al revés.
  if (escuela?._id) {
    const desdeMedianoche = new Date(ahora);
    desdeMedianoche.setHours(0, 0, 0, 0);
    const hoy = await ContactVerification.countDocuments({
      school: escuela._id, canal, enviadoEn: { $gte: desdeMedianoche },
    });
    if (hoy >= LIMITES.topeDiarioPorEscuela) {
      logger.warn(`[verificacion] tope diario alcanzado: escuela=${escuela._id} canal=${canal} envios=${hoy}`);
      return {
        ok: false, status: 429,
        error: 'La escuela llegó al límite de envíos por hoy. Probá mañana o pedile a un administrador que te lo confirme.',
      };
    }
  }

  // Los secretos. El token solo para el correo: en un SMS un enlace es exactamente lo que se le
  // enseña a la gente a no tocar.
  const codigo = ContactVerification.nuevoCodigo();
  const token  = def.usaEnlace ? ContactVerification.nuevoToken() : null;

  const verificacion = await ContactVerification.create({
    user:       user._id,
    school:     escuela?._id || user.school || null,
    canal,
    destino,
    codigoHash: ContactVerification.hashear(codigo),
    tokenHash:  token ? ContactVerification.hashear(token) : null,
    enviadoEn:  ahora,
    expiraEn:   new Date(ahora.getTime() + def.vidaMinutos * 60 * 1000),
  });

  // Recién ahora se matan las anteriores. El orden importa: si se mataran primero y el create
  // fallara, la persona quedaría sin ninguna verificación viva y sin saber por qué.
  await ContactVerification.updateMany(
    { user: user._id, canal, usadoEn: null, _id: { $ne: verificacion._id } },
    { $set: { usadoEn: ahora } },
  );

  const mensaje = canal === 'email'
    ? mensajeEmail({ nombre: user.name, codigo, url: urlDeVerificacion(user, token), escuela })
    : mensajeCelular({ codigo, escuela });

  const envio = await enviar(canal, { destino, ...mensaje });

  // El resultado del envío se guarda SIEMPRE, salga bien o mal: es lo que permite contestar una
  // queja real ("no me llegó") mirando qué dijo el proveedor, en vez de adivinar.
  verificacion.proveedor  = envio.proveedor;
  verificacion.envioId    = envio.id;
  verificacion.envioError = envio.error;
  await verificacion.save();

  if (!envio.ok) {
    // Se quema el pedido: dejarlo vivo haría que el cooldown corriera por un mensaje que nunca
    // salió, y la persona esperaría 60 segundos para reintentar algo que jamás llegó.
    verificacion.usadoEn = new Date();
    await verificacion.save();
    return { ok: false, status: 502, error: 'No pudimos enviar el mensaje. Probá de nuevo en un rato.' };
  }

  return {
    ok: true,
    destino:  destinoVisible(user, canal),
    expiraEn: verificacion.expiraEn,
    // Para que la UI arme la cuenta regresiva del botón sin hardcodear el número.
    esperaSegundos: LIMITES.segundosEntreEnvios,
  };
}

// Marca al usuario como verificado. Un solo lugar que escribe estos campos, para los cuatro
// caminos (código, enlace, staff, importación).
async function marcarVerificado(userId, canal, via) {
  const campos = canal === 'email'
    ? { emailVerifiedAt: new Date(), emailVerifiedVia: via }
    : { phoneVerifiedAt: new Date(), phoneVerifiedVia: via };

  await User.findByIdAndUpdate(userId, campos);
  // Sin esto el chip sigue gris hasta 45 segundos después de verificar y parece que no
  // funcionó: el documento de usuario vive cacheado por worker (middleware/cache.js).
  invalidateUser(userId);
  return campos;
}

/**
 * Confirma con el código de 6 dígitos. Exige sesión (lo llama el propio usuario).
 */
async function confirmarCodigo({ user, canal, codigo }) {
  if (!CANALES[canal]) return { ok: false, status: 400, error: 'Canal desconocido' };

  const limpio = String(codigo || '').replace(/\D/g, '');
  if (limpio.length !== 6) {
    return { ok: false, status: 400, error: 'El código son 6 números.' };
  }

  const v = await ContactVerification
    .findOne({ user: user._id, canal, usadoEn: null })
    .sort({ enviadoEn: -1 });

  if (!v) {
    return { ok: false, status: 400, error: 'No hay ningún código pendiente. Pedí uno nuevo.' };
  }

  const ahora = new Date();
  if (v.expiraEn <= ahora) {
    // La expiración se valida acá y no se delega al TTL de Mongo: el barrido corre cada 60
    // segundos, así que un documento vencido puede seguir existiendo un rato. El índice es la
    // limpieza, no la regla.
    return { ok: false, status: 400, error: 'El código venció. Pedí uno nuevo.' };
  }
  if (v.intentos >= LIMITES.intentosPorCodigo) {
    return { ok: false, status: 429, error: 'Demasiados intentos. Pedí un código nuevo.' };
  }

  // El destino CONGELADO: si pidió el código, cambió el correo y ahora mete el código, verificó
  // otra cosa. Sin esta comparación, cambiar el dato después de pedir el código sería la forma
  // de "verificar" cualquier correo.
  if (destinoDe(user, canal) !== v.destino) {
    v.usadoEn = ahora;
    await v.save();
    return {
      ok: false, status: 400,
      error: 'Cambiaste el dato después de pedir el código. Pedí uno nuevo.',
    };
  }

  if (!ContactVerification.coincide(limpio, v.codigoHash)) {
    v.intentos += 1;
    await v.save();
    const quedan = LIMITES.intentosPorCodigo - v.intentos;
    return {
      ok: false, status: 400,
      error: quedan > 0
        ? `El código no es correcto. Te ${quedan === 1 ? 'queda 1 intento' : `quedan ${quedan} intentos`}.`
        : 'El código no es correcto y se agotaron los intentos. Pedí uno nuevo.',
    };
  }

  v.usadoEn = ahora;
  await v.save();
  await marcarVerificado(user._id, canal, 'codigo');

  return { ok: true, canal, verificadoEn: ahora };
}

/**
 * Resuelve el token del enlace del correo. NO exige sesión (el mail se abre en otro dispositivo).
 *
 * `soloMirar: true` es lo que usa el GET: encuentra la verificación y dice si sirve, PERO NO
 * VERIFICA NADA. Es la mitad que hace que el enlace de "un click" no lo consuma el antivirus del
 * servidor de correo, que hace GET a todo lo que ve antes de que el usuario toque nada.
 */
async function confirmarToken(token, { soloMirar = false } = {}) {
  if (!token || typeof token !== 'string') {
    return { ok: false, estado: 'invalido' };
  }

  const v = await ContactVerification.findOne({
    tokenHash: ContactVerification.hashear(token),
    canal:     'email',
  });

  if (!v) return { ok: false, estado: 'invalido' };

  // `school` va en el select porque la ruta lo necesita para auditar: el enlace se abre SIN
  // sesión, así que la escuela del evento no puede salir de res.locals.user.
  const usuario = await User.findById(v.user).select('_id name email school emailVerifiedAt');
  if (!usuario) return { ok: false, estado: 'invalido' };

  // Ya verificado antes: se muestra como éxito y no como error. Pasa siempre —el usuario
  // confirma con el código y después abre el mail y toca el botón igual— y un cartel rojo ahí
  // es preocupar a alguien que hizo todo bien.
  if (usuario.emailVerifiedAt) return { ok: true, estado: 'ya-estaba', usuario };

  const ahora = new Date();
  if (v.usadoEn) return { ok: false, estado: 'usado',    usuario };
  if (v.expiraEn <= ahora) return { ok: false, estado: 'expirado', usuario };

  // El destino congelado, igual que con el código: si cambió el correo, este enlace verificaría
  // una dirección que ya no es la suya.
  if (usuario.email !== v.destino) return { ok: false, estado: 'cambiado', usuario };

  if (soloMirar) return { ok: true, estado: 'listo-para-confirmar', usuario };

  v.usadoEn = ahora;
  await v.save();
  await marcarVerificado(usuario._id, 'email', 'enlace');

  return { ok: true, estado: 'verificado', usuario };
}

/**
 * Verificación ASISTIDA: alguien de la escuela confirma un contacto que ya conoce.
 *
 * Es lo que cubre el canal del celular sin costo y el único camino posible para el alumno que no
 * tiene casilla propia (ver D6). Lo que la hace honesta y no un botón de "poner verde todo" es
 * que queda FIRMADA: `via: 'staff'` hace que el chip diga "Verificado por la escuela".
 *
 * Quién puede llamarla lo decide la ruta; acá vive la única regla que no depende del rol.
 */
async function verificarPorStaff({ target, canal, actorId }) {
  if (!CANALES[canal]) return { ok: false, status: 400, error: 'Canal desconocido' };

  // Nadie se auto-verifica por esta vía, ni el superadmin. Si pudiera, la firma no querría decir
  // nada: sería "yo confirmo que mi dato es mío", que es lo que la verificación va a averiguar.
  if (String(target._id) === String(actorId)) {
    return { ok: false, status: 403, error: 'No podés verificar tus propios datos por esta vía.' };
  }

  const dato = canal === 'email' ? target.email : target.phone;
  if (!dato) {
    return { ok: false, status: 400, error: `Esa persona no tiene ${canal === 'email' ? 'correo' : 'celular'} cargado.` };
  }

  await marcarVerificado(target._id, canal, 'staff');
  return { ok: true, canal };
}

/**
 * Saca la marca de verificado. Dos usos: el propio usuario diciendo "este ya no es mío", y
 * alguien de la escuela revirtiendo una verificación asistida que puso mal.
 */
async function quitarVerificacion({ userId, canal }) {
  if (!CANALES[canal]) return { ok: false, status: 400, error: 'Canal desconocido' };

  const campos = canal === 'email'
    ? { emailVerifiedAt: null, emailVerifiedVia: null }
    : { phoneVerifiedAt: null, phoneVerifiedVia: null };

  await User.findByIdAndUpdate(userId, campos);
  await ContactVerification.updateMany(
    { user: userId, canal, usadoEn: null },
    { $set: { usadoEn: new Date() } },
  );
  invalidateUser(userId);

  return { ok: true, canal };
}

/**
 * Cuántos de la escuela son contactables. Es la pregunta que hay que poder contestar ANTES de
 * mandar el primer comunicado: "¿a cuántos les va a llegar?".
 */
async function cobertura(schoolId) {
  const base = { school: schoolId, active: true };

  const [total, emailOk, emailCargado, celularOk, celularCargado] = await Promise.all([
    User.countDocuments(base),
    User.countDocuments({ ...base, emailVerifiedAt: { $ne: null } }),
    User.countDocuments({ ...base, email: { $nin: [null, ''] } }),
    User.countDocuments({ ...base, phoneVerifiedAt: { $ne: null } }),
    User.countDocuments({ ...base, phone: { $nin: [null, ''] } }),
  ]);

  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);

  return {
    total,
    email:   { verificados: emailOk,   conDato: emailCargado,   porcentaje: pct(emailOk) },
    celular: { verificados: celularOk, conDato: celularCargado, porcentaje: pct(celularOk) },
  };
}

module.exports = {
  pedirVerificacion,
  confirmarCodigo,
  confirmarToken,
  verificarPorStaff,
  quitarVerificacion,
  cobertura,
  marcarVerificado,
  destinoDe,
  destinoVisible,
};
