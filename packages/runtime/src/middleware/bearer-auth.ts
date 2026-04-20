/**
 * Bearer-token middleware for cross-VPS framework HTTP endpoints (#53).
 *
 * Token source: NEXAAS_CROSS_VPS_BEARER_TOKEN env var.
 *
 * Behavior:
 *   - Unset  → pass through. Preserves direct-adopter (Phoenix) behavior:
 *              endpoints stay open on the VPS, trusted because no peer
 *              writes to them.
 *   - Set    → require `Authorization: Bearer <token>` header on every
 *              request. 401 JSON response on mismatch or missing header.
 *              Constant-time comparison to avoid timing oracles.
 *
 * Applied to endpoints that accept writes from peer VPSes in
 * operator-managed mode (Nexmatic): /api/waitpoints/inbound-match,
 * /api/drawers/inbound. NOT applied to dashboard-local endpoints
 * (/api/pa/message) or health/observability (/health, /queues).
 *
 * Rotation: env var change + worker restart. No dynamic rotation in v1.
 */

import type { RequestHandler } from "express";
import { timingSafeEqual } from "crypto";

export function bearerAuth(): RequestHandler {
  const token = process.env.NEXAAS_CROSS_VPS_BEARER_TOKEN;

  if (!token) {
    return (_req, _res, next) => next();
  }

  const expected = Buffer.from(token, "utf8");

  return (req, res, next) => {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "bearer token required" });
      return;
    }
    const presented = Buffer.from(header.slice(7), "utf8");
    // timingSafeEqual requires equal-length buffers.
    if (presented.length !== expected.length) {
      res.status(401).json({ error: "bearer token required" });
      return;
    }
    if (!timingSafeEqual(presented, expected)) {
      res.status(401).json({ error: "bearer token required" });
      return;
    }
    next();
  };
}
