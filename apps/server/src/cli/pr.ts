import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { baseDirFlag } from "./config.ts";

const prAttachCommand = Command.make("attach", {
  baseDir: baseDirFlag,
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription("Git repository directory (defaults to the current directory)."),
    Flag.optional,
  ),
  repo: Flag.String("repo").pipe(
    Flag.withAlias("R"),
    Flag.withDescription(
      "Target repository (`owner/name`, `group/project`, or `[HOST/]OWNER/REPO`).",
    ),
    Flag.optional,
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription("GitHub or GitLab hostname override."),
    Flag.optional,
  ),
  alt: Flag.String("alt").pipe(
    Flag.withDescription("Alt text override when attaching a single file."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print JSON output (`[{ path, url, markdown }]`)."),
    Flag.withDefault(false),
  ),
  files: Argument.String("file").pipe(
    Argument.variadic({ min: 1 }),
    Argument.withDescription("Local file paths to upload (supports `path#Alt text`)."),
  ),
}).pipe(
  Command.withDescription(
    "Upload local images or videos to GitHub or GitLab and print Markdown to embed in PRs or MRs.",
  ),
  Command.withHandler((options) =>
    Effect.promise(() => import("./prAttach.ts")).pipe(
      Effect.flatMap((mod) =>
        mod.runPrAttach({
          baseDir: Option.getOrUndefined(options.baseDir),
          cwd: Option.getOrUndefined(options.cwd),
          repo: Option.getOrUndefined(options.repo),
          host: Option.getOrUndefined(options.host),
          alt: Option.getOrUndefined(options.alt),
          json: options.json,
          files: options.files,
        }),
      ),
    ),
  ),
);

export const prCommand = Command.make("pr").pipe(
  Command.withDescription("Pull request and merge request utilities."),
  Command.withSubcommands([prAttachCommand]),
);
