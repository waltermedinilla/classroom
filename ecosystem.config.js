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

    // Modo cluster: PM2 lanza un worker por core de CPU.
    // Cada worker es un proceso Node.js independiente que comparte el puerto.
    // Si un worker cae, los demás siguen atendiendo; PM2 reinicia el caído solo.
    instances:  2,
    exec_mode:  'cluster',

    // Reinicia el worker si consume más de 400 MB de RAM (previene memory leaks acumulados)
    max_memory_restart: '400M',

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
  }],
};
