# Smoke test end-to-end (Opción 1: HTTP directo)

Suite sin dependencias nuevas: usa el `fetch` global de Node contra un server corriendo
en local + tu Mongo local. Simula usuarios reales llamando a los mismos endpoints que
usa el frontend (login, crear curso, entregar actividad, calificar, sugerencias, etc.).

**Nunca corre contra producción**: `run.js` se niega a arrancar si `SMOKE_BASE_URL` no
apunta a `localhost`/`127.0.0.1`, salvo que fuerces `SMOKE_ALLOW_REMOTE=true`.

## Cómo correrlo

1. Levantá el server local (contra tu Mongo local, no el de producción):
   ```
   npm run dev
   ```
2. En otra terminal:
   ```
   npm run test:smoke
   ```

Con eso solo corre el **Nivel 1** (registro, login, servidor arriba) — no necesita
credenciales. Para el flujo completo (curso, actividades, entregas, calificaciones,
sugerencias) necesita un admin de escuela real de tu Mongo local:

```
SMOKE_ADMIN_EMAIL=admin@escuela.edu.ar SMOKE_ADMIN_PASSWORD=... npm run test:smoke
```

O creá un archivo `.env.test` (ya está en `.gitignore`, nunca se commitea) con:

```
SMOKE_ADMIN_EMAIL=admin@escuela.edu.ar
SMOKE_ADMIN_PASSWORD=...
SMOKE_SUPERADMIN_EMAIL=waltermedinilla@gmail.com   # opcional, prueba el panel superadmin
SMOKE_SUPERADMIN_PASSWORD=...
```

y corré `npm run test:smoke` normalmente — `run.js` lo carga automático si existe.

## Qué hace

- **Nivel 1** (siempre corre): el server responde, un docente y un alumno pueden
  autoregistrarse, login con contraseña incorrecta rechaza.
- **Nivel 2** (con `SMOKE_ADMIN_*`): un admin da de alta un docente y un alumno de
  prueba en su escuela, el docente crea un curso, el alumno se une, novedad + comentario,
  actividad + entrega + calificación, gradebook, y las dos regresiones de esta sesión:
  docente/alumno ven el botón de sugerencias y pueden enviarla (antes daba 403), y
  deshabilitar un usuario corta su sesión ya activa al toque (prueba la invalidación de
  cache, no que quede "vivo" hasta 5 min).
- **Nivel 3** (con `SMOKE_SUPERADMIN_*`, opcional): panel de sugerencias del superadmin
  pagina bien.
- Al final borra todo lo que creó (curso, división, usuarios de prueba, sugerencias).
  Los usuarios autoregistrados del Nivel 1 quedan (no hay endpoint para borrarlos sin
  escuela asignada) — es basura inofensiva en tu Mongo LOCAL, se pisa solo la próxima
  vez que corras `sync-prod.ps1`.

Los IDs de cada corrida son únicos (timestamp), así que podés correrlo las veces que
quieras sin que choque con la corrida anterior.

## Y después, Playwright (Opción 2)

Esta suite valida la capa HTTP/API y los efectos en la base — rápida y sin dependencias,
pero no toca el navegador: no detecta un botón que no se pinta, un modal roto, o un error
de JS del cliente. `specs.js` es literalmente el catálogo de "qué debe funcionar, para
qué rol" (registro, login, crear curso, unirse, actividad, entrega, calificación,
sugerencias...) — cuando quieran blindar también la UI real, cada spec de acá se
reimplementa como un test de Playwright que abre el navegador y hace los mismos pasos
con clicks/formularios en vez de `fetch`, reusando esta misma lista como checklist de
qué escenarios cubrir (los pasos no son 1:1 reutilizables entre HTTP y navegador, pero
el catálogo de "qué probar" sí).
