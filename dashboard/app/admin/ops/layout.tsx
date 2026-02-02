export default function AdminOpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="h-12 border-b flex items-center px-4 shrink-0">
        <h1 className="text-sm font-semibold">Nexaas — Ops Dashboard</h1>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
