// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and stat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import type { OrchestrationV2Notification } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// Native Cortex trajectory step types and statuses in `<sessionId>.db`.
const USER_INPUT_STEP_TYPE = 14;
const PLANNER_RESPONSE_STEP_TYPE = 15;
const ERROR_STEP_TYPE = 17;
const SYSTEM_MESSAGE_STEP_TYPE = 101;

const DONE_STEP_STATUS = 3;
const CANCELED_STEP_STATUS = 6;
const ERROR_STEP_STATUS = 7;
const WAITING_STEP_STATUS = 9;
const INTERRUPTED_STEP_STATUS = 12;

const NATIVE_SESSION_ID = /^[\w-]+$/;
const DEFAULT_POLL_INTERVAL: Duration.Input = "400 millis";
const DEFAULT_SETTLE_GRACE: Duration.Input = "150 millis";
const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

export const ANTIGRAVITY_WAKE_CONTINUATION_PROMPT =
  "<system_note>ACP stream reattached after background wakeup. Continue processing the background notification if you have not finished responding yet; if you already completed your response to it, end your turn immediately without repeating your answer.</system_note>";

const DEFAULT_WAKE_NOTIFICATION: OrchestrationV2Notification = backgroundWorkNotification([
  { kind: "background_task", outcome: "completed" },
]);

const conversationSegments = ["antigravity-acp", "conversations"];

class AntigravityWakeLogError extends Schema.TaggedError<AntigravityWakeLogError>()(
  "AntigravityWakeLogError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity session wake log.";
  }
}

const wakeLogError = (cause: unknown) => new AntigravityWakeLogError({ cause });

interface WakeSnapshot {
  readonly maxIdx: number;
  readonly lastUserInputIdx: number;
  readonly latestWakeIdx: number;
  readonly hasTerminalResponseAfterWake: boolean;
  readonly hasWaitingOrTerminalStepAfterWake: boolean;
}

interface FileFingerprint {
  readonly dbMtimeMs: number;
  readonly dbSize: number;
  readonly dbChangeCounter: number;
  readonly walMtimeMs: number;
  readonly walSize: number;
  readonly walSalt: string;
}

