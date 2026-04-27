import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { trustService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function trustRoutes(db: Db) {
  const router = Router();
  const svc = trustService(db);

  router.get("/companies/:companyId/trust", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const snapshot = await svc.getCompanyTrust(companyId);
    res.json(snapshot);
  });

  return router;
}
