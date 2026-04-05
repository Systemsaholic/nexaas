"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, AlertCircle, Zap, Brain, Shield, BookOpen } from "lucide-react";

interface ClientSkill {
  id: string;
  name: string;
  category: string;
  active: boolean;
  version: string;
  type: "simple" | "agentic";
  description: string;
  configured: boolean;
  missingConfig: string[];
  features: string[];
  actions: string[];
}

const featureIcons: Record<string, typeof Zap> = {
  "Fast AI classification": Zap,
  "Multi-step AI pipeline": Brain,
  "Asks before risky actions": Shield,
  "Full audit trail": BookOpen,
};

export default function SkillsPage() {
  const [skills, setSkills] = useState<ClientSkill[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchSkills() {
    setLoading(true);
    try {
      const res = await fetch("/api/skills");
      const json = await res.json();
      if (json.ok) setSkills(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchSkills(); }, []);

  const active = skills.filter((s) => s.active);
  const inactive = skills.filter((s) => !s.active);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AI Skills</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {active.length} active, {inactive.length} available
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSkills} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {skills.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Zap className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No skills installed yet</h3>
            <p className="text-sm text-zinc-500 max-w-md mx-auto">
              Your AI skills are being set up. Once activated, they'll appear here and start
              working on your behalf — automatically handling tasks within the rules you set.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Active Skills */}
      {active.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-500 mb-3">Active — working for you</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {active.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </div>
      )}

      {/* Inactive Skills */}
      {inactive.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-500 mb-3">
            {inactive.some((s) => !s.configured) ? "Needs setup" : "Available to activate"}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {inactive.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SkillCard({ skill }: { skill: ClientSkill }) {
  return (
    <Card className={skill.active ? "border-green-200 dark:border-green-900" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{skill.name}</CardTitle>
          <div className="flex gap-1">
            {skill.active ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
                <CheckCircle2 className="h-3 w-3" /> Active
              </span>
            ) : !skill.configured ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-700">
                <AlertCircle className="h-3 w-3" /> Needs setup
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-zinc-100 text-zinc-500">
                Inactive
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-zinc-500">{skill.description}</p>

        {/* Features */}
        {skill.features.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {skill.features.map((f) => {
              const Icon = featureIcons[f];
              return (
                <span key={f} className="inline-flex items-center gap-1 rounded-md bg-zinc-50 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                  {Icon && <Icon className="h-3 w-3" />}
                  {f}
                </span>
              );
            })}
          </div>
        )}

        {/* Missing config warning */}
        {!skill.configured && skill.missingConfig.length > 0 && (
          <div className="rounded-md bg-yellow-50 p-2 text-xs text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400">
            <p className="font-medium mb-1">Setup required:</p>
            <ul className="list-disc list-inside">
              {skill.missingConfig.map((field) => (
                <li key={field}>{field.replace(/_/g, " ").replace(/\./g, " → ")}</li>
              ))}
            </ul>
            <p className="mt-1 text-yellow-600">Contact your admin to complete the setup.</p>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>{skill.category} • v{skill.version}</span>
          <Badge variant="outline" className="text-xs">
            {skill.type === "agentic" ? "Multi-step AI" : "Quick AI"}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
