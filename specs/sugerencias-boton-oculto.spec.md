# Ocultar el botón de sugerencias

> **Estado:** APROBADA por Walter el 2026-11-22 ("quiero quitar por ahora el botón de sugerencia").

## Problema

El botón flotante de sugerencias (la lamparita amarilla abajo a la derecha, en todas las
pantallas) se quiere sacar **por ahora**, sin perder nada de lo que ya existe.

## Decisión

- Se esconde **solo el botón flotante**, con un interruptor en `config/sugerencias.js`
  (`BOTON_SUGERENCIAS_VISIBLE = false`). Volver a mostrarlo es poner `true` y hacer deploy.
- **Sigue igual:** el sobre del encabezado, las respuestas a sugerencias anteriores, el botón
  "Nueva sugerencia" dentro de la bandeja, `POST /suggestions` y el panel del superadmin. Así
  nadie pierde una conversación abierta con el equipo.
- No se toca la base: no hay datos que cambien.

## Criterios de aceptación

- **CS-01** El interruptor está apagado.
- **CS-02** Apagado, el footer no pinta el botón, pero sí el modal y la bandeja.
- **CS-03** Prendido, el botón vuelve.
- **CS-04** Una vista que no pasó por el middleware de `server.js` no lo muestra.
- **CS-05** Sin sesión no hay nada de sugerencias (como antes).
- **Smoke** `suggestions-teacher-sees-fab`: el botón sigue al interruptor y el sobre sigue estando.

## Pregunta abierta

¿También se saca "Nueva sugerencia" de la bandeja del sobre? Por ahora queda, para que quien
tenga una conversación con el equipo la pueda seguir.
