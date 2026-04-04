"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Download, CheckCircle2, XCircle, Play, Pause, Shield, ClipboardList } from "lucide-react";

interface InstanceSkill {
  id: string;
  name: string;
  category: string;
  type: "simple" | "agentic";
  version: string;
  description: string;
  status: string;
  pinnedVersion: string | null;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function InstanceSkills({ instanceId }: { instanceId: string }) {
  const [skills, setSkills] = useState<InstanceSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [validation, setValidation] = useState<Record<string, ValidationResult>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function fetchSkills() {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/skills`);
      const json = await res.json();
      if (json.ok) setSkills(json.data);
    } finally {
      setLoading(false);
    }
  }

  async function deploySkill(skillId: string) {
    setActing(skillId);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId }),
      });
      const json = await res.json();
      setMessage(json.ok ? `Deployed ${skillId}` : `Error: ${json.error}`);
      fetchSkills();
    } finally {
      setActing(null);
    }
  }

  async function validateSkill(skillId: string) {
    const encodedId = skillId.replace("/", "--");
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/skills/${encodedId}/validate`);
      const json = await res.json();
      if (json.ok) {
        setValidation((prev) => ({ ...prev, [skillId]: json.data }));
      }
    } catch { /* ignore */ }
  }

  async function toggleActive(skillId: string, active: boolean) {
    setActing(skillId);
    const encodedId = skillId.replace("/", "--");
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/skills/${encodedId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const json = await res.json();
      setMessage(json.ok ? json.data.message : `Error: ${json.error}`);
      fetchSkills();
    } finally {
      setActing(null);
    }
  }

  useEffect(() => { fetchSkills(); }, [instanceId]);

  const deployed = skills.filter((s) => s.status !== "not_deployed");
  const available = skills.filter((s) => s.status === "not_deployed");

  return (
    <div className="space-y-4">
      {message && (
        <div className={`rounded-md p-2 text-sm ${message.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {message}
        </div>
      )}

      {/* Deployed Skills */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deployed Skills ({deployed.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {deployed.length === 0 ? (
            <p className="text-sm text-zinc-400">No skills deployed to this instance yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Validation</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployed.map((skill) => {
                  const val = validation[skill.id];
                  return (
                    <TableRow key={skill.id}>
                      <TableCell>
                        <div>
                          <span className="font-medium text-sm">{skill.name}</span>
                          <p className="text-xs text-zinc-400">{skill.id}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          skill.type === "agentic" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                        }`}>{skill.type}</span>
                      </TableCell>
                      <TableCell className="font-mono text-sm">v{skill.version}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          skill.status === "active"
                            ? "bg-green-100 text-green-700"
                            : "bg-yellow-100 text-yellow-700"
                        }`}>{skill.status}</span>
                      </TableCell>
                      <TableCell>
                        {val ? (
                          val.valid ? (
                            <span className="text-green-600 text-xs flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Valid</span>
                          ) : (
                            <div>
                              <span className="text-red-600 text-xs flex items-center gap-1"><XCircle className="h-3 w-3" /> {val.errors.length} error(s)</span>
                              {val.errors.map((e, i) => <p key={i} className="text-xs text-red-500 mt-0.5">{e}</p>)}
                            </div>
                          )
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => validateSkill(skill.id)} className="text-xs">
                            <Shield className="h-3 w-3 mr-1" /> Validate
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {skill.status === "inactive" && (
                            <Link href={`/admin/instances/${instanceId}/skills/${skill.id.replace("/", "--")}/onboard`}>
                              <Button size="sm" variant="outline">
                                <ClipboardList className="h-3 w-3 mr-1" /> Onboard
                              </Button>
                            </Link>
                          )}
                          {skill.status === "active" ? (
                            <Button size="sm" variant="ghost" onClick={() => toggleActive(skill.id, false)} disabled={acting === skill.id}>
                              <Pause className="h-3 w-3 mr-1" /> Deactivate
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => toggleActive(skill.id, true)} disabled={acting === skill.id}>
                              <Play className="h-3 w-3 mr-1" /> Activate
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Available Skills */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Available Skills ({available.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {available.length === 0 ? (
            <p className="text-sm text-zinc-400">All skills are deployed.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {available.map((skill) => (
                  <TableRow key={skill.id}>
                    <TableCell>
                      <span className="font-medium text-sm">{skill.name}</span>
                      <p className="text-xs text-zinc-400">{skill.id}</p>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        skill.type === "agentic" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                      }`}>{skill.type}</span>
                    </TableCell>
                    <TableCell className="text-sm text-zinc-500 max-w-xs truncate">{skill.description}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => deploySkill(skill.id)} disabled={acting === skill.id}>
                        <Download className="h-3 w-3 mr-1" />
                        {acting === skill.id ? "Deploying..." : "Deploy"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
