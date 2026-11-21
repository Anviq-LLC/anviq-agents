import { deferred } from "@anviq/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { runInSandbox } from "./code-sandbox.js";

const echo = async (tool: string, args: Record<string, unknown>) => ({ tool, args });

describe("runInSandbox", () => {
  it("returns what the script returns, with the tool calls it made", async () => {
    const result = await runInSandbox(
      `const issues = await tools["Linear"].list_issues({ team: "a" });
       return issues.args.team + ":" + issues.tool;`,
      echo,
    );
    expect(result).toEqual({ ok: true, value: "a:Linear:list_issues", logs: [], calls: 1 });
  });

  it("starts parallel calls together", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];
    const call = vi.fn(async (tool: string) => {
      started.push(tool);
      return (tool.endsWith("one") ? first : second).promise;
    });
    const run = runInSandbox(
      `const [a, b] = await Promise.all([tools.S.one({}), tools.S.two({})]); return [a, b];`,
      call,
    );
    await vi.waitFor(() => expect(started).toEqual(["S:one", "S:two"]));
    second.resolve("b");
    first.resolve("a");
    expect(await run).toMatchObject({ ok: true, value: ["a", "b"], calls: 2 });
  });

  it("gives the script nothing of the host", async () => {
    const result = await runInSandbox(
      `return [typeof process, typeof require, typeof fetch, typeof globalThis.__call, typeof setTimeout];`,
      echo,
    );
    expect(result).toMatchObject({
      ok: true,
      value: ["undefined", "undefined", "undefined", "undefined", "undefined"],
    });
  });

  it("lets the script catch a tool's error, and reports one it does not catch", async () => {
    const call = async () => {
      throw new Error("not allowed");
    };
    expect(
      await runInSandbox(`try { await tools.S.x({}) } catch (e) { return e.message }`, call),
    ).toMatchObject({ ok: true, value: "not allowed" });
    expect(await runInSandbox(`await tools.S.x({})`, call)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not allowed"),
    });
  });

  it("rejects arguments that are not an object", async () => {
    const result = await runInSandbox(`return await tools.S.x([1])`, echo);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("must be an object"),
    });
  });

  it("stops a script after its tool call limit", async () => {
    const result = await runInSandbox(
      `for (let i = 0; i < 5; i++) await tools.S.x({}); return "done"`,
      echo,
      { limits: { maxCalls: 3 } },
    );
    expect(result).toMatchObject({
      ok: false,
      calls: 3,
      error: expect.stringContaining("Too many"),
    });
  });

  it("asks for less when the result is too large", async () => {
    const result = await runInSandbox(`return "x".repeat(2000)`, echo, {
      limits: { maxResultBytes: 100 },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Return less") });
  });

  it("refuses a tool result too large to hand to a script", async () => {
    const result = await runInSandbox(`return await tools.S.big({})`, async () => "x".repeat(500), {
      limits: { maxCallResultBytes: 100 },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("too much data") });
  });

  it("interrupts a script that never ends", async () => {
    const result = await runInSandbox(`while (true) {}`, echo, { limits: { timeoutMs: 200 } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
  });

  it("ends a script its own interrupt cannot reach, and keeps this process running meanwhile", async () => {
    // Heavy built-in calls leave the script too few steps to check its clock, so the thread is ended.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const result = await runInSandbox(
      `const rows = []; while (true) rows.push("x".repeat(1_000_000));`,
      echo,
      { limits: { timeoutMs: 300 } },
    );
    clearInterval(timer);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
    expect(ticks).toBeGreaterThan(10);
  });

  it("stops a script waiting on a tool that never answers", async () => {
    const result = await runInSandbox(`await tools.S.x({})`, () => new Promise(() => {}), {
      limits: { timeoutMs: 200 },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
  });

  it("stops a script that uses too much memory", async () => {
    const result = await runInSandbox(
      `const rows = []; for (let i = 0; ; i++) rows.push({ a: i, b: "s" + i });`,
      echo,
      { limits: { memoryBytes: 8 * 1024 * 1024, timeoutMs: 5_000 } },
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("out of memory") });
  });

  it("returns console.log output, within its limit", async () => {
    const result = await runInSandbox(
      `console.log("a", { b: 1 }); console.log("x".repeat(50)); return 1`,
      echo,
      { limits: { maxLogBytes: 20 } },
    );
    expect(result).toMatchObject({ ok: true, logs: ['a {"b":1}'] });
  });

  it("reports a syntax error", async () => {
    expect(await runInSandbox(`return (`, echo)).toMatchObject({ ok: false });
  });
});
