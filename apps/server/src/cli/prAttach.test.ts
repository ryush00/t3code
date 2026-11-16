import { describe, expect, it } from "@effect/vitest";

import { parseExplicitRepoOption, splitFileAndInlineAlt } from "./prAttach.ts";

describe("prAttach option parsing", () => {
  it("splits inline #alt suffixes while preserving bare filenames and leading hashes", () => {
    expect(splitFileAndInlineAlt("shot.png#Login screen")).toEqual({
      filePart: "shot.png",
      inlineAlt: "Login screen",
    });
    expect(splitFileAndInlineAlt("shot.png#   ")).toEqual({
      filePart: "shot.png",
      inlineAlt: undefined,
    });
    expect(splitFileAndInlineAlt("#leading.png")).toEqual({
      filePart: "#leading.png",
      inlineAlt: undefined,
    });
    expect(splitFileAndInlineAlt("dir/demo.mp4")).toEqual({
      filePart: "dir/demo.mp4",
      inlineAlt: undefined,
    });
  });

  it("parses owner/repo, [host/]owner/repo, nested GitLab paths, and URLs", () => {
    expect(parseExplicitRepoOption("acme/web", undefined)).toEqual({
      host: undefined,
      repository: "acme/web",
    });
    expect(parseExplicitRepoOption("acme.ghe.com/acme/web", undefined)).toEqual({
      host: "acme.ghe.com",
      repository: "acme/web",
    });
    expect(parseExplicitRepoOption("group/subgroup/web", undefined)).toEqual({
      host: undefined,
      repository: "group/subgroup/web",
    });
    expect(parseExplicitRepoOption("group/subgroup/web", "gitlab.internal.test")).toEqual({
      host: "gitlab.internal.test",
      repository: "group/subgroup/web",
    });
    expect(
      parseExplicitRepoOption("https://gitlab.example.com/group/sub/web.git", undefined),
    ).toEqual({
      host: "gitlab.example.com",
      repository: "group/sub/web",
    });
  });
});
