import { disconnectMongo } from '../src/infra/mongo/connection.js';
import { getRedisClient } from '../src/infra/redis/connection.js';

export default async function globalTeardown() {
  console.log('[Global Teardown] Starting cleanup...');

  try {
    // Disconnect from MongoDB
    await disconnectMongo();
    console.log('[Global Teardown] Disconnected from MongoDB');
  } catch (error) {
    console.error('[Global Teardown] Error disconnecting MongoDB:', error);
  }

  try {
    // Close Redis connection if available
    const redisClient = getRedisClient();
    if (redisClient) {
      await redisClient.quit();
      console.log('[Global Teardown] Closed Redis connection');
    }
  } catch (error) {
    console.error('[Global Teardown] Error closing Redis:', error);
  }

  console.log('[Global Teardown] Cleanup complete');
}
