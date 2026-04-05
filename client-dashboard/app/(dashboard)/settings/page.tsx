"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shield, Lock } from "lucide-react";

export default function SettingsPage() {
  const { data: session } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) { setMessage("Error: Passwords don't match"); return; }
    if (newPassword.length < 8) { setMessage("Error: Password must be at least 8 characters"); return; }

    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: session?.user?.email,
          currentPassword,
          newPassword,
        }),
      });
      const json = await res.json();
      setMessage(json.ok ? "Password updated successfully" : `Error: ${json.error}`);
      if (json.ok) { setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Account Info */}
      <Card>
        <CardHeader><CardTitle className="text-base">Account</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Email</span>
            <span>{session?.user?.email ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">2FA</span>
            <Badge variant="default" className="text-xs">
              <Shield className="h-3 w-3 mr-1" /> Enabled
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4" /> Change Password
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <Input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            <Input type="password" placeholder="New password (min 8 chars)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            <Input type="password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            {message && (
              <p className={`text-sm ${message.startsWith("Error") ? "text-red-500" : "text-green-500"}`}>{message}</p>
            )}
            <Button type="submit" disabled={saving}>{saving ? "Updating..." : "Update Password"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
