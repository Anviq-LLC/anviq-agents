import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANVIQ_DOCS_URLS, BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);

describe("Anviq Agents skill", () => {
  it("links only to published docs pages", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Anviq Agents")!;
    const urls = [...skill.content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(ANVIQ_DOCS_URLS);
    for (const url of urls) {
      const slug =
        url === "https://anviq.net/docs.md"
          ? "getting-started"
          : /^https:\/\/anviq\.net\/docs\/([\w-]+)\.md$/.exec(url)?.[1];
      expect(slug, url).toBeTruthy();
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });
});
