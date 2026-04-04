"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Key, Plus, Trash2, Shield } from "lucide-react";

interface ApiKey {
  id: number;
  provider: string;
  key_name: string;
  api_key_masked: string;
  is_default: boolean;
  active: boolean;
}

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", logo: "A" },
  { id: "openai", name: "OpenAI", logo: "O" },
  { id: "gemini", name: "Gemini", logo: "G" },
];

export function InstanceKeys({ instanceId }: { instanceId: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [useDefault, setUseDefault] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function fetchKeys() {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/keys`);
      const json = await res.json();
      if (json.ok) setKeys(json.data.keys ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function addKey(provider: string) {
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: useDefault ? undefined : newKey,
          isDefault: useDefault,
        }),
      });
      const json = await res.json();
      setMessage(json.ok ? `${provider} key configured` : `Error: ${json.error}`);
      setAdding(null);
      setNewKey("");
      setUseDefault(false);
      fetchKeys();
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  }

  async function removeKey(provider: string) {
    if (!confirm(`Remove ${provider} key from this instance?`)) return;
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/keys`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const json = await res.json();
      setMessage(json.ok ? `${provider} key removed` : `Error: ${json.error}`);
      fetchKeys();
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  }

  useEffect(() => { fetchKeys(); }, [instanceId]);

  const configuredProviders = new Set(keys.map((k) => k.provider));

  return (
    <div className="space-y-4">
      {message && (
        <div className={`rounded-md p-2 text-sm ${message.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {message}
        </div>
      )}

      {/* Configured Keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Provider Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {keys.length === 0 && !loading && (
            <p className="text-sm text-zinc-400">No API keys configured. Skills requiring AI won't run without keys.</p>
          )}

          {keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between rounded-md border p-3">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-100 text-xs font-bold dark:bg-zinc-800">
                  {key.provider.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize">{key.provider}</span>
                    {key.is_default && (
                      <Badge variant="secondary" className="text-xs">
                        <Shield className="h-3 w-3 mr-1" /> Nexmatic
                      </Badge>
                    )}
                  </div>
                  <code className="text-xs text-zinc-400">{key.api_key_masked}</code>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeKey(key.provider)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Add Key */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Provider</CardTitle>
        </CardHeader>
        <CardContent>
          {adding ? (
            <div className="space-y-3">
              <p className="text-sm font-medium capitalize">{adding}</p>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useDefault}
                  onChange={(e) => { setUseDefault(e.target.checked); setNewKey(""); }}
                  className="accent-zinc-900"
                />
                <span className="text-sm">Use Nexmatic's key (usage billed to client)</span>
              </label>

              {!useDefault && (
                <Input
                  type="password"
                  placeholder={`${adding === "anthropic" ? "sk-ant-" : adding === "openai" ? "sk-" : "AI"}...`}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                />
              )}

              <div className="flex gap-2">
                <Button size="sm" onClick={() => addKey(adding)} disabled={!useDefault && !newKey}>
                  Save Key
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setAdding(null); setNewKey(""); setUseDefault(false); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              {PROVIDERS.filter((p) => !configuredProviders.has(p.id)).map((provider) => (
                <Button key={provider.id} variant="outline" size="sm" onClick={() => setAdding(provider.id)}>
                  <Plus className="h-3 w-3 mr-1" />
                  {provider.name}
                </Button>
              ))}
              {PROVIDERS.every((p) => configuredProviders.has(p.id)) && (
                <p className="text-sm text-zinc-400">All providers configured.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
