import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2Notification } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  ANTIGRAVITY_WAKE_CONTINUATION_PROMPT,
  makeAntigravityPostSettleWakeWatcher,
  rewriteAntigravityUserText,
} from "./AntigravityWakeWatcher.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const SYSTEM_MESSAGE = 101;

const DONE_STATUS = 3;
const WAITING_STATUS = 9;

describe("AntigravityWakeWatcher", () => {
  it.effect(
    "ignores answered mid-turn wakes, honors settle grace on post-settle wakes, and deduplicates",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
        const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
        yield* fs.makeDirectory(conversations, { recursive: true });
        const dbPath = path.join(conversations, `${sessionId}.db`);

        let nextIndex = 0;
        const appendSteps = (steps: ReadonlyArray<readonly [number, number]>) => {
          const database = new NodeSqlite.DatabaseSync(dbPath);
          try {
            database.exec(
              "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)",
            );
            const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?)");
            for (const [stepType, status] of steps) {
              insert.run(nextIndex++, stepType, status);
            }
          } finally {
            database.close();
          }
        };

        // Turn 1 contained a mid-turn wake that was already answered before `end_turn`.
        appendSteps([
          [USER_INPUT, DONE_STATUS],
          [SYSTEM_MESSAGE, DONE_STATUS],
          [PLANNER_RESPONSE, DONE_STATUS],
        ]);

        const pollWaiting = yield* Queue.unbounded<void>();
        const graceWaiting = yield* Queue.unbounded<void>();
        const notifications: Array<OrchestrationV2Notification | undefined> = [];
        const firstWake = yield* Deferred.make<OrchestrationV2Notification | undefined>();

        const watch = makeAntigravityPostSettleWakeWatcher(profileDirectory, {
          pollInterval: "400 millis",
          settleGrace: "150 millis",
          onPollWait: () => Queue.offer(pollWaiting, undefined).pipe(Effect.asVoid),
          onSettleGraceWait: () => Queue.offer(graceWaiting, undefined).pipe(Effect.asVoid),
        });

        const firstFiber = yield* Effect.forkScoped(
          watch({
            sessionId,
            offerWake: (options) =>
              Effect.sync(() => {
                notifications.push(options?.notification);
              }).pipe(
                Effect.andThen(Deferred.succeed(firstWake, options?.notification)),
                Effect.as(true),
              ),
          }),
        );

        yield* Queue.take(pollWaiting);
        assert.lengthOf(notifications, 0);

        // Now a detached background command completes after `end_turn` and writes step_type = 101.
        appendSteps([[SYSTEM_MESSAGE, DONE_STATUS]]);
        yield* TestClock.adjust("400 millis");
        yield* Queue.take(graceWaiting);
        assert.lengthOf(notifications, 0);

        yield* TestClock.adjust("150 millis");
        const notification = yield* Deferred.await(firstWake);
        yield* Fiber.join(firstFiber);
        assert.deepEqual(notification, {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: "Background task finished",
        });

        // Restarting the watcher after the continuation turn without a newer wake must not re-offer it.
        const secondFiber = yield* Effect.forkScoped(
          watch({
            sessionId,
            offerWake: (options) =>
              Effect.sync(() => {
                notifications.push(options?.notification);
                return true;
              }),
          }),
        );
        yield* Queue.take(pollWaiting);
        assert.lengthOf(notifications, 1);
        yield* Fiber.interrupt(secondFiber);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("wakes immediately when a boundary wake stalled on tool confirmation (WAITING)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const sessionId = "0d9c2b4e-1111-4222-8333-944455556666";
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
      try {
        database.exec(
          "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)",
        );
        database.exec(
          `INSERT INTO steps VALUES
            (0, ${USER_INPUT}, ${DONE_STATUS}),
            (1, ${PLANNER_RESPONSE}, ${DONE_STATUS}),
            (2, ${SYSTEM_MESSAGE}, ${DONE_STATUS}),
            (3, ${PLANNER_RESPONSE}, ${WAITING_STATUS})`,
        );
      } finally {
        database.close();
      }

      const watch = makeAntigravityPostSettleWakeWatcher(profileDirectory, {
        pollInterval: "10 seconds",
        settleGrace: "10 seconds",
      });
      let offered = 0;
      yield* watch({
        sessionId,
        offerWake: () =>
          Effect.sync(() => {
            offered += 1;
            return true;
          }),
      });
      assert.equal(offered, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rewrites only server-authored continuation messages into the non-duplicating prompt",
    () =>
      Effect.gen(function* () {
        const serverTurn = {
          message: { createdBy: "agent", creationSource: "server" },
        } as ProviderAdapter.ProviderAdapterV2TurnInput;
        const userTurn = {
          message: { createdBy: "user", creationSource: "web" },
        } as ProviderAdapter.ProviderAdapterV2TurnInput;

        assert.equal(
          yield* rewriteAntigravityUserText("Background task completed.", serverTurn),
          ANTIGRAVITY_WAKE_CONTINUATION_PROMPT,
        );
        assert.equal(
          yield* rewriteAntigravityUserText("Background task completed.", userTurn),
          "Background task completed.",
        );
      }),
  );
});
