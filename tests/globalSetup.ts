import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectMongo, disconnectMongo } from '../src/infra/mongo/connection.js';

let mongoServer: MongoMemoryServer;

export default async function globalSetup() {
  console.log('[Global Setup] Starting MongoDB Memory Server...');

  mongoServer = await MongoMemoryServer.create({
    instance: {
      port: undefined, // Let the system assign a free port
      dbName: 'navin-test',
    },
    binary: {
      version: '7.0.14',
    },
  });

  const mongoUri = mongoServer.getUri();
  console.log(`[Global Setup] MongoDB Memory Server running at: ${mongoUri}`);

  // Set the MongoDB URI in environment for all tests
  process.env.MONGO_URI = mongoUri;

  // Connect once to verify the server is working
  await connectMongo(mongoUri);
  console.log('[Global Setup] Connected to MongoDB Memory Server');

  await disconnectMongo();
  console.log('[Global Setup] Disconnected for test isolation');
}

export { mongoServer };
