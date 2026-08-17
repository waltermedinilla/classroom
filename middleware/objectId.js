// Guarda de forma para los parámetros `:id` de las rutas.
//
// El problema que resuelve (issue conocido nº 10 de agente.md): un `:id` que no tiene forma
// de ObjectId hace lanzar `CastError` a `findById`, y de ahí salen DOS síntomas según cómo
// esté escrito el handler:
//
//   - con `try/catch`  → cae en el catch genérico y contesta **500**, cuando lo correcto es
//                        un 404: el recurso no existe, no se rompió nada.
//   - async SIN catch  → nadie captura el rechazo de la promesa (Express 4 no lo hace) y el
//                        request queda **COLGADO para siempre**: `unhandledRejection` en el
//                        log y el navegador esperando hasta que el usuario se cansa.
//
// El caso real que lo destapó fue `GET /admin/users/new`: esa URL no existe —la buena es
// `/users/create`— y caía en `/users/:id`, que es de los segundos.
//
// NO es un middleware de Express a propósito: se llama explícitamente al entrar a cada
// handler, así que ninguna ruta cambia de comportamiento sin que se la haya tocado.
//
//   if (idMalo(req, res, 'Usuario no encontrado')) return;
//
// Devuelve true si ya contestó (y entonces el handler tiene que cortar), false si el id
// tiene forma válida y se puede seguir.
//
// Opciones:
//   param — valida otro parámetro que no sea `:id` (el `:teacherId` de las rutas con dos).
//   como  — 'json' | 'texto', fuerza la forma de la respuesta.
const mongoose = require('mongoose');

const idMalo = (req, res, mensaje, { param = 'id', como } = {}) => {
  if (mongoose.isValidObjectId(req.params[param])) return false;
  // La forma de la respuesta tiene que ser la MISMA que la del 404 propio del handler: si no,
  // el front recibe texto donde espera `{ error }` (o al revés) y se queda sin poder mostrarlo.
  //
  // Por defecto: texto en los GET, que renderean vistas, y JSON en el resto, que se llaman
  // por fetch(). Pero el default no alcanza — hay GET que son endpoints de fetch() y
  // contestan JSON (`/courses/:id/data`, `/activities/:id/grades`, `/tasks/:id`…). Esos
  // pasan `como: 'json'` explícito.
  const enJson = como ? como === 'json' : req.method !== 'GET';
  if (enJson) res.status(404).json({ error: mensaje });
  else res.status(404).send(mensaje);
  return true;
};

module.exports = { idMalo };
