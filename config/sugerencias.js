// El botón flotante de sugerencias (la lamparita abajo a la derecha, views/partials/footer.ejs).
// Ver specs/sugerencias-boton-oculto.spec.md.
//
// Apagado "por ahora" por pedido de Walter (2026-11-22). Lo único que se esconde es el botón:
// el sobre del encabezado, las respuestas a sugerencias anteriores, el "Nueva sugerencia" de
// la bandeja, la ruta POST /suggestions y el panel del superadmin siguen funcionando.
//
// Para volver a mostrarlo: poner true y hacer deploy.
module.exports = {
  BOTON_SUGERENCIAS_VISIBLE: false,
};
