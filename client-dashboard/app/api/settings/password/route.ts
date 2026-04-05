import { queryOne } from "@/lib/db";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

export async function POST(request: Request) {
  const { email, currentPassword, newPassword } = await request.json();

  if (!email || !currentPassword || !newPassword) {
    return NextResponse.json({ error: "All fields required" }, { status: 400 });
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 });
  }

  const user = await queryOne<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM users WHERE email = $1`,
    [email]
  );

  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await queryOne(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, user.id]);

  return NextResponse.json({ ok: true, message: "Password updated" });
}
