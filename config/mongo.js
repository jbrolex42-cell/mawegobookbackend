
'use strict';

const mongoose = require('mongoose');

const CONNECTION_OPTIONS = {
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 0,
  retryWrites: true
};

let connectionPromise = null;

async function connectMongo() {
  const uri = process.env.MONGODB_URI;

  if (!uri || !uri.trim()) {
    throw new Error(
      'MONGODB_URI is not configured.\n' +
      'Add your MongoDB connection string to your .env file.\n\n' +
      'Example:\n' +
      'MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/mawego'
    );
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  mongoose.set('strictQuery', true);

  connectionPromise = mongoose
    .connect(uri, CONNECTION_OPTIONS)
    .then(() => {
      console.log(
        `MongoDB connected successfully: ${mongoose.connection.name}`
      );

      return mongoose.connection;
    })
    .catch((error) => {
      console.error('MongoDB connection failed:', error.message);
      throw error;
    })
    .finally(() => {
      connectionPromise = null;
    });

  return connectionPromise;
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

function getConnectionState() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };

  return states[mongoose.connection.readyState] || 'unknown';
}

async function disconnectMongo() {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.disconnect();

  console.log('MongoDB disconnected successfully.');
}

mongoose.connection.on('connected', () => {
  console.log('MongoDB connection established.');
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB connection lost.');
});

mongoose.connection.on('reconnected', () => {
  console.log('MongoDB connection restored.');
});

mongoose.connection.on('error', (error) => {
  console.error('MongoDB error:', error.message);
});

module.exports = {
  connectMongo,
  disconnectMongo,
  isConnected,
  getConnectionState,
  mongoose
};