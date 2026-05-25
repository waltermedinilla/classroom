const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      // Pool de conexiones: 10 por proceso de Node.
      // Con PM2 en modo cluster (ej. 4 workers) → 40 conexiones en total a MongoDB.
      // Suficiente para una escuela con acceso concurrente real.
      maxPoolSize: 10,
      // Si MongoDB no responde en 5 s, lanza error en lugar de quedar colgado
      serverSelectionTimeoutMS: 5000,
      // Tiempo máximo de inactividad de un socket antes de cerrarlo
      socketTimeoutMS: 45000,
    });
    console.log(`MongoDB conectado: ${conn.connection.host} (pool: 10)`);
  } catch (error) {
    console.error(`Error conectando a MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
