import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import {
  addMcpServerFromTool,
  buildMcpCredentialBlob,
  connectMcpByName,
  deriveMcpSlug,
  needsOAuthProbe,
  parseMcpServerToolArgs,
} from "./mcp-server-tool.js";

describe("deriveMcpSlug", () => {
  it("slugifies server names like the settings overlay does", () => {
    expect(deriveMcpSlug("Brex MCP Server!")).toBe("brex-mcp-server");
    expect(deriveMcpSlug("  --  ")).toMatch(/^mcp-\d+$/);
    expect(deriveMcpSlug("x".repeat(100))).toHaveLength(64);
  });
});

describe("parseMcpServerToolArgs", () => {
  it("parses a minimal remote server", () => {
    const parsed = parseMcpServerToolArgs({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
    });
    expect(parsed).toMatchObject({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
      assignToSelf: true,
    });
    expect(parsed?.slug).toBe("brex");
  });

  it("rejects missing names, bad transports, and non-http endpoints", () => {
    expect(
      parseMcpServerToolArgs({ transport: "streamable_http", endpoint: "https://x.test" }),
    ).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "carrier-pigeon" })).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "streamable_http" })).toBeUndefined();
    expect(
      parseMcpServerToolArgs({ name: "x", transport: "streamable_http", endpoint: "ftp://x.test" }),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "http://10.0.0.8/mcp",
      }),
    ).toMatchObject({ endpoint: "http://10.0.0.8/mcp" });
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "https://user:password@x.test/mcp#fragment",
      }),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs({ name: "x", transport: "stdio", command: "node" }),
    ).toBeUndefined();
  });

  it("keeps only string-valued headers and caps their count", () => {
    const parsed = parseMcpServerToolArgs({
      name: "H",
      transport: "sse",
      endpoint: "https://h.example.test",
      headers: { Authorization: "Bearer t", Broken: 42 as unknown as string },
    });
    expect(parsed?.headers).toEqual({ Authorization: "Bearer t" });

    const tooMany = parseMcpServerToolArgs({
      name: "H",
      transport: "sse",
      endpoint: "https://h.example.test",
      headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, "v"])),
    });
    expect(tooMany).toBeUndefined();
  });
});

