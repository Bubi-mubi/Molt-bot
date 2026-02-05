#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_CWD = "/Users/lyrra/MyAPPS/moltbot-2026.1.24";
const DEFAULT_ENV_FILE = path.join(os.homedir(), ".clawdbot", "telegram-reminders.env");
const DEFAULT_STATE_FILE = path.join(os.homedir(), ".clawdbot", "reminders.json");
const DEFAULT_LOG_FILE = path.join(os.homedir(), ".clawdbot", "logs", "reminders.log");
const DEFAULT_REPEAT_MINUTES = 5;

function parseArgs(argv) {
  const args = {
    mode: "tick",
    text: "",
    in: "",
    at: "",
    repeatMinutes: DEFAULT_REPEAT_MINUTES,
    id: "",
    target: "",
    channel: "telegram",
    dryRun: false,
    group: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--mode" && argv[i + 1]) {
      args.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--text" && argv[i + 1]) {
      args.text = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--in" && argv[i + 1]) {
      args.in = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--at" && argv[i + 1]) {
      args.at = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--repeat-min" && argv[i + 1]) {
      args.repeatMinutes = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--id" && argv[i + 1]) {
      args.id = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--target" && argv[i + 1]) {
      args.target = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--channel" && argv[i + 1]) {
      args.channel = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--group" && argv[i + 1]) {
      args.group = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
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

function appendLog(line) {
  const dir = path.dirname(DEFAULT_LOG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(DEFAULT_LOG_FILE, `${new Date().toISOString()} ${line}\n`);
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) return { reminders: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { reminders: [] };
  }
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseDurationMs(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit.startsWith("m")) return value * 60 * 1000;
  if (unit.startsWith("h")) return value * 60 * 60 * 1000;
  if (unit.startsWith("d")) return value * 24 * 60 * 60 * 1000;
  return null;
}

function parseAtMs(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(raw)) {
    const ts = Date.parse(raw.replace(" ", "T"));
    return Number.isFinite(ts) ? ts : null;
  }
  if (/^\d{2}:\d{2}$/.test(raw)) {
    const now = new Date();
    const [hh, mm] = raw.split(":").map((v) => Number(v));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    const target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() < now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }
  return null;
}

function ensureTarget(args, env) {
  return args.target || env.TELEGRAM_TARGET || "";
}

function sendTelegramMessage(target, message, dryRun) {
  if (!target) throw new Error("Missing TELEGRAM_TARGET for reminder delivery.");
  if (dryRun) {
    appendLog(`[dry-run] send to ${target}: ${message.slice(0, 160)}`);
    return;
  }
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
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim().slice(0, 400);
    throw new Error(`Failed to send Telegram reminder (exit ${result.status}): ${stderr}`);
  }
}

function buildReminderText(reminder) {
  return `Напомням ти: ${reminder.text}\n\nОтговори с \"готово\" или \"по-късно <мин/час>\".`;
}

function buildAckText(kind, reminder) {
  if (kind === "done") return `Отбелязах като изпълнено: ${reminder.text}`;
  if (kind === "snooze") return `Ок, ще ти напомня по-късно: ${reminder.text}`;
  return `Ок.`;
}

function nextReminderId(state) {
  const ids = state.reminders.map((r) => Number(r.id)).filter(Number.isFinite);
  const maxId = ids.length > 0 ? Math.max(...ids) : 0;
  return String(maxId + 1);
}

function parseSnoozeMinutes(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (match[2].startsWith("h")) return value * 60;
  return value;
}

