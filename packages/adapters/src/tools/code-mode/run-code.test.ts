import type { ConnectorEvent, ConnectorTool } from "@anviq/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { CodeToolHost } from "./run-code.js";
import { runCode } from "./run-code.js";

const read: ConnectorTool = {
  name: "list_items",
  description: "",
  inputSchema: { type: "object" },
};
const write: ConnectorTool = {
  name: "create_item",
  description: "",
  inputSchema: { type: "object" },
};

function host(overrides: Partial<CodeToolHost> = {}) {
  const taint = vi.fn(async () => {});
  const execute = vi.fn(async function* (): AsyncIterable<ConnectorEvent> {
    yield { type: "result", data: [{ id: 1 }, { id: 2 }] };
  });
  const value: CodeToolHost = {
    resolve: async (id) => ({
      tool: id.endsWith("create_item") ? write : read,
      call: { tool: "x", args: {}, executionId: "e" },
    }),
    refusal: async (tool) => (tool === write ? "create_item changes data" : undefined),
    execute,
    taint,
    ...overrides,
  };
  return { value, taint, execute };
}

describe("runCode", () => {
  it("runs a read, hands the script its data, and treats the run as having seen outside text", async () => {
    const h = host();
    const result = await runCode(
      `const items = await tools.App.list_items({}); return items.map((i) => i.id);`,
      h.value,
    );
    expect(result).toEqual({ result: [1, 2] });
    expect(h.taint).toHaveBeenCalledOnce();
  });

  it("never runs a tool the run would not let it, and the script can see why", async () => {
    const h = host();
    const result = await runCode(
      `try { await tools.App.create_item({}); } catch (e) { return e.message; }`,
      h.value,
    );
    expect(result).toEqual({ result: "create_item changes data" });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.taint).not.toHaveBeenCalled();
  });

  it("taints the run when a tool fails partway, as a direct call does", async () => {
    const h = host({
      execute: async function* () {
        yield { type: "error", message: "boom" };
      },
    });
    const result = await runCode(`await tools.App.list_items({})`, h.value);
    expect(result).toMatchObject({ error: expect.stringContaining("boom") });
    expect(h.taint).toHaveBeenCalledOnce();
  });

  it("reports an unknown tool", async () => {
    const h = host({
      resolve: async () => {
        throw new Error("Tool is unknown or not authorized for this bot.");
      },
    });
    expect(await runCode(`await tools.App.nope({})`, h.value)).toMatchObject({
      error: expect.stringContaining("unknown"),
    });
  });

  it("returns what the script logged", async () => {
    const result = await runCode(`console.log("step", 1); return "ok"`, host().value);
    expect(result).toEqual({ result: "ok", logs: ["step 1"] });
  });
});
