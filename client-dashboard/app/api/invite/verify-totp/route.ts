import { queryOne } from "@/lib/db";
import { verifyTotp } from "@/lib/totp";
import { NextResponse } from "next/server";

// POST: Verify TOTP during setup to enable 2FA
export async function POST(request: Request) {
  const { email, code } = await request.json();

  if (!email || !code) {
    return NextResponse.json({ error: "Email and code required" }, { status: 400 });
  }

  const user = await queryOne<{ id: string; totp_secret: string }>(
    `SELECT id, totp_secret FROM users WHERE email = $1`,
    [email]
  );

  if (!user?.totp_secret) {
    return NextResponse.json({ error: "No TOTP secret found" }, { status: 400 });
  }

  const valid = verifyTotp(user.totp_secret, code, email);
  if (!valid) {
    return NextResponse.json({ error: "Invalid code. Try again." }, { status: 400 });
  }

  // Enable TOTP
  await queryOne(
    `UPDATE users SET totp_enabled = true WHERE id = $1`,
    [user.id]
  );

  return NextResponse.json({ ok: true, message: "2FA enabled successfully" });
}
