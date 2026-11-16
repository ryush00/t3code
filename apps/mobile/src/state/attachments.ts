import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { readEnvironmentScope } from "./session";

function requireAttachmentWriteAccess<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  resolveScope: (input: W) => AuthEnvironmentScope = () => AuthOrchestrationOperateScope,
): AtomCommand<W, A, E | EnvironmentAuthorizationError> {
  return {
    ...command,
    run: async (registry, input) => {
      const requiredScope = resolveScope(input);
      if (!readEnvironmentScope(input.environmentId, requiredScope)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: m(msg("This connection cannot change attachments.")),
              requiredScope,
            }),
          ),
        );
      }
      return command.run(registry, input);
    },
  };
}

const commands = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
export const attachmentEnvironment = {
  createUploadUrl: requireAttachmentWriteAccess(commands.createUploadUrl, (call) =>
    call.input.type === "pull-request"
      ? AuthSourceControlWriteScope
      : AuthOrchestrationOperateScope,
  ),
  remove: requireAttachmentWriteAccess(commands.remove),
};
