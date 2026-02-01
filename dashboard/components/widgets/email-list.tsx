"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

interface Email {
  sender: string;
  subject: string;
  date: string;
  read: boolean;
}

interface EmailListConfig {
  mailbox?: string;
  filters?: string[];
  [key: string]: unknown;
}

const placeholderEmails: Email[] = [
  { sender: "Alice Chen", subject: "Q4 Campaign Draft Review", date: "10:32 AM", read: false },
  { sender: "Platform Alerts", subject: "Agent pipeline completed", date: "9:15 AM", read: false },
  { sender: "Bob Martinez", subject: "Re: API integration timeline", date: "Yesterday", read: true },
  { sender: "Carol Wu", subject: "Weekly sync notes", date: "Yesterday", read: true },
  { sender: "System", subject: "Scheduled maintenance tonight", date: "Jan 29", read: true },
];

export default function EmailList({
  config,
  title,
}: {
  config: EmailListConfig;
  title?: string;
}) {
  const emails = placeholderEmails;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {title ?? config.mailbox ?? "Inbox"}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[320px]">
          {emails.map((email, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 border-b px-4 py-3 last:border-0 ${
                !email.read ? "bg-primary/[0.03]" : ""
              }`}
            >
              <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                <span className={`text-sm truncate ${!email.read ? "font-semibold" : "font-medium"}`}>
                  {email.sender}
                </span>
                <span className="truncate text-sm text-muted-foreground">{email.subject}</span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{email.date}</span>
              {!email.read && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />}
            </div>
          ))}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
