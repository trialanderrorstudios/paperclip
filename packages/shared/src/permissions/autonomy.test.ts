import { describe, expect, it } from "vitest";
import {
  resolveBoardTier,
  canPerformAutonomyAction,
  canPromoteAgent,
  canDemoteAgent,
  canEditAllowlist,
  canSetCompanyFloor,
  canAgentProposeOwnPromotion,
} from "./autonomy.js";

describe("autonomy permissions", () => {
  describe("resolveBoardTier", () => {
    it("maps owner → board_owner", () => {
      expect(resolveBoardTier("owner")).toBe("board_owner");
    });

    it("maps admin → board_member", () => {
      expect(resolveBoardTier("admin")).toBe("board_member");
    });

    it("maps operator → board_observer", () => {
      expect(resolveBoardTier("operator")).toBe("board_observer");
    });

    it("maps viewer → board_observer", () => {
      expect(resolveBoardTier("viewer")).toBe("board_observer");
    });

    it("maps member → board_observer", () => {
      expect(resolveBoardTier("member")).toBe("board_observer");
    });

    it("maps null / unknown → board_observer (safe default)", () => {
      expect(resolveBoardTier(null)).toBe("board_observer");
      expect(resolveBoardTier(undefined)).toBe("board_observer");
      expect(resolveBoardTier("weird")).toBe("board_observer");
    });
  });

  describe("canPerformAutonomyAction", () => {
    it("board_owner can perform every action", () => {
      for (const action of ["autonomy.demote", "autonomy.promote", "autonomy.setFloor", "autonomy.editAllowlist"] as const) {
        expect(canPerformAutonomyAction("board_owner", action)).toBe(true);
      }
    });

    it("board_member can perform all but setFloor", () => {
      expect(canPerformAutonomyAction("board_member", "autonomy.demote")).toBe(true);
      expect(canPerformAutonomyAction("board_member", "autonomy.promote")).toBe(true);
      expect(canPerformAutonomyAction("board_member", "autonomy.editAllowlist")).toBe(true);
      expect(canPerformAutonomyAction("board_member", "autonomy.setFloor")).toBe(false);
    });

    it("board_observer cannot perform any action", () => {
      for (const action of ["autonomy.demote", "autonomy.promote", "autonomy.setFloor", "autonomy.editAllowlist"] as const) {
        expect(canPerformAutonomyAction("board_observer", action)).toBe(false);
      }
    });
  });

  describe("canPromoteAgent — CEO asymmetry", () => {
    it("board_member CANNOT promote CEO to autopilot", () => {
      expect(canPromoteAgent("board_member", { isCeoAgent: true, toLevel: "autopilot" })).toBe(false);
    });

    it("board_owner CAN promote CEO to autopilot", () => {
      expect(canPromoteAgent("board_owner", { isCeoAgent: true, toLevel: "autopilot" })).toBe(true);
    });

    it("board_member CAN promote CEO to policy", () => {
      expect(canPromoteAgent("board_member", { isCeoAgent: true, toLevel: "policy" })).toBe(true);
    });

    it("board_member CAN promote non-CEO to autopilot", () => {
      expect(canPromoteAgent("board_member", { isCeoAgent: false, toLevel: "autopilot" })).toBe(true);
    });

    it("board_observer CANNOT promote anyone", () => {
      expect(canPromoteAgent("board_observer", { isCeoAgent: false, toLevel: "policy" })).toBe(false);
      expect(canPromoteAgent("board_observer", { isCeoAgent: true, toLevel: "policy" })).toBe(false);
    });
  });

  describe("canDemoteAgent — CEO safety valve", () => {
    it("board_member CAN demote CEO (safety valve)", () => {
      expect(canDemoteAgent("board_member", { isCeoAgent: true })).toBe(true);
    });

    it("board_owner CAN demote CEO", () => {
      expect(canDemoteAgent("board_owner", { isCeoAgent: true })).toBe(true);
    });

    it("board_observer CANNOT demote anyone", () => {
      expect(canDemoteAgent("board_observer", { isCeoAgent: false })).toBe(false);
      expect(canDemoteAgent("board_observer", { isCeoAgent: true })).toBe(false);
    });

    it("board_member CAN demote non-CEO", () => {
      expect(canDemoteAgent("board_member", { isCeoAgent: false })).toBe(true);
    });
  });

  describe("canEditAllowlist", () => {
    it("board_member CANNOT edit CEO allowlist", () => {
      expect(canEditAllowlist("board_member", { isCeoAgent: true })).toBe(false);
    });

    it("board_owner CAN edit CEO allowlist", () => {
      expect(canEditAllowlist("board_owner", { isCeoAgent: true })).toBe(true);
    });

    it("board_member CAN edit non-CEO allowlist", () => {
      expect(canEditAllowlist("board_member", { isCeoAgent: false })).toBe(true);
    });

    it("board_observer CANNOT edit any allowlist", () => {
      expect(canEditAllowlist("board_observer", { isCeoAgent: false })).toBe(false);
    });
  });

  describe("canSetCompanyFloor", () => {
    it("only board_owner can set company floor", () => {
      expect(canSetCompanyFloor("board_owner")).toBe(true);
      expect(canSetCompanyFloor("board_member")).toBe(false);
      expect(canSetCompanyFloor("board_observer")).toBe(false);
    });
  });

  describe("canAgentProposeOwnPromotion", () => {
    it("agent may propose its own promotion", () => {
      expect(canAgentProposeOwnPromotion({ actorAgentId: "a1", targetAgentId: "a1" })).toBe(true);
    });

    it("agent may NOT propose promotion of another agent", () => {
      expect(canAgentProposeOwnPromotion({ actorAgentId: "a1", targetAgentId: "a2" })).toBe(false);
    });
  });
});
