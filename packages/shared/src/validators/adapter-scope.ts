/**
 * Structured adapter scope/allowlist envelope (NEW 0-B-2, -tne delta).
 *
 * Typed transport for the Overwatch-v3 allowlist envelope. Mirrors the
 * `AdapterExecutionContext["scope"]` field in `@paperclipai/adapter-utils`.
 * V1 is advisory — adapters serialize these fields into their spawn
 * payload; runtime enforcement is V1.1 per the Overwatch-v3 plan.
 */
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const adapterScopeNetworkAccessSchema = z.enum(["none", "localhost", "full"]);

export const adapterScopeSchema = z
  .object({
    allowedTools: z.array(nonEmptyString).optional(),
    allowedPaths: z.array(nonEmptyString).optional(),
    deniedTools: z.array(nonEmptyString).optional(),
    deniedPaths: z.array(nonEmptyString).optional(),
    workingDir: nonEmptyString.optional(),
    networkAccess: adapterScopeNetworkAccessSchema.optional(),
  })
  .strict();

export type AdapterScope = z.infer<typeof adapterScopeSchema>;
export type AdapterScopeNetworkAccess = z.infer<typeof adapterScopeNetworkAccessSchema>;
