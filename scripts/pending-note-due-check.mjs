#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_CWD = "/Users/lyrra/MyAPPS/moltbot-2026.1.24";
const STATE_FILE = path.join(os.homedir(), ".clawdbot", "script-only-state.json");

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function sendTelegramMessage(target, message) {
  const args = [
    "clawdbot",
    "message",
    "send",
    "--channel",
    "telegram",
    "--target",
    String(target),
    "--message",
    message,
  ];
  const result = spawnSync("pnpm", args, {
    cwd: REPO_CWD,
    encoding: "utf8",
    timeout: 120000,
  });
  return result.status === 0;
}

function main() {
  const state = loadState();
  const chats = state.telegram || {};
  for (const [chatId, entry] of Object.entries(chats)) {
    const pending = entry?.pending;
    if (!pending || pending.type !== "note-due") continue;
    const title = pending.title || "неуточнена задача";
    const message =
      `Имаш задача без краен срок: "${title}". ` +
      `Моля, напиши краен срок (напр. 06.01.2026 12:00) или "няма краен срок".`;
    sendTelegramMessage(chatId, message);
  }
}

main();
