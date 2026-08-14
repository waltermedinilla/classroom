const winston = require('winston');
const path    = require('path');
const fs      = require('fs');

const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

const fmt = winston.format;

// `pid` en TODAS las líneas. Con PM2 en modo cluster hay 2 workers y, sin esto, no hay forma
// de saber cuál atendió una request: el 2026-08-11 se perdió media hora persiguiendo un
// "worker zombi" que no existía, justamente porque las líneas del log no dicen de quién son.
// `/health` ya lo expone; el log no lo hacía.
const conPid = fmt((info) => {
  info.pid = process.pid;
  return info;
});

const logger = winston.createLogger({
  level: 'info',
  format: fmt.combine(
    // Timestamp CON offset. El formato anterior ('YYYY-MM-DD HH:mm:ss') era hora local sin
    // zona, y producción corre en UTC: una línea que decía "16:50:31" había que cruzarla a
    // mano con el "19:50:31 GMT" del header HTTP para saber si hablaban del mismo evento.
    fmt.timestamp({ format: 'YYYY-MM-DDTHH:mm:ssZZ' }),
    conPid(),
    fmt.errors({ stack: true }),
    fmt.json()
  ),
  transports: [
    // Solo errores
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
    }),
    // Todo (info, warn, error)
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
    }),
  ],
});

// En desarrollo también muestra en consola con formato legible
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: fmt.combine(
      fmt.colorize(),
      fmt.timestamp({ format: 'HH:mm:ss' }),
      fmt.printf(({ timestamp, level, message, stack }) =>
        stack ? `${timestamp} ${level}: ${message}\n${stack}` : `${timestamp} ${level}: ${message}`
      )
    ),
  }));
}

module.exports = logger;
