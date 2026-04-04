import { ok } from "@/lib/api-response";

// Returns the terminal token for authenticated users.
// The middleware already verified auth (cookie or bearer) before this runs.
export async function GET() {
  return ok({ token: process.env.ADMIN_SECRET ?? "" });
}
