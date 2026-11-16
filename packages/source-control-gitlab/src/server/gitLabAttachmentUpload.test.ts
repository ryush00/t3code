import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";

import * as GitLabCredentials from "./GitLabCredentials.ts";
import * as GitLabAttachmentUpload from "./gitLabAttachmentUpload.ts";

function collectBodyText(body: HttpBody.HttpBody): Effect.Effect<string> {
  if (body._tag === "Stream") {
    return Stream.runFold(
      Stream.orDie(body.stream),
      () => [] as number[],
      (acc, chunk) => {
        for (const byte of chunk) acc.push(byte);
        return acc;
      },
    ).pipe(Effect.map((bytes) => new TextDecoder().decode(new Uint8Array(bytes))));
  }
  return Effect.succeed("");
}

function makeFixture(options: {
  readonly auth?: { readonly apiOrigin: string; readonly token: string } | null;
  readonly respond?: (request: {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly contentType: string | undefined;
    readonly contentLength: number | undefined;
    readonly bodyText: string;
  }) => Response;
}) {
  const fileBytes = new TextEncoder().encode("gitlab-image-bytes");
  const requests: Array<{
    readonly url: string;
    readonly authorization: string | undefined;
    readonly contentType: string | undefined;
    readonly contentLength: number | undefined;
    readonly bodyText: string;
  }> = [];
  const invalidated: Array<string> = [];

  const layer = Layer.mergeAll(
    FileSystem.layerNoop({
      stat: () =>
        Effect.succeed({
          type: "File",
          size: BigInt(fileBytes.byteLength) as FileSystem.File.Info["size"],
        } as FileSystem.File.Info),
      stream: () => Stream.make(fileBytes),
    }),
    Layer.mock(GitLabCredentials.GitLabCredentials)({
      getUploadAuth: () =>
        Effect.succeed(
          options.auth === null
            ? Option.none()
            : Option.some({
                apiOrigin: options.auth?.apiOrigin ?? "https://gitlab.example.com",
                token: Redacted.make(options.auth?.token ?? "glpat-secret"),
              }),
        ),
      invalidate: (host) => Effect.sync(() => void invalidated.push(host)),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const bodyText = yield* collectBodyText(request.body);
          const entry = {
            url: request.url,
            authorization: request.headers.authorization,
            contentType: request.body._tag === "Stream" ? request.body.contentType : undefined,
            contentLength: request.body._tag === "Stream" ? request.body.contentLength : undefined,
            bodyText,
          };
          requests.push(entry);
          const response = options.respond
            ? options.respond(entry)
            : new Response(
                JSON.stringify({
                  alt: "shot",
                  url: "/uploads/66dbcd21ec5d24ed6ea225176098d52b/shot.png",
                  full_path: "/group/sub/app/uploads/66dbcd21ec5d24ed6ea225176098d52b/shot.png",
                  markdown: "![shot](/uploads/66dbcd21ec5d24ed6ea225176098d52b/shot.png)",
                }),
                { status: 201, headers: { "content-type": "application/json" } },
              );
          return HttpClientResponse.fromWeb(request, response);
        }),
      ),
    ),
  );

  return { layer, requests, invalidated };
}

describe("GitLabAttachmentUpload", () => {
  it.effect(
    "streams multipart uploads to the project API and preserves GitLab's relative markdown",
    () => {
      const fixture = makeFixture({});
      return Effect.gen(function* () {
        const upload = yield* GitLabAttachmentUpload.make;
        const result = yield* upload({
          cwd: "/repo",
          host: "gitlab.example.com",
          repository: "group/sub/app",
          filePath: "/tmp/shot.png",
          fileName: "shot.png",
          mimeType: "image/png",
        });

        expect(result).toEqual({
          url: "https://gitlab.example.com/group/sub/app/uploads/66dbcd21ec5d24ed6ea225176098d52b/shot.png",
          markdown: "![shot](/uploads/66dbcd21ec5d24ed6ea225176098d52b/shot.png)",
        });
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]?.url).toBe(
          "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp/uploads",
        );
        expect(fixture.requests[0]?.authorization).toBe("Bearer glpat-secret");
        expect(fixture.requests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(fixture.requests[0]?.contentLength).toBe(
          new TextEncoder().encode(fixture.requests[0]!.bodyText).byteLength,
        );
        expect(fixture.requests[0]?.bodyText).toContain(
          'Content-Disposition: form-data; name="file"; filename="shot.png"',
        );
        expect(fixture.requests[0]?.bodyText).toContain("gitlab-image-bytes");
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("applies custom escaped alt text while keeping image vs link syntax", () => {
    const fixture = makeFixture({
      respond: () =>
        new Response(
          JSON.stringify({
            url: "/uploads/abc/spec.pdf",
            markdown: "[spec.pdf](/uploads/abc/spec.pdf)",
          }),
          { status: 201 },
        ),
    });
    return Effect.gen(function* () {
      const upload = yield* GitLabAttachmentUpload.make;
      const result = yield* upload({
        cwd: "/repo",
        host: "gitlab.com",
        repository: "acme/docs",
        filePath: "/tmp/spec.pdf",
        fileName: "spec.pdf",
        alt: "Spec [v2]",
      });

      expect(result.markdown).toBe("[Spec \\[v2\\]](/uploads/abc/spec.pdf)");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("invalidates credentials on 401 and classifies 403 as forbidden", () => {
    let status = 401;
    const fixture = makeFixture({
      respond: () => new Response(JSON.stringify({ message: "Unauthorized" }), { status }),
    });
    return Effect.gen(function* () {
      const upload = yield* GitLabAttachmentUpload.make;
      const unauth = yield* upload({
        cwd: "/repo",
        host: "gitlab.example.com",
        repository: "group/app",
        filePath: "/tmp/shot.png",
        fileName: "shot.png",
      }).pipe(Effect.flip);
      expect(unauth.reason).toBe("unauthenticated");
      expect(fixture.invalidated).toEqual(["gitlab.example.com"]);

      status = 403;
      const forbidden = yield* upload({
        cwd: "/repo",
        host: "gitlab.example.com",
        repository: "group/app",
        filePath: "/tmp/shot.png",
        fileName: "shot.png",
      }).pipe(Effect.flip);
      expect(forbidden.reason).toBe("forbidden");
    }).pipe(Effect.provide(fixture.layer));
  });
});
