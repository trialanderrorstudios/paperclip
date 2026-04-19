import type { CompanyStatus, PauseReason } from "../constants.js";
import type { AutonomyPolicy } from "./autonomy.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  /**
   * NEW 3 V1 (-tne): per-company autonomy floor. Empty object is the
   * default; server reads a compat shim from
   * `requireBoardApprovalForNewAgents` when empty.
   *
   * Optional on the TypeScript type to keep existing Company fixtures
   * (pre-migration tests, CLI test mocks) compiling. Server always
   * returns a value because the migration's NOT NULL DEFAULT '{}'
   * guarantees presence at the DB level.
   */
  autonomyPolicy?: AutonomyPolicy | Record<string, never>;
  createdAt: Date;
  updatedAt: Date;
}
