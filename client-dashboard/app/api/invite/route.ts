import { queryOne } from "@/lib/db";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { generateTotpSecret, generateQrCodeDataUrl } from "@/lib/totp";

// POST: Accept invite — set password + setup TOTP
export async function POST(request: Request) {
  const { token, password } = await request.json();

  if (!token || !password) {
    return NextResponse.json({ error: "Token and password required" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const user = await queryOne<{ id: string; email: string; invite_expires: string }>(
    `SELECT id, email, invite_expires FROM users WHERE invite_token = $1`,
    [token]
  );

  if (!user) {
    return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 });
  }

  if (new Date(user.invite_expires) < new Date()) {
    return NextResponse.json({ error: "Invite has expired" }, { status: 400 });
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);

  // Generate TOTP secret
  const totpSecret = generateTotpSecret();
  const qrCode = await generateQrCodeDataUrl(totpSecret, user.email);

  // Update user
  await queryOne(
    `UPDATE users SET password_hash = $1, totp_secret = $2, invite_token = NULL, invite_expires = NULL WHERE id = $3`,
    [passwordHash, totpSecret, user.id]
  );

  return NextResponse.json({
    ok: true,
    email: user.email,
    totpSecret,
    qrCode,
    message: "Password set. Scan the QR code with your authenticator app.",
  });
}
