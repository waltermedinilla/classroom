// Normalización y validación del DNI.
//
// El DNI es OBLIGATORIO para toda alta y edición de usuario desde el 2026-07-30 (pedido
// del usuario). La validación vive acá y no como `required: true` en el schema a propósito:
// al momento del cambio había 118 cuentas sin DNI (109 alumnos, 8 docentes, el superadmin),
// y marcarlo requerido en el modelo haría fallar CUALQUIER `.save()` sobre ellas — incluso
// operaciones que no tocan el DNI, como deshabilitar la cuenta o cambiar la contraseña.
// Validando en las rutas, esas cuentas siguen funcionando y el dato se exige recién cuando
// alguien las edita.
//
// Contrato:
//   normalizeDni(raw) → { value: String|null, error: String|null }
//   - Acepta el formato que la gente escribe ("40.123.456", "40 123 456") y devuelve solo
//     los dígitos, que es como se guarda y como lo busca el índice único {school, dni}.
//   - `error` no nulo = rechazar el request con 400 y ese mensaje.

// Rango del documento argentino: 7 a 9 dígitos. 7 cubre documentos viejos, 9 deja margen
// para los que se emitan más adelante sin tener que volver a tocar esto.
const MIN_DIGITOS = 7;
const MAX_DIGITOS = 9;

function normalizeDni(raw) {
  const soloDigitos = String(raw ?? '').replace(/\D/g, '').trim();

  if (!soloDigitos) {
    return { value: null, error: 'El DNI es obligatorio' };
  }
  if (soloDigitos.length < MIN_DIGITOS || soloDigitos.length > MAX_DIGITOS) {
    return {
      value: null,
      error: `El DNI debe tener entre ${MIN_DIGITOS} y ${MAX_DIGITOS} dígitos`,
    };
  }
  return { value: soloDigitos, error: null };
}

module.exports = { normalizeDni, MIN_DIGITOS, MAX_DIGITOS };
