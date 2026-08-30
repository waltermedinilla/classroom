#!/usr/bin/env node
// Regenera views/partials/head-iconos.ejs con los iconos que la aplicación usa hoy.
//
// Se corre con:  npm run iconos:actualizar
//
// Cuándo hay que correrlo: cada vez que se agrega (o se saca) un icono. No hay que
// acordarse: tests/unit/iconos.test.js falla y lo dice con estas mismas palabras.

const fs = require('fs');
const { escanearIconos, urlDeIconos, PARTIAL } = require('./iconos');

const iconos = escanearIconos();
const url = urlDeIconos(iconos);

const contenido = `<%# ─────────────────────────────────────────────────────────────────────────────
     Fuente de iconos (Material Symbols). UN solo lugar para las 87 vistas.

     Antes esta línea estaba repetida en cada vista —cada una tiene su propio <head>— y
     cambiar algo acá significaba tocar 87 archivos. Ahora se incluye.

     Dos decisiones dentro de esa URL, las dos con su motivo:

     1. display=block
        Los iconos se escriben en el HTML como TEXTO ("dynamic_feed") y la fuente los
        convierte en dibujo mediante ligaduras. Con display=swap el navegador dibujaba la
        PALABRA mientras bajaba la fuente, y como es mucho más ancha que el glifo,
        descolocaba el menú entero. Con block no dibuja nada hasta que la fuente llega.

     2. icon_names
        La familia completa pesa 3,8 MB (~3.700 iconos) y la app usa ${iconos.length}. Pidiendo
        solo esos, el archivo baja a ~233 KB: 17 veces menos. No se nota en una computadora
        sola, pero a las 7 de la mañana con 300 dispositivos son 70 MB por el enlace de la
        escuela en vez de 1,1 GB.

     ⚠️ LA LISTA NO SE EDITA A MANO, Y NO SE LE SACA NINGUNO. Un icono que falte no da error
     en ningún log: se muestra con su NOMBRE en inglés al lado del control, para siempre.
     La genera tools/actualizar-iconos.js y la vigila tests/unit/iconos.test.js.

     Si ese test falla:   npm run iconos:actualizar

     ⚠️ Tampoco se aloja la fuente en el servidor propio, aunque parezca más prolijo: medido
     el 2026-08-30 desde Mendoza, Google entregó 3,8 MB en 0,34 s y el VPS 145 KB en 1,83 s.
     Google tiene nodos en Argentina; el VPS es una máquina sola en Alemania. Servirla desde
     casa la haría decenas de veces más lenta.
──────────────────────────────────────────────────────────────────────────── %>
<link rel="stylesheet" href="${url}" />
`;

fs.writeFileSync(PARTIAL, contenido, 'utf8');
console.log(`head-iconos.ejs actualizado: ${iconos.length} iconos, URL de ${url.length} caracteres.`);
