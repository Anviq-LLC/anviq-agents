// Copyright 2026 Anviq LLC. All rights reserved.
import type { Actor } from "@anviq/contracts";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@anviq/contracts";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { lockOwnedGroup } from "./groups.js";
import { OrganizationError } from "./organizations.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const SHARED_CHAT_MAX_PEOPLE = 50;

const ACTIVE_RUN_STATUSES = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];

/** Takes these people's bots out of a chat and stops what they were running in it. */
async function removeBotsOf(
  tx: Prisma.TransactionClient,
  group: { id: string; threadId: string },
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const bots = await tx.chatGroupMember.findMany({
    where: { groupId: group.id, bot: { userId: { in: userIds } } },
    select: { botId: true },
  });
  if (bots.length === 0) return [];
  const botIds = bots.map((member) => member.botId);
  const runs = await tx.run.findMany({
    where: { threadId: group.threadId, botId: { in: botIds }, status: { in: ACTIVE_RUN_STATUSES } },
    select: { id: true, taskId: true, userId: true, spaceId: true },
  });
  if (runs.length) await cancelRunsInTransaction(tx, runs, new Date());
  await tx.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: { in: botIds } } });
  return runs.map((run) => run.id);
}
/**
 * Chooses who else takes part in a group the host owns. Everyone must belong to the group's
 * space, and the space must be a team's. Adding people to a chat that already has messages is
 * refused until it is cleared, so a conversation held in private is never handed to someone
 * who joins later. An empty list makes the group private again.
 */
export async function setGroupParticipants(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { groupId: string; userIds: string[] },
): Promise<{ cancelledRunIds: string[] }> {
  const guests = [...new Set(input.userIds)].filter((userId) => userId !== actor.userId);
  if (guests.length + 1 > SHARED_CHAT_MAX_PEOPLE)
    throw new OrganizationError("LIMIT", "Too many people in one chat");
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockOwnedGroup(tx, actor, input.groupId);
      const group = await tx.chatGroup.findFirst({
        where: { id: input.groupId, spaceId: actor.spaceId, userId: actor.userId },
        select: {
          space: { select: { organization: { select: { metadata: true } } } },
          participants: { select: { userId: true } },
          thread: { select: { id: true, nextMessageSeq: true } },
        },
      });
      if (!group?.thread) throw new OrganizationError("NOT_FOUND", "Chat not found");
      const current = new Set(group.participants.map((row) => row.userId));
      const wanted = new Set(guests);
      const thread = { id: input.groupId, threadId: group.thread.id };
      if (guests.length === 0) {
        const leaving = [...current].filter((userId) => userId !== actor.userId);
        const cancelledRunIds = await removeBotsOf(tx, thread, leaving);
        await tx.chatGroupParticipant.deleteMany({ where: { groupId: input.groupId } });
        return { cancelledRunIds };
      }
      if (!group.space.organization.metadata?.includes('"kind":"team"'))
        throw new OrganizationError("INVALID", "Chats are shared inside a team");
      const members = await tx.spaceMember.findMany({
        where: { spaceId: actor.spaceId, userId: { in: guests } },
        select: { userId: true },
      });
      if (members.length !== guests.length)
        throw new OrganizationError("INVALID", "Only people in this space can join");
      const adding = guests.some((userId) => !current.has(userId));
      if (
        adding &&
        current.size < 2 &&
        (await tx.message.count({ where: { threadId: group.thread.id } })) > 0
      )
        throw new OrganizationError("INVALID", "Clear this chat before sharing it");
      const stale = [...current].filter((userId) => userId !== actor.userId && !wanted.has(userId));
      const cancelledRunIds = await removeBotsOf(tx, thread, stale);
      if (stale.length)
        await tx.chatGroupParticipant.deleteMany({
          where: { groupId: input.groupId, userId: { in: stale } },
        });
      const toAdd = [actor.userId, ...guests].filter((userId) => !current.has(userId));
      if (toAdd.length) {
        const seen = group.thread.nextMessageSeq - 1;
        await tx.chatGroupParticipant.createMany({
          data: toAdd.map((userId) => ({ groupId: input.groupId, userId, lastReadSeq: seen })),
        });
      }
      return { cancelledRunIds };
    }),
  );
}

