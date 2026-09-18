// /v3/agents — the agent chat. Mounted in app.js with attachV3User in front,
// BEFORE the /v3 router so "/v3/agents/…" is not swallowed by it.
import express from "express";
import * as ctrl from "../agents/controller.js";

const router = express.Router();

router.get("/", ctrl.listAgents);
router.get("/stats", ctrl.getStats); // before /:key, like /chats

// Literal /chats routes before /:key so "chats" is never read as an agent key.
router.get("/chats", ctrl.listChats);
router.post("/chats", ctrl.createChat);
router.get("/chats/:id", ctrl.getChat);
router.post("/chats/:id/messages", ctrl.postMessage);

router.get("/:key", ctrl.getAgent);

export default router;
