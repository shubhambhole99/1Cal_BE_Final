// /v3/agents — the agent chat. Mounted in app.js with attachV3User in front,
// BEFORE the /v3 router so "/v3/agents/…" is not swallowed by it.
import express from "express";
import * as ctrl from "../agents/controller.js";

const router = express.Router();

router.get("/", ctrl.listAgents);
router.get("/stats", ctrl.getStats); // before /:key, like /chats

router.get("/usage", ctrl.getUsage);

// The context library — literal, so it is never read as an agent key.
router.get("/contexts", ctrl.listContexts);
router.post("/contexts", ctrl.createContext);
router.get("/contexts/:id", ctrl.getContext);
router.patch("/contexts/:id", ctrl.updateContext);
router.delete("/contexts/:id", ctrl.deleteContext);

// Saved budget presets — literal, so they are never read as an agent key.
router.get("/budgets", ctrl.listBudgets);
router.post("/budgets", ctrl.createBudget);
router.patch("/budgets/:id", ctrl.updateBudget);
router.delete("/budgets/:id", ctrl.deleteBudget);

// Literal /chats routes before /:key so "chats" is never read as an agent key.
router.get("/chats", ctrl.listChats);
router.post("/chats", ctrl.createChat);
router.get("/chats/:id", ctrl.getChat);
router.post("/chats/:id/messages", ctrl.postMessage);

router.get("/:key", ctrl.getAgent);
router.patch("/:key", ctrl.patchAgent);

export default router;
