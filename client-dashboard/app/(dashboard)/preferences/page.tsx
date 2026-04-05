"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Save } from "lucide-react";

interface Preferences {
  tone: string;
  domain: string;
  approval_gates: Record<string, string>;
  hard_limits: string[];
  escalation_rules: Record<string, string>;
  notification_prefs: { channel: string; mode: string };
}

const GATE_OPTIONS = ["auto_execute", "notify_after", "required", "always_manual"];
const NOTIFY_MODES = ["digest_urgent_only", "notify_all", "daily_digest"];

export default function PreferencesPage() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newLimit, setNewLimit] = useState("");

  useEffect(() => {
    fetch("/api/preferences").then((r) => r.json()).then((j) => {
      if (j.ok) setPrefs(j.data);
      setLoading(false);
    });
  }, []);

  async function save() {
    if (!prefs) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      const json = await res.json();
      setMessage(json.ok ? "Preferences saved" : `Error: ${json.error}`);
    } finally {
      setSaving(false);
    }
  }

  function updateGate(key: string, value: string) {
    if (!prefs) return;
    setPrefs({ ...prefs, approval_gates: { ...prefs.approval_gates, [key]: value } });
  }

  function updateEscalation(key: string, value: string) {
    if (!prefs) return;
    setPrefs({ ...prefs, escalation_rules: { ...prefs.escalation_rules, [key]: value } });
  }

  function addHardLimit() {
    if (!prefs || !newLimit.trim()) return;
    setPrefs({ ...prefs, hard_limits: [...prefs.hard_limits, newLimit.trim()] });
    setNewLimit("");
  }

  function removeHardLimit(index: number) {
    if (!prefs) return;
    setPrefs({ ...prefs, hard_limits: prefs.hard_limits.filter((_, i) => i !== index) });
  }

  if (loading || !prefs) return <p className="text-zinc-400">Loading...</p>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Preferences</h1>
          <p className="text-sm text-zinc-500 mt-1">Configure how your AI behaves</p>
        </div>
        <Button onClick={save} disabled={saving}>
          <Save className="h-4 w-4 mr-2" /> {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {message && (
        <div className={`rounded-md p-3 text-sm ${message.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {message}
        </div>
      )}

      {/* Tone & Domain */}
      <Card>
        <CardHeader><CardTitle className="text-base">Tone & Domain</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Communication Tone</label>
            <Input value={prefs.tone} onChange={(e) => setPrefs({ ...prefs, tone: e.target.value })} placeholder="e.g. warm, professional" />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Business Domain</label>
            <Input value={prefs.domain} onChange={(e) => setPrefs({ ...prefs, domain: e.target.value })} placeholder="e.g. healthcare, trades, hospitality" />
          </div>
        </CardContent>
      </Card>

      {/* Approval Gates */}
      <Card>
        <CardHeader><CardTitle className="text-base">Approval Gates</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-zinc-500">Control when the AI needs your approval before acting.</p>
          {Object.entries(prefs.approval_gates).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm capitalize">{key.replace(/_/g, " ")}</span>
              <select
                value={value}
                onChange={(e) => updateGate(key, e.target.value)}
                className="rounded-md border bg-transparent px-2 py-1 text-sm"
              >
                {GATE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Hard Limits */}
      <Card>
        <CardHeader><CardTitle className="text-base">Hard Limits</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-zinc-500">Things the AI should never do, regardless of context.</p>
          {prefs.hard_limits.map((limit, i) => (
            <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">{limit}</span>
              <Button variant="ghost" size="sm" onClick={() => removeHardLimit(i)} className="text-red-500 text-xs">Remove</Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={newLimit} onChange={(e) => setNewLimit(e.target.value)} placeholder="e.g. Never discuss pricing" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addHardLimit())} />
            <Button variant="outline" size="sm" onClick={addHardLimit} disabled={!newLimit.trim()}>Add</Button>
          </div>
        </CardContent>
      </Card>

      {/* Escalation Rules */}
      <Card>
        <CardHeader><CardTitle className="text-base">Escalation Rules</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-zinc-500">Who should the AI escalate specific issues to?</p>
          {Object.entries(prefs.escalation_rules).map(([key, value]) => (
            <div key={key}>
              <label className="text-sm font-medium mb-1 block capitalize">{key} matters</label>
              <Input type="email" value={value} onChange={(e) => updateEscalation(key, e.target.value)} placeholder="email@example.com" />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Notification Preferences */}
      <Card>
        <CardHeader><CardTitle className="text-base">Notifications</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Notification Mode</label>
            <select
              value={prefs.notification_prefs.mode}
              onChange={(e) => setPrefs({ ...prefs, notification_prefs: { ...prefs.notification_prefs, mode: e.target.value } })}
              className="rounded-md border bg-transparent px-2 py-1 text-sm w-full"
            >
              {NOTIFY_MODES.map((m) => (
                <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
