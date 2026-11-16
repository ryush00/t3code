import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubAttachmentUpload from "./gitHubAttachmentUpload.ts";
import * as GitHubRest from "./GitHubRest.ts";

function collectBodyBytes(body: HttpBody.HttpBody): Effect.Effect<Uint8Array> {
  if (body._tag === "Uint8Array") return Effect.succeed(body.body);
  if (body._tag === "Stream") {
    return Stream.runFold(
      Stream.orDie(body.stream),
      () => [] as number[],
      (acc, chunk) => {
        for (const byte of chunk) acc.push(byte);
        return acc;
      },
    ).pipe(Effect.map((bytes) => new Uint8Array(bytes)));
  }
  return Effect.succeed(new Uint8Array());
}

function makeUploadFixture(options: {
  readonly fileBytes?: Uint8Array;
  readonly repoPermissions?: {
    readonly admin?: boolean;
    readonly maintain?: boolean;
    readonly push?: boolean;
  };
  readonly uploadResponse?: (request: {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly contentType: string | undefined;
    readonly contentLength: number | undefined;
    readonly bytes: Uint8Array;
  }) => Response;
}) {
  const bytes = options.fileBytes ?? new TextEncoder().encode("png-bytes");
  const uploadCalls: Array<{
    readonly url: string;
    readonly authorization: string | undefined;
    readonly contentType: string | undefined;
    readonly contentLength: number | undefined;
    readonly bytes: Uint8Array;
  }> = [];
  const restCalls: Array<string> = [];
  const invalidated: Array<string> = [];

  const fileSystemLayer = FileSystem.layerNoop({
    stat: () =>
      Effect.succeed({
        type: "File",
        size: BigInt(bytes.byteLength) as FileSystem.File.Info["size"],
      } as FileSystem.File.Info),
    stream: () => Stream.make(bytes),
  });

  const layer = Layer.mergeAll(
    fileSystemLayer,
    Layer.mock(GitHubCredentials.GitHubCredentials)({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("gho_secret"),
          fingerprint: "fp",
          source: "gh" as const,
        }),
      invalidate: (host) => Effect.sync(() => void invalidated.push(host)),
    }),
    Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) =>
        Effect.sync(() => {
          restCalls.push(`${input.host}:${input.path}`);
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              id: 4242,
              ...(options.repoPermissions === undefined
                ? { permissions: { push: true } }
                : { permissions: options.repoPermissions }),
            }),
            truncated: false,
            invalidUtf8: false,
          };
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const sentBytes = yield* collectBodyBytes(request.body);
          const contentLength =
            request.body._tag === "Stream" ? request.body.contentLength : undefined;
          const contentType = request.body._tag === "Stream" ? request.body.contentType : undefined;
          const entry = {
            url: request.url,
            authorization: request.headers.authorization,
            contentType,
            contentLength,
            bytes: sentBytes,
          };
          uploadCalls.push(entry);
          const response = options.uploadResponse
            ? options.uploadResponse(entry)
            : new Response(
                JSON.stringify({
                  url: "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
                }),
                { status: 201, headers: { "content-type": "application/json" } },
              );
          return HttpClientResponse.fromWeb(request, response);
        }),
      ),
    ),
  );

  return { layer, uploadCalls, restCalls, invalidated, bytes };
}

describe("GitHubAttachmentUpload", () => {
  it.effect("uploads images to uploads.<host> and escapes markdown alt text", () => {
    const fixture = makeUploadFixture({});
    return Effect.gen(function* () {
      const upload = yield* GitHubAttachmentUpload.make;
      const result = yield* upload({
        cwd: "/repo",
        host: "github.com",
        repository: "acme/web",
        filePath: "/tmp/login.bug.png",
        fileName: "login.bug.png",
        alt: "Fix [banner](x)",
      });

      expect(result).toEqual({
        url: "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
        markdown:
          "![Fix \\[banner\\](x)](https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c)",
      });
      expect(fixture.restCalls).toEqual(["github.com:repos/acme/web"]);
      expect(fixture.uploadCalls).toEqual([
        {
          url: "https://uploads.github.com/user-attachments/assets?name=login.bug.png&content_type=image%2Fpng&repository_id=4242",
          authorization: "Bearer gho_secret",
          contentType: "application/octet-stream",
          contentLength: fixture.bytes.byteLength,
          bytes: fixture.bytes,
        },
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("returns bare URLs for videos and supports data-residency ghe.com tenants", () => {
    const fixture = makeUploadFixture({
      uploadResponse: () =>
        new Response(
          JSON.stringify({
            url: "https://acme.ghe.com/user-attachments/assets/clip-uuid",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    });
    return Effect.gen(function* () {
      const upload = yield* GitHubAttachmentUpload.make;
      const result = yield* upload({
        cwd: "/repo",
        host: "acme.ghe.com",
        repository: "acme/web",
        filePath: "/tmp/repro",
        fileName: "repro",
        mimeType: "video/mp4",
      });

      expect(result).toEqual({
        url: "https://acme.ghe.com/user-attachments/assets/clip-uuid",
        markdown: "https://acme.ghe.com/user-attachments/assets/clip-uuid",
      });
      expect(fixture.uploadCalls[0]?.url).toBe(
        "https://uploads.acme.ghe.com/user-attachments/assets?name=repro.mp4&content_type=video%2Fmp4&repository_id=4242",
      );
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("refuses GitHub Enterprise Server and read-only viewers before uploading bytes", () => {
    const fixture = makeUploadFixture({ repoPermissions: { push: false } });
    return Effect.gen(function* () {
      const upload = yield* GitHubAttachmentUpload.make;
      const ghesError = yield* upload({
        cwd: "/repo",
        host: "github.example.com",
        repository: "acme/web",
        filePath: "/tmp/shot.png",
        fileName: "shot.png",
      }).pipe(Effect.flip);
      expect(ghesError.detail).toContain("GitHub Enterprise Server");
      expect(fixture.restCalls).toEqual([]);

      const forbiddenError = yield* upload({
        cwd: "/repo",
        host: "github.com",
        repository: "acme/web",
        filePath: "/tmp/shot.png",
        fileName: "shot.png",
      }).pipe(Effect.flip);
      expect(forbiddenError.reason).toBe("forbidden");
      expect(fixture.uploadCalls).toEqual([]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("maps 404 upload refusals to forbidden and invalidates credentials on 401", () => {
    let status = 404;
    const fixture = makeUploadFixture({
      uploadResponse: () => new Response("Not Found", { status }),
    });
    return Effect.gen(function* () {
      const upload = yield* GitHubAttachmentUpload.make;
      const notFoundAsForbidden = yield* upload({
        cwd: "/repo",
        host: "github.com",
        repository: "acme/web",
        filePath: "/tmp/shot.png",
        fileName: "shot.png",
      }).pipe(Effect.flip);
      expect(notFoundAsForbidden.reason).toBe("forbidden");

      status = 401;
      const unauth = yield* upload({
        cwd: "/repo",
        host: "github.com",
        repository: "acme/web",
        filePath: "/tmp/shot.png",
        fileName: "shot.png",
      }).pipe(Effect.flip);
      expect(unauth.reason).toBe("unauthenticated");
      expect(fixture.invalidated).toEqual(["github.com"]);
    }).pipe(Effect.provide(fixture.layer));
  });
});