/** A guest leaves a chat shared with them. The host keeps it and cannot leave their own. */
export async function leaveSharedGroup(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
): Promise<{ cancelledRunIds: string[] }> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const group = await tx.chatGroup.findFirst({
        where: {
          id: groupId,
          spaceId: actor.spaceId,
          participants: { some: { userId: actor.userId } },
        },
        select: {
          userId: true,
          participants: { select: { userId: true } },
          thread: { select: { id: true } },
        },
      });
      if (!group?.thread) throw new OrganizationError("NOT_FOUND", "Chat not found");
      if (group.userId === actor.userId)
        throw new OrganizationError("FORBIDDEN", "The host cannot leave their own chat");
      const cancelledRunIds = await removeBotsOf(tx, { id: groupId, threadId: group.thread.id }, [
        actor.userId,
      ]);
      await tx.chatGroupParticipant.deleteMany({ where: { groupId, userId: actor.userId } });
      // A chat left with only its host is private again.
      if (group.participants.length <= 2)
        await tx.chatGroupParticipant.deleteMany({ where: { groupId } });
      return { cancelledRunIds };
    }),
  );
}

/**
 * Sets which of a person's own bots take part in a chat shared with them. Their bots answer with
 * their own models and apps and ask them, not the host, before acting. A chat keeps at least two
 * bots in all.
 */
export async function setMyBotsInSharedGroup(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { groupId: string; botIds: string[] },
): Promise<{ cancelledRunIds: string[] }> {
  const wanted = [...new Set(input.botIds)];
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM chat_groups
        WHERE id = ${input.groupId} AND "spaceId" = ${actor.spaceId}
        FOR UPDATE`;
      if (locked.length !== 1) throw new OrganizationError("NOT_FOUND", "Chat not found");
      const group = await tx.chatGroup.findFirst({
        where: {
          id: input.groupId,
          spaceId: actor.spaceId,
          archivedAt: null,
          participants: { some: { userId: actor.userId } },
        },
        select: {
          thread: { select: { id: true } },
          members: { select: { botId: true, bot: { select: { userId: true } } } },
        },
      });
      if (!group?.thread) throw new OrganizationError("NOT_FOUND", "Chat not found");
      const owned = await tx.bot.count({
        where: {
          id: { in: wanted },
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
          linkedFromBotId: undefined,
        },
      });
      if (owned !== wanted.length) throw new OrganizationError("NOT_FOUND", "Bot not found");
      const others = group.members.filter((member) => member.bot.userId !== actor.userId);
      const mine = group.members.filter((member) => member.bot.userId === actor.userId);
      const size = others.length + wanted.length;
      if (size > GROUP_MEMBER_MAX)
        throw new OrganizationError("LIMIT", "Too many bots in this chat");
      if (size < GROUP_MEMBER_MIN)
        throw new OrganizationError("INVALID", "A chat needs at least two bots");
      const keep = new Set(wanted);
      const removed = mine
        .filter((member) => !keep.has(member.botId))
        .map((member) => member.botId);
      const present = new Set(mine.map((member) => member.botId));
      const added = wanted.filter((botId) => !present.has(botId));
      let cancelledRunIds: string[] = [];
      if (removed.length) {
        const runs = await tx.run.findMany({
          where: {
            threadId: group.thread.id,
            botId: { in: removed },
            status: { in: ACTIVE_RUN_STATUSES },
          },
          select: { id: true, taskId: true, userId: true, spaceId: true },
        });
        if (runs.length) await cancelRunsInTransaction(tx, runs, new Date());
        cancelledRunIds = runs.map((run) => run.id);
        await tx.chatGroupMember.deleteMany({
          where: { groupId: input.groupId, botId: { in: removed } },
        });
      }
      if (added.length) {
        const base = Date.now();
        await tx.chatGroupMember.createMany({
          data: added.map((botId, index) => ({
            groupId: input.groupId,
            botId,
            createdAt: new Date(base + index),
          })),
        });
      }
      await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: new Date() } });
      return { cancelledRunIds };
    }),
  );
}

/** Records that a person has read a shared chat up to a message. */
export async function markParticipantRead(
  prisma: Pick<PrismaClient, "chatGroupParticipant">,
  input: { groupId: string; userId: string; seq: number },
): Promise<void> {
  await prisma.chatGroupParticipant.updateMany({
    where: { groupId: input.groupId, userId: input.userId, lastReadSeq: { lt: input.seq } },
    data: { lastReadSeq: input.seq },
  });
}
