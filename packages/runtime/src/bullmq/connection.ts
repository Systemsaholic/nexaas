/**
 * Shared Redis connection for BullMQ.
 * Uses the IORedis pattern recommended by BullMQ docs.
 */

import { Redis } from "ioredis";

let _connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!_connection) {
    _connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return _connection;
}

export function getRedisConnectionOpts() {
  return { connection: getRedisConnection() };
}
