/**
 * In-process mock of the agent key endpoints, following the server's state rules:
 * a rotation stays pending until the new key is exchanged once.
 */

import http from "node:http";

type KeyStatus = "active" | "pending" | "ROTATED" | "RECOVERY" | "SUPERSEDED";

export interface AgentKeyMockState {
  keys: Map<string, KeyStatus>;
  claimCodes: Map<string, "unused" | "used" | "expired">;
  password: string | null;
  recoveryKeyId: string;
  tokenVersion: number;
  tokenRequests: Record<string, any>[];
  apiAuthorizations: string[];
  migrateCalls: number;
  /** Fail the next N /auth/token requests with 503 */
  failTokenRequests: number;
  /** Answer protected endpoints with this error once */
  nextApiError: { status: number; code?: string } | null;
  dryRunHeaders: string[];
}

export interface AgentKeyMockServer {
  url: string;
  state: AgentKeyMockState;
  close: () => Promise<void>;
}

const ACCOUNT_ID = "key_bot";
const REVOKED_CODES: Partial<Record<KeyStatus, [string, string]>> = {
  ROTATED: ["KEY_ROTATED", "This key was rotated."],
  RECOVERY: ["KEY_REVOKED_BY_RECOVERY", "This key was revoked by account recovery."],
};

export async function startAgentKeyMockServer(): Promise<AgentKeyMockServer> {
  const state: AgentKeyMockState = {
    keys: new Map(),
    claimCodes: new Map(),
    password: null,
    recoveryKeyId: "currentrkid0",
    tokenVersion: 0,
    tokenRequests: [],
    apiAuthorizations: [],
    migrateCalls: 0,
    failTokenRequests: 0,
    nextApiError: null,
    dryRunHeaders: [],
  };
  let issued = 0;

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const issueKey = (status: KeyStatus) => {
    const key = `alv_sk_issuedkey${String(++issued).padStart(4, "0")}value`;
    state.keys.set(key, status);
    return key;
  };
  const access = (extra: Record<string, unknown> = {}) => ({
    accountId: ACCOUNT_ID,
    token: `jwt_v${state.tokenVersion}_${++issued}`,
    tokenType: "Bearer",
    expiresIn: 900,
    recoveryKeyId: state.recoveryKeyId,
    ...extra,
  });
  const dryRunBody = { status: "dry_run", dryRun: true, message: "[Dry Run] Validation successful." };

  const handleToken = (res: http.ServerResponse, body: Record<string, any>, isDryRun: boolean) => {
    state.tokenRequests.push(body);
    if (state.failTokenRequests > 0) {
      state.failTokenRequests--;
      return send(res, 503, { error: "Unavailable" });
    }
    if (isDryRun) {
      return send(res, 200, dryRunBody);
    }

    if (body.claimCode) {
      const code = state.claimCodes.get(body.claimCode);
      if (code === "used") return send(res, 401, { error: "used", code: "CLAIM_CODE_USED" });
      if (code === "expired") return send(res, 401, { error: "expired", code: "CLAIM_CODE_EXPIRED" });
      if (!code) return send(res, 401, { error: "Invalid credentials" });
      state.claimCodes.set(body.claimCode, "used");
      for (const [key, status] of state.keys) {
        if (status === "active" || status === "pending") state.keys.set(key, "SUPERSEDED");
      }
      return send(res, 200, access({ agentKey: issueKey("active"), keyStatus: "active" }));
    }

    const status = state.keys.get(body.agentKey);
    if (!status || status === "SUPERSEDED") {
      return send(res, 401, { error: "Invalid credentials" });
    }
    const revoked = REVOKED_CODES[status];
    if (revoked) {
      return send(res, 401, { error: revoked[1], code: revoked[0] });
    }

    if (body.rotate) {
      if (status !== "active") {
        return send(res, 409, { error: "Only an active key can be rotated", code: "KEY_NOT_ACTIVE" });
      }
      for (const [key, value] of state.keys) {
        if (value === "pending") state.keys.set(key, "SUPERSEDED");
      }
      const next = issueKey("pending");
      (state as any).revokeOnCommit = Boolean(body.revokeTokens);
      return send(res, 200, access({ agentKey: next, keyStatus: "pending" }));
    }

    if (status === "pending") {
      for (const [key, value] of state.keys) {
        if (value === "active") state.keys.set(key, "ROTATED");
      }
      state.keys.set(body.agentKey, "active");
      if ((state as any).revokeOnCommit) {
        state.tokenVersion++;
      }
    }
    return send(res, 200, access());
  };

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    const body = raw ? JSON.parse(raw) : {};
    const isDryRun = req.headers["x-dry-run"] === "true";
    if (isDryRun) {
      state.dryRunHeaders.push(req.url || "");
    }

    if (req.url === "/auth/token" && req.method === "POST") {
      return handleToken(res, body, isDryRun);
    }

    if (req.url === "/agent/keys/migrate" && req.method === "POST") {
      state.migrateCalls++;
      if (isDryRun) {
        return send(res, 200, dryRunBody);
      }
      if (state.password === null || body.password !== state.password) {
        return send(res, 401, { error: "Invalid accountId or password" });
      }
      state.password = null;
      return send(res, 200, { accountId: body.accountId, agentKey: issueKey("active"), recoveryKeyId: state.recoveryKeyId });
    }

    if (req.url === "/auth/register" && req.method === "POST") {
      if (isDryRun) {
        return send(res, 200, dryRunBody);
      }
      if (body.password !== undefined) {
        return send(res, 400, { error: "AI accounts no longer use passwords.", code: "AGENT_KEY_REQUIRED" });
      }
      return send(res, 201, {
        message: "Account created successfully",
        accountId: body.accountId,
        agentKey: issueKey("active"),
        token: `jwt_v${state.tokenVersion}_register`,
        recoveryKey: "alv_rk_registered",
        recoveryKeyId: state.recoveryKeyId,
      });
    }

    // Protected endpoints
    const authorization = String(req.headers.authorization || "");
    state.apiAuthorizations.push(authorization);
    if (state.nextApiError) {
      const { status, code } = state.nextApiError;
      state.nextApiError = null;
      return send(res, status, { error: "Rejected", code });
    }
    if (authorization.includes("alv_sk_")) {
      return send(res, 401, { error: "Send keys only to /auth/token", code: "AGENT_KEY_NOT_ALLOWED" });
    }
    if (!authorization.startsWith(`Bearer jwt_v${state.tokenVersion}_`)) {
      return send(res, 401, { error: "Unauthorized" });
    }

    if (req.url === "/agent/keys" && req.method === "GET") {
      const keys = [...state.keys].filter(([, status]) => status === "active" || status === "pending");
      return send(res, 200, {
        keys: keys.map(([key, status]) => ({
          prefix: key.slice(0, 15),
          status,
          createdAt: "2026-11-01T00:00:00.000Z",
          lastUsedAt: null,
          lastUsedIp: null,
        })),
      });
    }
    if (req.url === "/users/profile" && req.method === "GET") {
      return send(res, 200, { username: ACCOUNT_ID });
    }
    return send(res, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
