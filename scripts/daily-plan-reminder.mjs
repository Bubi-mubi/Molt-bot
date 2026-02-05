#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_CWD = "/Users/lyrra/MyAPPS/moltbot-2026.1.24";
const STATE_FILE = path.join(os.homedir(), ".clawdbot", "reminders.json");
const SCRIPT_STATE_FILE = path.join(os.homedir(), ".clawdbot", "script-only-state.json");
const ENV_FILE = path.join(os.homedir(), ".clawdbot", "telegram-reminders.env");

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { reminders: [] };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { reminders: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

function loadScriptState() {
  try {
    if (!fs.existsSync(SCRIPT_STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(SCRIPT_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveScriptState(state) {
  fs.mkdirSync(path.dirname(SCRIPT_STATE_FILE), { recursive: true });
  fs.writeFileSync(SCRIPT_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function setDailyPlanPending() {
  const env = parseEnvFile(ENV_FILE);
  const target = env.TELEGRAM_TARGET;
  if (!target) return;
  const state = loadScriptState();
  state.telegram ||= {};
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);
  state.telegram[String(target)] ||= {};
  if (!state.telegram[String(target)].pending) {
    state.telegram[String(target)].pending = { type: "daily-plan", date };
  }
  saveScriptState(state);
}

function clearDailyPlan(state) {
  state.reminders = (state.reminders || []).filter((r) => r.group !== "daily-plan");
}

function addReminder() {
  const scriptPath = path.join(REPO_CWD, "scripts", "telegram-reminders.mjs");
  const args = [
    scriptPath,
    "--mode",
    "add",
    "--text",
    "Напомняне: време е да направиш график за утре. Напиши задачите си.",
    "--at",
    "21:00",
    "--repeat-min",
    "10",
    "--group",
    "daily-plan",
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_CWD,
    encoding: "utf8",
    timeout: 120000,
  });
  return result.status === 0;
}

function main() {
  const state = loadState();
  clearDailyPlan(state);
  saveState(state);
  addReminder();
  setDailyPlanPending();
}

main();
