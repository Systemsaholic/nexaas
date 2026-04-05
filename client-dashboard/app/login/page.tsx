"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const result = await signIn("credentials", {
      email,
      password,
      totpCode: step === "totp" ? totpCode : undefined,
      redirect: false,
    });

    if (result?.error) {
      if (step === "credentials" && result.error === "CredentialsSignin") {
        // Could be wrong password OR needs TOTP — try with empty TOTP first
        // If user has TOTP enabled, the authorize function returns null without code
        // We need to check if TOTP is needed
        const checkRes = await fetch("/api/auth/check-totp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const check = await checkRes.json();

        if (check.totpRequired && step === "credentials") {
          setStep("totp");
          setLoading(false);
          return;
        }
      }
      setError(step === "totp" ? "Invalid 2FA code" : "Invalid email or password");
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Nexmatic</CardTitle>
          <p className="text-sm text-zinc-500">
            {step === "credentials" ? "Sign in to your dashboard" : "Enter your 2FA code"}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {step === "credentials" ? (
              <>
                <Input
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Shield className="h-4 w-4" />
                  <span>Open your authenticator app</span>
                </div>
                <Input
                  type="text"
                  placeholder="6-digit code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  maxLength={6}
                  autoFocus
                  className="text-center text-2xl tracking-widest font-mono"
                />
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}

            <Button type="submit" disabled={loading}>
              {loading ? "Signing in..." : step === "totp" ? "Verify" : "Sign in"}
            </Button>

            {step === "totp" && (
              <Button type="button" variant="ghost" className="text-xs" onClick={() => { setStep("credentials"); setTotpCode(""); }}>
                Back to login
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
