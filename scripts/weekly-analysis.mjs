#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_CWD = "/Users/lyrra/MyAPPS/moltbot-2026.1.24";
const LOG_FILE = path.join(os.homedir(), ".clawdbot", "daily-log.json");
const ENV_FILE = path.join(os.homedir(), ".clawdbot", "telegram-reminders.env");
const NOTION_SCHEDULE_SCRIPT = path.join(REPO_CWD, "scripts", "notion-schedule.mjs");

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

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
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

function buildSummary(entries) {
  let scheduled = 0;
  let deviations = 0;
  const lines = [];
  for (const [date, info] of entries) {
    const s = info.schedule?.length || 0;
    const d = info.deviations?.length || 0;
    scheduled += s;
    deviations += d;
    lines.push(`${date}: планирани ${s}, отклонения ${d}`);
    if (info.deviations?.length) {
      for (const item of info.deviations.slice(0, 5)) {
        lines.push(`  - ${item}`);
      }
    }
  }
  lines.push(`Общо планирани: ${scheduled}`);
  lines.push(`Общо отклонения: ${deviations}`);
  return lines;
}

function main() {
  const log = loadLog();
  const dates = Object.keys(log).sort();
  if (dates.length === 0) return;
  const last7 = dates.slice(-7);
  const entries = last7.map((date) => [date, log[date]]);
  const lines = buildSummary(entries);
  const message = `Седмичен анализ (последни 7 дни):\n` + lines.map((l) => `• ${l}`).join("\n");
  const env = parseEnvFile(ENV_FILE);
  const target = env.TELEGRAM_TARGET || "";
  if (target) sendTelegramMessage(target, message);
  const today = new Date().toISOString().slice(0, 10);
  for (const line of lines) {
    spawnSync(process.execPath, [NOTION_SCHEDULE_SCRIPT, "--date", today, "--text", `Седмичен анализ: ${line}`], {
      cwd: REPO_CWD,
      encoding: "utf8",
      timeout: 120000,
    });
  }
}

main();