async function main() {
  const args = parseArgs(process.argv);
  const fileEnv = parseEnvFile(DEFAULT_ENV_FILE);
  const env = { ...fileEnv, ...process.env };
  const target = ensureTarget(args, env);
  const stateFile = env.REMINDERS_STATE_FILE || DEFAULT_STATE_FILE;
  const repeatMinutes = Number.isFinite(args.repeatMinutes) && args.repeatMinutes > 0
    ? args.repeatMinutes
    : DEFAULT_REPEAT_MINUTES;

  const state = loadState(stateFile);
  state.reminders ||= [];
  state.groups ||= {};
  const groupName = String(args.group || "").trim();
  if (groupName && !state.groups[groupName]) {
    state.groups[groupName] = { repeatMinutes };
  }

  if (args.mode === "add") {
    const text = String(args.text || "").trim();
    if (!text) throw new Error("Missing reminder text (--text).");

    let dueAt = null;
    if (args.in) {
      const delta = parseDurationMs(args.in);
      if (!delta) throw new Error("Invalid --in duration. Use e.g. 10m, 2h, 1d.");
      dueAt = Date.now() + delta;
    } else if (args.at) {
      const parsed = parseAtMs(args.at);
      if (!parsed) throw new Error("Invalid --at value. Use HH:MM or YYYY-MM-DD HH:MM.");
      dueAt = parsed;
    } else {
      throw new Error("Missing reminder time. Provide --in or --at.");
    }

    const reminder = {
      id: nextReminderId(state),
      text,
      status: "pending",
      createdAt: Date.now(),
      dueAt,
      nextAt: dueAt,
      repeatMinutes,
      target,
      group: groupName || undefined,
    };
    state.reminders.push(reminder);
    saveState(stateFile, state);
    sendTelegramMessage(target, `Записах напомняне: ${text}`, args.dryRun);
    appendLog(`[add] id=${reminder.id} dueAt=${reminder.dueAt} text="${text}"`);
    return;
  }

  if (args.mode === "done") {
    const id = String(args.id || "").trim();
    const reminder =
      (id && state.reminders.find((r) => String(r.id) === id)) ||
      [...state.reminders]
        .reverse()
        .find(
          (r) =>
            r.status === "pending" &&
            r.target === target &&
            (!groupName || r.group === groupName),
        );
    if (!reminder) throw new Error("No pending reminder found to mark done.");
    reminder.status = "done";
    reminder.doneAt = Date.now();
    saveState(stateFile, state);
    sendTelegramMessage(target, buildAckText("done", reminder), args.dryRun);
    appendLog(`[done] id=${reminder.id}`);
    return;
  }

  if (args.mode === "snooze") {
    const id = String(args.id || "").trim();
    const minutes = parseSnoozeMinutes(args.in) ?? repeatMinutes;
    const reminder =
      (id && state.reminders.find((r) => String(r.id) === id)) ||
      [...state.reminders]
        .reverse()
        .find(
          (r) =>
            r.status === "pending" &&
            r.target === target &&
            (!groupName || r.group === groupName),
        );
    if (!reminder) throw new Error("No pending reminder found to snooze.");
    reminder.nextAt = Date.now() + minutes * 60 * 1000;
    saveState(stateFile, state);
    sendTelegramMessage(target, buildAckText("snooze", reminder), args.dryRun);
    appendLog(`[snooze] id=${reminder.id} nextAt=${reminder.nextAt}`);
    return;
  }

  if (args.mode === "list") {
    const pending = state.reminders.filter(
      (r) => r.status === "pending" && (!groupName || r.group === groupName),
    );
    const lines = [`Pending reminders: ${pending.length}`];
    for (const r of pending) {
      lines.push(`- (${r.id}) ${r.text} | next ${new Date(r.nextAt).toLocaleString("bg-BG")}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (args.mode === "tick") {
    const now = Date.now();
    let sent = 0;
    for (const reminder of state.reminders) {
      if (reminder.status !== "pending") continue;
      if (!reminder.nextAt || reminder.nextAt > now) continue;
      if (groupName && reminder.group !== groupName) continue;
      sendTelegramMessage(reminder.target || target, buildReminderText(reminder), args.dryRun);
      reminder.lastSentAt = now;
      reminder.nextAt = now + (reminder.repeatMinutes || repeatMinutes) * 60 * 1000;
      sent += 1;
    }
    if (sent > 0) saveState(stateFile, state);
    appendLog(`[tick] sent=${sent}`);
    return;
  }

  throw new Error(`Unknown mode: ${args.mode}`);
}

main().catch((error) => {
  const text = error instanceof Error ? error.message : String(error);
  appendLog(`[error] ${text}`);
  console.error(text);
  process.exit(1);
});
