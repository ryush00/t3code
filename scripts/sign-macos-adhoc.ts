import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

interface Packager {
  readonly appInfo: { readonly id: string };
}

// An ad hoc signature's default designated requirement is the build's own cdhash, which
// no later build satisfies, so Squirrel.Mac rejects every update. Pin it to the bundle ID.
export default async function sign(options: SignOptions, packager: Packager): Promise<void> {
  const requirements = `=designated => identifier "${packager.appInfo.id}"`;
  await signApplication({
    ...options,
    identity: "-",
    identityValidation: false,
    optionsForFile: (filePath, context) => ({
      ...options.optionsForFile?.(filePath, context),
      ...(filePath === options.app ? { requirements } : {}),
    }),
  });
}
