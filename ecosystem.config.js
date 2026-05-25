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

    // Logs unificados de todos los workers en un solo archivo
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:      'logs/error.log',
    out_file:        'logs/out.log',
    merge_logs:      true,  // Un solo archivo en lugar de uno por worker

    // Espera 5 s antes de reiniciar tras un crash (evita bucles de reinicio rápido)
    restart_delay: 5000,

    // Si crashea más de 10 veces en 30 min, PM2 deja de reiniciarlo (evita bucle infinito)
    max_restarts:   10,
    min_uptime:     '30s',
  }],
};
