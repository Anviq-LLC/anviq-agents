import type { ConnectorCall, ConnectorTool } from "@anviq/adapter-kit";
import {
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  resolveActionApprovalForTools,
  toolRequiresApproval,
} from "@anviq/core";
import { MAX_SCRIPT_LENGTH } from "../../tools/builtin-code.tool-definition.js";
import type { CodeToolHost } from "../../tools/code-mode/run-code.js";
import { runCode } from "../../tools/code-mode/run-code.js";
import { isCatalogExecuteTool, UnknownCatalogToolError } from "../../tools/lazy-tool-catalog.js";
import type { RunContext } from "../assembly/run-context.js";
import { isRunTainted, markReadOutsideContent } from "../assembly/run-context.js";
import { connectorTrustKeys } from "../assembly/run-trust.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import { toolAskFor } from "./run-tool-questions.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./run-tool-selection.js";

/**
 * Why a script may not run this tool, or undefined. It decides as the gate does for the same call
 * made directly: only reads that need no approval, no block or ask rule against them, and, once
 * outside text is in the run, only on an app the run already used.
 */
export async function scriptToolRefusal(
  ctx: RunContext,
  tool: ConnectorTool,
): Promise<string | undefined> {
  if (BUILTIN_AGENT_TOOL_NAMES.has(tool.name)) {
    return "Connector tool name conflicts with a built-in tool";
  }
  const { route } = tool;
  const providers = ctx.tools.connectedPlugins.map((plugin) => plugin.provider);
  const approvalName = route?.connectionId ? (route.toolName ?? tool.name) : tool.name;
  if (toolRequiresApproval(approvalName, true, tool.readOnly)) {
    return `${tool.name} can change data. Call it directly so the user can approve it.`;
  }
  const connectorKind = connectorKindFromToolName(approvalName, providers);
  const rules = resolveActionApprovalForTools({
    tools: [
      {
        name: approvalName,
        aliases: approvalName === tool.name ? undefined : [tool.name],
        connectorKind,
        readOnly: tool.readOnly,
      },
    ],
    rules: await ctx.trust.loadApprovalRules(),
  });
  if (rules.decision === "deny") return `${tool.name} is blocked in this space.`;
  if (rules.decision === "ask") return `${tool.name} needs the user's approval. Call it directly.`;
  const trusts = connectorTrustKeys(undefined, route, connectorKind, providers);
  const trusted = await ctx.trust.loadTrustedConnectors();
  if (
    connectorReadRequiresApproval({
      tainted: await isRunTainted(ctx),
      connectorTrusted: trusts.every((trust) => trusted.has(trust)),
    })
  ) {
    return `Reading ${tool.name} needs review now that this run has taken in outside content. Call it directly.`;
  }
  for (const trust of trusts) trusted.add(trust);
  return undefined;
}

export const codeTools: ToolHandlers = {
  async run_code(ctx, call) {
    const { deps, context } = ctx;
    const { code } = call.args;
    if (typeof code !== "string" || !code.trim() || code.length > MAX_SCRIPT_LENGTH) {
      return call.finish({
        error: `Give the script as code, at most ${MAX_SCRIPT_LENGTH} characters.`,
      });
    }
    const { connector } = deps;
    const wrappers = [...ctx.tools.connector.values()].filter(isCatalogExecuteTool);
    if (!connector?.resolveCall || wrappers.length === 0) {
      return call.finish({ error: "No connected apps are available to a script." });
    }
    let sequence = 0;
    const host: CodeToolHost = {
      async resolve(id, args) {
        // Each catalog resolves the ids it holds; one that does not know this id says so.
        for (const wrapper of wrappers) {
          const request: ConnectorCall = {
            tool: wrapper.name,
            args: { id, arguments: args },
            executionId: call.effectKey,
            route: wrapper.route,
          };
          try {
            const resolved = await connector.resolveCall?.(request, context);
            if (resolved) return resolved;
          } catch (error) {
            if (!(error instanceof UnknownCatalogToolError)) throw error;
          }
        }
        throw new UnknownCatalogToolError();
      },
      refusal: (tool) => scriptToolRefusal(ctx, tool),
      execute: (inner) =>
        connector.execute(
          { ...inner, executionId: `${call.effectKey}:code:${++sequence}`, withApp: false },
          { ...context, askPerson: toolAskFor(ctx) },
        ),
      taint: () => markReadOutsideContent(ctx),
    };
    return call.finish(await runCode(code, host, ctx.abortController.signal));
  },
};
