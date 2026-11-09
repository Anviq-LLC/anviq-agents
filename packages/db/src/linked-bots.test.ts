import { describe, expect, it } from "vitest";
import { withoutLinkedBots } from "./linked-bots.js";

describe("withoutLinkedBots", () => {
  it("leaves link rows out of reads, counts and bulk writes", () => {
    for (const operation of [
      "findFirst",
      "findMany",
      "findUnique",
      "count",
      "aggregate",
      "groupBy",
      "updateMany",
      "deleteMany",
    ]) {
      expect(
        withoutLinkedBots(operation, { where: { spaceId: "s", userId: "u" } }),
        operation,
      ).toEqual({ where: { spaceId: "s", userId: "u", linkedFromBotId: null } });
    }
  });

  it("filters a query that has no where at all", () => {
    expect(withoutLinkedBots("findMany", undefined)).toEqual({ where: { linkedFromBotId: null } });
    expect(withoutLinkedBots("count", {})).toEqual({ where: { linkedFromBotId: null } });
  });

  it("keeps the other arguments", () => {
    expect(
      withoutLinkedBots("findMany", { where: { id: "b" }, select: { id: true }, take: 3 }),
    ).toEqual({ where: { id: "b", linkedFromBotId: null }, select: { id: true }, take: 3 });
  });

  it("lets a query that names linkedFromBotId, even as undefined, see link rows", () => {
    const named = { where: { id: "b", linkedFromBotId: "original" } };
    expect(withoutLinkedBots("findFirst", named)).toBe(named);
    const any = { where: { id: "b", linkedFromBotId: undefined } };
    expect(withoutLinkedBots("findFirst", any)).toBe(any);
  });

  it("does not touch single-row writes or creates", () => {
    const args = { where: { id: "b" }, data: { name: "n" } };
    for (const operation of ["update", "create", "delete", "upsert", "createMany"])
      expect(withoutLinkedBots(operation, args), operation).toBe(args);
  });
});
