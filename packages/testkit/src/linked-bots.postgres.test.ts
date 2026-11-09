// Copyright 2026 Anviq LLC. All rights reserved.
import { linkBotIntoSpace, runAsTenant } from "@anviq/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Person } from "./team-harness.js";
import { createTeamHarness } from "./team-harness.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

/**
 * A person's own bot takes part in a team space through a link row. The row shows the team the
 * bot's name and look and nothing else, only its owner can create one, and the original bot stays
 * out of reach of everyone in the team, its owner included while they are working in the team.
 */
describeWithDatabase("linked bots", () => {
  let harness: Awaited<ReturnType<typeof createTeamHarness>>["harness"];
  let ana: Person;
  let ben: Person;
  let anaPersonalSpaceId: string;
  let benPersonalSpaceId: string;
  let originalId: string;
  let secret: string;

  const personalSpaceOf = async (person: Person) => {
    const memberships = await harness.db.spaceMember.findMany({
      where: { userId: person.userId },
      select: { spaceId: true },
    });
    const space = memberships.find((row) => row.spaceId !== harness.teamSpaceId);
    if (!space) throw new Error("no personal space");
    return space.spaceId;
  };

  beforeAll(async () => {
    const created = await createTeamHarness("linked-bots", ["cy", "ana", "ben"]);
    harness = created.harness;
    [, ana, ben] = created.people as [Person, Person, Person];
    anaPersonalSpaceId = await personalSpaceOf(ana);
    benPersonalSpaceId = await personalSpaceOf(ben);
    secret = `secret-instructions-${harness.stamp}`;
    const original = await harness.db.bot.create({
      data: {
        spaceId: anaPersonalSpaceId,
        userId: ana.userId,
        name: "Ana Original",
        title: "Research",
        description: "Reads papers",
        instructions: secret,
        color: "#5b8def",
      },
      select: { id: true },
    });
    originalId = original.id;
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("creates a team row that carries the presentation and never the instructions", async () => {
    const link = await linkBotIntoSpace(
      harness.handles.prisma,
      { userId: ana.userId },
      { botId: originalId, spaceId: harness.teamSpaceId },
    );
    expect(link.created).toBe(true);
    const row = await harness.db.bot.findFirstOrThrow({
      where: { id: link.id, linkedFromBotId: originalId },
    });
    expect(row).toMatchObject({
      spaceId: harness.teamSpaceId,
      userId: ana.userId,
      name: "Ana Original",
      title: "Research",
      description: "",
      instructions: "",
      color: "#5b8def",
    });
    for (const person of [ana, ben]) {
      const response = await harness.call(person, "bots/list", {});
      const text = await response.text();
      expect(text, "bots/list leaked").not.toContain(secret);
      expect(text, "a link row is not a personal bot").not.toContain(link.id);
    }
  });

  it("is idempotent, so linking again returns the same row", async () => {
    const again = await linkBotIntoSpace(
      harness.handles.prisma,
      { userId: ana.userId },
      { botId: originalId, spaceId: harness.teamSpaceId },
    );
    expect(again.created).toBe(false);
    const count = await harness.db.bot.count({
      where: { spaceId: harness.teamSpaceId, linkedFromBotId: originalId, archivedAt: null },
    });
    expect(count).toBe(1);
  });

  it("keeps link rows out of ordinary bot queries unless one names the link", async () => {
    const ordinary = await harness.db.bot.findMany({
      where: { spaceId: harness.teamSpaceId, userId: ana.userId },
    });
    expect(ordinary).toEqual([]);
    expect(
      await harness.db.bot.count({ where: { spaceId: harness.teamSpaceId, userId: ana.userId } }),
    ).toBe(0);
    const named = await harness.db.bot.findMany({
      where: { spaceId: harness.teamSpaceId, userId: ana.userId, linkedFromBotId: { not: null } },
    });
    expect(named).toHaveLength(1);
  });

  it("leaves the original unreadable from the team space, even to its owner", async () => {
    for (const person of [ana, ben]) {
      const rows = await runAsTenant({ spaceId: harness.teamSpaceId, userId: person.userId }, () =>
        harness.handles.prisma.bot.findMany({
          where: { id: originalId, linkedFromBotId: undefined },
        }),
      );
      expect(rows, `${person.email} read the original`).toEqual([]);
    }
  });

  it("lets only the owner link a bot", async () => {
    await expect(
      linkBotIntoSpace(
        harness.handles.prisma,
        { userId: ben.userId },
        { botId: originalId, spaceId: harness.teamSpaceId },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to link into a space the owner does not belong to", async () => {
    await expect(
      linkBotIntoSpace(
        harness.handles.prisma,
        { userId: ana.userId },
        { botId: originalId, spaceId: benPersonalSpaceId },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is refused by the database when a row points at someone else's bot", async () => {
    await expect(
      harness.db.bot.create({
        data: {
          spaceId: harness.teamSpaceId,
          userId: ben.userId,
          linkedFromBotId: originalId,
          name: "Not Ben's",
          color: "#000000",
        },
      }),
    ).rejects.toThrow(/linked bot must point at its owner/);
  });

  it("is refused by the database when the owner is not in the space", async () => {
    await expect(
      harness.db.bot.create({
        data: {
          spaceId: benPersonalSpaceId,
          userId: ana.userId,
          linkedFromBotId: originalId,
          name: "Nowhere",
          color: "#000000",
        },
      }),
    ).rejects.toThrow(/owner must belong to the space/);
  });

  it("offers a person only their own other bots, with the link once there is one", async () => {
    const anaList = await harness.ok<Array<{ id: string; linkedBotId: string | null }>>(
      ana,
      "bots/linkable",
      {},
    );
    expect(anaList.map((bot) => bot.id)).toContain(originalId);
    const benList = await harness.ok<Array<{ id: string }>>(ben, "bots/linkable", {});
    expect(benList.map((bot) => bot.id)).not.toContain(originalId);
    expect(JSON.stringify(benList)).not.toContain(secret);
  });

  it("puts a personal bot into a team group through its link", async () => {
    const teamBot = await harness.ok<{ id: string }>(ana, "bots/create", {
      name: "Ana Team Bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const group = await harness.ok<{ id: string; members: Array<{ botId: string }> }>(
      ana,
      "groups/create",
      { name: "Mixed", botIds: [teamBot.id, originalId] },
    );
    const link = await harness.db.bot.findFirstOrThrow({
      where: { spaceId: harness.teamSpaceId, linkedFromBotId: originalId },
    });
    expect(group.members.map((member) => member.botId).sort()).toEqual(
      [teamBot.id, link.id].sort(),
    );
    expect(JSON.stringify(group)).not.toContain(secret);
  });

  it("refuses to put someone else's bot into a group", async () => {
    const anaBot = await harness.ok<{ id: string }>(ana, "bots/create", {
      name: "Ana Another",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const response = await harness.call(ben, "groups/create", {
      name: "Borrowed",
      botIds: [anaBot.id, originalId],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await harness.db.bot.count({
        where: { spaceId: harness.teamSpaceId, userId: ben.userId, linkedFromBotId: { not: null } },
      }),
    ).toBe(0);
  });

  it("follows the original's name and look, and its archiving", async () => {
    await harness.db.bot.update({
      where: { id: originalId },
      data: { name: "Ana Renamed", color: "#ff8800" },
    });
    const link = await harness.db.bot.findFirstOrThrow({
      where: { spaceId: harness.teamSpaceId, linkedFromBotId: originalId },
    });
    expect(link).toMatchObject({ name: "Ana Renamed", color: "#ff8800", instructions: "" });
    await harness.db.bot.update({ where: { id: originalId }, data: { archivedAt: new Date() } });
    const archived = await harness.db.bot.findFirstOrThrow({
      where: { id: link.id, linkedFromBotId: originalId },
    });
    expect(archived.archivedAt).not.toBeNull();
  });
});
