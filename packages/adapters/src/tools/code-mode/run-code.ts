import type { ConnectorCall, ConnectorEvent, ConnectorTool } from "@anviq/adapter-kit";
import { runInSandbox } from "./code-sandbox.js";

/** What a script's tool calls run on; the run supplies it so they follow the run's own rules. */
export interface CodeToolHost {
  /** The tool a script's "Source:name" names, with its arguments checked against its schema. */
  resolve(
    id: string,
    args: Record<string, unknown>,
  ): Promise<{ tool: ConnectorTool; call: ConnectorCall }>;
  /** Why this tool may not run from a script, or undefined when it may. */
  refusal(tool: ConnectorTool): Promise<string | undefined>;
  execute(call: ConnectorCall): AsyncIterable<ConnectorEvent>;
  /** Everything a tool returns is outside text, which the run treats as such from then on. */
  taint(): Promise<void>;
}

export type CodeRunResult =
  | { result: unknown; logs?: string[] }
  | { error: string; logs?: string[] };

export async function runCode(
  code: string,
  host: CodeToolHost,
  signal?: AbortSignal,
): Promise<CodeRunResult> {
  const outcome = await runInSandbox(
    code,
    async (id, args) => {
      const { tool, call } = await host.resolve(id, args);
      const refusal = await host.refusal(tool);
      if (refusal) throw new Error(refusal);
      let data: unknown = null;
      try {
        for await (const event of host.execute(call)) {
          if (event.type === "result") data = event.data;
          if (event.type === "error") throw new Error(event.message);
        }
      } finally {
        await host.taint();
      }
      return data;
    },
    { signal },
  );
  const logs = outcome.logs.length ? { logs: outcome.logs } : {};
  return outcome.ok ? { result: outcome.value, ...logs } : { error: outcome.error, ...logs };
}
