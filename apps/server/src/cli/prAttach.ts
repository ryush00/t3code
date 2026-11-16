import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveCliAuthConfig } from "./config.ts";

export class PrAttachCliError extends Schema.TaggedError<PrAttachCliError>()("PrAttachCliError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const PrAttachUploadedItem = Schema.Struct({
  path: Schema.String,
  url: Schema.String,
  markdown: Schema.String,
});
const encodePrAttachJson = Schema.encodeSync(
  fromJsonStringPretty(Schema.Array(PrAttachUploadedItem)),
);

export interface PrAttachOptions {
  readonly baseDir?: string | undefined;
  readonly cwd?: string | undefined;
  readonly repo?: string | undefined;
  readonly host?: string | undefined;
  readonly alt?: string | undefined;
  readonly json: boolean;
  readonly files: ReadonlyArray<string>;
}

export function splitFileAndInlineAlt(raw: string): {
  readonly filePart: string;
  readonly inlineAlt: string | undefined;
} {
  const hashIndex = raw.indexOf("#");
  if (hashIndex <= 0) {
    return { filePart: raw, inlineAlt: undefined };
  }
  const filePart = raw.slice(0, hashIndex);
  const inlineAlt = raw.slice(hashIndex + 1).trim();
  return { filePart, inlineAlt: inlineAlt.length > 0 ? inlineAlt : undefined };
}

export function parseExplicitRepoOption(
  rawRepo: string,
  explicitHost: string | undefined,
): { readonly host: string | undefined; readonly repository: string } {
  const trimmed = rawRepo.trim().replace(/\.git$/iu, "");
  if (URL.canParse(trimmed)) {
    const parsed = new URL(trimmed);
    return {
      host: explicitHost?.trim().toLowerCase() ?? parsed.host.toLowerCase(),
      repository: parsed.pathname.replace(/^\/+|\/+$/gu, ""),
    };
  }
  const segments = trimmed.split("/").filter(Boolean);
  if (explicitHost === undefined && segments.length >= 3 && segments[0]!.includes(".")) {
    return {
      host: segments[0]!.toLowerCase(),
      repository: segments.slice(1).join("/"),
    };
  }
  return {
    host: explicitHost?.trim().toLowerCase(),
    repository: segments.join("/"),
  };
}

export const runPrAttach = Effect.fn("cli.pr.attach")(function* (options: PrAttachOptions) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const rawCwd = options.cwd ? yield* expandHomePath(options.cwd) : process.cwd();
  const workingDir = path.resolve(rawCwd);
  const config = yield* resolveCliAuthConfig(
    { baseDir: Option.fromNullishOr(options.baseDir) },
    Option.none(),
    { quietLogs: true },
  );

  if (options.alt !== undefined && options.files.length > 1) {
    return yield* new PrAttachCliError({
      detail: "Pass `--alt` with a single file, or append `#Alt text` per file argument.",
    });
  }

  const runtimeLayer = Layer.mergeAll(BuiltInDrivers.layer, RepositoryIdentityResolver.layer).pipe(
    Layer.provideMerge(
      ServerSettings.layer.pipe(
        Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layer)),
      ),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(VcsDriverRegistry.layer),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

  const results = yield* Effect.gen(function* () {
    const drivers = yield* BuiltInDrivers.SourceControlDrivers;
    const identityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

    let host = options.host?.trim().toLowerCase();
    let repository: string | null = null;
    let kind: "github" | "gitlab" | undefined;

    if (options.repo !== undefined) {
      const parsed = parseExplicitRepoOption(options.repo, host);
      host = parsed.host;
      repository = parsed.repository;
    }

    const identity = yield* identityResolver.resolve(workingDir);
    const detectedHost =
      identity !== null && identity.provider !== undefined
        ? sourceControlDefinitions.changeRequestHost(identity, identity.provider)?.toLowerCase()
        : undefined;
    if (repository === null && identity !== null) {
      repository = sourceControlDefinitions.repositorySelector(identity);
    }
    if (host === undefined && detectedHost) {
      host = detectedHost;
    }
    if (host === undefined || host === detectedHost) {
      if (identity?.provider === "github") kind = "github";
      else if (identity?.provider === "gitlab") kind = "gitlab";
    }

    if (host !== undefined && kind === undefined) {
      if (host === "github.com" || host.endsWith(".ghe.com") || host.includes("github")) {
        kind = "github";
      } else if (host === "gitlab.com" || host.includes("gitlab")) {
        kind = "gitlab";
      } else {
        // Probe whether glab has a login for this self-hosted hostname.
        const gitlabDriver = drivers.find((entry) => entry.driver.kind === "gitlab")?.instance;
        if (gitlabDriver?.pullRequests) {
          const viewer = yield* gitlabDriver.pullRequests
            .getViewer({ cwd: workingDir, host })
            .pipe(Effect.option);
          if (viewer._tag === "Some") kind = "gitlab";
        }
      }
    }
    if (host === undefined && kind !== undefined) {
      host = kind === "github" ? "github.com" : "gitlab.com";
    }
    if (!repository || !host || !kind) {
      return yield* new PrAttachCliError({
        detail:
          "Could not determine a GitHub or GitLab repository from this directory. Pass `--repo OWNER/REPO` (and `--host` for self-hosted GitLab).",
      });
    }

    const driverEntry = drivers.find((entry) => entry.driver.kind === kind);
    const uploader = driverEntry?.instance.pullRequests?.uploadAttachment;
    if (!uploader) {
      return yield* new PrAttachCliError({
        detail: `Provider ${kind} does not support attachment uploads.`,
      });
    }

    const uploadedItems: Array<{
      readonly path: string;
      readonly url: string;
      readonly markdown: string;
    }> = [];

    for (const rawArg of options.files) {
      const literalCandidate = path.isAbsolute(rawArg) ? rawArg : path.resolve(workingDir, rawArg);
      const literalExists = yield* fs
        .exists(literalCandidate)
        .pipe(Effect.orElseSucceed(() => false));
      const { filePart, inlineAlt } = literalExists
        ? { filePart: rawArg, inlineAlt: undefined }
        : splitFileAndInlineAlt(rawArg);
      const resolvedPath = path.isAbsolute(filePart)
        ? filePart
        : path.resolve(workingDir, filePart);
      const uploaded = yield* uploader({
        cwd: workingDir,
        host,
        repository,
        filePath: resolvedPath,
        fileName: path.basename(resolvedPath),
        alt: options.alt ?? inlineAlt,
      }).pipe(
        Effect.mapError((error) => new PrAttachCliError({ detail: error.detail, cause: error })),
      );
      uploadedItems.push({
        path: filePart,
        url: uploaded.url,
        markdown: uploaded.markdown,
      });
    }

    return uploadedItems;
  }).pipe(Effect.provide(runtimeLayer), Effect.scoped);

  if (options.json) {
    yield* Console.log(encodePrAttachJson(results));
  } else {
    for (const item of results) {
      yield* Console.log(item.markdown);
    }
  }
});
