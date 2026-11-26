# Transmisión con cupo automático

> **Estado:** APROBADA por Walter el 2026-11-26 (3 min de reserva; uso = clases en vivo de 30
> días; mide la capacidad hoy a la noche con `medir-capacidad.sh`). `CAPACIDAD_MBPS` se completa
> con esa medición; hasta entonces vale el presupuesto actual (160 Mbit/s).
> Flujo SDD: arquitecto → **spec aprobada** → tester → implementador → revisor.
> Base de código revisada: `origin/main` v1.0.140.
> Hermana de `transmision-en-vivo.spec.md` (D5, el gobernador; D10, el módulo de dos ejes).

## Pedido

> "quiero que prepares la plataforma para que si algún docente está usando la actividad de
> transmitir, el servidor se vaya autogestionando para 'habilitar' a otro docente que pueda hacer
> lo mismo [...] Quiero habilitar de una a todos los docentes de la San José, pero que el servidor
> vaya midiendo sus métricas para poder habilitarle el acceso o no, dependiendo de sus
> capacidades actuales para que no se 'trabe'."

Respuestas de Walter (2026-11-26):

| Pregunta | Respuesta |
|---|---|
| Prioridad si hay un solo lugar | **El que tiene clase en ese momento según el horario oficial**; entre esos, **el que tocó el botón primero** |
| Calidad | **Mantener la calidad media.** Al llegar al tope, **bajarle la calidad a los docentes que menos usan** la sala |
| Capacidad del servidor | **Medirla con un script** (no adivinarla) |
| Habilitar a todos | **Sí, cuando esto esté en producción** |

## Lo que existe hoy (y por qué no alcanza)

- `media/aforo.js` (el gobernador) cuenta espectadores contra **`PRESUPUESTO_MBPS = 160`**, un
  número puesto a mano, y elige **una capa para toda la escuela**: si se llena, bajan **todas**
  las clases a la vez.
- Decide **con la clase ya al aire**. No hay un "¿entra?" antes de empezar.
- Tope duro `MAX_CLASES = 20`: la 21 se rechaza con "Podés seguir con el chat", sin lista de
  espera ni aviso cuando se libera.
- No mide nada real: ni la salida de red, ni el procesador, ni la pérdida de paquetes.

## Decisiones de diseño

### D1 — Medir de verdad, cada 5 segundos

El proceso de medios (`media/servidor.js`) toma, cada 5 s:

| Medición | De dónde |
|---|---|
| **Salida de red real** (Mbit/s) | `/proc/net/dev` de la interfaz principal (lo mismo que mide el script) |
| **Procesador** del proceso de medios y carga del equipo | `process.cpuUsage()` de los workers de mediasoup y `os.loadavg()` |
| **Memoria libre** | `os.freemem()` |
| **Pérdida de paquetes** de los alumnos que miran | las estadísticas RTCP de mediasoup (`consumer.getStats()`, `fractionLost`) |

Se guardan con la telemetría que ya usa el Monitor (`SalaSample`), así se ven en el gráfico.

### D2 — La capacidad sale de la medición, no de un número inventado

- `medir-capacidad.sh` mide la **subida real** del VPS (lo que el servidor puede mandar). Con
  ese número se fija `CAPACIDAD_MBPS` en la configuración, y el **presupuesto** para video es el
  **70 %** de esa capacidad (el resto queda para las páginas, las entregas y todo lo demás).
- Si en funcionamiento la salida medida (D1) muestra que el puerto da menos de lo esperado
  (pérdida > 5 % sostenida 30 s con la salida por debajo del presupuesto), el presupuesto se
  **achica solo** al valor que realmente se sostuvo, y queda anotado en el Monitor. Nunca se
  agranda solo: subirlo es una decisión del superadmin.

### D3 — "¿Entra?" antes de empezar

Al tocar **Transmitir**, antes de abrir la cámara, el servidor calcula si con esa clase más:

1. el **consumo proyectado** (lo medido + lo que sumaría esa clase en **calidad media**: sus
   alumnos conectados, o el promedio de presentes de sus últimas clases si todavía no entraron)
   queda por debajo del **umbral de admisión** (el 60 % del presupuesto, el mismo umbral que hoy
   tiene la calidad media), **y**
2. el **procesador** del proceso de medios está por debajo del 70 %, **y**
3. la **pérdida de paquetes** promedio está por debajo del 3 %.

Si entra, arranca como hoy. Si no, **no se abre la cámara** y el docente ve:

> "En este momento la escuela no tiene lugar para otra transmisión. Estás **2.º** en la lista:
> te avisamos acá apenas se libere un lugar. Mientras tanto podés seguir la clase con el chat."

### D4 — Lista de espera con prioridad por horario

- Cuando no entra, el docente queda en la **lista de espera de la escuela**.
- **Orden** (pedido de Walter): primero los que **tienen clase en ese momento** según el horario
  de la materia (`Course.horarioClases` sobre la grilla `Horario`, el mismo que usa Secretaría);
  entre ellos, **el que tocó primero**. Después, el resto, también por orden de llegada.
- Cuando se libera lugar (alguien deja de transmitir, se cierra una sala, o baja el consumo),
  el **primero** de la lista recibe el aviso en su sala ("¡Ya hay lugar! Tocá Transmitir") y
  tiene **3 minutos reservados**. Si no lo usa, el lugar pasa al siguiente y él vuelve a la lista
  en su mismo orden.
- Salir de la sala o cerrarla lo saca de la lista.
- La lista vive en el proceso de medios (memoria) y se reconstruye vacía si se reinicia: nadie
  queda "esperando para siempre".

