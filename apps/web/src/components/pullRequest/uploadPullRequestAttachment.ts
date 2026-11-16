import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type PullRequestRef,
  type PullRequestUploadAttachmentResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

function uploadBytesOverXhr(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const xhr = new XMLHttpRequest();
  return new Promise<void>((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new Error("Upload cancelled."));
      return;
    }
    input.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload rejected (${xhr.status}).`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed.")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
    xhr.send(input.file);
  });
}

export async function uploadPullRequestAttachment(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly file: File;
  readonly signal?: AbortSignal | undefined;
}): Promise<PullRequestUploadAttachmentResult> {
  const { environmentId, reference, file } = input;
  if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
    throw new Error("This connection isn't allowed to attach files to source control.");
  }
  const fileName = file.name.trim() || "attachment";
  const mimeType = file.type || "application/octet-stream";

  const cycle = await Effect.runPromise(
    runAttachmentUploadCycle({
      registry: appAtomRegistry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId,
      upload: {
        type: "pull-request",
        name: fileName,
        mimeType,
        sizeBytes: file.size,
      },
      resolveUploadUrl: (relativeUrl) => {
        if (
          input.signal?.aborted ||
          !readEnvironmentScope(environmentId, AuthSourceControlWriteScope)
        ) {
          return null;
        }
        const connection = readPreparedConnection(environmentId);
        return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
      },
      transport: (url) =>
        Effect.tryPromise({
          try: (signal) => uploadBytesOverXhr({ url, file, mimeType, signal }),
          catch: attachmentUploadError,
        }),
    }),
    { signal: input.signal },
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
    throw cycle.error instanceof Error ? cycle.error : new Error("Could not upload the file.");
  }

  const uploaded = await runAtomCommand(
    appAtomRegistry,
    pullRequestEnvironment.uploadAttachment,
    {
      environmentId,
      input: {
        ...reference,
        attachmentId: cycle.attachmentId,
        fileName,
        ...(file.type ? { mimeType: file.type } : {}),
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
    throw cause instanceof Error ? cause : new Error("The host refused the attachment.");
  }

  return uploaded.value;
}
