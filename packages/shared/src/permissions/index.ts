/**
 * Permissions namespace (NEW 3 V1, -tne delta).
 *
 * Housing for fork-local permission families that do not belong under
 * the upstream `PERMISSION_KEYS` enum. Keeps the autonomy role matrix
 * isolated so it can be retired cleanly if upstream ships a compatible
 * primitive.
 */
export {
  AUTONOMY_ACTIONS,
  resolveBoardTier,
  canPerformAutonomyAction,
  canPromoteAgent,
  canDemoteAgent,
  canEditAllowlist,
  canSetCompanyFloor,
  canAgentProposeOwnPromotion,
  type AutonomyAction,
  type BoardTier,
} from "./autonomy.js";
