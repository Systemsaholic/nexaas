/**
 * nexaas create-mcp — scaffold a new MCP server.
 *
 * Usage:
 *   nexaas create-mcp <name> [--dir <path>]
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export async function run(args: string[]) {
  const name = args.find(a => !a.startsWith("--"));
  const dirIdx = args.indexOf("--dir");
  const baseDir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : process.cwd();

  if (!name) {
    console.log(`
  nexaas create-mcp — scaffold a new MCP server

  Usage:
    nexaas create-mcp <name>             Create in current directory
    nexaas create-mcp <name> --dir /path Create in specified directory
`);
    return;
  }

  const serverDir = join(baseDir, name);
  if (existsSync(serverDir)) {
    console.error(`Directory already exists: ${serverDir}`);
    process.exit(1);
  }

  mkdirSync(join(serverDir, "src"), { recursive: true });

  writeFileSync(join(serverDir, "package.json"), JSON.stringify({
    name: `@nexaas/mcp-${name}`,
    version: "1.0.0",
    type: "module",
    main: "src/index.ts",
    scripts: { start: "npx tsx src/index.ts" },
    dependencies: {},
    devDependencies: { typescript: "^5.5.0", tsx: "^4.0.0" },
  }, null, 2) + "\n");

  writeFileSync(join(serverDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      strict: true, outDir: "dist", esModuleInterop: true, skipLibCheck: true,
    },
    include: ["src"],
  }, null, 2) + "\n");

  const serverCode = `import { createInterface } from "readline";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: Tool[] = [
  {
    name: "hello",
    description: "A sample tool that greets the user",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Name to greet" } },
      required: ["name"],
    },
  },
];

async function handleToolCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "hello":
      return { greeting: \`Hello, \${args.name}!\` };
    default:
      throw new Error(\`Unknown tool: \${toolName}\`);
  }
}

function respond(id: number | string, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function respondError(id: number | string, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let req: JsonRpcRequest;
  try { req = JSON.parse(line); } catch { return; }

  switch (req.method) {
    case "initialize":
      respond(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "${name}", version: "1.0.0" },
      });
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      respond(req.id, { tools: TOOLS });
      break;
    case "tools/call": {
      const p = req.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await handleToolCall(p.name, p.arguments ?? {});
        respond(req.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        respondError(req.id, -32000, (e as Error).message);
      }
      break;
    }
    default:
      respondError(req.id, -32601, \`Method not found: \${req.method}\`);
  }
});

process.stderr.write("[${name}] MCP server started (stdio)\\n");
`;

  writeFileSync(join(serverDir, "src/index.ts"), serverCode);

  console.log(`\n  Created MCP server: ${name}`);
  console.log(`  Location: ${serverDir}`);
  console.log(`\n  Next steps:`);
  console.log(`    1. cd ${serverDir} && npm install`);
  console.log(`    2. Add tools to TOOLS array in src/index.ts`);
  console.log(`    3. Implement handlers in handleToolCall()`);
  console.log(`    4. Add to .mcp.json: "${name}": { "command": "npx", "args": ["tsx", "${serverDir}/src/index.ts"] }`);
  console.log(`    5. Declare in skill manifests: mcp_servers: ["${name}"]`);
  console.log("");
}
