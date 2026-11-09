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

/** Whether a person is in a space whose organization has other people in it. */
async function isTeamSpace(prisma: PrismaClient, spaceId: string, userId: string) {
  const space = await prisma.space.findFirst({
    where: { id: spaceId, deletingAt: null, memberships: { some: { userId } } },
    select: { organization: { select: { _count: { select: { members: true } } } } },
  });
  return (space?.organization._count.members ?? 0) > 1;
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
    if (!(await isTeamSpace(prisma, input.spaceId, actor.userId)))
      throw new OrganizationError("NOT_FOUND", "Space not found");
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

export type LinkableBot = {
  id: string;
  name: string;
  title: string;
  color: string;
  spaceId: string;
  spaceName: string;
  /** The link in the current space, when the bot is already linked there. */
  linkedBotId: string | null;
};

/**
 * A person's bots in their other spaces that can take part in the team space they are working
 * in, with the link where one exists. Nothing is offered outside a team space.
 */
export async function listLinkableBots(
  prisma: PrismaClient,
  actor: { userId: string; spaceId: string },
): Promise<LinkableBot[]> {
  return runAsSystem("list a person's own bots that can join a team space", async () => {
    if (!(await isTeamSpace(prisma, actor.spaceId, actor.userId))) return [];
    const originals = await prisma.bot.findMany({
      where: {
        userId: actor.userId,
        archivedAt: null,
        linkedFromBotId: null,
        spaceId: { not: actor.spaceId },
        space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
      },
      select: {
        id: true,
        name: true,
        title: true,
        color: true,
        spaceId: true,
        space: { select: { name: true } },
      },
      orderBy: [{ spaceId: "asc" }, { position: "asc" }, { createdAt: "asc" }],
    });
    const links = await prisma.bot.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
        linkedFromBotId: { in: originals.map((bot) => bot.id) },
      },
      select: { id: true, linkedFromBotId: true },
    });
    const linked = new Map(links.map((link) => [link.linkedFromBotId, link.id]));
    return originals.map((bot) => ({
      id: bot.id,
      name: bot.name,
      title: bot.title,
      color: bot.color,
      spaceId: bot.spaceId,
      spaceName: bot.space.name,
      linkedBotId: linked.get(bot.id) ?? null,
    }));
  });
}

/**
 * The bot ids of a group edit with each of the person's own bots from another space replaced by
 * its link in this one, creating the link when there is none. Ids that already belong to this
 * space, or that cannot be linked, are left as they are for the caller's own checks to refuse.
 */
export async function resolveGroupBotIds(
  prisma: PrismaClient,
  actor: { userId: string; spaceId: string },
  botIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(botIds)];
  if (unique.length === 0) return [...botIds];
  const here = await prisma.bot.findMany({
    where: {
      id: { in: unique },
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      linkedFromBotId: undefined,
    },
    select: { id: true },
  });
  const inSpace = new Set(here.map((bot) => bot.id));
  const replacement = new Map<string, string>();
  for (const botId of unique) {
    if (inSpace.has(botId)) continue;
    try {
      const link = await linkBotIntoSpace(prisma, actor, { botId, spaceId: actor.spaceId });
      replacement.set(botId, link.id);
    } catch (error) {
      if (!(error instanceof OrganizationError && error.code === "NOT_FOUND")) throw error;
    }
  }
  return botIds.map((botId) => replacement.get(botId) ?? botId);
}
