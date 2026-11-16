import {
  insertPullRequestUploadPlaceholders,
  makePullRequestUploadPlaceholder,
  removePullRequestUploadPlaceholder,
  replacePullRequestUploadPlaceholder,
  validatePullRequestAttachmentClientFile,
} from "@t3tools/client-runtime/pull-request-attachments";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import {
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type PullRequestRef,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { msg } from "gt-react-native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { m } from "../../i18n/messages";

import * as Dialog from "../../components/ui/Dialog";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { appAtomRegistry } from "../../state/atom-registry";
import { attachmentEnvironment } from "../../state/attachments";
import { composerPullRequests } from "../../state/pull-requests";
import { environmentSession, readEnvironmentScope } from "../../state/session";

interface PickedMobilePullRequestFile {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

function inferExtensionForMimeType(
  mimeType: string,
  assetType?: "image" | "video" | string | null,
): string {
  const lower = mimeType.toLowerCase();
  if (lower === "image/png") return ".png";
  if (lower === "image/jpeg") return ".jpg";
  if (lower === "image/gif") return ".gif";
  if (lower === "image/webp") return ".webp";
  if (lower === "image/svg+xml") return ".svg";
  if (lower === "video/mp4") return ".mp4";
  if (lower === "video/quicktime") return ".mov";
  if (lower === "video/webm") return ".webm";
  return assetType === "video" ? ".mp4" : ".jpg";
}

function inferMimeTypeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

async function resolveAssetSizeBytes(
  uri: string,
  reported: number | null | undefined,
): Promise<number> {
  if (typeof reported === "number" && reported > 0) return reported;
  const { File } = await import("expo-file-system");
  const size = new File(uri).size;
  return typeof size === "number" ? size : Number(size ?? 0);
}

async function pickPullRequestMedia(): Promise<ReadonlyArray<PickedMobilePullRequestFile>> {
  const imagePicker = await import("expo-image-picker");
  const endHandoff = beginForegroundHandoff();
  let result: Awaited<ReturnType<typeof imagePicker.launchImageLibraryAsync>>;
  try {
    result = await imagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      base64: false,
      quality: 1,
      shouldDownloadFromNetwork: true,
    });
  } finally {
    endHandoff();
  }
  if (result.canceled) return [];

  const picked: PickedMobilePullRequestFile[] = [];
  for (const [index, asset] of result.assets.entries()) {
    const rawName = asset.fileName?.trim() ?? "";
    const mimeType =
      asset.mimeType?.trim() ||
      (rawName
        ? inferMimeTypeFromName(rawName)
        : asset.type === "video"
          ? "video/mp4"
          : "image/jpeg");
    const name =
      rawName.length > 0 && rawName.includes(".")
        ? rawName
        : `${asset.type === "video" ? "video" : "photo"}-${index + 1}${inferExtensionForMimeType(mimeType, asset.type)}`;
    const sizeBytes = await resolveAssetSizeBytes(asset.uri, asset.fileSize);
    picked.push({ uri: asset.uri, name, mimeType, sizeBytes });
  }
  return picked;
}

async function pickPullRequestDocuments(
  provider: SourceControlProviderKind | undefined,
): Promise<ReadonlyArray<PickedMobilePullRequestFile>> {
  const { getDocumentAsync } = await import("expo-document-picker");
  const endHandoff = beginForegroundHandoff();
  let result: Awaited<ReturnType<typeof getDocumentAsync>>;
  try {
    result = await getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      ...(provider === "github" ? { type: ["image/*", "video/*"] } : {}),
    });
  } finally {
    endHandoff();
  }
  if (result.canceled) return [];

  const picked: PickedMobilePullRequestFile[] = [];
  for (const asset of result.assets) {
    const name = asset.name.trim() || "attachment";
    const mimeType = asset.mimeType?.trim() || inferMimeTypeFromName(name);
    const sizeBytes = await resolveAssetSizeBytes(asset.uri, asset.size);
    picked.push({ uri: asset.uri, name, mimeType, sizeBytes });
  }
  return picked;
}

