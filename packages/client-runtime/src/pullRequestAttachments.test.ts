import { describe, expect, it } from "vite-plus/test";

import {
  canAttachToPullRequest,
  insertPullRequestUploadPlaceholders,
  makePullRequestUploadPlaceholder,
  pullRequestAttachmentFileAccept,
  removePullRequestUploadPlaceholder,
  replacePullRequestUploadPlaceholder,
  validatePullRequestAttachmentClientFile,
} from "./pullRequestAttachments.ts";

describe("pullRequestAttachments", () => {
  it("gates attachment capability on provider support and viewer upload permission", () => {
    expect(canAttachToPullRequest(null)).toBe(false);
    expect(canAttachToPullRequest({ capabilities: {} })).toBe(false);
    expect(
      canAttachToPullRequest({
        capabilities: { attachments: true },
        viewerPermissions: { uploadAttachment: false },
      }),
    ).toBe(false);
    expect(
      canAttachToPullRequest({
        capabilities: { attachments: true },
        viewerPermissions: { uploadAttachment: true },
      }),
    ).toBe(true);
    expect(canAttachToPullRequest({ capabilities: { attachments: true } })).toBe(true);
    expect(pullRequestAttachmentFileAccept("github")).toContain(".mp4");
    expect(pullRequestAttachmentFileAccept("gitlab")).toBeUndefined();
  });

  it("validates GitHub image/video extensions and sizes while allowing arbitrary GitLab files up to 100 MB", () => {
    expect(
      validatePullRequestAttachmentClientFile({
        name: "empty.png",
        sizeBytes: 0,
        provider: "github",
      }),
    ).toBe("'empty.png' is empty.");
    expect(
      validatePullRequestAttachmentClientFile({
        name: "shot.png",
        sizeBytes: 11 * 1024 * 1024,
        provider: "github",
      }),
    ).toBe("'shot.png' exceeds the 10 MB attachment limit.");
    expect(
      validatePullRequestAttachmentClientFile({
        name: "demo.mp4",
        sizeBytes: 25 * 1024 * 1024,
        provider: "github",
      }),
    ).toBeNull();
    expect(
      validatePullRequestAttachmentClientFile({
        name: "trace.zip",
        sizeBytes: 1024,
        provider: "github",
      }),
    ).toContain("not supported on GitHub");
    expect(
      validatePullRequestAttachmentClientFile({
        name: "trace.zip",
        sizeBytes: 25 * 1024 * 1024,
        provider: "gitlab",
      }),
    ).toBeNull();
  });

  it("inserts placeholders on their own lines, promotes bare video URLs to paragraphs, and cleans up failed uploads", () => {
    const p1 = makePullRequestUploadPlaceholder("shot.png", 1);
    const p2 = makePullRequestUploadPlaceholder("demo.mp4", 2);

    const inserted = insertPullRequestUploadPlaceholders("Before", 6, 6, [p1, p2]);
    expect(inserted.text).toBe(`Before\n${p1}\n${p2}`);

    const withTypedAfter = `${inserted.text}\nAfter`;
    const afterImage = replacePullRequestUploadPlaceholder(
      withTypedAfter,
      p1,
      "![shot](https://uploads.github.com/user-attachments/assets/1)",
    );
    const afterVideo = replacePullRequestUploadPlaceholder(
      afterImage,
      p2,
      "https://uploads.github.com/user-attachments/assets/2",
    );
    expect(afterVideo).toBe(
      "Before\n![shot](https://uploads.github.com/user-attachments/assets/1)\n\nhttps://uploads.github.com/user-attachments/assets/2\n\nAfter",
    );

    const removed = removePullRequestUploadPlaceholder(`Line 1\n${p1}\nLine 2`, p1);
    expect(removed).toBe("Line 1\nLine 2");
  });
});
