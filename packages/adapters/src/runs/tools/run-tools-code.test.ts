import type { ConnectorTool } from "@anviq/adapter-kit";
import { describe, expect, it } from "vitest";
import { CATALOG_EXECUTE } from "../../tools/lazy-tool-catalog.js";
import type { RunContext } from "../assembly/run-context.js";
import { offerCodeTool } from "./run-tool-selection.js";
import { scriptToolRefusal } from "./run-tools-code.js";

describe("offerCodeTool", () => {
  const builtins = [{ name: "shell" }, { name: "run_code" }];
  const wrapper = (resourceId?: string): ConnectorTool => ({
    name: "connectors_execute_tool",
    description: "",
    inputSchema: { type: "object" },
    route: { connectorId: "mcp", toolName: CATALOG_EXECUTE, resourceId },
  });
  const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

  it("offers scripts only where a tool catalog exists", () => {
    expect(names(offerCodeTool(builtins, [wrapper()]))).toEqual(["shell", "run_code"]);
    expect(names(offerCodeTool(builtins, []))).toEqual(["shell"]);
  });

  it("does not take one app's own tool for the catalog", () => {
    expect(names(offerCodeTool(builtins, [wrapper("server-1")]))).toEqual(["shell"]);
  });
});

function run(options: { tainted?: boolean; rules?: unknown[]; trusted?: string[] } = {}) {
  const trusted = new Set(options.trusted ?? []);
  const ctx = {
    runId: "run-1",
    state: { tainted: options.tainted ?? false },
    tools: { connectedPlugins: [] },
    trust: {
      loadApprovalRules: async () => options.rules ?? [],
      loadTrustedConnectors: async () => trusted,
      receivedOutsideMessage: async () => false,
    },
    deps: { prisma: { attempt: { count: async () => 0 } } },
  } as unknown as RunContext;
  return { ctx, trusted };
}

const tool = (name: string, extra: Partial<ConnectorTool> = {}): ConnectorTool => ({
  name,
  description: "",
  inputSchema: { type: "object" },
  route: { connectorId: "mcp", resourceId: "server-1", toolName: name },
  ...extra,
});

describe("scriptToolRefusal", () => {
  it("lets a script read", async () => {
    expect(
      await scriptToolRefusal(run().ctx, tool("list_issues", { readOnly: true })),
    ).toBeUndefined();
  });

  it("keeps a script from changing anything", async () => {
    expect(await scriptToolRefusal(run().ctx, tool("create_issue"))).toContain("can change data");
    expect(await scriptToolRefusal(run().ctx, tool("get_thing", { readOnly: false }))).toContain(
      "can change data",
    );
  });

  it("keeps a connector tool from taking a built-in's name", async () => {
    expect(await scriptToolRefusal(run().ctx, tool("shell"))).toContain("built-in");
  });

  it("honors a block rule and an ask rule on a read", async () => {
    const rule = (effect: string) => [{ effect, matchKind: "tool", matchValue: "list_issues" }];
    expect(
      await scriptToolRefusal(run({ rules: rule("deny") }).ctx, tool("list_issues")),
    ).toContain("blocked");
    expect(
      await scriptToolRefusal(run({ rules: rule("require_approval") }).ctx, tool("list_issues")),
    ).toContain("needs the user's approval");
  });

  it("asks for a direct call on an app the run has not used once outside text is in", async () => {
    const refused = await scriptToolRefusal(run({ tainted: true }).ctx, tool("list_issues"));
    expect(refused).toContain("outside content");
    expect(
      await scriptToolRefusal(
        run({ tainted: true, trusted: ["resource:mcp:server-1"] }).ctx,
        tool("list_issues"),
      ),
    ).toBeUndefined();
  });

  it("trusts the app it read from while the run was clean, so a later read there still runs", async () => {
    const { ctx, trusted } = run();
    expect(await scriptToolRefusal(ctx, tool("list_issues"))).toBeUndefined();
    expect(trusted.has("resource:mcp:server-1")).toBe(true);
    ctx.state.tainted = true;
    expect(await scriptToolRefusal(ctx, tool("get_issue"))).toBeUndefined();
    expect(
      await scriptToolRefusal(
        ctx,
        tool("list_issues", {
          route: { connectorId: "mcp", resourceId: "server-2", toolName: "list_issues" },
        }),
      ),
    ).toContain("outside content");
  });
});
