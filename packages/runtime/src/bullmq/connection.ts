/**
 * Shared Redis connection for BullMQ.
 * Both workers and queues use the same connection config.
 */

import IORedis from "ioredis";

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });
  }
  return _connection;
}

export function getRedisConnectionOpts(): { connection: IORedis } {
  return { connection: getRedisConnection() };
}
