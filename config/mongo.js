/**
 * MongoDB connection for Mawego Bookshop
 * Set MONGODB_URI in .env (MongoDB Atlas or local)
 */
const mongoose = require('mongoose');

let connected = false;

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Add your Atlas connection string to .env\n' +
        'Example: MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/mawego'
    );
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000
  });

  connected = true;
  console.log('MongoDB connected:', mongoose.connection.name);
  return mongoose.connection;
}

function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}

module.exports = { connectMongo, isConnected, mongoose };
