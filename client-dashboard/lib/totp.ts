import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";

export function generateTotpSecret(): string {
  const secret = new Secret({ size: 20 });
  return secret.base32;
}

export function createTotp(secret: string, email: string): TOTP {
  return new TOTP({
    issuer: "Nexmatic",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

export function verifyTotp(secret: string, token: string, email: string): boolean {
  const totp = createTotp(secret, email);
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

export async function generateQrCodeDataUrl(secret: string, email: string): Promise<string> {
  const totp = createTotp(secret, email);
  const uri = totp.toString();
  return QRCode.toDataURL(uri);
}
