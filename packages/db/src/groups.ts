import type { Actor, Group, GroupMember, SpaceGroup } from "@anviq/contracts";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@anviq/contracts";
import { displayName } from "@anviq/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases, restoreBotUnderComputerQuota } from "./computers.js";
import { withNewestThreadMessages } from "./preview-messages.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import {
  activeRunSelection,
  activeRunStatuses,
  previewFromBlocks,
  primaryActiveRun,
} from "./thread-listing.js";
import { withTransactionRetry } from "./transaction-retry.js";

type GroupRecord = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  pinned: boolean;
  sectionId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  thread: {
    id: string;
    unread: boolean;
    nextMessageSeq: number;
    messages: Array<{ blocks: unknown }>;
  } | null;
  members: Array<{
    bot: {
      id: string;
      name: string;
      color: string;
      userId?: string;
      runs: Array<{ status: string }>;
    };
  }>;
  participants?: ParticipantRecord[];
};

type ParticipantRecord = { userId: string; lastReadSeq: number; user: { name: string } };

type SpaceGroupRecord = Pick<
  GroupRecord,
  "id" | "spaceId" | "name" | "pinned" | "sectionId" | "updatedAt" | "members"
> & {
  thread: {
    unread: boolean;
    nextMessageSeq: number;
    messages: Array<{ blocks: unknown }>;
  } | null;
  userId: string;
  participants?: ParticipantRecord[];
};

/**
 * What a chat shared with others adds for one viewer: who is in it, whether they may change it,
 * and whether it is unread by their own reading position. Empty for a private group.
 */
function sharedView(
  group: { userId: string; participants?: ParticipantRecord[] },
  thread: { unread: boolean; nextMessageSeq: number },
  viewerUserId: string,
) {
  const rows = group.participants ?? [];
  if (rows.length < 2) return { unread: thread.unread };
  const mine = rows.find((row) => row.userId === viewerUserId);
  // The host is always listed first.
  const ordered = [...rows].sort(
    (left, right) => Number(right.userId === group.userId) - Number(left.userId === group.userId),
  );
  return {
    participants: ordered.map((row) => ({
      userId: row.userId,
      name: row.user.name,
      host: row.userId === group.userId,
    })),
    canManage: group.userId === viewerUserId,
    unread: mine ? thread.nextMessageSeq - 1 > mine.lastReadSeq : thread.unread,
  };
}

function mapGroupMembers(members: GroupRecord["members"]): GroupMember[] {
  return members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
    status: primaryActiveRun(member.bot.runs)?.status ?? "idle",
    ...(member.bot.userId ? { ownerUserId: member.bot.userId } : {}),
  }));
}

function mapGroup(group: GroupRecord, viewerUserId: string = group.userId): Group {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  const preview = previewFromBlocks(group.thread.messages[0]?.blocks);
  const shared = sharedView(group, group.thread, viewerUserId);
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    pinned: group.pinned,
    sectionId: group.sectionId,
    archivedAt: group.archivedAt?.toISOString() ?? null,
    members: mapGroupMembers(group.members),
    threadId: group.thread.id,
    preview,
    ...shared,
    updatedAt: group.updatedAt.toISOString(),
    createdAt: group.createdAt.toISOString(),
  };
}

function mapSpaceGroup(group: SpaceGroupRecord, viewerUserId: string): SpaceGroup {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  const { canManage: _canManage, ...shared } = sharedView(group, group.thread, viewerUserId);
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    pinned: group.pinned,
    sectionId: group.sectionId,
    members: mapGroupMembers(group.members),
    preview: previewFromBlocks(group.thread.messages[0]?.blocks),
    ...shared,
    updatedAt: group.updatedAt.toISOString(),
  };
}

function hasMinimumActiveMembers(members: readonly unknown[]) {
  return members.length >= GROUP_MEMBER_MIN;
}

async function assertOwnedBots(
  prisma: PrismaClient,
  actor: Actor,
  botIds: string[],
  /** Bots other people already have in a shared chat count toward its size. */
  othersCount = 0,
): Promise<GroupMember[]> {
  const unique = [...new Set(botIds)];
  const size = unique.length + othersCount;
  if (size < GROUP_MEMBER_MIN || size > GROUP_MEMBER_MAX) {
    throw new IsolationError(
      `Groups require ${GROUP_MEMBER_MIN} to ${GROUP_MEMBER_MAX} distinct bots`,
    );
  }
  const bots = await prisma.bot.findMany({
    where: {
      id: { in: unique },
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      // A group in a team space can hold the person's linked bots as well.
      linkedFromBotId: undefined,
    },
    select: { id: true, name: true, color: true },
  });
  if (bots.length !== unique.length) throw new IsolationError();
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  return unique.map((botId) => {
    const bot = botsById.get(botId);
    if (!bot) throw new IsolationError();
    return { botId: bot.id, name: bot.name, color: bot.color };
  });
}

