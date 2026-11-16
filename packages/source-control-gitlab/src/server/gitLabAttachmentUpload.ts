import {
  PULL_REQUEST_ATTACHMENT_MAX_BYTES,
  SourceControlProviderKind,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitLabCredentials from "./GitLabCredentials.ts";

const KIND = SourceControlProviderKind.make("gitlab");
function createMultipartBoundary(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `----t3codeGitLabUpload${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".zip": "application/zip",
};

const decodeGitLabUploadJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      url: TrimmedNonEmptyString,
      full_path: Schema.optional(Schema.NullOr(Schema.String)),
      markdown: TrimmedNonEmptyString,
      alt: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

const decodeGitLabErrorJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  ),
);

function sanitizeFileName(raw: string): string {
  const leaf = raw.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = leaf.replace(/[\p{Cc}"/\\]/gu, "").trim();
  return cleaned.length > 0 ? cleaned : "attachment";
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

function resolveUploadFileMeta(
  fileName: string,
  mimeType: string | undefined,
): { readonly uploadName: string; readonly contentType: string } {
  const baseName = sanitizeFileName(fileName);
  const ext = extensionOf(baseName);
  const normalizedMime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (ext.length > 0) {
    return {
      uploadName: baseName,
      contentType:
        normalizedMime.length > 0
          ? normalizedMime
          : (MIME_BY_EXTENSION[ext] ?? "application/octet-stream"),
    };
  }
  const inferredExt = EXTENSION_BY_MIME[normalizedMime] ?? "";
  return {
    uploadName: `${baseName}${inferredExt}`,
    contentType: normalizedMime.length > 0 ? normalizedMime : "application/octet-stream",
  };
}

function escapeMarkdownAlt(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/[\r\n]+/gu, " ")
    .trim();
}

function failure(
  reason: PullRequestProviderError["reason"],
  detail: string,
  cause?: unknown,
): PullRequestProviderError {
  return new PullRequestProviderError({
    provider: KIND,
    operation: "uploadAttachment",
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

export const make = Effect.gen(function* () {
  const credentials = yield* GitLabCredentials.GitLabCredentials;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;

  const upload: NonNullable<PullRequestProviderApi["uploadAttachment"]> = Effect.fn(
    "GitLabAttachmentUpload.uploadAttachment",
  )(function* (input) {
    const host = normalizeHost(input.host);
    const repository = input.repository.trim().replace(/^\/+|\/+$/gu, "");
    if (repository.length === 0 || !repository.includes("/")) {
      return yield* failure("failed", "GitLab projects must be named group/project.");
    }

    const meta = resolveUploadFileMeta(input.fileName, input.mimeType);
    const stat = yield* fileSystem
      .stat(input.filePath)
      .pipe(
        Effect.mapError((cause) => failure("failed", `Could not read ${meta.uploadName}.`, cause)),
      );
    if (stat.type !== "File") {
      return yield* failure("failed", `${meta.uploadName} is not a regular file.`);
    }
    const sizeBytes = Number(stat.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return yield* failure("failed", `${meta.uploadName} is empty.`);
    }
    if (sizeBytes > PULL_REQUEST_ATTACHMENT_MAX_BYTES) {
      return yield* failure(
        "failed",
        `${meta.uploadName} exceeds the ${Math.round(PULL_REQUEST_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB upload limit.`,
      );
    }

    const auth = yield* credentials.getUploadAuth(host);
    if (Option.isNone(auth)) {
      return yield* failure(
        "unauthenticated",
        "GitLab CLI is not authenticated for this host. Run `glab auth login` and retry.",
      );
    }

    const { apiOrigin, token } = auth.value;
    const boundary = createMultipartBoundary();
    const encoder = new TextEncoder();
    const prefixBytes = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${meta.uploadName}"\r\nContent-Type: ${meta.contentType}\r\n\r\n`,
    );
    const suffixBytes = encoder.encode(`\r\n--${boundary}--\r\n`);
    const totalLength = prefixBytes.byteLength + sizeBytes + suffixBytes.byteLength;
    const contentTypeHeader = `multipart/form-data; boundary=${boundary}`;

    const makeMultipartStream = () =>
      Stream.concat(
        Stream.concat(Stream.make(prefixBytes), fileSystem.stream(input.filePath)),
        Stream.make(suffixBytes),
      );

    const initialUrl = `${apiOrigin}/api/v4/projects/${encodeURIComponent(repository)}/uploads`;
    const executeUpload = Effect.gen(function* () {
      let targetUrl = initialUrl;
      for (let hop = 0; ; hop += 1) {
        const parsedTarget = URL.parse(targetUrl);
        if (parsedTarget === null || !["https:", "http:"].includes(parsedTarget.protocol)) {
          return yield* failure("failed", "GitLab returned an invalid upload URL.");
        }
        const sameOrigin = parsedTarget.origin === apiOrigin;
        const request = HttpClientRequest.post(targetUrl).pipe(
          HttpClientRequest.setBody(
            HttpBody.stream(makeMultipartStream(), contentTypeHeader, totalLength),
          ),
          HttpClientRequest.setHeaders({
            accept: "application/json",
            ...(sameOrigin ? { authorization: `Bearer ${Redacted.value(token)}` } : {}),
          }),
        );
        const response: HttpClientResponse.HttpClientResponse = yield* httpClient
          .execute(request)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.mapError((cause) =>
              failure("failed", "Failed to send attachment bytes to GitLab.", cause),
            ),
          );
        const location = response.headers.location;
        if (response.status === 307 || response.status === 308) {
          if (!location || hop >= MAX_REDIRECTS) {
            return yield* failure(
              "failed",
              "GitLab redirected the attachment upload too many times.",
            );
          }
          const next = URL.parse(location, targetUrl);
          if (next === null || next.protocol !== "https:" || next.username || next.password) {
            return yield* failure("failed", "GitLab returned an invalid upload redirect.");
          }
          targetUrl = next.toString();
          continue;
        }
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return { status: response.status, body };
      }
    });

    const uploadResult = yield* Effect.scoped(executeUpload);
    if (uploadResult.status === 401) {
      yield* credentials.invalidate(host);
      return yield* failure(
        "unauthenticated",
        "GitLab rejected the credential for this host. Run `glab auth login` and retry.",
      );
    }
    if (uploadResult.status === 403) {
      return yield* failure(
        "forbidden",
        "Attaching files requires at least Reporter access to the GitLab project.",
      );
    }
    if (uploadResult.status === 404) {
      return yield* failure(
        "not-found",
        `GitLab project ${repository} was not found or cannot accept uploads.`,
      );
    }
    if (uploadResult.status === 413) {
      return yield* failure(
        "failed",
        `${meta.uploadName} exceeds this GitLab instance's maximum attachment size.`,
      );
    }
    if (uploadResult.status === 429) {
      return yield* failure("rate-limited", "GitLab attachment upload rate limit exceeded.");
    }
    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      const parsedErr = Option.getOrUndefined(decodeGitLabErrorJson(uploadResult.body));
      const detailText = (parsedErr?.message ?? parsedErr?.error)?.trim();
      return yield* failure(
        "failed",
        detailText && detailText.length > 0
          ? `Could not upload ${meta.uploadName}: ${detailText}`
          : `Could not upload ${meta.uploadName} (HTTP ${uploadResult.status}).`,
      );
    }

    const decoded = decodeGitLabUploadJson(uploadResult.body);
    if (Result.isFailure(decoded)) {
      return yield* failure("failed", "GitLab returned an unreadable upload response.");
    }

    const uploaded = decoded.success;
    const rawAlt = input.alt?.trim();
    const markdown =
      rawAlt && rawAlt.length > 0
        ? `${uploaded.markdown.trimStart().startsWith("![") ? "!" : ""}[${escapeMarkdownAlt(rawAlt) || "attachment"}](${uploaded.url})`
        : uploaded.markdown;
    const fullPath =
      uploaded.full_path && uploaded.full_path.startsWith("/")
        ? uploaded.full_path
        : `/${repository}${uploaded.url.startsWith("/") ? uploaded.url : `/${uploaded.url}`}`;
    const resolvedUrl = URL.canParse(uploaded.url) ? uploaded.url : `${apiOrigin}${fullPath}`;
    return {
      url: resolvedUrl,
      markdown,
    };
  });

  return upload;
});
