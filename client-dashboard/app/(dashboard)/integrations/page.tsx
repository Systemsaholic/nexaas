"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, CheckCircle2, AlertCircle, Circle } from "lucide-react";

interface Provider {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  connection: {
    status: string;
    connected_at: string | null;
    error_message: string | null;
  } | null;
}

export default function IntegrationsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchProviders() {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations");
      const json = await res.json();
      if (json.ok) setProviders(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchProviders(); }, []);

  function StatusIcon({ status }: { status: string | null }) {
    if (!status || status === "pending") return <Circle className="h-4 w-4 text-zinc-300" />;
    if (status === "connected") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    if (status === "error") return <AlertCircle className="h-4 w-4 text-red-500" />;
    return <Circle className="h-4 w-4 text-zinc-300" />;
  }

  const [apiKeyModal, setApiKeyModal] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const OAUTH_PROVIDERS = ["gmail", "microsoft_365"];
  const PLAID_PROVIDER = "plaid";

  function handleConnect(providerId: string) {
    if (OAUTH_PROVIDERS.includes(providerId)) {
      // OAuth redirect
      window.location.href = `/api/integrations/oauth/authorize?provider=${providerId}`;
    } else if (providerId === PLAID_PROVIDER) {
      // Plaid Link — handled separately
      launchPlaidLink();
    } else {
      // API key form
      setApiKeyModal(providerId);
    }
  }

  async function launchPlaidLink() {
    try {
      const res = await fetch("/api/integrations/plaid/link-token", { method: "POST" });
      const json = await res.json();
      if (!json.ok) { setMessage(`Error: ${json.error}`); return; }
      // Plaid Link requires the client-side SDK — for now show instructions
      setMessage("Plaid Link token created. Client-side Plaid Link SDK integration pending.");
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  }

  async function submitApiKey() {
    if (!apiKeyModal || !apiKeyValue) return;
    try {
      const res = await fetch(`/api/integrations/${apiKeyModal}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKeyValue }),
      });
      const json = await res.json();
      setMessage(json.ok ? `${apiKeyModal} connected` : `Error: ${json.error}`);
      setApiKeyModal(null);
      setApiKeyValue("");
      fetchProviders();
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  }

  async function handleDisconnect(providerId: string) {
    if (!confirm(`Disconnect ${providerId}?`)) return;
    try {
      await fetch(`/api/integrations/${providerId}`, { method: "DELETE" });
      fetchProviders();
    } catch { /* ignore */ }
  }

  const connected = providers.filter((p) => p.connection?.status === "connected");
  const available = providers.filter((p) => p.connection?.status !== "connected");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Integrations</h1>
          <p className="text-sm text-zinc-500 mt-1">{connected.length} connected, {available.length} available</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchProviders} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Connected */}
      {connected.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-500 mb-3">Connected</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {connected.map((p) => (
              <Card key={p.id}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{p.icon}</span>
                      <div>
                        <p className="text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-zinc-400">{p.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
                      </span>
                      <Button variant="ghost" size="sm" className="text-xs text-red-500" onClick={() => handleDisconnect(p.id)}>Disconnect</Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Available */}
      <div>
        <h2 className="text-sm font-medium text-zinc-500 mb-3">Available</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {available.map((p) => (
            <Card key={p.id} className="transition-shadow hover:shadow-md">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{p.icon}</span>
                    <div>
                      <p className="text-sm font-medium">{p.name}</p>
                      <p className="text-xs text-zinc-400">{p.description}</p>
                    </div>
                  </div>
                  <Button size="sm" onClick={() => handleConnect(p.id)}>Connect</Button>
                </div>
                {p.connection?.error_message && (
                  <p className="text-xs text-red-500 mt-2">{p.connection.error_message}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Status message */}
      {message && (
        <div className={`rounded-md p-3 text-sm ${message.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {message}
        </div>
      )}

      {/* API Key Modal */}
      {apiKeyModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-sm">
            <CardContent className="pt-6 space-y-4">
              <p className="text-sm font-medium capitalize">Connect {apiKeyModal}</p>
              <input
                type="password"
                placeholder="Enter API key"
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => { setApiKeyModal(null); setApiKeyValue(""); }}>Cancel</Button>
                <Button size="sm" onClick={submitApiKey} disabled={!apiKeyValue}>Connect</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
