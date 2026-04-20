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
    // Without an 'error' listener ioredis emits events that get promoted
    // to uncaughtException. These are usually transient reconnects, not
    // crashes — log them, don't exit. The client handles reconnection
    // automatically.
    _connection.on("error", (err) => {
      console.warn(`[nexaas] redis connection error (client will reconnect): ${err.message}`);
    });
    _connection.on("reconnecting", (delay: number) => {
      console.log(`[nexaas] redis reconnecting in ${delay}ms`);
    });
    _connection.on("end", () => {
      console.warn("[nexaas] redis connection ended");
    });
  }
  return _connection;
}

export function getRedisConnectionOpts() {
  return { connection: getRedisConnection() };
}