async function readHeaderSlice(
  path: string,
  offset: number,
  length: number,
): Promise<Buffer | undefined> {
  const handle = await NodeFSP.open(path, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function statFingerprint(dbPath: string): Promise<FileFingerprint | undefined> {
  const dbStat = await NodeFSP.stat(dbPath).catch(() => undefined);
  if (dbStat === undefined) return undefined;
  const walPath = `${dbPath}-wal`;
  const [dbCounterBytes, walStat, walSaltBytes] = await Promise.all([
    dbStat.size >= 28 ? readHeaderSlice(dbPath, 24, 4) : Promise.resolve(undefined),
    NodeFSP.stat(walPath).catch(() => undefined),
    readHeaderSlice(walPath, 16, 8),
  ]);
  return {
    dbMtimeMs: dbStat.mtimeMs,
    dbSize: dbStat.size,
    dbChangeCounter: dbCounterBytes?.readUInt32BE(0) ?? -1,
    walMtimeMs: walStat?.mtimeMs ?? -1,
    walSize: walStat?.size ?? -1,
    walSalt: walSaltBytes?.toString("hex") ?? "",
  };
}

function sameFingerprint(
  left: FileFingerprint | undefined,
  right: FileFingerprint | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dbMtimeMs === right.dbMtimeMs &&
    left.dbSize === right.dbSize &&
    left.dbChangeCounter === right.dbChangeCounter &&
    left.walMtimeMs === right.walMtimeMs &&
    left.walSize === right.walSize &&
    left.walSalt === right.walSalt
  );
}

const readWakeSnapshot = (file: string, floorIdx: number) =>
  Effect.try({
    try: (): WakeSnapshot | undefined => {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const columns = database
          .prepare("PRAGMA table_info(steps)")
          .all()
          .flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
        if (!columns.includes("idx") || !columns.includes("step_type")) {
          return undefined;
        }
        const hasStatus = columns.includes("status");
        const maxRow = database.prepare("SELECT max(idx) AS idx FROM steps").get();
        const maxIdx = typeof maxRow?.idx === "number" ? maxRow.idx : -1;
        const userRow = database
          .prepare("SELECT max(idx) AS idx FROM steps WHERE step_type = ?")
          .get(USER_INPUT_STEP_TYPE);
        const lastUserInputIdx = typeof userRow?.idx === "number" ? userRow.idx : -1;
        const wakeRow = database
          .prepare("SELECT max(idx) AS idx FROM steps WHERE idx > ? AND step_type = ?")
          .get(floorIdx, SYSTEM_MESSAGE_STEP_TYPE);
        const latestWakeIdx = typeof wakeRow?.idx === "number" ? wakeRow.idx : -1;
        if (latestWakeIdx <= floorIdx) {
          return {
            maxIdx,
            lastUserInputIdx,
            latestWakeIdx: -1,
            hasTerminalResponseAfterWake: false,
            hasWaitingOrTerminalStepAfterWake: false,
          };
        }
        const hasTerminalResponseAfterWake = hasStatus
          ? database
              .prepare(
                `SELECT 1 FROM steps
                 WHERE idx > ? AND step_type IN (?, ?) AND status IN (?, ?, ?, ?)
                 LIMIT 1`,
              )
              .get(
                latestWakeIdx,
                PLANNER_RESPONSE_STEP_TYPE,
                ERROR_STEP_TYPE,
                DONE_STEP_STATUS,
                CANCELED_STEP_STATUS,
                ERROR_STEP_STATUS,
                INTERRUPTED_STEP_STATUS,
              ) !== undefined
          : database
              .prepare(
                `SELECT 1 FROM steps
                 WHERE idx > ? AND step_type IN (?, ?)
                 LIMIT 1`,
              )
              .get(latestWakeIdx, PLANNER_RESPONSE_STEP_TYPE, ERROR_STEP_TYPE) !== undefined;
        const hasWaitingOrTerminalStepAfterWake = hasStatus
          ? database
              .prepare(
                `SELECT 1 FROM steps
                 WHERE idx > ? AND status IN (?, ?, ?, ?, ?)
                 LIMIT 1`,
              )
              .get(
                latestWakeIdx,
                WAITING_STEP_STATUS,
                DONE_STEP_STATUS,
                CANCELED_STEP_STATUS,
                ERROR_STEP_STATUS,
                INTERRUPTED_STEP_STATUS,
              ) !== undefined
          : hasTerminalResponseAfterWake;
        return {
          maxIdx,
          lastUserInputIdx,
          latestWakeIdx,
          hasTerminalResponseAfterWake,
          hasWaitingOrTerminalStepAfterWake,
        };
      } finally {
        database.close();
      }
    },
    catch: wakeLogError,
  });

export function rewriteAntigravityUserText(
  text: string,
  turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
): Effect.Effect<string> {
  if (
    turnInput.message.createdBy === "agent" &&
    turnInput.message.creationSource === "server" &&
    text === CONTINUATION_MESSAGE_TEXT
  ) {
    return Effect.succeed(ANTIGRAVITY_WAKE_CONTINUATION_PROMPT);
  }
  return Effect.succeed(text);
}

export interface AntigravityWakeWatcherOptions {
  readonly pollInterval?: Duration.Input;
  readonly settleGrace?: Duration.Input;
  readonly onPollWait?: () => Effect.Effect<void>;
  readonly onSettleGraceWait?: () => Effect.Effect<void>;
}

/**
 * `agy acp` 1.5.6+ ends `session/prompt` (`end_turn`) while background commands, timers, and
 * subagents continue in the native trajectory, then writes `SYSTEM_MESSAGE` (`step_type = 101`)
 * into `<sessionId>.db` on wakeup without emitting any ACP frames unless a prompt reattaches.
 */
