import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { DeployStep } from "@/lib/types";

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case "running":
      return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
    case "failed":
      return <XCircle className="h-5 w-5 text-red-500" />;
    default:
      return <Circle className="h-5 w-5 text-zinc-300" />;
  }
}

function stepBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed": return "default";
    case "running": return "secondary";
    case "failed": return "destructive";
    default: return "outline";
  }
}

export function DeployProgress({ steps, currentStep }: { steps: DeployStep[]; currentStep: number }) {
  return (
    <div className="space-y-2">
      {steps.map((step) => (
        <div
          key={step.step}
          className={`flex items-center gap-3 rounded-md p-3 transition-colors ${
            step.status === "running"
              ? "bg-blue-50 dark:bg-blue-950"
              : step.status === "failed"
              ? "bg-red-50 dark:bg-red-950"
              : ""
          }`}
        >
          <StepIcon status={step.status} />
          <span className="text-sm flex-1">
            <span className="font-medium">Step {step.step}:</span> {step.label}
          </span>
          <Badge variant={stepBadgeVariant(step.status)} className="text-xs">
            {step.status}
          </Badge>
        </div>
      ))}
    </div>
  );
}
