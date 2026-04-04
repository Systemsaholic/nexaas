"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Server, Rocket, Sparkles, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/admin/instances", label: "Instances", icon: Server },
  { href: "/admin/deploy", label: "Deploy", icon: Rocket },
  { href: "/admin/skills", label: "Skills", icon: Sparkles },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-56 flex-col border-r bg-zinc-50 dark:bg-zinc-900">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/admin/instances" className="text-sm font-bold tracking-tight">
          Nexmatic
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-zinc-200 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-2">
        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
