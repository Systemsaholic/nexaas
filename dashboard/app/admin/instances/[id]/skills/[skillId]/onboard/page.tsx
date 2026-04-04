"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ArrowRight, CheckCircle2, Save } from "lucide-react";

interface OnboardingQuestion {
  id: string;
  required: boolean;
  question: string;
  type?: string;
  options?: Array<{ label: string; value: unknown }>;
  examples?: string[];
  maps_to: string;
  default?: unknown;
}

export default function OnboardPage() {
  const { id: instanceId, skillId: rawSkillId } = useParams<{ id: string; skillId: string }>();
  const skillId = (rawSkillId as string).replace("--", "/");
  const router = useRouter();

  const [questions, setQuestions] = useState<OnboardingQuestion[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/v1/instances/${instanceId}/skills/${rawSkillId}/configure`);
        const json = await res.json();
        if (json.ok) {
          setQuestions(json.data.questions ?? []);
          // Pre-fill from existing config
          if (json.data.existingConfig) {
            const existing: Record<string, unknown> = {};
            for (const q of json.data.questions ?? []) {
              const val = getNestedValue(json.data.existingConfig, q.maps_to);
              if (val !== undefined) existing[q.id] = val;
            }
            setAnswers(existing);
          }
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [instanceId, rawSkillId]);

  function setAnswer(questionId: string, value: unknown) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }

  async function saveConfig() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/skills/${rawSkillId}/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const json = await res.json();
      if (json.ok) {
        setDone(true);
      } else {
        setError(json.error ?? "Failed to save");
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-zinc-400">Loading onboarding questions...</div>;
  if (questions.length === 0) return <div className="text-zinc-400">No onboarding questions defined for this skill.</div>;

  if (done) {
    return (
      <div className="max-w-lg space-y-4">
        <Card>
          <CardContent className="pt-6 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
            <h2 className="text-xl font-bold">Onboarding Complete</h2>
            <p className="text-sm text-zinc-500">
              {skillId} is configured on {instanceId}. You can now validate and activate it.
            </p>
            <Link href={`/admin/instances/${instanceId}`}>
              <Button>Back to Instance</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const q = questions[currentStep];
  const isLast = currentStep === questions.length - 1;
  const canProceed = !q.required || answers[q.id] !== undefined;

  return (
    <div className="max-w-lg">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/admin/instances/${instanceId}`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold">Configure: {skillId}</h1>
          <p className="text-sm text-zinc-500">Instance: {instanceId}</p>
        </div>
      </div>

      {/* Progress */}
      <div className="flex gap-1 mb-6">
        {questions.map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full ${
              i < currentStep ? "bg-green-500" : i === currentStep ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-200 dark:bg-zinc-800"
            }`}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              Question {currentStep + 1} of {questions.length}
            </CardTitle>
            {q.required && <Badge variant="destructive">Required</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">{q.question}</p>

          {q.options ? (
            <div className="space-y-2">
              {q.options.map((opt, i) => (
                <label
                  key={i}
                  className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    answers[q.id] === opt.value
                      ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                      : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800"
                  }`}
                >
                  <input
                    type="radio"
                    name={q.id}
                    checked={answers[q.id] === opt.value}
                    onChange={() => setAnswer(q.id, opt.value)}
                    className="accent-zinc-900"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          ) : q.type === "email" ? (
            <Input
              type="email"
              placeholder="email@example.com"
              value={(answers[q.id] as string) ?? ""}
              onChange={(e) => setAnswer(q.id, e.target.value)}
            />
          ) : q.type === "freetext" ? (
            <div>
              <textarea
                className="w-full h-24 rounded-md border bg-zinc-950 p-3 text-sm text-zinc-300 font-mono resize-none focus:outline-none focus:ring-1 focus:ring-zinc-600"
                placeholder={q.examples?.join("\n") ?? "Type your answer..."}
                value={Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join("\n") : (answers[q.id] as string) ?? ""}
                onChange={(e) => setAnswer(q.id, e.target.value.split("\n").filter(Boolean))}
              />
              {q.examples && (
                <p className="text-xs text-zinc-400 mt-1">Examples: {q.examples.join(", ")}</p>
              )}
            </div>
          ) : (
            <Input
              placeholder="Your answer"
              value={(answers[q.id] as string) ?? ""}
              onChange={(e) => setAnswer(q.id, e.target.value)}
            />
          )}

          {error && <div className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</div>}

          <div className="flex justify-between pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentStep((s) => s - 1)}
              disabled={currentStep === 0}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Button>

            {isLast ? (
              <Button size="sm" onClick={saveConfig} disabled={!canProceed || saving}>
                <Save className="h-4 w-4 mr-1" />
                {saving ? "Saving..." : "Save Configuration"}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setCurrentStep((s) => s + 1)} disabled={!canProceed}>
                Next <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
