import type { PrismaClient } from "./client.js";
import { OrganizationError } from "./organizations.js";
import { runAsSystem } from "./row-security.js";

/*
 * A person's bot takes part in a team space through a link: a thin bot row in that space that
 * points at the person's own bot (`linkedFromBotId`). It carries only what the team may see of
 * the bot (name, title and look), which the database keeps in step with the original. Its
 * description, instructions, notes and history stay with the original.
 *
 * Link rows are hidden from ordinary bot queries so no list, count or lookup can surface one
 * by oversight. Code that means to work with links names `linkedFromBotId` in its filter.
 */

const FILTERED_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The arguments of a bot query with link rows left out, unless the query names `linkedFromBotId`. */
export function withoutLinkedBots(operation: string, args: unknown): unknown {
  if (!FILTERED_OPERATIONS.has(operation)) return args;
  const base = isPlainObject(args) ? args : {};
  const where = isPlainObject(base.where) ? base.where : {};
  if ("linkedFromBotId" in where) return args;
  return { ...base, where: { ...where, linkedFromBotId: null } };
}

export function withLinkedBotsHidden(prisma: PrismaClient): PrismaClient {
  return prisma.$extends({
    query: {
      bot: {
        $allOperations({ operation, args, query }) {
          return query(withoutLinkedBots(operation, args) as typeof args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Links a person's own bot into a team space they belong to, and returns the link, which is the
 * existing one when the bot is already linked there. Only the owner can link a bot, and only
 * into a space they are a member of; the database refuses anything else.
 */
export async function linkBotIntoSpace(
  prisma: PrismaClient,
  actor: { userId: string },
  input: { botId: string; spaceId: string },
): Promise<{ id: string; created: boolean }> {
  return runAsSystem("link a person's own bot into a team space", async () => {
    const original = await prisma.bot.findFirst({
      where: { id: input.botId, userId: actor.userId, archivedAt: null, linkedFromBotId: null },
      select: { id: true, spaceId: true, name: true, title: true, color: true },
    });
    if (!original || original.spaceId === input.spaceId)
      throw new OrganizationError("NOT_FOUND", "Bot not found");
    const space = await prisma.space.findFirst({
      where: {
        id: input.spaceId,
        deletingAt: null,
        memberships: { some: { userId: actor.userId } },
      },
      select: { id: true },
    });
    if (!space) throw new OrganizationError("NOT_FOUND", "Space not found");
    const existing = () =>
      prisma.bot.findFirst({
        where: { spaceId: input.spaceId, linkedFromBotId: original.id, archivedAt: null },
        select: { id: true },
      });
    const found = await existing();
    if (found) return { id: found.id, created: false };
    try {
      const link = await prisma.bot.create({
        data: {
          spaceId: input.spaceId,
          userId: actor.userId,
          linkedFromBotId: original.id,
          name: original.name,
          title: original.title,
          color: original.color,
          notifyOnFinish: false,
        },
        select: { id: true },
      });
      return { id: link.id, created: true };
    } catch (error) {
      // A concurrent link won the unique index: use theirs.
      if (!isUniqueViolation(error)) throw error;
      const winner = await existing();
      if (!winner) throw error;
      return { id: winner.id, created: false };
    }
  });
}
