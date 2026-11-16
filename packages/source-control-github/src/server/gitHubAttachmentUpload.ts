import { SourceControlProviderKind, TrimmedNonEmptyString } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
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

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";

const KIND = SourceControlProviderKind.make("github");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

const CONTENT_TYPES: ReadonlyArray<{ readonly ext: string; readonly contentType: string }> = [
  { ext: ".png", contentType: "image/png" },
  { ext: ".jpg", contentType: "image/jpeg" },
  { ext: ".jpeg", contentType: "image/jpeg" },
  { ext: ".gif", contentType: "image/gif" },
  { ext: ".webp", contentType: "image/webp" },
  { ext: ".svg", contentType: "image/svg+xml" },
  { ext: ".mp4", contentType: "video/mp4" },
  { ext: ".mov", contentType: "video/quicktime" },
  { ext: ".webm", contentType: "video/webm" },
];

const SUPPORTED_EXTENSIONS = CONTENT_TYPES.map((entry) => entry.ext.slice(1)).join(", ");

const decodeRepositoryJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Int,
      permissions: Schema.optional(
        Schema.Struct({
          admin: Schema.optional(Schema.Boolean),
          maintain: Schema.optional(Schema.Boolean),
          push: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
);

const decodeUploadedAssetJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      url: TrimmedNonEmptyString,
    }),
  ),
);

const decodeErrorMessageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optional(Schema.String),
    }),
  ),
);

export function isGitHubUploadHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "github.com" || normalized.endsWith(".ghe.com");
}

function sanitizeFileName(raw: string): string {
  const leaf = raw.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = leaf.replace(/[\p{Cc}/\\]/gu, "").trim();
  return cleaned.length > 0 ? cleaned : "attachment";
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

function resolveGitHubContentType(
  fileName: string,
  mimeType: string | undefined,
): { readonly uploadName: string; readonly contentType: string; readonly isVideo: boolean } | null {
  const baseName = sanitizeFileName(fileName);
  const ext = extensionOf(baseName);
  const byExt = CONTENT_TYPES.find((entry) => entry.ext === ext);
  if (byExt !== undefined) {
    return {
      uploadName: baseName,
      contentType: byExt.contentType,
      isVideo: byExt.contentType.startsWith("video/"),
    };
  }
  const normalizedMime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const byMime = CONTENT_TYPES.find((entry) => entry.contentType === normalizedMime);
  if (byMime !== undefined) {
    const stem = ext.length > 0 ? baseName.slice(0, -ext.length) : baseName;
    return {
      uploadName: `${stem}${byMime.ext}`,
      contentType: byMime.contentType,
      isVideo: byMime.contentType.startsWith("video/"),
    };
  }
  return null;
}

function escapeMarkdownAlt(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/[\r\n]+/gu, " ")
    .trim();
}

function defaultImageAlt(uploadName: string): string {
  const ext = extensionOf(uploadName);
  const stem = ext.length > 0 ? uploadName.slice(0, -ext.length) : uploadName;
  const formatted = stem.replaceAll(".", " ").trim();
  return formatted.length > 0 ? formatted : "image";
}

function formatBytesLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function parseRepositorySegments(
  repository: string,
): { readonly owner: string; readonly name: string } | null {
  const segments = repository.trim().split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return { owner: segments[0]!, name: segments[1]! };
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

function mapCredentialOrRestError(error: unknown): PullRequestProviderError {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "GitHubCliMissingError":
        return failure("missing-tool", error instanceof Error ? error.message : "Missing gh CLI.");
      case "GitHubNotSignedInError":
      case "GitHubHostDisabledError":
      case "SettingsSecretUnresolvedError":
      case "GitHubApiAuthenticationError":
        return failure(
          "unauthenticated",
          error instanceof Error ? error.message : "GitHub authentication failed.",
          error,
        );
      case "GitHubApiRateLimitError":
      case "SourceControlRateLimitPausedError":
        return failure("rate-limited", "GitHub API rate limit exceeded.", error);
      case "GitHubApiNotFoundError":
        return failure(
          "not-found",
          "Repository was not found or cannot be accessed with the active GitHub credential.",
          error,
        );
      case "GitHubApiResponseError":
        if ("status" in error && error.status === 403) {
          return failure(
            "forbidden",
            "Attaching files requires write access to the repository.",
            error,
          );
        }
        break;
    }
  }
  return failure(
    "failed",
    error instanceof Error ? error.message : "Failed to upload attachment to GitHub.",
    error,
  );
}

