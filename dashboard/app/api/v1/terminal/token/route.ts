import { ok } from "@/lib/api-response";
import crypto from "node:crypto";

// Returns a short-lived terminal token (not the raw ADMIN_SECRET).
// The middleware already verified auth before this runs.
// The terminal server validates this token against the same HMAC.
export async function GET() {
  const secret = process.env.ADMIN_SECRET ?? "";
  const timestamp = Date.now();
  const payload = `terminal:${timestamp}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const token = `${timestamp}:${hmac}`;

  return ok({ token });
}
