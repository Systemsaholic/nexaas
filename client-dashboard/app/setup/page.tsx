"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, CheckCircle2 } from "lucide-react";

export default function SetupPage() {
  return <Suspense><SetupFlow /></Suspense>;
}

function SetupFlow() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");

  const [step, setStep] = useState<"password" | "totp" | "verify" | "done">("password");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [email, setEmail] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="max-w-sm"><CardContent className="pt-6 text-center text-zinc-500">Invalid setup link.</CardContent></Card>
      </div>
    );
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { setError("Passwords don't match"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }

    setLoading(true);
    setError("");

    const res = await fetch("/api/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const json = await res.json();

    if (json.ok) {
      setQrCode(json.qrCode);
      setTotpSecret(json.totpSecret);
      setEmail(json.email);
      setStep("totp");
    } else {
      setError(json.error ?? "Setup failed");
    }
    setLoading(false);
  }

  async function handleVerifyTotp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/invite/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: verifyCode }),
    });
    const json = await res.json();

    if (json.ok) {
      setStep("done");
    } else {
      setError(json.error ?? "Verification failed");
    }
    setLoading(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Welcome to Nexmatic</CardTitle>
          <p className="text-sm text-zinc-500">
            {step === "password" && "Set your password to get started"}
            {step === "totp" && "Set up two-factor authentication"}
            {step === "verify" && "Verify your authenticator app"}
            {step === "done" && "You're all set!"}
          </p>
        </CardHeader>
        <CardContent>
          {step === "password" && (
            <form onSubmit={handleSetPassword} className="space-y-4">
              <Input type="password" placeholder="Password (min 8 characters)" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
              <Input type="password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button type="submit" disabled={loading} className="w-full">{loading ? "Setting up..." : "Set Password"}</Button>
            </form>
          )}

          {step === "totp" && (
            <div className="space-y-4 text-center">
              <div className="flex items-center justify-center gap-2 text-sm text-zinc-500">
                <Shield className="h-4 w-4" />
                <span>Scan this QR code with your authenticator app</span>
              </div>
              {qrCode && <img src={qrCode} alt="TOTP QR Code" className="mx-auto rounded-md border" />}
              <p className="text-xs text-zinc-400">
                Manual entry: <code className="bg-zinc-100 px-1 rounded dark:bg-zinc-800">{totpSecret}</code>
              </p>
              <Button onClick={() => setStep("verify")} className="w-full">I've scanned the code</Button>
            </div>
          )}

          {step === "verify" && (
            <form onSubmit={handleVerifyTotp} className="space-y-4">
              <p className="text-sm text-zinc-500 text-center">Enter the 6-digit code from your authenticator app</p>
              <Input
                type="text" placeholder="000000" value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                maxLength={6} autoFocus className="text-center text-2xl tracking-widest font-mono"
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button type="submit" disabled={loading || verifyCode.length !== 6} className="w-full">
                {loading ? "Verifying..." : "Verify & Enable 2FA"}
              </Button>
            </form>
          )}

          {step === "done" && (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
              <p className="text-sm">Your account is ready with 2FA enabled.</p>
              <Button onClick={() => router.push("/login")} className="w-full">Go to Login</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
