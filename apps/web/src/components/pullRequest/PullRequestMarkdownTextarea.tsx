import {
  canAttachToPullRequest,
  insertPullRequestUploadPlaceholders,
  makePullRequestUploadPlaceholder,
  pullRequestAttachmentFileAccept,
  removePullRequestUploadPlaceholder,
  replacePullRequestUploadPlaceholder,
  validatePullRequestAttachmentClientFile,
} from "@t3tools/client-runtime/pull-request-attachments";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
  type PullRequestDetailView,
  type PullRequestRef,
  type PullRequestReferenceCandidate,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  debouncedPullRequestCompletionSearch,
  detectPullRequestComposerTrigger,
  insertPullRequestCompletion,
  pullRequestCompletionKey,
  pullRequestCompletions,
  type PullRequestCompletion,
  type PullRequestCompletionSupport,
  type PullRequestComposerTrigger,
} from "@t3tools/shared/pullRequestComposerTrigger";
import { CircleCheckIcon, CircleDotIcon, Loader2Icon, PaperclipIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { usePullRequestFilterOptions } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentScope } from "~/state/session";

import { Popover, PopoverPopup } from "../ui/popover";
import { Textarea, type TextareaProps } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { PULL_REQUEST_STATE_PRESENTATION } from "./pullRequestIcons";
import { PullRequestActorAvatar, resolvePullRequestState } from "./pullRequestPresentation";
import { uploadPullRequestAttachment } from "./uploadPullRequestAttachment";

export interface PullRequestAttachmentScope {
  readonly reference: PullRequestRef;
  readonly provider?: SourceControlProviderKind | undefined;
}

/** The repository whose users `@` completes, whose issues/PRs `#` does, and where files upload. */
export interface PullRequestCompletionScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly support: PullRequestCompletionSupport;
  readonly attachment?: PullRequestAttachmentScope | null | undefined;
}

/** Null on hosts that neither complete references nor accept attachments. */
export function pullRequestCompletionScope(
  detail: Pick<PullRequestDetailView, "capabilities"> &
    Partial<Pick<PullRequestDetailView, "provider" | "viewerPermissions">>,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): PullRequestCompletionScope | null {
  const { mentions, referenceSigils } = detail.capabilities;
  const canAttach = canAttachToPullRequest(detail);
  return mentions === true || (referenceSigils?.length ?? 0) > 0 || canAttach
    ? {
        environmentId,
        projectId: reference.projectId,
        support: { mentions, referenceSigils },
        attachment: canAttach
          ? {
              reference,
              ...(detail.provider === undefined ? {} : { provider: detail.provider }),
            }
          : null,
      }
    : null;
}

// About a full list of suggestions. The popup fits itself to the space it opens into, so it never
// flips once results grow it; the side is picked up front from the room a full list needs.
const SUGGESTION_LIST_HEIGHT = 320;

function suggestionSide(target: HTMLTextAreaElement): "top" | "bottom" {
  const rect = target.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom;
  return below < SUGGESTION_LIST_HEIGHT && rect.top > below ? "top" : "bottom";
}

const COMPLETION_SEARCH_DEBOUNCE_MS = 200;
const COMPLETION_SUGGESTION_LIMIT = 8;

