/**
 * Local mock of the Anthropic Messages API for conformance runs (#213).
 *
 * `nexaas conformance` points the Anthropic SDK at this server via
 * ANTHROPIC_BASE_URL *inside the conformance process only* — the live
 * worker's environment is never touched. Both runtime model paths work
 * against it unmodified:
 *   - the agentic loop's `client.messages.stream()` (SSE streaming)
 *   - the gateway's anthropic provider (`messages.create`, JSON)
 *
 * Responses are deterministic and cost $0. The server binds 127.0.0.1 on
 * an ephemeral port and lives only for the duration of the check.
 */

import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

export const MOCK_REPLY_TEXT =
  "CONFORMANCE_OK — deterministic reply from the Nexaas mock model server.";

export interface MockModelServer {
  /** Base URL to assign to ANTHROPIC_BASE_URL (no trailing slash). */
  url: string;
  /** Number of /v1/messages requests served so far. */
  calls: () => number;
  close: () => Promise<void>;
}

interface MessagesRequestBody {
  model?: string;
  stream?: boolean;
}

function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function buildFinalMessage(model: string) {
  return {
    id: "msg_conformance_mock",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: MOCK_REPLY_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

export function startMockModelServer(): Promise<MockModelServer> {
  let callCount = 0;

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found_error", message: "mock server only implements POST /v1/messages" } }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      callCount++;
      let body: MessagesRequestBody = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        /* tolerate — reply anyway, this is a probe */
      }
      const model = body.model ?? "mock-model";

      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(buildFinalMessage(model)));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        sseEvent("message_start", {
          message: {
            id: "msg_conformance_mock",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      res.write(
        sseEvent("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      res.write(
        sseEvent("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: MOCK_REPLY_TEXT },
        }),
      );
      res.write(sseEvent("content_block_stop", { index: 0 }));
      res.write(
        sseEvent("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 12 },
        }),
      );
      res.write(sseEvent("message_stop", {}));
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls: () => callCount,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Don't keep the CLI process alive on lingering keep-alive sockets.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
