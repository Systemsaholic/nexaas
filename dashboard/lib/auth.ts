import { cookies } from "next/headers";

const COOKIE_NAME = "nexaas_admin";

export async function isAuthenticated(): Promise<boolean> {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;

  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  return token === secret;
}

export function isAuthenticatedFromHeader(request: Request): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7) === secret;
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] === secret;
}

export { COOKIE_NAME };
