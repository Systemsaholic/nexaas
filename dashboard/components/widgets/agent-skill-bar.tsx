"use client";

import { useState } from "react";
import { renderMarkdown } from "@/lib/sanitize";
import { useAgentStream } from "@/lib/hooks/use-agent-stream";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  PenToolIcon,
  BarChart3Icon,
  MailIcon,
  ShareIcon,
  ChevronDownIcon,
  SparklesIcon,
  LoaderIcon,
  AlertCircleIcon,
} from "lucide-react";

interface AgentSkillBarConfig {
  [key: string]: unknown;
}

interface SkillGroup {
  name: string;
  agent: string;
  icon: React.ReactNode;
  commands: { label: string; prompt: string }[];
}

const skillGroups: SkillGroup[] = [
  {
    name: "Content Writer",
    agent: "content-writer",
    icon: <PenToolIcon className="size-4" />,
    commands: [
      { label: "Write Blog Post", prompt: "Write a 1000-word blog post on the topic I specify." },
      { label: "Generate Headlines", prompt: "Generate 10 headline variations for the given topic." },
      { label: "Rewrite for SEO", prompt: "Rewrite the following content optimized for SEO with target keywords." },
      { label: "Write Ad Copy", prompt: "Write compelling ad copy for the specified product/service." },
    ],
  },
  {
    name: "Analytics",
    agent: "analytics",
    icon: <BarChart3Icon className="size-4" />,
    commands: [
      { label: "Weekly Report", prompt: "Generate a weekly performance report for all active campaigns." },
      { label: "ROI Analysis", prompt: "Analyze ROI across all campaigns and identify top performers." },
      { label: "Budget Forecast", prompt: "Forecast next month's budget requirements based on current trends." },
      { label: "Competitor Analysis", prompt: "Run a competitive analysis for the specified client." },
    ],
  },
  {
    name: "Email Manager",
    agent: "email-manager",
    icon: <MailIcon className="size-4" />,
    commands: [
      { label: "Draft Campaign Email", prompt: "Draft a marketing email for the specified campaign." },
      { label: "A/B Subject Lines", prompt: "Generate A/B test subject line variants for the given email." },
      { label: "Review All Drafts", prompt: "Review all pending email drafts and provide feedback." },
    ],
  },
  {
    name: "Social Media",
    agent: "social-media",
    icon: <ShareIcon className="size-4" />,
    commands: [
      { label: "Draft Week's Posts", prompt: "Draft next week's social media posts for all active clients." },
      { label: "Hashtag Research", prompt: "Research trending hashtags for the specified topic and platform." },
      { label: "Engagement Report", prompt: "Generate a social media engagement report for the past week." },
    ],
  },
];

export default function AgentSkillBar({
  config,
  title,
}: {
  config: AgentSkillBarConfig;
  title?: string;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeCommand, setActiveCommand] = useState<{ agent: string; label: string; prompt: string } | null>(null);
  const { response, status, error, fire, cancel } = useAgentStream();

  const fireCommand = (agent: string, label: string, prompt: string) => {
    setActiveCommand({ agent, label, prompt });
    setSheetOpen(true);
    toast.info(`Running "${label}"...`, { description: `Agent: ${agent}` });
    fire(agent, prompt);
  };

  const handleSheetChange = (open: boolean) => {
    setSheetOpen(open);
    if (!open && (status === "connecting" || status === "streaming")) {
      cancel();
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Agent Skills"}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {skillGroups.map((group) => (
              <DropdownMenu key={group.name}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5">
                    {group.icon}
                    {group.name}
                    <ChevronDownIcon className="size-3 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel className="text-xs">{group.agent}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {group.commands.map((cmd) => (
                    <DropdownMenuItem
                      key={cmd.label}
                      onClick={() => fireCommand(group.agent, cmd.label, cmd.prompt)}
                    >
                      <SparklesIcon className="mr-2 size-3.5 text-purple-500" />
                      {cmd.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Response Sheet */}
      <Sheet open={sheetOpen} onOpenChange={handleSheetChange}>
        <SheetContent side="right" className="w-full sm:w-[480px] sm:max-w-[480px]">
          {activeCommand && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 text-base">
                  {(status === "connecting" || status === "streaming") && <LoaderIcon className="size-4 animate-spin" />}
                  {status === "error" && <AlertCircleIcon className="size-4 text-destructive" />}
                  {activeCommand.label}
                </SheetTitle>
                <SheetDescription>
                  Agent: {activeCommand.agent}
                </SheetDescription>
              </SheetHeader>
              <Separator className="my-3" />
              <ScrollArea className="h-[calc(100vh-160px)] px-4">
                {error ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <AlertCircleIcon className="size-8 text-destructive" />
                    <p className="text-sm font-medium text-destructive">Agent Error</p>
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <Button size="sm" variant="outline" onClick={() => fire(activeCommand.agent, activeCommand.prompt)}>
                      Retry
                    </Button>
                  </div>
                ) : response ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(response) }} />
                    {status === "streaming" && <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-primary" />}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Waiting for agent response...</p>
                )}
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