describe("addMcpServerFromTool", () => {
  it("never adds a local (stdio) server", async () => {
    const create = vi.fn();
    const result = await addMcpServerFromTool(
      {
        prisma: { mcpServer: { create }, $transaction: create },
      } as unknown as ExecutorDeps,
      { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", botId: "b-1" },
      "b-1",
      { name: "Local", transport: "stdio", command: "node", args: ["-e", "1"] },
      "exec-1",
    );
    expect(result).toEqual({
      error: "Bots can't add local (stdio) MCP servers. Ask an admin to add it in Settings.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a credential in the endpoint query, which would be stored in plaintext", async () => {
    const run = {
      id: "run-1",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "t-1",
      botId: "b-1",
    };
    const result = await addMcpServerFromTool(
      { mcpAllowPrivateEndpoint: true } as ExecutorDeps,
      run,
      "b-1",
      { name: "Brex", transport: "streamable_http", endpoint: "http://localhost/mcp?token=abc" },
      "exec-1",
    );
    expect(result).toEqual({ error: "Put token in a header instead of the server URL" });
  });
});

describe("connectMcpByName", () => {
  const run = { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", botId: "b-1" };
  const server = (name: string, domain: string) => ({
    domain,
    name,
    surfaces: [
      { kind: "mcp", slug: domain, url: `https://mcp.${domain}/mcp`, auth: { kind: "oauth" } },
    ],
  });
  const prismaWith = (existing: { id: string } | null = null, assigned = 0) => ({
    mcpServer: { findFirst: vi.fn(async () => existing) },
    botMcpServer: { count: vi.fn(async () => assigned) },
  });
  const lookup = (app: string, deps: Partial<ExecutorDeps> = {}) =>
    connectMcpByName(
      { prisma: prismaWith(), ...deps } as unknown as ExecutorDeps,
      run,
      "b-1",
      app,
      "exec-1",
      new AbortController().signal,
    );
  const answerWith = (results: unknown[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results })),
    );
  afterEach(() => vi.unstubAllGlobals());

  it("says nothing when the catalog has no sign-in server for the app", async () => {
    answerWith([]);
    expect(await lookup("Nothing")).toBeUndefined();
  });

  it("says nothing when the catalog cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await lookup("Notion")).toBeUndefined();
  });

  it("asks which one when several servers match and none is named exactly", async () => {
    answerWith([server("Notion Docs", "docs.example"), server("Notion Tasks", "tasks.example")]);
    expect(await lookup("Notion")).toEqual({
      error: "Several MCP servers match: Notion Docs, Notion Tasks. Ask the user which one.",
    });
  });

  it("registers the one server named exactly, so the user approves it", async () => {
    answerWith([server("Notion", "notion.example"), server("Notion Tasks", "tasks.example")]);
    const result = await lookup("notion", {
      secretHttp: { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] },
    } as Partial<ExecutorDeps>);
    expect(result).toEqual({ error: "Secret storage is not available in this deployment." });
  });

  it("finds a server this user already added instead of adding it again", async () => {
    answerWith([server("Notion", "notion.example")]);
    const added = (assigned: number) =>
      lookup("Notion", {
        prisma: prismaWith({ id: "srv-1" }, assigned),
      } as unknown as Partial<ExecutorDeps>);
    expect(await added(1)).toMatchObject({ status: "connected" });
    expect(await added(0)).toMatchObject({ status: "pending" });
  });
});

describe("buildMcpCredentialBlob", () => {
  it("returns null when no credential material exists", () => {
    expect(buildMcpCredentialBlob({})).toBeNull();
    expect(buildMcpCredentialBlob({ headers: {}, env: {} })).toBeNull();
  });

  it("serializes secret, env, and headers into the encrypted blob shape", () => {
    expect(
      buildMcpCredentialBlob({ secret: "tok", headers: { Authorization: "Bearer tok" }, env: {} }),
    ).toEqual(JSON.stringify({ secret: "tok", env: {}, headers: { Authorization: "Bearer tok" } }));
  });

  it("stores stdio arguments, which may carry tokens, in the blob", () => {
    expect(
      JSON.parse(buildMcpCredentialBlob({ args: ["--api-key", "fake-key"] }) ?? "null"),
    ).toEqual({ env: {}, headers: {}, args: ["--api-key", "fake-key"] });
    expect(buildMcpCredentialBlob({ args: [] })).toBeNull();
  });

  it("stores a pre-registered OAuth client on its own", () => {
    expect(
      JSON.parse(
        buildMcpCredentialBlob({
          headers: {},
          oauthClient: { clientId: "client-1", clientSecret: "client-secret" },
        }) ?? "null",
      ),
    ).toEqual({
      env: {},
      headers: {},
      oauthClient: { client_id: "client-1", client_secret: "client-secret" },
    });
    expect(
      JSON.parse(buildMcpCredentialBlob({ oauthClient: { clientId: "public-client" } }) ?? "null"),
    ).toMatchObject({ oauthClient: { client_id: "public-client" } });
  });
});

describe("buildMcpCredentialBlob credential files", () => {
  const files = { CREDENTIALS_PATH: '{"refresh_token":"{{oauth.refresh_token}}"}' };

  it("stores file templates, which may hold secrets, in the blob", () => {
    expect(JSON.parse(buildMcpCredentialBlob({ files }) ?? "null")).toEqual({
      env: {},
      headers: {},
      files,
    });
  });

  it("leaves the files out when there are none", () => {
    expect(buildMcpCredentialBlob({ files: {} })).toBeNull();
    expect(JSON.parse(buildMcpCredentialBlob({ secret: "tok", files: {} }) ?? "null")).toEqual({
      secret: "tok",
      env: {},
      headers: {},
    });
  });
});

describe("buildMcpCredentialBlob OAuth client options", () => {
  it("stores the scope and the normalized authorization server when given", () => {
    expect(
      JSON.parse(
        buildMcpCredentialBlob({
          env: { TOKEN: "{{oauth.access_token}}" },
          oauthClient: {
            clientId: "client-1",
            scope: "mail.read mail.send",
            authorizationServer: "https://accounts.example.test",
          },
        }) ?? "null",
      ),
    ).toMatchObject({
      oauthClient: {
        client_id: "client-1",
        scope: "mail.read mail.send",
        authorization_server: "https://accounts.example.test/",
      },
    });
  });

  it("leaves out an empty scope and a missing authorization server", () => {
    const blob = JSON.parse(
      buildMcpCredentialBlob({ oauthClient: { clientId: "client-1", scope: "" } }) ?? "null",
    );
    expect(blob.oauthClient).toEqual({ client_id: "client-1" });
  });
});

describe("needsOAuthProbe", () => {
  it("is true only for remote servers without static credentials", () => {
    expect(needsOAuthProbe({ transport: "streamable_http" })).toBe(true);
    expect(needsOAuthProbe({ transport: "sse" })).toBe(true);
    expect(needsOAuthProbe({ transport: "streamable_http", secret: "tok" })).toBe(false);
    expect(needsOAuthProbe({ transport: "streamable_http", headers: { Authorization: "x" } })).toBe(
      false,
    );
    expect(needsOAuthProbe({ transport: "stdio", command: "c" } as never)).toBe(false);
  });
});

describe("buildMcpCredentialBlob authorization parameters", () => {
  it("stores the client's extra authorization parameters", () => {
    expect(
      JSON.parse(
        buildMcpCredentialBlob({
          oauthClient: { clientId: "c", authorizationParams: "access_type=offline" },
        }) ?? "null",
      ),
    ).toMatchObject({
      oauthClient: { client_id: "c", authorization_params: "access_type=offline" },
    });
  });
});