### D5 — Calidad media para todos; al tope, baja primero quien menos usa la sala

Cambia el gobernador: deja de elegir **una capa para toda la escuela** y elige **por clase**.

- Mientras el consumo de todos en **calidad media** entre en el presupuesto, **todas** van en
  calidad media.
- Si se pasa (entró gente a mirar después de que arrancaron), se baja a **calidad baja** una
  clase por vez, **empezando por el docente que menos usa la sala** (cantidad de clases en vivo
  en los **últimos 30 días**, de `RoomSession`), hasta volver a entrar. Si empatan, baja primero
  la que **arrancó a transmitir más tarde**.
- Si aun con todas en calidad baja no entra, se sigue con el mismo orden hacia **solo audio**.
- Para volver a subir hace falta quedar **10 puntos por debajo** del umbral (histéresis): así una
  clase no salta entre media y baja cada cuatro segundos.
- **Nunca se corta** a quien ya está transmitiendo para hacerle lugar a otro. El cupo (D3) frena
  la entrada; la calidad (D5) se acomoda entre los que están.
- `MAX_CLASES` queda como red de seguridad.

El docente cuya clase bajó ve el aviso de siempre ("Estás transmitiendo en calidad baja…"), sin
el motivo de "usás poco la sala": el criterio se ve en el Monitor, no se le dice al docente.

### D6 — Monitor del superadmin

En **Superadmin → Monitor**, un recuadro **"Transmisiones"**:

- capacidad medida, presupuesto, salida real, procesador y pérdida, ahora;
- cuántas clases transmiten, en qué calidad cada una, y **cuántas más entran** en calidad media;
- la **lista de espera** (docente, materia, si tiene clase ahora, desde cuándo espera);
- el **registro** del día: quién entró, quién quedó esperando y por qué (red, procesador o
  pérdida), a quién se le bajó la calidad y cuándo se le devolvió.

### D7 — Habilitar a todos, después del deploy

Con esto en producción, en la Escuela 4118 San José "¿Quiénes pueden transmitir?" pasa a
**"Todos los docentes de la escuela"**. Es un ajuste, no código. La novedad guiada de Transmitir
les aparece sola a todos (spec `recorrido-novedades`).

### D8 — ¿Lleva novedad guiada?

**No.** El mensaje de la lista de espera (D3) ya explica qué pasa en el momento en que pasa.

## Reglas

- **RN-1** Nadie arranca a transmitir si D3 dice que no entra. El servidor decide, no el navegador.
- **RN-2** Una vez al aire, nadie es cortado por el cupo (D5).
- **RN-3** El orden de la lista es el de D4 y se recalcula cada vez que cambia (una clase que
  empieza su módulo pasa adelante de las que no tienen clase).
- **RN-4** El "uso" para D5 son las clases en vivo de los últimos 30 días del docente que
  transmite (titular o co-docente), contadas al arrancar la transmisión.
- **RN-5** El presupuesto nunca se agranda solo (D2).
- **RN-6** Si las mediciones fallan (no hay dato), se decide con la cuenta de hoy
  (espectadores × capa) y se anota en el Monitor; nunca se deja entrar "a ciegas".

## Lugares a tocar

| Archivo | Qué |
|---|---|
| `config/transmision.js` | `CAPACIDAD_MBPS` (medida), presupuesto al 70 %, umbrales de D3, reserva de 3 min, histéresis |
| `media/aforo.js` | Gobernador por clase (D5) y la función de admisión (D3). Sigue sin mongoose |
| `media/servidor.js` | Mediciones (D1), lista de espera (D4), aplicar capa por sala |
| `services/transmision.js` + `routes/rooms.js` | Pedir lugar antes de emitir; prioridad por horario y uso de 30 días |
| `views/partials/transmision.ejs`, `public/js/transmision.js` | Mensaje de espera, aviso "ya hay lugar" |
| `models/SalaSample.js`, `routes/superadmin.js`, vista del Monitor | D1 y D6 |

## Criterios de aceptación (borrador)

- **CU-01** Con el presupuesto lleno en calidad media, tocar Transmitir no abre la cámara y deja
  al docente 1.º en la lista.
- **CU-02** Entre dos esperando, entra primero el que tiene clase ahora, aunque haya tocado después.
- **CU-03** Entre dos con clase ahora, entra primero el que tocó primero.
- **CU-04** Al liberarse lugar, el primero tiene 3 minutos; si no lo usa, pasa al siguiente.
- **CU-05** Con más espectadores que presupuesto, baja a calidad baja primero la clase del docente
  con menos clases en 30 días; nadie es cortado.
- **CU-06** Con histéresis, una clase no cambia de calidad más de una vez por minuto en una carga
  estable.
- **CU-07** Con pérdida > 5 % sostenida, el presupuesto se achica y queda en el Monitor; nunca se
  agranda solo.
- **CU-08** Sin mediciones, decide como hoy y lo anota (RN-6).
- **CU-09** Prueba de carga controlada (con aviso previo, fuera de horario y sin la PC de Walter):
  N transmisiones simuladas hasta el tope, sin que las páginas de la plataforma pasen de 2 s.

## Plan de migración

Sin cambios en la base salvo campos nuevos en `SalaSample` (opcionales). El cambio del
gobernador va detrás de una variable (`TX_CUPO=1`): si algo falla en producción, se vuelve al
comportamiento actual sin deploy.

## Preguntas abiertas

1. ~~Reserva~~ **3 minutos** (2026-11-26).
2. ~~Criterio de uso~~ **Clases en vivo de los últimos 30 días** (2026-11-26).
3. ~~Prueba~~ Walter la hace **hoy a la noche** (2026-11-26).
