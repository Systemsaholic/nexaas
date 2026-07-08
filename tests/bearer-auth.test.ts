/**
 * Unit tests for the cross-VPS bearer-token middleware (#53/#217) — one of
 * the critical-function coverage gaps from #257. Exercises the three env
 * postures (unset = open, set = enforced, rotation dual-accept) against a
 * mock express req/res.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../packages/runtime/src/middleware/bearer-auth.js";

const TOKEN_ENV = "NEXAAS_CROSS_VPS_BEARER_TOKEN";
const PREV_ENV = "NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS";

afterEach(() => {
  delete process.env[TOKEN_ENV];
  delete process.env[PREV_ENV];
});

type Res = {
  statusCode: number | null;
  body: unknown;
  status(code: number): Res;
  json(payload: unknown): Res;
};

function invoke(authHeader?: string): { nexted: boolean; res: Res } {
  const middleware = bearerAuth();
  const req = {
    header: (name: string) =>
      name.toLowerCase() === "authorization" ? authHeader : undefined,
  };
  const res: Res = {
    statusCode: null,
    body: null,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  let nexted = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middleware(req as any, res as any, () => { nexted = true; });
  return { nexted, res };
}

describe("bearerAuth — token unset (direct-adopter posture)", () => {
  it("passes every request through", () => {
    const { nexted, res } = invoke(undefined);
    expect(nexted).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});

describe("bearerAuth — token set", () => {
  it("accepts the correct token", () => {
    process.env[TOKEN_ENV] = "secret-token";
    const { nexted } = invoke("Bearer secret-token");
    expect(nexted).toBe(true);
  });

  it("401s a missing Authorization header", () => {
    process.env[TOKEN_ENV] = "secret-token";
    const { nexted, res } = invoke(undefined);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("401s a non-Bearer scheme", () => {
    process.env[TOKEN_ENV] = "secret-token";
    const { nexted, res } = invoke("Basic secret-token");
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("401s a wrong token of the same length", () => {
    process.env[TOKEN_ENV] = "secret-token";
    const { nexted, res } = invoke("Bearer secret-tokeX");
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("401s a wrong-length token without throwing (timingSafeEqual guard)", () => {
    process.env[TOKEN_ENV] = "secret-token";
    const { nexted, res } = invoke("Bearer short");
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("401s an empty bearer value", () => {
    process.env[TOKEN_ENV] = "secret-token";
    const { nexted, res } = invoke("Bearer ");
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

describe("bearerAuth — rotation dual-accept (#217)", () => {
  it("accepts the previous token during the rotation window", () => {
    process.env[TOKEN_ENV] = "new-token";
    process.env[PREV_ENV] = "old-token";
    expect(invoke("Bearer old-token").nexted).toBe(true);
    expect(invoke("Bearer new-token").nexted).toBe(true);
  });

  it("still rejects a token matching neither", () => {
    process.env[TOKEN_ENV] = "new-token";
    process.env[PREV_ENV] = "old-token";
    const { nexted, res } = invoke("Bearer stale-token");
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("rejects the old token once _PREVIOUS is removed (rotation complete)", () => {
    process.env[TOKEN_ENV] = "new-token";
    const { nexted, res } = invoke("Bearer old-token");
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