export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const rest = yield* GitHubRest.GitHubRest;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;

  const upload: NonNullable<PullRequestProviderApi["uploadAttachment"]> = Effect.fn(
    "GitHubAttachmentUpload.uploadAttachment",
  )(function* (input) {
    const host = normalizeHost(input.host);
    // Check the host first: GitHub Enterprise Server has no user-attachments upload endpoint.
    if (!isGitHubUploadHost(host)) {
      return yield* failure(
        "failed",
        "Attaching files is not supported on GitHub Enterprise Server.",
      );
    }

    const repoSegments = parseRepositorySegments(input.repository);
    if (repoSegments === null) {
      return yield* failure("failed", "Repositories on GitHub must be named owner/name.");
    }

    const resolvedType = resolveGitHubContentType(input.fileName, input.mimeType);
    if (resolvedType === null) {
      return yield* failure(
        "failed",
        `${sanitizeFileName(input.fileName)} is not a supported file type (supported: ${SUPPORTED_EXTENSIONS}).`,
      );
    }

    const stat = yield* fileSystem
      .stat(input.filePath)
      .pipe(
        Effect.mapError((cause) =>
          failure("failed", `Could not read ${sanitizeFileName(input.fileName)}.`, cause),
        ),
      );
    if (stat.type !== "File") {
      return yield* failure("failed", `${sanitizeFileName(input.fileName)} is not a regular file.`);
    }
    const sizeBytes = Number(stat.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return yield* failure("failed", `${sanitizeFileName(input.fileName)} is empty.`);
    }
    const maxBytes = resolvedType.isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (sizeBytes > maxBytes) {
      return yield* failure(
        "failed",
        `${sanitizeFileName(input.fileName)}: ${resolvedType.isVideo ? "videos" : "images"} must be at most ${formatBytesLimit(maxBytes)}.`,
      );
    }

    const repoResponse = yield* rest
      .rest({
        host,
        operation: "uploadAttachment.repository",
        path: `repos/${encodeURIComponent(repoSegments.owner)}/${encodeURIComponent(repoSegments.name)}`,
        allowReserve: true,
      })
      .pipe(Effect.mapError(mapCredentialOrRestError));
    const decodedRepo = decodeRepositoryJson(repoResponse.body);
    if (Result.isFailure(decodedRepo) || decodedRepo.success.id <= 0) {
      return yield* failure("failed", "Could not determine the target GitHub repository ID.");
    }
    const permissions = decodedRepo.success.permissions;
    // GitHub App installation tokens may omit `permissions`; otherwise refuse before uploading bytes.
    if (
      permissions !== undefined &&
      permissions.admin !== true &&
      permissions.maintain !== true &&
      permissions.push !== true
    ) {
      return yield* failure(
        "forbidden",
        "Attaching files requires write access to the repository.",
      );
    }

    const credential = yield* credentials.get(host).pipe(Effect.mapError(mapCredentialOrRestError));
    // uploads.github.com rejects chunked bodies ("Bad Content-Length"), and fetch drops the
    // declared length of a stream body, so send the size-capped file as bytes.
    const fileBytes = yield* fileSystem
      .readFile(input.filePath)
      .pipe(
        Effect.mapError((cause) =>
          failure("failed", `Could not read ${sanitizeFileName(input.fileName)}.`, cause),
        ),
      );
    const uploadHost = `uploads.${host}`;
    const initialUrl = new URL(`https://${uploadHost}/user-attachments/assets`);
    initialUrl.searchParams.set("name", resolvedType.uploadName);
    initialUrl.searchParams.set("content_type", resolvedType.contentType);
    initialUrl.searchParams.set("repository_id", String(decodedRepo.success.id));

    const executeUpload = Effect.gen(function* () {
      let targetUrl = initialUrl.toString();
      let method: "POST" | "GET" = "POST";
      for (let hop = 0; ; hop += 1) {
        const parsedTarget = URL.parse(targetUrl);
        if (parsedTarget === null || parsedTarget.protocol !== "https:") {
          return yield* failure("failed", "GitHub returned an invalid upload redirect.");
        }
        const sameUploadHost = parsedTarget.hostname.toLowerCase() === uploadHost;
        const baseRequest =
          method === "POST"
            ? HttpClientRequest.post(targetUrl).pipe(
                HttpClientRequest.setBody(
                  HttpBody.uint8Array(fileBytes, "application/octet-stream"),
                ),
              )
            : HttpClientRequest.get(targetUrl);
        const request = baseRequest.pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            ...(sameUploadHost
              ? { authorization: `Bearer ${Redacted.value(credential.token)}` }
              : {}),
          }),
        );
        const response: HttpClientResponse.HttpClientResponse = yield* httpClient
          .execute(request)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.mapError((cause) =>
              failure("failed", "Failed to send attachment bytes to GitHub.", cause),
            ),
          );
        const location = response.headers.location;
        if (response.status >= 300 && response.status < 400) {
          if (!location || hop >= MAX_REDIRECTS) {
            return yield* failure(
              "failed",
              "GitHub redirected the attachment upload too many times.",
            );
          }
          const next = URL.parse(location, targetUrl);
          if (next === null || next.protocol !== "https:" || next.username || next.password) {
            return yield* failure("failed", "GitHub returned an invalid upload redirect.");
          }
          if (response.status === 301 || response.status === 302 || response.status === 303) {
            method = "GET";
          }
          targetUrl = next.toString();
          continue;
        }
        const collected = yield* collectUint8StreamText({
          stream: response.stream,
          maxBytes: MAX_RESPONSE_BYTES,
        }).pipe(Effect.orElseSucceed(() => ({ text: "", truncated: false, invalidUtf8: false })));
        return { status: response.status, body: collected.text };
      }
    });

    const uploadResult = yield* Effect.scoped(executeUpload);
    if (uploadResult.status === 401) {
      yield* credentials.invalidate(host);
      return yield* failure(
        "unauthenticated",
        `GitHub rejected the credential for ${host}. Run \`gh auth login\` or update your token.`,
      );
    }
    if (uploadResult.status === 403 || uploadResult.status === 404) {
      // GitHub's upload endpoint returns 404 when the token lacks write access to the repository.
      return yield* failure(
        "forbidden",
        "Attaching files requires write access to the repository.",
      );
    }
    if (uploadResult.status === 429) {
      return yield* failure("rate-limited", "GitHub attachment upload rate limit exceeded.");
    }
    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      const apiMessage = Option.getOrUndefined(
        decodeErrorMessageJson(uploadResult.body),
      )?.message?.trim();
      return yield* failure(
        "failed",
        apiMessage && apiMessage.length > 0
          ? `Could not upload ${resolvedType.uploadName}: ${apiMessage}`
          : `Could not upload ${resolvedType.uploadName} (HTTP ${uploadResult.status}).`,
      );
    }

    const decodedAsset = decodeUploadedAssetJson(uploadResult.body);
    if (Result.isFailure(decodedAsset)) {
      return yield* failure("failed", "GitHub returned no asset URL for the uploaded file.");
    }
    const parsedAssetUrl = URL.parse(decodedAsset.success.url);
    if (parsedAssetUrl === null || parsedAssetUrl.protocol !== "https:") {
      return yield* failure("failed", "GitHub returned an invalid asset URL.");
    }

    const assetUrl = parsedAssetUrl.toString();
    if (resolvedType.isVideo) {
      return { url: assetUrl, markdown: assetUrl };
    }
    const rawAlt = input.alt?.trim();
    const escapedAlt = escapeMarkdownAlt(
      rawAlt && rawAlt.length > 0 ? rawAlt : defaultImageAlt(resolvedType.uploadName),
    );
    return {
      url: assetUrl,
      markdown: `![${escapedAlt || "image"}](${assetUrl})`,
    };
  });

  return upload;
});
