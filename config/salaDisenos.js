// Los diseños de la sala en vivo que elige el docente. Ver specs/sala-disenos.spec.md.
//
// Es la ÚNICA lista: de acá salen el menú del selector, la validación de la ruta
// POST /courses/:id/sala/diseno y disenoEfectivo() de services/liveRoom.js. Los enums de
// models/User.js y models/RoomSession.js tienen los cuatro ids escritos a mano porque un schema
// no debería depender de un archivo de configuración, pero tienen que coincidir con TODOS los
// de acá (lo controla tests/unit/salaDisenos.test.js).
//
// `listo: false` es un diseño que todavía no se implementó: no aparece en el menú y, si una
// sala lo tuviera guardado, se pinta en Clásico. Se van prendiendo de a uno, un diseño por
// deploy (plan de la spec): primero A, después B, después C.
const DISENOS = [
  { id: 'clasico',  letra: '',  clase: '',             icono: 'view_agenda',
    rotulo: 'Clásico',       ayuda: 'Como siempre.',                                                      listo: true },
  { id: 'ordenada', letra: 'A', clase: 'lr-diseno-a',  icono: 'dashboard',
    rotulo: 'Ordenada',      ayuda: 'Lo mismo, con los controles agrupados y su estado a la vista.',     listo: true },
  { id: 'panel',    letra: 'B', clase: 'lr-diseno-b',  icono: 'view_sidebar',
    rotulo: 'Panel lateral', ayuda: 'Chat grande y los controles a un costado. Para clases de charla.', listo: true },
  { id: 'aula',     letra: 'C', clase: 'lr-diseno-c',  icono: 'co_present',
    rotulo: 'Modo aula',     ayuda: 'Oscuro, el video grande y los botones abajo. Para exponer.',        listo: true },
];

// El freno de mano (D-5). En false, el selector desaparece y TODAS las salas se ven en Clásico,
// aunque tengan otro diseño guardado: lo guardado no se borra, así que volver a true las deja
// como estaban. Es para apagarlo en el acto si un diseño se porta mal en una clase real, sin
// revertir el deploy.
const DISENOS_SALA_VISIBLES = true;

const DISENO_DEFAULT = 'clasico';

// Lo que necesita la vista: solo los diseños listos, y nada si el freno está puesto.
function paraVista() {
  if (!DISENOS_SALA_VISIBLES) return { visibles: false, lista: [] };
  return {
    visibles: true,
    lista: DISENOS.filter(d => d.listo).map(({ id, clase, icono, rotulo, ayuda }) => ({ id, clase, icono, rotulo, ayuda })),
  };
}

module.exports = { DISENOS, DISENOS_SALA_VISIBLES, DISENO_DEFAULT, paraVista };
