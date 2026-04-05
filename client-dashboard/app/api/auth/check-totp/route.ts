import { queryOne } from "@/lib/db";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { email } = await request.json();
  if (!email) return NextResponse.json({ totpRequired: false });

  const user = await queryOne<{ totp_enabled: boolean }>(
    `SELECT totp_enabled FROM users WHERE email = $1`,
    [email]
  );

  return NextResponse.json({ totpRequired: user?.totp_enabled ?? false });
}