/**
 * Members enter a group in the order the caller lists them, and a group send without a
 * mention wakes the first one. `createMany` stamps every row with the transaction's
 * timestamp, so ties would come back in whatever order Postgres happens to return them:
 * one millisecond per member keeps the caller's order authoritative.
 */
function memberRowsInOrder(groupId: string, botIds: string[], base = Date.now()) {
  return botIds.map((botId, index) => ({
    groupId,
    botId,
    createdAt: new Date(base + index),
  }));
}

const groupMemberOrder = [{ createdAt: "asc" as const }, { botId: "asc" as const }];

const participantOrder = [{ createdAt: "asc" as const }, { userId: "asc" as const }];

const participantInclude = {
  select: { userId: true, lastReadSeq: true, user: { select: { name: true } } },
  orderBy: participantOrder,
} as const;

/** A group is visible to its host and to the people it is shared with. */
function visibleTo(userId: string) {
  return { OR: [{ userId }, { participants: { some: { userId } } }] };
}

const groupInclude = {
  thread: true,
  participants: participantInclude,
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          userId: true,
          runs: activeRunSelection,
        },
      },
    },
    orderBy: groupMemberOrder,
  },
} as const;

// Every member, archived bots included, so a group that can't be opened still names its bots.
const archivedGroupInclude = {
  thread: groupInclude.thread,
  participants: participantInclude,
  members: {
    include: {
      bot: { select: { ...groupInclude.members.include.bot.select, archivedAt: true } },
    },
    orderBy: groupMemberOrder,
  },
} as const;

const groupTargetInclude = {
  thread: { select: { id: true } },
  participants: { select: { userId: true } },
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          userId: true,
          runs: activeRunSelection,
        },
      },
    },
    orderBy: groupMemberOrder,
  },
} as const;

type RunTeardownTarget = {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  botId: string;
  runId: string;
  fence: number;
};

/** `expiresAfter` keeps leases newer than that instant. Resume passes the cleanup epoch. */
async function snapshotRunTeardownTargets(
  tx: Prisma.TransactionClient,
  runIds: string[],
  expiresAfter?: Date,
  ignoreStaleLegacy = false,
): Promise<{ leasedRunIds: string[]; targets: RunTeardownTarget[] }> {
  if (runIds.length === 0) return { leasedRunIds: [], targets: [] };
  const leases = await tx.computerExecutionLease.findMany({
    where: {
      runId: { in: runIds },
      ...(expiresAfter ? { expiresAt: { gt: expiresAfter } } : {}),
    },
    select: { computerId: true, botId: true, runId: true, fence: true },
  });
  const leasedRunIds = [...new Set(leases.map((lease) => lease.runId))];
  // Reclaim rewrites the lease runId. Resume must not follow a leftover executionRunId.
  const legacyRunIds = ignoreStaleLegacy ? leasedRunIds : runIds;
  if (legacyRunIds.length === 0) return { leasedRunIds, targets: [] };

  const leaseComputerIds = [...new Set(leases.map((lease) => lease.computerId))];
  const computers = await tx.computer.findMany({
    where: leaseComputerIds.length
      ? { OR: [{ id: { in: leaseComputerIds } }, { executionRunId: { in: legacyRunIds } }] }
      : { executionRunId: { in: legacyRunIds } },
    select: {
      id: true,
      homeKey: true,
      kind: true,
      providerRef: true,
      executionBotId: true,
      executionRunId: true,
    },
  });
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));
  const targets: RunTeardownTarget[] = [];
  const seen = new Set<string>();
  const addTarget = (computerId: string, botId: string, runId: string, fence: number) => {
    const computer = computerById.get(computerId);
    if (!computer || seen.has(`${computerId}:${runId}`)) return;
    seen.add(`${computerId}:${runId}`);
    const { id, homeKey, kind, providerRef } = computer;
    targets.push({ id, homeKey, kind, providerRef, botId, runId, fence });
  };
  for (const lease of leases) addTarget(lease.computerId, lease.botId, lease.runId, lease.fence);
  for (const computer of computers) {
    if (!computer.executionBotId || !computer.executionRunId) continue;
    if (!legacyRunIds.includes(computer.executionRunId)) continue;
    addTarget(computer.id, computer.executionBotId, computer.executionRunId, 0);
  }
  return { leasedRunIds, targets };
}

