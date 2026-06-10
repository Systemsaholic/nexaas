/**
 * Bearer-token middleware for cross-VPS framework HTTP endpoints (#53).
 *
 * Token source: NEXAAS_CROSS_VPS_BEARER_TOKEN env var, with
 * NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS accepted during rotation (#217).
 *
 * Behavior:
 *   - Unset  → pass through. Preserves direct-adopter (Phoenix) behavior:
 *              endpoints stay open on the VPS, trusted because no peer
 *              writes to them.
 *   - Set    → require `Authorization: Bearer <token>` header on every
 *              request. 401 JSON response on mismatch or missing header.
 *              Constant-time comparison to avoid timing oracles.
 *
 * Applied to every mutating /api/* endpoint (#217 surface audit) — not to
 * health/observability (/health, /queues; see docs/security-surface.md for
 * why the dashboard is bind/firewall-gated instead).
 *
 * Rotation (dual-accept, #217): move the live token to
 * NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS, set the new value as
 * NEXAAS_CROSS_VPS_BEARER_TOKEN, restart the worker — both are accepted
 * while senders are updated one by one. Then remove _PREVIOUS and restart
 * again to complete the rotation. Tokens are read at worker startup;
 * every step is an .env edit + restart.
 */

import type { RequestHandler } from "express";
import { timingSafeEqual } from "crypto";

function matches(presented: Buffer, expected: Buffer): boolean {
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export function bearerAuth(): RequestHandler {
  const token = process.env.NEXAAS_CROSS_VPS_BEARER_TOKEN;

  if (!token) {
    return (_req, _res, next) => next();
  }

  const expected = Buffer.from(token, "utf8");
  const previousRaw = process.env.NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS;
  const previous = previousRaw ? Buffer.from(previousRaw, "utf8") : null;

  return (req, res, next) => {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "bearer token required" });
      return;
    }
    const presented = Buffer.from(header.slice(7), "utf8");
    if (matches(presented, expected) || (previous !== null && matches(presented, previous))) {
      next();
      return;
    }
    res.status(401).json({ error: "bearer token required" });
  };
}
