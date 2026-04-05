import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { queryOne } from "./db";
import { verifyTotp } from "./totp";

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    Credentials({
      id: "credentials",
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totpCode: { label: "2FA Code", type: "text" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string;
        const password = credentials?.password as string;
        const totpCode = credentials?.totpCode as string | undefined;

        if (!email || !password) return null;

        const user = await queryOne<{
          id: string;
          email: string;
          username: string;
          password_hash: string;
          role: string;
          company_id: string;
          totp_enabled: boolean;
          totp_secret: string | null;
        }>(
          `SELECT id, email, username, password_hash, role, company_id, totp_enabled, totp_secret
           FROM users WHERE email = $1`,
          [email]
        );

        if (!user) return null;

        const passwordValid = await bcrypt.compare(password, user.password_hash);
        if (!passwordValid) return null;

        // Check TOTP if enabled
        if (user.totp_enabled && user.totp_secret) {
          if (!totpCode) return null; // Need 2FA code
          const totpValid = verifyTotp(user.totp_secret, totpCode, user.email);
          if (!totpValid) return null;
        }

        // Update last login
        await queryOne(
          `UPDATE users SET last_login = NOW() WHERE id = $1`,
          [user.id]
        );

        return {
          id: user.id,
          email: user.email,
          name: user.username,
          role: user.role,
          companyId: user.company_id,
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role;
        token.companyId = (user as any).companyId;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.sub;
        (session.user as any).role = token.role;
        (session.user as any).companyId = token.companyId;
      }
      return session;
    },
  },
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },
});
