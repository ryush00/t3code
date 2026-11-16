import {
  PULL_REQUEST_ATTACHMENT_MAX_BYTES,
  type PullRequestCapabilities,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";

import { fileAttachmentTooLargeMessage } from "./state/attachments.ts";

const GITHUB_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const GITHUB_VIDEO_MAX_BYTES = PULL_REQUEST_ATTACHMENT_MAX_BYTES;

const GITHUB_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const GITHUB_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);

const GITHUB_PULL_REQUEST_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.mov,.webm,image/png,image/jpeg,image/gif,image/webp,image/svg+xml,video/mp4,video/quicktime,video/webm";

export function canAttachToPullRequest(
  detail:
    | {
        readonly capabilities: Pick<PullRequestCapabilities, "attachments">;
        readonly viewerPermissions?:
          | Pick<PullRequestViewerPermissions, "uploadAttachment">
          | undefined;
      }
    | null
    | undefined,
): boolean {
  return Boolean(
    detail &&
    detail.capabilities.attachments === true &&
    detail.viewerPermissions?.uploadAttachment !== false,
  );
}

export function pullRequestAttachmentFileAccept(provider: string | undefined): string | undefined {
  return provider === "github" ? GITHUB_PULL_REQUEST_FILE_ACCEPT : undefined;
}

function fileExtensionLower(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function validatePullRequestAttachmentClientFile(input: {
  readonly name: string;
  readonly sizeBytes: number;
  readonly provider?: string | undefined;
}): string | null {
  const displayName = input.name.trim() || "attachment";
  if (input.sizeBytes <= 0) {
    return `'${displayName}' is empty.`;
  }
  if (input.provider === "github") {
    const ext = fileExtensionLower(displayName);
    if (GITHUB_IMAGE_EXTENSIONS.has(ext)) {
      return input.sizeBytes > GITHUB_IMAGE_MAX_BYTES
        ? fileAttachmentTooLargeMessage(displayName, GITHUB_IMAGE_MAX_BYTES)
        : null;
    }
    if (GITHUB_VIDEO_EXTENSIONS.has(ext)) {
      return input.sizeBytes > GITHUB_VIDEO_MAX_BYTES
        ? fileAttachmentTooLargeMessage(displayName, GITHUB_VIDEO_MAX_BYTES)
        : null;
    }
    return `'${displayName}' is not supported on GitHub. Attach PNG, JPEG, GIF, WebP, SVG, MP4, MOV, or WebM files.`;
  }
  if (input.sizeBytes > PULL_REQUEST_ATTACHMENT_MAX_BYTES) {
    return fileAttachmentTooLargeMessage(displayName, PULL_REQUEST_ATTACHMENT_MAX_BYTES);
  }
  return null;
}

export function makePullRequestUploadPlaceholder(name: string, token: string | number): string {
  const sanitized = (name.trim() || "attachment")
    .replace(/[\r\n]+/gu, " ")
    .replace(/--!?>/gu, "--");
  return `<!-- Uploading "${sanitized}" (${token}) -->`;
}

export function insertPullRequestUploadPlaceholders(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  placeholders: ReadonlyArray<string>,
): { readonly text: string; readonly cursor: number } {
  if (placeholders.length === 0) {
    const clamped = Math.max(0, Math.min(selectionEnd, text.length));
    return { text, cursor: clamped };
  }
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const suffix = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
  const block = placeholders.join("\n");
  const next = `${before}${prefix}${block}${suffix}${after}`;
  const cursor = before.length + prefix.length + block.length;
  return { text: next, cursor };
}

function isBareAttachmentUrl(markdown: string): boolean {
  return /^https?:\/\/\S+$/u.test(markdown.trim());
}

export function replacePullRequestUploadPlaceholder(
  text: string,
  placeholder: string,
  markdown: string,
): string {
  const trimmedMarkdown = markdown.trim();
  const bareUrl = isBareAttachmentUrl(trimmedMarkdown);
  const index = text.indexOf(placeholder);
  if (index === -1) {
    if (text.length === 0) return trimmedMarkdown;
    const separator = bareUrl
      ? text.endsWith("\n\n")
        ? ""
        : text.endsWith("\n")
          ? "\n"
          : "\n\n"
      : text.endsWith("\n")
        ? ""
        : "\n";
    return `${text}${separator}${trimmedMarkdown}`;
  }
  const before = text.slice(0, index);
  const after = text.slice(index + placeholder.length);
  if (!bareUrl) {
    return `${before}${trimmedMarkdown}${after}`;
  }
  const leading =
    before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trailing =
    after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${before}${leading}${trimmedMarkdown}${trailing}${after}`;
}

export function removePullRequestUploadPlaceholder(text: string, placeholder: string): string {
  const index = text.indexOf(placeholder);
  if (index === -1) return text;
  const before = text.slice(0, index);
  const after = text.slice(index + placeholder.length);
  if (before.endsWith("\n") && after.startsWith("\n")) {
    return `${before}${after.slice(1)}`;
  }
  if (before.length === 0 && after.startsWith("\n")) {
    return after.slice(1);
  }
  if (after.length === 0 && before.endsWith("\n")) {
    return before.slice(0, -1);
  }
  return `${before}${after}`;
}
