// Configuración de PM2 para producción.
// Para iniciar: pm2 start ecosystem.config.js
// Para detener: pm2 stop classroom
// Para reiniciar: pm2 restart classroom
// Para ver logs: pm2 logs classroom
// Para monitorear: pm2 monit

module.exports = {
  apps: [{
    name:      'classroom',
    script:    'server.js',

    // Modo cluster: 2 procesos Node independientes que comparten el puerto 3000; el sistema
    // operativo reparte las conexiones entrantes entre ellos. Si uno cae o se recicla, el otro
    // sigue atendiendo — es lo ÚNICO que hace que los reciclados por memoria (ver abajo) pasen
    // inadvertidos en vez de ser un corte de servicio en plena clase.
    //
    // ⚠️ El 2 es un número FIJO escrito a mano, NO "un worker por core": el archivo nació con
    // `instances: 'max'` y se bajó a 2 el mismo día (25/05/2026), con la excusa de "si el
    // servidor es chico". Ninguna de las dos máquinas lo es —el server viejo tiene 12 núcleos
    // y 15 GB; el VPS, 8 y 24 GB—, así que hay margen para subirlo si alguna vez la CPU
    // aprieta. Hoy no aprieta: está al 1%. Dos cosas antes de tocarlo:
    //   · Cada worker tiene SU PROPIO contador de rate limit (por eso vuelca a Mongo cada
    //     minuto, ver rateLimitStats en server.js): el techo real es el configurado × 2.
    //   · Cada worker tiene SU PROPIO max_memory_restart: más workers son MÁS reciclados en
    //     total, no menos. La palanca para eso es el techo de abajo, no este número.
    instances:  2,
    exec_mode:  'cluster',

    // ── Techo de memoria: DOS límites que tienen que estar alineados ────────────────────
    //
    // ⭐ Esto decía 400 MB a secas, y reciclaba los workers cada 4 minutos en horario de clase:
    // 272 reinicios medidos en el VPS y 89 en el servidor viejo, todos con
    // `[PM2][WORKER] ... exceeds --max-memory-restart`. NO era una fuga ni una caída —el worker
    // salía con código 0— era este número peleado con el de V8.
    //
    // Node calcula el techo de su heap según la RAM de la máquina: da 4144 MB (medido en las
    // dos, con `v8.getHeapStatistics()`). V8 no hace recolección profunda hasta acercarse a SU
    // límite, así que con permiso para 4 GB dejaba crecer el heap tranquilo... y a los 400 MB
    // lo mataba PM2. El worker moría lleno de basura que nadie le había pedido juntar.
    // Por eso el RSS tampoco bajaba de noche, con la escuela vacía: 376 MB por worker a las
    // 00:11 del 04/09.
    //
    // El orden correcto es V8 PRIMERO, PM2 después:
    //   --max-old-space-size=768  → V8 compacta al llegar a 768 MB de heap
    //   max_memory_restart 1280M  → PM2 solo interviene si algo se desmadra de verdad
    //
    // ⚠️ Los 512 MB de margen entre uno y otro NO son decorativos ni redondeo: el RSS que mide
    // PM2 es el heap MÁS todo lo nativo (libvips/sharp, los hasta 20 MB por request de las
    // imágenes en memoryStorage, los buffers de mongoose), que no vive en el heap de V8 y que
    // por lo tanto NINGÚN GC baja. Sin margen, PM2 seguiría matando workers sanos.
    //
    // ⚠️ Si tocás uno de los dos números, tocá el otro: tests/unit/limitesMemoria.test.js falla
    // si el techo de PM2 no le deja al heap ese margen.
    //
    // Con 24 GB en el VPS, 2 workers × 1280 MB es el 10% de la máquina.
    max_memory_restart: '1280M',
    node_args: ['--max-old-space-size=768'],

    // No recarga archivos en producción (solo en dev con nodemon)
    watch: false,

    // Variables de entorno de producción (las del .env tienen prioridad si usás dotenv)
    env: {
      NODE_ENV: 'production',
    },

    // Logs unificados de todos los workers en un solo archivo.
    //
    // ⚠️ `error_file` apuntaba a 'logs/error.log', EL MISMO ARCHIVO que escribe winston
    // (config/logger.js). Resultado: el stderr crudo de Node se intercalaba con el JSON
    // estructurado y `tail -40 logs/error.log` devolvía casi puros `DeprecationWarning` de
    // mongoose y punycode — había que filtrar con `grep '"level":"error"'` para ver algo.
    // El 2026-08-11 eso costó una vuelta entera de diagnóstico.
    //
    // Ahora cada uno tiene lo suyo:
    //   logs/error.log      → winston: errores de la aplicación, JSON, uno por línea
    //   logs/combined.log   → winston: todo (info/warn/error), incluye el access log
    //   logs/pm2-error.log  → stderr del proceso: warnings de Node, crashes, arranques
    //   logs/pm2-out.log    → stdout del proceso
    //
    // ⚠️ Al desplegar esto NO alcanza `pm2 restart classroom`: ese comando reusa la
    // configuración guardada y seguiría escribiendo en el archivo viejo. Hay que releer
    // este archivo con `pm2 restart ecosystem.config.js --update-env`.
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:      'logs/pm2-error.log',
    out_file:        'logs/pm2-out.log',
    merge_logs:      true,  // Un solo archivo en lugar de uno por worker

    // Espera 5 s antes de reiniciar tras un crash (evita bucles de reinicio rápido)
    restart_delay: 5000,

    // Si crashea más de 10 veces en 30 min, PM2 deja de reiniciarlo (evita bucle infinito)
    max_restarts:   10,
    min_uptime:     '30s',
  }, {
    // ── Proceso de medios (transmisión en vivo) ──────────────────────────────
    //
    // ⭐ FORK Y UNA SOLA INSTANCIA. No es una preferencia, es la condición para que la feature
    // funcione: un `router` de mediasoup vive en la MEMORIA de un proceso. En cluster, la
    // señalización de un alumno puede caer en un worker mientras el router de su clase está en
    // el otro — y como PM2 reparte por conexión, fallaría LA MITAD DE LAS VECES, al azar.
    // Ver D2 de specs/transmision-en-vivo.spec.md.
    //
    // Está separado de `classroom` además por una razón práctica: el `max_memory_restart` de
    // arriba reinicia a los workers de Express sin avisar, y con la transmisión adentro eso
    // cortaría la clase en el medio.
    name:      'classroom-media',
    script:    'media/servidor.js',
    instances: 1,
    exec_mode: 'fork',

    // Más alto que el de Express: cada worker de mediasoup mantiene sus buffers de RTP. Aun
    // así es un techo, no un objetivo — un SFU no transcodifica y no debería acercarse.
    max_memory_restart: '600M',
    watch: false,

    env: { NODE_ENV: 'production' },

    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:      'logs/media-error.log',
    out_file:        'logs/media-out.log',
    merge_logs:      true,

    restart_delay: 5000,
    max_restarts:  10,
    min_uptime:    '30s',
  }],
};
