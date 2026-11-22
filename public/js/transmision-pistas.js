/* Dónde va cada pista de video en el cuadro de la transmisión: "pantalla grande, cámara chica"
 * (C2 de specs/transmision-camara-primero.spec.md).
 *
 * Pura y sin DOM a propósito: la usa public/js/transmision.js en el navegador y la prueban los
 * tests unitarios con `require`. Va en su propio archivo porque transmision.js es una IIFE que
 * toca `window` y `document` al cargar y no se puede requerir desde node.
 *
 * Recibe las pistas de video al aire como [{ fuente, ...lo que sea }] y devuelve
 * { grande, chica }: el elemento de la lista que va en cada cuadro, o null.
 *
 *   · cámara sola        → grande: cámara
 *   · pantalla sola      → grande: pantalla
 *   · cámara + pantalla  → grande: pantalla, chica: cámara
 *   · ninguna            → nada (el partial muestra "Estás escuchando la clase")
 *   · sin fuente         → al cuadro grande: un cliente viejo no puede quedar sin imagen
 */
(function (raiz) {
  'use strict';

  function ubicarPistas(pistas) {
    const lista = Array.isArray(pistas) ? pistas.filter(Boolean) : [];
    const pantalla = lista.find(p => p.fuente === 'pantalla') || null;
    const camara   = lista.find(p => p.fuente === 'camara')   || null;
    const otra     = lista.find(p => p.fuente !== 'pantalla' && p.fuente !== 'camara') || null;

    if (pantalla) return { grande: pantalla, chica: camara };
    if (camara)   return { grande: camara,   chica: null };
    return { grande: otra, chica: null };
  }

  const api = { ubicarPistas };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.TransmisionPistas = api;
})(typeof window !== 'undefined' ? window : this);