async function uploadNativeFile(
  file: PickedMobilePullRequestFile,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  const { File, UploadType } = await import("expo-file-system");
  const result = await new File(file.uri).upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": file.mimeType },
    signal,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upload failed for '${file.name}' (${result.status}).`);
  }
}

async function uploadMobilePullRequestFile(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly file: PickedMobilePullRequestFile;
  readonly signal: AbortSignal;
}) {
  const { environmentId, reference, file, signal } = input;
  if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
    throw new Error("This device isn't allowed to attach files to source control.");
  }

  const cycle = await Effect.runPromise(
    runAttachmentUploadCycle({
      registry: appAtomRegistry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId,
      upload: {
        type: "pull-request",
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      },
      resolveUploadUrl: (relativeUrl) => {
        if (signal.aborted || !readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
          return null;
        }
        const connection = appAtomRegistry.get(
          environmentSession.preparedConnectionValueAtom(environmentId),
        );
        return Option.isNone(connection)
          ? null
          : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
      },
      transport: (url) =>
        Effect.tryPromise({
          try: (transferSignal) => uploadNativeFile(file, url, transferSignal),
          catch: attachmentUploadError,
        }),
    }),
    { signal },
  ).catch(() => {
    throw new Error("Upload cancelled.");
  });

  if (cycle.status !== "uploaded") {
    if (
      cycle.attachmentId !== null &&
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId: cycle.attachmentId,
      });
    }
    throw cycle.error instanceof Error
      ? cycle.error
      : new Error(`Could not upload '${file.name}'.`);
  }

  const uploaded = await runAtomCommand(
    appAtomRegistry,
    composerPullRequests.uploadAttachment,
    {
      environmentId,
      input: {
        ...reference,
        attachmentId: cycle.attachmentId,
        fileName: file.name,
        mimeType: file.mimeType,
      },
    },
    { reportFailure: false },
  );

  if (uploaded._tag !== "Success") {
    if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId: cycle.attachmentId,
      });
    }
    const cause = squashAtomCommandFailure(uploaded);
    throw cause instanceof Error ? cause : new Error("The provider refused the attachment.");
  }

  return uploaded.value;
}

export function usePullRequestAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly provider?: SourceControlProviderKind | undefined;
  readonly value: string;
  readonly updateValue: (updater: (current: string) => string) => void;
  readonly selection?: { readonly start: number; readonly end: number } | null | undefined;
  readonly onPlaceCursor?: ((cursor: number) => void) | undefined;
}) {
  const counterRef = useRef(0);
  const unmountAbortRef = useRef<AbortController | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts in-flight native file uploads held until unmount
  useEffect(
    () => () => {
      unmountAbortRef.current?.abort();
    },
    [],
  );

  const attachPickedFiles = async (files: ReadonlyArray<PickedMobilePullRequestFile>) => {
    if (files.length === 0) return;
    const accepted: Array<{
      readonly file: PickedMobilePullRequestFile;
      readonly placeholder: string;
    }> = [];
    const errors: Array<string> = [];
    for (const file of files) {
      const problem = validatePullRequestAttachmentClientFile(
        { name: file.name, sizeBytes: file.sizeBytes, provider: input.provider },
        m,
      );
      if (problem !== null) {
        errors.push(problem);
        continue;
      }
      accepted.push({
        file,
        placeholder: makePullRequestUploadPlaceholder(file.name, ++counterRef.current),
      });
    }
    if (errors.length > 0) {
      Dialog.alert(m(msg("Could not attach file")), errors.join("\n\n"));
    }
    if (accepted.length === 0) return;

    const selStart = input.selection?.start ?? input.value.length;
    const selEnd = input.selection?.end ?? input.value.length;
    const inserted = insertPullRequestUploadPlaceholders(
      input.value,
      selStart,
      selEnd,
      accepted.map((entry) => entry.placeholder),
    );
    input.updateValue(() => inserted.text);
    input.onPlaceCursor?.(inserted.cursor);

    if (unmountAbortRef.current === null || unmountAbortRef.current.signal.aborted) {
      unmountAbortRef.current = new AbortController();
    }
    const signal = unmountAbortRef.current.signal;
    setUploadingCount((count) => count + accepted.length);

    await Promise.all(
      accepted.map(async ({ file, placeholder }) => {
        const outcome = await settlePromise(() =>
          uploadMobilePullRequestFile({
            environmentId: input.environmentId,
            reference: input.reference,
            file,
            signal,
          }),
        );
        if (signal.aborted) return;
        if (AsyncResult.isSuccess(outcome)) {
          input.updateValue((current) =>
            replacePullRequestUploadPlaceholder(current, placeholder, outcome.value.markdown),
          );
        } else {
          input.updateValue((current) => removePullRequestUploadPlaceholder(current, placeholder));
          const cause = squashAtomCommandFailure(outcome);
          Dialog.alert(
            m(msg("Could not attach file")),
            cause instanceof Error ? cause.message : m(msg("Try again.")),
          );
        }
        setUploadingCount((count) => Math.max(0, count - 1));
      }),
    );
  };

  return {
    uploading: uploadingCount > 0,
    uploadingCount,
    pickMedia: async () => {
      const picked = await settlePromise(() => pickPullRequestMedia());
      if (AsyncResult.isFailure(picked)) {
        const cause = squashAtomCommandFailure(picked);
        Dialog.alert(
          m(msg("Could not open photo library")),
          cause instanceof Error ? cause.message : m(msg("Try again.")),
        );
        return;
      }
      await attachPickedFiles(picked.value);
    },
    pickFiles: async () => {
      const picked = await settlePromise(() => pickPullRequestDocuments(input.provider));
      if (AsyncResult.isFailure(picked)) {
        const cause = squashAtomCommandFailure(picked);
        Dialog.alert(
          m(msg("Could not open file picker")),
          cause instanceof Error ? cause.message : m(msg("Try again.")),
        );
        return;
      }
      await attachPickedFiles(picked.value);
    },
  };
}