export function makeAntigravityPostSettleWakeWatcher(
  profileDirectory: string,
  options?: AntigravityWakeWatcherOptions,
) {
  const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const settleGrace = Duration.fromInputUnsafe(options?.settleGrace ?? DEFAULT_SETTLE_GRACE);
  const waitSettleGrace = Duration.isZero(settleGrace)
    ? Effect.void
    : (options?.onSettleGraceWait?.() ?? Effect.void).pipe(
        Effect.andThen(Effect.sleep(settleGrace)),
      );
  const lastOfferedWakeIndexBySession = new Map<string, number>();

  return Effect.fn("AntigravityWakeWatcher.watch")(function* (input: {
    readonly sessionId: string;
    readonly offerWake: (options?: {
      readonly detail?: string | null;
      readonly notification?: OrchestrationV2Notification;
    }) => Effect.Effect<boolean>;
  }) {
    if (!NATIVE_SESSION_ID.test(input.sessionId)) return;
    const segments = [...conversationSegments, `${input.sessionId}.db`];
    const resolveManagedDb = Effect.tryPromise({
      try: async () => {
        const root = await antigravityProfileRoot(profileDirectory);
        if (root === undefined) return undefined;
        if ((await antigravityManagedPath(root, conversationSegments, "directory")) === undefined) {
          return undefined;
        }
        return await antigravityManagedPath(root, segments, "file");
      },
      catch: wakeLogError,
    }).pipe(Effect.orElseSucceed(() => undefined));

    const previousOffered = lastOfferedWakeIndexBySession.get(input.sessionId) ?? -1;
    let baselineIdx = previousOffered;
    let lastFingerprint: FileFingerprint | undefined;

    const initialManaged = yield* resolveManagedDb;
    if (initialManaged !== undefined) {
      lastFingerprint = yield* Effect.tryPromise({
        try: () => statFingerprint(initialManaged.path),
        catch: wakeLogError,
      }).pipe(Effect.orElseSucceed(() => undefined));
      const initial = yield* readWakeSnapshot(initialManaged.path, previousOffered).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (initial !== undefined) {
        const floorIdx = Math.max(previousOffered, initial.lastUserInputIdx);
        if (initial.latestWakeIdx > floorIdx && !initial.hasTerminalResponseAfterWake) {
          if (!initial.hasWaitingOrTerminalStepAfterWake) {
            yield* waitSettleGrace;
          }
          lastOfferedWakeIndexBySession.set(input.sessionId, initial.latestWakeIdx);
          const offered = yield* input.offerWake({ notification: DEFAULT_WAKE_NOTIFICATION });
          if (offered) return;
          baselineIdx = Math.max(floorIdx, initial.latestWakeIdx);
        } else {
          baselineIdx = Math.max(floorIdx, initial.maxIdx);
        }
      }
    }

    while (true) {
      if (options?.onPollWait !== undefined) {
        yield* options.onPollWait();
      }
      yield* Effect.sleep(pollInterval);
      const managed = yield* resolveManagedDb;
      if (managed === undefined) continue;
      const fingerprint = yield* Effect.tryPromise({
        try: () => statFingerprint(managed.path),
        catch: wakeLogError,
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (fingerprint === undefined || sameFingerprint(lastFingerprint, fingerprint)) {
        continue;
      }
      lastFingerprint = fingerprint;
      const snapshot = yield* readWakeSnapshot(managed.path, baselineIdx).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (snapshot === undefined) continue;
      if (snapshot.latestWakeIdx <= baselineIdx) {
        baselineIdx = Math.max(baselineIdx, snapshot.maxIdx);
        continue;
      }
      if (!snapshot.hasWaitingOrTerminalStepAfterWake) {
        yield* waitSettleGrace;
      }
      lastOfferedWakeIndexBySession.set(input.sessionId, snapshot.latestWakeIdx);
      const offered = yield* input.offerWake({ notification: DEFAULT_WAKE_NOTIFICATION });
      if (offered) return;
      baselineIdx = Math.max(baselineIdx, snapshot.latestWakeIdx, snapshot.maxIdx);
    }
  });
}
