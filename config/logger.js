const winston = require('winston');
const path    = require('path');
const fs      = require('fs');

const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

const fmt = winston.format;

const logger = winston.createLogger({
  level: 'info',
  format: fmt.combine(
    fmt.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
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