async function resumeArchivedGroupTeardown(tx: Prisma.TransactionClient, threadId: string) {
  const cancelled = await tx.run.findMany({
    where: { threadId, status: "cancelled" },
    select: { id: true },
  });
  // Cleanup sets expiresAt to epoch and leaves runId. A TTL lapse is still after that.
  const { leasedRunIds, targets } = await snapshotRunTeardownTargets(
    tx,
    cancelled.map((run) => run.id),
    new Date(0),
    true,
  );
  if (leasedRunIds.length === 0) throw new IsolationError();
  return { cancelledRunIds: leasedRunIds, computers: targets };
}

/**
 * Newest message for one group's preview. A top-level `take` is sent as LIMIT;
 * the content-encryption extension decrypts the row, so this read has no `select`.
 */
async function attachNewestGroupMessage<T extends { thread: { id: string } | null }>(
  client: PrismaClient | Prisma.TransactionClient,
  group: T,
) {
  if (!group.thread) return group;
  const messages = await client.message.findMany({
    where: { threadId: group.thread.id },
    orderBy: { seq: "desc" },
    take: 1,
  });
  return { ...group, thread: { ...group.thread, messages } };
}

export function createGroupRepos(prisma: PrismaClient) {
  async function listSpaceGroupsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceGroup[]> {
    if (spaceIds.length === 0) return [];
    const groups = await withNewestThreadMessages(
      prisma,
      await prisma.chatGroup.findMany({
        where: {
          spaceId: { in: spaceIds },
          archivedAt: null,
          ...visibleTo(actor.userId),
        },
        select: {
          id: true,
          spaceId: true,
          userId: true,
          name: true,
          pinned: true,
          sectionId: true,
          updatedAt: true,
          thread: {
            select: {
              id: true,
              unread: true,
              nextMessageSeq: true,
            },
          },
          participants: participantInclude,
          members: groupInclude.members,
        },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      }),
      1,
    );
    return groups
      .filter((group) => hasMinimumActiveMembers(group.members))
      .map((group) => mapSpaceGroup(group, actor.userId));
  }

  /**
   * Archived groups, and groups left with too few active bots to open, whatever their member
   * count: this is the only list they appear in, so it's where they're restored.
   */
  async function listArchivedGroups(actor: Actor): Promise<Group[]> {
    const groups = await withNewestThreadMessages(
      prisma,
      await prisma.chatGroup.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          OR: [
            { archivedAt: { not: null } },
            { members: { some: { bot: { archivedAt: { not: null } } } } },
          ],
        },
        include: archivedGroupInclude,
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      }),
      1,
    );
    return groups
      .filter(
        (group) =>
          group.archivedAt !== null ||
          !hasMinimumActiveMembers(group.members.filter((member) => !member.bot.archivedAt)),
      )
      .map((group) => mapGroup(group as GroupRecord, actor.userId));
  }

  return {
    async listGroups(actor: Actor, options: { archived?: boolean } = {}): Promise<Group[]> {
      if (options.archived) return listArchivedGroups(actor);
      const groups = await withNewestThreadMessages(
        prisma,
        await prisma.chatGroup.findMany({
          where: {
            spaceId: actor.spaceId,
            archivedAt: null,
            ...visibleTo(actor.userId),
          },
          include: groupInclude,
          orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        }),
        1,
      );
      return groups
        .filter((group) => hasMinimumActiveMembers(group.members))
        .map((group) => mapGroup(group as GroupRecord, actor.userId));
    },

    listSpaceGroupsForSpaces,

    async getGroup(actor: Actor, groupId: string, options: { includeArchived?: boolean } = {}) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          spaceId: actor.spaceId,
          ...visibleTo(actor.userId),
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: groupInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return (await attachNewestGroupMessage(prisma, group)) as GroupRecord;
    },

    /** Host-only unless `participant` lets the people a chat is shared with resolve it too. */
    async getGroupTarget(actor: Actor, groupId: string, options: { participant?: boolean } = {}) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          spaceId: actor.spaceId,
          ...(options.participant ? visibleTo(actor.userId) : { userId: actor.userId }),
          archivedAt: null,
        },
        include: groupTargetInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group;
    },

    async createGroup(actor: Actor, input: { name: string; botIds: string[] }): Promise<Group> {
      const members = await assertOwnedBots(prisma, actor, input.botIds);
      const created = await prisma.$transaction(async (tx) => {
        await lockSpaceForContentCreation(tx, {
          spaceId: actor.spaceId,
          userId: actor.userId,
        });
        const group = await tx.chatGroup.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: displayName(input.name, ""),
          },
        });
        await tx.chatGroupMember.createMany({
          data: memberRowsInOrder(
            group.id,
            members.map((member) => member.botId),
          ),
        });
        await tx.thread.create({
          data: {
            spaceId: actor.spaceId,
            groupId: group.id,
            userId: actor.userId,
          },
        });
        const loaded = await tx.chatGroup.findFirstOrThrow({
          where: { id: group.id },
          include: groupInclude,
        });
        return attachNewestGroupMessage(tx, loaded);
      });
      return mapGroup(created as GroupRecord, actor.userId);
    },

    async updateGroup(
      actor: Actor,
      input: {
        groupId: string;
        name?: string;
        botIds?: string[];
        expectedBotIds?: string[];
        pinned?: boolean;
        sectionId?: string | null;
      },
    ): Promise<{ group: Group; cancelledRunIds: string[] }> {
      // Bots that guests of a shared chat brought in stay as they are; the host edits their own.
      const guestBotIds = input.botIds
        ? new Set(
            (
              await prisma.chatGroupMember.findMany({
                where: {
                  groupId: input.groupId,
                  group: { spaceId: actor.spaceId, userId: actor.userId },
                  bot: { userId: { not: actor.userId }, archivedAt: null },
                },
                select: { botId: true },
              })
            ).map((member) => member.botId),
          )
        : new Set<string>();
      const members = input.botIds
        ? await assertOwnedBots(
            prisma,
            actor,
            input.botIds.filter((botId) => !guestBotIds.has(botId)),
            guestBotIds.size,
          )
        : undefined;
      const updated = await prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, input.groupId);
        const current = await tx.chatGroup.findFirst({
          where: {
            id: input.groupId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          include: {
            members: { select: { botId: true, bot: { select: { archivedAt: true } } } },
            thread: { select: { id: true } },
          },
        });
        if (!current?.thread) throw new IsolationError();
        if (input.expectedBotIds) {
          const expected = new Set(input.expectedBotIds);
          const active = current.members.filter((member) => member.bot.archivedAt === null);
          if (
            expected.size !== active.length ||
            active.some((member) => !expected.has(member.botId))
          ) {
            throw new IsolationError("Group members changed. Refresh and try again.");
          }
        }
        if (
          !members &&
          !hasMinimumActiveMembers(
            current.members.filter((member) => member.bot.archivedAt === null),
          )
        ) {
          throw new IsolationError();
        }
        const nextBotIds = new Set(
          members
            ? [...members.map((member) => member.botId), ...guestBotIds]
            : current.members.map((member) => member.botId),
        );
        const removedBotIds = current.members
          .map((member) => member.botId)
          .filter((botId) => !nextBotIds.has(botId));
        const activeRuns = removedBotIds.length
          ? await tx.run.findMany({
              where: {
                threadId: current.thread.id,
                botId: { in: removedBotIds },
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true, taskId: true, userId: true, spaceId: true },
            })
          : [];
        if (activeRuns.length) {
          const now = new Date();
          await cancelRunsInTransaction(tx, activeRuns, now);
        }
        if (input.name !== undefined) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { name: displayName(input.name, "") },
          });
        }
        if (members) {
          await tx.chatGroupMember.deleteMany({ where: { groupId: input.groupId } });
          await tx.chatGroupMember.createMany({
            data: memberRowsInOrder(input.groupId, [
              ...members.map((member) => member.botId),
              ...guestBotIds,
            ]),
          });
        }
        await tx.chatGroup.update({
          where: { id: input.groupId },
          data: {
            updatedAt: new Date(),
            pinned: input.pinned,
            sectionId: input.sectionId,
          },
        });
        const loaded = await tx.chatGroup.findFirstOrThrow({
          where: { id: input.groupId },
          include: groupInclude,
        });
        return {
          group: await attachNewestGroupMessage(tx, loaded),
          cancelledRunIds: activeRuns.map((run) => run.id),
        };
      });
      if (!updated.group.thread) throw new IsolationError();
      return {
        group: mapGroup(updated.group as GroupRecord, actor.userId),
        cancelledRunIds: updated.cancelledRunIds,
      };
    },

    async archiveGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, groupId);
        const current = await tx.chatGroup.findFirst({
          where: {
            id: groupId,
            spaceId: actor.spaceId,
            userId: actor.userId,
          },
          select: { archivedAt: true, thread: { select: { id: true } } },
        });
        if (!current?.thread) throw new IsolationError();
        if (current.archivedAt) return resumeArchivedGroupTeardown(tx, current.thread.id);

        const activeRuns = await tx.run.findMany({
          where: {
            threadId: current.thread.id,
            status: { in: activeRunStatuses },
          },
          select: { id: true, taskId: true, userId: true, spaceId: true },
        });
        const runIds = activeRuns.map((run) => run.id);
        const now = new Date();
        // Snapshot before cancellation commits. An expired lease that has not been
        // reclaimed still names this run's screen.
        const { targets } = await snapshotRunTeardownTargets(tx, runIds);

        if (runIds.length) {
          await cancelRunsInTransaction(tx, activeRuns, now);
          await tx.event.deleteMany({
            where: { type: "thread.progress", runId: { in: runIds } },
          });
        }

        await tx.chatGroup.update({
          where: { id: groupId },
          data: { archivedAt: now, pinned: false },
        });

        return { cancelledRunIds: runIds, computers: targets };
      });
    },

    /** After an archive's teardown: expire the cancelled runs' leases and legacy columns. */
    async releaseArchivedRunLeases(runIds: string[]) {
      if (runIds.length === 0) return;
      await expireComputerExecutionLeases(prisma, { runId: { in: runIds } });
      await prisma.computer.updateMany({
        where: { executionRunId: { in: runIds } },
        data: {
          executionRunId: null,
          executionBotId: null,
          executionLeaseExpiresAt: null,
        },
      });
    },

    /**
     * A group needs its bots to open, so its archived bots come back with it, each within its
     * computer's quota and all in one transaction: one that doesn't fit leaves everything archived.
     */
    async restoreGroup(actor: Actor, groupId: string) {
      await withTransactionRetry(() =>
        prisma.$transaction(async (tx) => {
          await lockOwnedGroup(tx, actor, groupId);
          const archived = await tx.chatGroupMember.findMany({
            where: { groupId, bot: { archivedAt: { not: null } } },
            select: { bot: { select: { id: true, computerId: true } } },
            orderBy: groupMemberOrder,
          });
          for (const { bot } of archived) {
            if (bot.computerId) {
              await restoreBotUnderComputerQuota(tx, {
                userId: actor.userId,
                botId: bot.id,
                computerId: bot.computerId,
              });
            } else {
              await tx.bot.update({ where: { id: bot.id }, data: { archivedAt: null } });
            }
          }
          await tx.chatGroup.update({ where: { id: groupId }, data: { archivedAt: null } });
        }),
      );
    },

    async removeGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, groupId);
        const group = await tx.chatGroup.findUnique({
          where: { id: groupId },
          select: {
            artifacts: { select: { storageKey: true } },
            members: { orderBy: groupMemberOrder, take: 1, select: { botId: true } },
          },
        });
        const contextBotId = group?.members[0]?.botId;
        if (!contextBotId) throw new IsolationError();
        await tx.chatGroup.delete({ where: { id: groupId } });
        return {
          contextBotId,
          artifactStorageKeys: group.artifacts.map((artifact) => artifact.storageKey),
        };
      });
    },

    mapGroup,
  };
}

/** Locks a group for whoever holds one of its bots, whoever owns the group. */
export async function lockGroupOfSpace(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  spaceId: string,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM chat_groups
    WHERE id = ${groupId}
      AND "spaceId" = ${spaceId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IsolationError();
}

export async function lockOwnedGroup(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM chat_groups
    WHERE id = ${groupId}
      AND "spaceId" = ${actor.spaceId}
      AND "userId" = ${actor.userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IsolationError();
}

export async function touchGroupUpdatedAt(
  prisma: Pick<Prisma.TransactionClient, "chatGroup">,
  groupId: string,
) {
  await prisma.chatGroup.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });
}