function useCompletions(
  scope: PullRequestCompletionScope | null,
  trigger: PullRequestComposerTrigger | null,
) {
  const key = pullRequestCompletionKey(trigger);
  const sentKey = useDebouncedValue(key, COMPLETION_SEARCH_DEBOUNCE_MS);
  const sent =
    trigger === null ? undefined : debouncedPullRequestCompletionSearch(trigger, sentKey);
  const hosted = usePullRequestFilterOptions(
    scope === null || trigger === null
      ? []
      : [
          {
            environmentId: scope.environmentId,
            input:
              trigger.kind === "mention"
                ? { kind: "authors", projectId: scope.projectId, ...(sent ? { query: sent } : {}) }
                : {
                    kind: "references",
                    projectId: scope.projectId,
                    sigil: trigger.sigil,
                    ...(sent ? { query: sent } : {}),
                  },
          },
        ],
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const completions = pullRequestCompletions(trigger, hosted, COMPLETION_SUGGESTION_LIMIT);
  return {
    completions,
    isPending: hosted.isPending || sentKey !== key,
    failed: hosted.error !== null,
  };
}

function ReferenceStateIcon({ candidate }: { candidate: PullRequestReferenceCandidate }) {
  const presentation =
    candidate.kind === "change-request"
      ? resolvePullRequestState({ state: candidate.state, isDraft: false })
      : candidate.state === "open"
        ? {
            label: "Open issue",
            Icon: CircleDotIcon,
            toneClassName: PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
          }
        : {
            label: "Closed issue",
            Icon: CircleCheckIcon,
            toneClassName: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
          };
  return (
    <presentation.Icon
      role="img"
      aria-label={presentation.label}
      className={cn("size-4 shrink-0", presentation.toneClassName)}
    />
  );
}

function CompletionRow({ completion }: { completion: PullRequestCompletion }) {
  if (completion.kind === "mention") {
    const { actor } = completion;
    return (
      <>
        <PullRequestActorAvatar actor={actor} className="size-5" />
        <span className="truncate font-medium">{actor.login}</span>
        {actor.name && actor.name !== actor.login ? (
          <span className="min-w-0 truncate text-muted-foreground">{actor.name}</span>
        ) : null}
      </>
    );
  }
  const { candidate } = completion;
  return (
    <>
      <ReferenceStateIcon candidate={candidate} />
      <span className="shrink-0 font-medium tabular-nums">{candidate.reference}</span>
      <span className="min-w-0 truncate text-muted-foreground">{candidate.title}</span>
    </>
  );
}

const EMPTY_STATE = {
  mention: {
    label: "Mention a user",
    pending: "Searching users...",
    failed: "Couldn't search users on the host",
    none: "No matching users",
  },
  reference: {
    label: "Reference an issue or change request",
    pending: "Searching...",
    failed: "Couldn't search the host",
    none: "No matching issues or change requests",
  },
} as const;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/** A markdown textarea for pull request text that completes `@login`, `#123`, `!123`, and uploads attachments. */
export function PullRequestMarkdownTextarea({
  ref,
  value,
  onValueChange,
  completionScope,
  className,
  onKeyDown,
  onSelect,
  onFocus,
  onBlur,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  ...props
}: Omit<TextareaProps, "value" | "onChange"> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly completionScope: PullRequestCompletionScope | null;
}) {
  const listId = useId();
  const [element, setElement] = useState<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const latestValueRef = useRef(value);
  const uploadCounterRef = useRef(0);
  const unmountAbortRef = useRef<AbortController | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);

  const [caret, setCaret] = useState<number | null>(null);
  const [side, setSide] = useState<"top" | "bottom">("bottom");
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState({ query: "", index: 0 });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts in-flight XHR uploads held until unmount
  useEffect(
    () => () => {
      unmountAbortRef.current?.abort();
    },
    [],
  );

  const canWriteSourceControl = useEnvironmentScope(
    completionScope?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const attachmentScope = completionScope?.attachment ?? null;
  const showAttachControl = attachmentScope !== null && canWriteSourceControl;
  const canAttachNow = showAttachControl && !props.disabled && !props.readOnly;
  const hasCompletionSupport =
    completionScope !== null &&
    (completionScope.support.mentions === true ||
      (completionScope.support.referenceSigils?.length ?? 0) > 0);

  const trigger =
    !hasCompletionSupport || completionScope === null || caret === null || props.readOnly
      ? null
      : detectPullRequestComposerTrigger(value, caret, completionScope.support);
  const open = trigger !== null && trigger.rangeStart !== dismissedAt;
  const {
    completions: candidates,
    isPending,
    failed,
  } = useCompletions(hasCompletionSupport ? completionScope : null, open ? trigger : null);
  const activeIndex =
    trigger !== null && highlight.query === trigger.query
      ? Math.min(highlight.index, Math.max(0, candidates.length - 1))
      : 0;
  const active = open ? candidates[activeIndex] : undefined;
  const optionId = (token: string) => `${listId}-${token}`;

  const syncCaret = (target: HTMLTextAreaElement) => {
    setSide(suggestionSide(target));
    setCaret(target.selectionStart === target.selectionEnd ? target.selectionStart : null);
  };

  const select = (completion: PullRequestCompletion) => {
    if (trigger === null || element === null) return;
    const next = insertPullRequestCompletion(value, trigger, completion.token);
    latestValueRef.current = next.text;
    flushSync(() => onValueChange(next.text));
    element.setSelectionRange(next.cursor, next.cursor);
    setCaret(next.cursor);
  };

  const attachFiles = async (rawFiles: ReadonlyArray<File>) => {
    if (
      !canAttachNow ||
      completionScope === null ||
      attachmentScope === null ||
      rawFiles.length === 0
    ) {
      return;
    }
    const accepted: Array<{ readonly file: File; readonly placeholder: string }> = [];
    for (const file of rawFiles) {
      const validationError = validatePullRequestAttachmentClientFile({
        name: file.name,
        sizeBytes: file.size,
        provider: attachmentScope.provider,
      });
      if (validationError !== null) {
        toastManager.add({ type: "error", title: validationError });
        continue;
      }
      const placeholder = makePullRequestUploadPlaceholder(
        file.name || "attachment",
        ++uploadCounterRef.current,
      );
      accepted.push({ file, placeholder });
    }
    if (accepted.length === 0) return;

    const currentText = element?.value ?? value;
    const selectionStart = element?.selectionStart ?? currentText.length;
    const selectionEnd = element?.selectionEnd ?? currentText.length;
    const inserted = insertPullRequestUploadPlaceholders(
      currentText,
      selectionStart,
      selectionEnd,
      accepted.map((item) => item.placeholder),
    );
    latestValueRef.current = inserted.text;
    flushSync(() => onValueChange(inserted.text));
    element?.setSelectionRange(inserted.cursor, inserted.cursor);

    if (unmountAbortRef.current === null || unmountAbortRef.current.signal.aborted) {
      unmountAbortRef.current = new AbortController();
    }
    const signal = unmountAbortRef.current.signal;
    setUploadingCount((count) => count + accepted.length);

    await Promise.all(
      accepted.map(async ({ file, placeholder }) => {
        const outcome = await settlePromise(() =>
          uploadPullRequestAttachment({
            environmentId: completionScope.environmentId,
            reference: attachmentScope.reference,
            file,
            signal,
          }),
        );
        if (signal.aborted) return;
        const base = element?.value ?? latestValueRef.current;
        if (AsyncResult.isSuccess(outcome)) {
          const next = replacePullRequestUploadPlaceholder(
            base,
            placeholder,
            outcome.value.markdown,
          );
          latestValueRef.current = next;
          flushSync(() => onValueChange(next));
        } else {
          const next = removePullRequestUploadPlaceholder(base, placeholder);
          latestValueRef.current = next;
          flushSync(() => onValueChange(next));
          const cause = squashAtomCommandFailure(outcome);
          toastManager.add({
            type: "error",
            title: cause instanceof Error ? cause.message : "Could not attach file",
          });
        }
        setUploadingCount((count) => Math.max(0, count - 1));
      }),
    );
  };

  return (
    <>
      <Textarea
        {...props}
        className={className}
        ref={(node) => {
          setElement(node);
          assignRef(ref, node);
        }}
        value={value}
        role={hasCompletionSupport ? "combobox" : undefined}
        aria-autocomplete={hasCompletionSupport ? "list" : undefined}
        aria-expanded={hasCompletionSupport ? open : undefined}
        aria-controls={open && candidates.length > 0 ? listId : undefined}
        aria-activedescendant={active ? optionId(active.token) : undefined}
        onChange={(event) => {
          latestValueRef.current = event.target.value;
          onValueChange(event.target.value);
          syncCaret(event.target);
          setDismissedAt(null);
        }}
        onSelect={(event) => {
          syncCaret(event.currentTarget);
          onSelect?.(event);
        }}
        onFocus={(event) => {
          syncCaret(event.currentTarget);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setCaret(null);
          onBlur?.(event);
        }}
        onPaste={(event) => {
          if (canAttachNow && event.clipboardData) {
            const pasted = Array.from(event.clipboardData.files);
            const hasImage = pasted.some((file) => file.type.startsWith("image/"));
            if (
              pasted.length > 0 &&
              (hasImage || event.clipboardData.getData("text/plain") === "")
            ) {
              event.preventDefault();
              void attachFiles(pasted);
              return;
            }
          }
          onPaste?.(event);
        }}
        onDragOver={(event) => {
          if (canAttachNow && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
          }
          onDragOver?.(event);
        }}
        onDragLeave={onDragLeave}
        onDrop={(event) => {
          if (canAttachNow && event.dataTransfer.files.length > 0) {
            event.preventDefault();
            void attachFiles(Array.from(event.dataTransfer.files));
            return;
          }
          onDrop?.(event);
        }}
        onKeyDown={(event) => {
          // Some IMEs confirm a composition with an Enter that reports keyCode 229 but not isComposing.
          if (open && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            const handled = (() => {
              if (event.key === "Escape") {
                setDismissedAt(trigger.rangeStart);
                return true;
              }
              if (candidates.length === 0) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlight({
                  query: trigger.query,
                  index: (activeIndex + step + candidates.length) % candidates.length,
                });
                return true;
              }
              const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
              if ((event.key === "Enter" || event.key === "Tab") && plain && active) {
                select(active);
                return true;
              }
              return false;
            })();
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
          if (
            uploadingCount > 0 &&
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            toastManager.add({
              type: "info",
              title: "Wait for file uploads to finish before submitting.",
            });
            return;
          }
          onKeyDown?.(event);
        }}
      />
      {showAttachControl ? (
        <div className="mt-1 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={pullRequestAttachmentFileAccept(attachmentScope.provider)}
            className="sr-only"
            tabIndex={-1}
            aria-label="Attach files to Markdown"
            onChange={(event) => {
              const selected = event.currentTarget.files
                ? Array.from(event.currentTarget.files)
                : [];
              event.currentTarget.value = "";
              if (selected.length > 0) {
                void attachFiles(selected);
              }
            }}
          />
          <button
            type="button"
            disabled={!canAttachNow}
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {uploadingCount > 0 ? (
              <>
                <Loader2Icon className="size-3 animate-spin" />
                <span>
                  {uploadingCount === 1 ? "Uploading file…" : `Uploading ${uploadingCount} files…`}
                </span>
              </>
            ) : (
              <>
                <PaperclipIcon className="size-3" />
                <span>Attach, paste, or drop files</span>
              </>
            )}
          </button>
        </div>
      ) : null}
      <Popover
        open={open}
        modal={false}
        onOpenChange={(next, details) => {
          if (next || details.event?.target === element) return;
          if (trigger !== null) setDismissedAt(trigger.rangeStart);
        }}
      >
        <PopoverPopup
          anchor={element}
          side={side}
          align="start"
          padding="compact"
          width={trigger?.kind === "reference" ? "md" : "sm"}
          initialFocus={false}
          finalFocus={false}
        >
          {candidates.length > 0 ? (
            <div
              id={listId}
              role="listbox"
              aria-label={EMPTY_STATE[trigger?.kind ?? "mention"].label}
              className="-mx-1.5"
            >
              {candidates.map((completion, index) => (
                <div
                  key={completion.token}
                  id={optionId(completion.token)}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    index === activeIndex && "bg-accent text-accent-foreground",
                  )}
                  onMouseMove={() => {
                    if (index !== activeIndex) setHighlight({ query: trigger?.query ?? "", index });
                  }}
                  // Keeps focus, and the caret, in the textarea.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(completion)}
                >
                  <CompletionRow completion={completion} />
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              {
                EMPTY_STATE[trigger?.kind ?? "mention"][
                  isPending ? "pending" : failed ? "failed" : "none"
                ]
              }
            </p>
          )}
        </PopoverPopup>
      </Popover>
    </>
  );
}
