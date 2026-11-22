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
  // A "Ordenada" se RETIRÓ el 2026-11-22 ("no me gusta"). Queda en la lista, apagado, porque el
  // id está en los enums de User y RoomSession: sacarlo de ahí haría fallar el .save() de
  // cualquier usuario que lo hubiera elegido. Con listo: false no se ofrece, no se puede elegir y
  // quien lo tenga guardado ve Clásico (disenoEfectivo). Su CSS y sus mudanzas ya no existen.
  { id: 'ordenada', letra: 'A', clase: 'lr-diseno-a',  icono: 'dashboard',
    rotulo: 'Ordenada',      ayuda: 'Lo mismo, con los controles agrupados y su estado a la vista.',     listo: false },
  { id: 'panel',    letra: 'B', clase: 'lr-diseno-b',  icono: 'view_sidebar',
    rotulo: 'Panel lateral', ayuda: 'Chat grande y los controles a un costado. Para clases de charla.', listo: true },
  // D "Aula virtual" (specs/sala-diseno-d.spec.md): la base de B, el botón Abrir/Cerrar en la
  // cabecera, la barra de abajo de C y el alumno entra viendo la transmisión. Se arma de a poco
  // con el usuario.
  { id: 'mixto',    letra: 'D', clase: 'lr-diseno-d',  icono: 'view_quilt',
    rotulo: 'Aula virtual',  ayuda: 'Para clases a distancia: el alumno entra viendo la transmisión.',   listo: true },
  { id: 'aula',     letra: 'C', clase: 'lr-diseno-c',  icono: 'co_present',
    rotulo: 'Modo aula',     ayuda: 'Oscuro, el video grande y los botones abajo. Para exponer.',        listo: true },
];

// El freno de mano (D-5). En false, el selector desaparece y TODAS las salas se ven en Clásico,
// aunque tengan otro diseño guardado: lo guardado no se borra, así que volver a true las deja
// como estaban. Es para apagarlo en el acto si un diseño se porta mal en una clase real, sin
// revertir el deploy.
const DISENOS_SALA_VISIBLES = true;

// ⭐ EL DISEÑO FIJO (pedido del 2026-11-22: "cada vez que un docente haga click en 'en vivo'
// quiero que le aparezca la versión D, quiero que elimines el botón de diseño").
//
// Con un id acá, TODAS las salas se ven en ese diseño —abiertas o cerradas, docente o alumno—
// sin importar lo que cada docente tenga guardado, y el botón "Diseño" no se dibuja (la lista
// que llega a la vista trae solo este). Lo guardado no se borra: con null vuelve el selector y
// cada uno queda como estaba. El freno de mano de arriba sigue mandando: en false, Clásico.
const DISENO_FIJO = 'mixto';

const DISENO_DEFAULT = 'clasico';

// Lo que necesita la vista: solo los diseños listos, y nada si el freno está puesto.
function paraVista({ visibles = DISENOS_SALA_VISIBLES, fijo = DISENO_FIJO } = {}) {
  if (!visibles) return { visibles: false, lista: [] };
  return {
    visibles: true,
    // Con un diseño fijo la lista trae solo ese: con uno solo, la vista no dibuja el botón.
    lista: DISENOS.filter(d => d.listo && (!fijo || d.id === fijo))
      .map(({ id, clase, icono, rotulo, ayuda }) => ({ id, clase, icono, rotulo, ayuda })),
  };
}

module.exports = { DISENOS, DISENOS_SALA_VISIBLES, DISENO_DEFAULT, DISENO_FIJO, paraVista };
