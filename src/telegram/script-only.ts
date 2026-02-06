import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { Bot } from "grammy";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from "grammy/types";

import type { ReplyToMode } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import { deliverReplies } from "./bot/delivery.js";
import type { RuntimeEnv } from "../runtime.js";

const REPO_CWD = process.cwd();
const CLICKUP_SCRIPT = path.join(REPO_CWD, "scripts", "clickup-telegram-reminder.mjs");
const NOTION_SCRIPT = path.join(REPO_CWD, "scripts", "notion-quick-note.mjs");
const REMINDERS_SCRIPT = path.join(REPO_CWD, "scripts", "telegram-reminders.mjs");
const NOTION_SCHEDULE_SCRIPT = path.join(REPO_CWD, "scripts", "notion-schedule.mjs");
const OPENAI_TRANSCRIBE_SCRIPT = path.join(REPO_CWD, "scripts", "openai-transcribe.mjs");
const STATE_FILE = path.join(os.homedir(), ".clawdbot", "script-only-state.json");
const NOTION_TARGETS_PATH = path.join(os.homedir(), ".clawdbot", "notion-targets.json");
const DAILY_LOG_FILE = path.join(os.homedir(), ".clawdbot", "daily-log.json");

type ScriptState = {
  telegram?: Record<
    string,
    {
      smart?: boolean;
      pending?:
      | { type: "note-destination"; title: string; body?: string }
      | { type: "note-target"; title: string; due?: string; origin?: "voice" | "text" }
      | { type: "note-due"; title: string; targetKey?: string; origin?: "voice" | "text" }
      | { type: "note-reminder-ask"; title: string; targetKey: string; due?: string }
      | { type: "note-reminder-time"; title: string; targetKey: string; due?: string }
      | { type: "clickup-title"; assignee?: string; list?: string }
      | { type: "clickup-list"; title: string; assignee?: string }
      | { type: "daily-plan"; text?: string; date?: string }
      | { type: "reminder-text"; when: { kind: "in" | "at"; value: string } }
      | { type: "reminder-time"; text: string }
      | null;
    }
  >;
};

function loadState(): ScriptState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state: ScriptState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function loadDailyLog(): Record<string, { schedule?: string[]; deviations?: string[] }> {
  try {
    if (!fs.existsSync(DAILY_LOG_FILE)) return {};
    return JSON.parse(fs.readFileSync(DAILY_LOG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDailyLog(log: Record<string, { schedule?: string[]; deviations?: string[] }>) {
  fs.mkdirSync(path.dirname(DAILY_LOG_FILE), { recursive: true });
  fs.writeFileSync(DAILY_LOG_FILE, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}

function recordDailyLog(date: string, kind: "schedule" | "deviation", text: string) {
  const log = loadDailyLog();
  log[date] ||= {};
  if (kind === "schedule") {
    log[date].schedule ||= [];
    log[date].schedule?.push(text);
  } else {
    log[date].deviations ||= [];
    log[date].deviations?.push(text);
  }
  saveDailyLog(log);
}

function normalize(text: string) {
  return text.trim().toLowerCase();
}

function runNodeScript(scriptPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_CWD,
    encoding: "utf8",
    timeout: 120000,
  });
  return {
    status: result.status ?? 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function loadNotionTargets() {
  if (!fs.existsSync(NOTION_TARGETS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(NOTION_TARGETS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function buildNotionTargetsKeyboard(targets: Record<string, { name?: string }>) {
  const entries = Object.entries(targets);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < entries.length; i += 2) {
    const slice = entries.slice(i, i + 2);
    rows.push(
      slice.map(([key, value]) => ({
        text: value?.name || key,
        callback_data: `/note-target ${key}`,
      })),
    );
  }
  return rows;
}

function buildReminderAskKeyboard() {
  return [
    [
      { text: "✅ Да", callback_data: "/reminder-ask yes" },
      { text: "❌ Не", callback_data: "/reminder-ask no" },
    ],
  ];
}

function buildReminderTimeKeyboard() {
  return [
    [
      { text: "30 мин", callback_data: "/reminder-time 30m" },
      { text: "1 час", callback_data: "/reminder-time 1h" },
      { text: "2 часа", callback_data: "/reminder-time 2h" },
    ],
    [
      { text: "Утре 09:00", callback_data: "/reminder-time tomorrow-9" },
      { text: "Утре 18:00", callback_data: "/reminder-time tomorrow-18" },
    ],
  ];
}

function parseDueText(text: string) {
  const match = text.match(
    /до\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|\d{2}\.\d{2}\.\d{4}|\d{2}:\d{2})/i,
  );
  if (!match) return { title: text.trim(), due: "" };
  const due = match[1].trim();
  const title = text.replace(match[0], "").trim();
  return { title, due };
}

function normalizeDueToNotionFormat(input: string) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(raw)) return raw;
  if (/^\d{2}:\d{2}$/.test(raw)) {
    const now = new Date();
    const [hh, mm] = raw.split(":").map((v) => Number(v));
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return `${date} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  if (/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}$/.test(raw)) {
    const [d, t] = raw.split(" ");
    const [day, month, year] = d.split(".");
    return `${year}-${month}-${day} ${t}`;
  }
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split(".");
    return `${year}-${month}-${day} 09:00`;
  }
  return raw;
}

async function sendText(params: {
  text: string;
  bot: Bot;
  chatId: string | number;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  textLimit: number;
  messageThreadId?: number;
  telegramCfg: TelegramAccountConfig;
  accountId: string;
  replyMarkup?: TelegramReplyMarkup;
}) {
  const tableMode = resolveMarkdownTableMode({
    cfg: { channels: { telegram: params.telegramCfg } },
    channel: "telegram",
    accountId: params.accountId,
  });
  await deliverReplies({
    replies: [{ text: params.text }],
    chatId: String(params.chatId),
    token: params.telegramCfg.botToken || "",
    runtime: params.runtime,
    bot: params.bot,
    replyToMode: params.replyToMode,
    textLimit: params.textLimit,
    messageThreadId: params.messageThreadId,
    tableMode,
    ...(params.replyMarkup ? { replyMarkup: params.replyMarkup } : {}),
  });
}

type TelegramReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

function parseReminderRelative(text: string) {
  const match = text.match(
    /напомни\s+ми\s+след\s+(\d+)\s*(мин(?:ути)?|м|min|час(?:а)?|h|hrs?|hour|hours|ден|дни|d)\s*(.*)$/i,
  );
  if (!match) return null;
  const value = Number(match[1]);
  const unit = normalize(match[2]);
  let remainder = (match[3] || "").trim();
  // Strip starting punctuation like "." or "," or ":" often used after time unit
  remainder = remainder.replace(/^[\.,:;]\s*/, "");

  if (!Number.isFinite(value) || value <= 0) return null;
  let suffix = "m";
  if (unit.startsWith("ч") || unit.startsWith("h") || unit.startsWith("hour")) suffix = "h";
  if (unit.startsWith("д") || unit.startsWith("d")) suffix = "d";
  return { when: `${value}${suffix}`, text: remainder };
}

function parseReminderAbsolute(text: string) {
  const match = text.match(/напомни\s+ми\s+в\s+([0-9]{1,2}:[0-9]{2}|\d{4}-\d{2}-\d{2}\s+[0-9]{2}:[0-9]{2})\s*(.*)$/i);
  if (!match) return null;
  return { when: match[1].trim(), text: (match[2] || "").trim() };
}

function stripFields(text: string) {
  let title = text.trim();
  let due = "";
  let priority = "";
  const dueMatch = title.match(/\bсрок\s+(\d{4}-\d{2}-\d{2})/i);
  if (dueMatch) {
    due = dueMatch[1];
    title = title.replace(dueMatch[0], "").trim();
  }
  const priMatch = title.match(/\bприоритет\s+(urgent|high|normal|low|1|2|3|4)\b/i);
  if (priMatch) {
    priority = priMatch[1];
    title = title.replace(priMatch[0], "").trim();
  }
  return { title, due, priority };
}

function parseClickupCreate(text: string) {
  const trimmed = text.trim();
  const patterns = [
    { re: /^нова\s+задача\s+към\s+(.+?)\s+в\s+(.+?):\s*(.+)$/i, kind: "assignee-list" },
    { re: /^нова\s+задача\s+към\s+(.+?):\s*(.+)$/i, kind: "assignee" },
    { re: /^нова\s+задача:\s*(.+)$/i, kind: "title" },
    { re: /^създай\s+в\s+clickup:\s*(.+)$/i, kind: "title" },
    { re: /^създай\s+задача:\s*(.+)$/i, kind: "title" },
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern.re);
    if (!match) continue;
    if (pattern.kind === "assignee-list") {
      const { title, due, priority } = stripFields(match[3]);
      return {
        title,
        assignee: match[1].trim(),
        list: match[2].trim(),
        due,
        priority,
      };
    }
    if (pattern.kind === "assignee") {
      const { title, due, priority } = stripFields(match[2]);
      return {
        title,
        assignee: match[1].trim(),
        list: "",
        due,
        priority,
      };
    }
    const { title, due, priority } = stripFields(match[1]);
    return { title, assignee: "", list: "", due, priority };
  }
  return null;
}

function buildScheduleLines(text: string) {
  const rawLines = text
    .split(/[\n;]/g)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  const scheduled: Array<{ time: string; task: string }> = [];
  const unscheduled: string[] = [];
  for (const line of rawLines) {
    const timeMatch = line.match(/\b(\d{1,2}:\d{2})\b/);
    if (timeMatch) {
      const time = timeMatch[1];
      const task = line.replace(timeMatch[0], "").trim().replace(/^[-–:]\s*/, "");
      scheduled.push({ time, task: task || line });
    } else {
      unscheduled.push(line);
    }
  }
  const defaultTimes = ["09:00", "11:00", "13:30", "15:30", "17:30", "19:00"];
  let idx = 0;
  for (const task of unscheduled) {
    const time = defaultTimes[idx] || "";
    if (time) {
      scheduled.push({ time, task });
      idx += 1;
    } else {
      scheduled.push({ time: "20:30", task });
    }
  }
  scheduled.sort((a, b) => a.time.localeCompare(b.time));
  return scheduled.map((entry) => `${entry.time} - ${entry.task}`);
}

function formatTomorrowAt(hour: number, minute: number) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

function buildHelpText() {
  return [
    "Работя само със скриптове (без AI). Ползвай тези команди/формати:",
    "",
    "• /clickup или 'дай ми задачите от ClickUp'",
    "• /smart (умен разговор) | /script (връщане към скриптове)",
    "• Нова задача: <заглавие>",
    "• Нова задача към <име>: <заглавие>",
    "• Нова задача към <име> в <лист>: <заглавие>",
    "• утре сутрин (прехвърля напомнянето за график към 09:00)",
    "• отклонение: <описание> (записва се към дневния график)",
    "• Запиши в Notion: <текст>",
    "• Запиши в ClickUp: <заглавие>",
    "• Запиши ми: <текст> (ще те питам къде)",
    "• Напомни ми след 10 мин <текст>",
    "• Напомни ми в 18:30 <текст>",
    "• готово / по-късно 30 мин",
    "• /daily_planner",
  ].join("\n");
}

export async function handleTelegramScriptOnlyMessage(params: {
  text: string;
  mediaPaths: string[];
  mediaTypes: string[];
  bot: Bot;
  chatId: string | number;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  textLimit: number;
  messageThreadId?: number;
  telegramCfg: TelegramAccountConfig;
  accountId: string;
}): Promise<{ handled: boolean } | { handled: boolean; error: string }> {
  let raw = params.text || "";
  let text = raw.trim();

  const isAudio =
    params.mediaPaths.length > 0 &&
    params.mediaTypes.some((t) => {
      const type = String(t || "").toLowerCase();
      return type.startsWith("audio/") || type.startsWith("voice/");
    });

  if (!text && isAudio) {
    const audioPath = params.mediaPaths[0];
    const result = runNodeScript(OPENAI_TRANSCRIBE_SCRIPT, ["--file", audioPath]);
    if (result.status !== 0) {
      await sendText({
        text: `Грешка при транскрипция: ${result.stderr || result.stdout}`.trim(),
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        replyToMode: params.replyToMode,
        textLimit: params.textLimit,
        messageThreadId: params.messageThreadId,
        telegramCfg: params.telegramCfg,
        accountId: params.accountId,
      });
      return { handled: true };
    }
    raw = result.stdout || "";
    text = raw.replace(/\s+/g, " ").trim();
  }

  const fromVoice = isAudio && !String(params.text || "").trim();
  if (!text) return { handled: false };

  const state = loadState();
  const chatKey = String(params.chatId);
  const entry = state.telegram?.[chatKey] ?? {};
  const pending = entry.pending ?? null;
  const smartEnabled = entry.smart === true;

  const send = (msg: string, replyMarkup?: TelegramReplyMarkup) =>
    sendText({
      text: msg,
      bot: params.bot,
      chatId: params.chatId,
      runtime: params.runtime,
      replyToMode: params.replyToMode,
      textLimit: params.textLimit,
      messageThreadId: params.messageThreadId,
      telegramCfg: params.telegramCfg,
      accountId: params.accountId,
      replyMarkup,
    });

  const smartMatch = text.match(/^\/smart(?:\s+(on|off))?$/i);
  if (smartMatch) {
    const mode = normalize(smartMatch[1] || "on");
    entry.smart = mode !== "off";
    state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
    saveState(state);
    if (entry.smart) {
      await send("Включих smart режим. Пиши свободно. За връщане към скриптове: /script.");
    } else {
      await send("Изключих smart режим. Върнах те към скриптовете.");
    }
    return { handled: true };
  }

  if (/^\/script\b/i.test(text)) {
    entry.smart = false;
    state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
    saveState(state);
    await send("Върнах те към скриптовете.");
    return { handled: true };
  }

  if (pending) {
    if (pending.type === "note-destination") {
      const choice = normalize(text);
      if (choice.includes("notion")) {
        const targets = loadNotionTargets();
        const choices = targets?.targets ?? null;
        if (!choices) {
          await send("Нямам конфигурирани Notion цели. Кажи ми къде да запиша.");
          return { handled: true };
        }
        entry.pending = { type: "note-target", title: pending.title, origin: "text" };
        state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
        saveState(state);
        const keyboard = buildNotionTargetsKeyboard(choices);
        await send("Избери къде да запиша задачата:", { inline_keyboard: keyboard });
        return { handled: true };
      }
      if (choice.includes("clickup") || choice.includes("click up")) {
        const result = runNodeScript(CLICKUP_SCRIPT, [
          "--mode",
          "create",
          "--title",
          pending.title,
        ]);
        entry.pending = null;
        state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
        saveState(state);
        if (result.status !== 0) {
          await send(`Грешка при ClickUp: ${result.stderr || result.stdout}`.trim());
          return { handled: true };
        }
        await send(result.stdout || "Създадох задачата в ClickUp.");
        return { handled: true };
      }
      await send('Моля, избери: "Notion" или "ClickUp".');
      return { handled: true };
    }

    if (pending.type === "note-target") {
      const targetKey = text.replace(/^\/note-target\s+/i, "").trim();
      if (!targetKey) {
        await send("Моля, избери цел от бутоните по‑долу.");
        return { handled: true };
      }
      // Transition to reminder ask flow
      entry.pending = { type: "note-reminder-ask", title: pending.title, targetKey, due: pending.due };
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      const keyboard = buildReminderAskKeyboard();
      await send("Искаш ли да ти напомня за тази задача?", { inline_keyboard: keyboard });
      return { handled: true };
    }

    if (pending.type === "note-reminder-ask") {
      const response = text.replace(/^\/reminder-ask\s+/i, "").trim().toLowerCase();
      if (response === "yes" || response === "да") {
        entry.pending = { type: "note-reminder-time", title: pending.title, targetKey: pending.targetKey, due: pending.due };
        state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
        saveState(state);
        const keyboard = buildReminderTimeKeyboard();
        await send("Кога да ти напомня?", { inline_keyboard: keyboard });
        return { handled: true };
      }
      // No reminder - save directly
      const result = runNodeScript(NOTION_SCRIPT, [
        "--target",
        pending.targetKey,
        "--title",
        pending.title,
        ...(pending.due ? ["--body", `До ${normalizeDueToNotionFormat(pending.due)}`] : []),
      ]);
      entry.pending = null;
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      if (result.status !== 0) {
        await send(`Грешка при Notion: ${result.stderr || result.stdout}`.trim());
        return { handled: true };
      }
      await send(result.stdout || "Записах задачата в Notion (без напомняне).");
      return { handled: true };
    }

    if (pending.type === "note-reminder-time") {
      let reminderTime = text.replace(/^\/reminder-time\s+/i, "").trim();
      // Parse button callbacks or free text
      const now = new Date();
      let reminderWhen = "";
      if (reminderTime === "30m") {
        reminderWhen = "30m";
      } else if (reminderTime === "1h") {
        reminderWhen = "1h";
      } else if (reminderTime === "2h") {
        reminderWhen = "2h";
      } else if (reminderTime === "tomorrow-9") {
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        const dateStr = tomorrow.toISOString().slice(0, 10);
        reminderWhen = `${dateStr} 09:00`;
      } else if (reminderTime === "tomorrow-18") {
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        const dateStr = tomorrow.toISOString().slice(0, 10);
        reminderWhen = `${dateStr} 18:00`;
      } else {
        // Try to parse free text time
        const absoluteMatch = reminderTime.match(/(\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
        const relativeMatch = reminderTime.match(/(\d+)\s*(мин(?:ути)?|м|min|час(?:а)?|h|hrs?|hour|hours)/i);
        if (absoluteMatch) {
          reminderWhen = absoluteMatch[1];
        } else if (relativeMatch) {
          const value = Number(relativeMatch[1]);
          const unit = relativeMatch[2].toLowerCase();
          const suffix = unit.startsWith("ч") || unit.startsWith("h") ? "h" : "m";
          reminderWhen = `${value}${suffix}`;
        } else {
          await send("Не разпознах времето. Избери от бутоните или напиши напр. '30 мин' или '18:30'.");
          return { handled: true };
        }
      }
      // Save to Notion
      const result = runNodeScript(NOTION_SCRIPT, [
        "--target",
        pending.targetKey,
        "--title",
        pending.title,
        ...(pending.due ? ["--body", `До ${normalizeDueToNotionFormat(pending.due)}`] : []),
      ]);
      if (result.status !== 0) {
        entry.pending = null;
        state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
        saveState(state);
        await send(`Грешка при Notion: ${result.stderr || result.stdout}`.trim());
        return { handled: true };
      }
      // Create Telegram reminder
      const isAbsolute = reminderWhen.includes(":") && reminderWhen.length > 5;
      const reminderArgs = [
        "--mode", "add",
        "--text", `Напомняне: ${pending.title}`,
        isAbsolute ? "--at" : "--in",
        reminderWhen,
        "--group", "tasks",
        "--target", chatKey,
      ];
      const remResult = runNodeScript(REMINDERS_SCRIPT, reminderArgs);
      if (remResult.status !== 0) {
        // Log error but don't fail the whole flow since Notion is already saved
        await send(`Записах в Notion, но грешка при напомняне: ${remResult.stderr}`);
      }
      entry.pending = null;
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      await send(`Записах задачата в Notion и създадох напомняне. ✅`);
      return { handled: true };
    }

    if (pending.type === "note-due") {
      const noDue =
        /няма\s+краен\s+срок|без\s+краен\s+срок|няма\s+срок/i.test(text);
      const due = noDue ? "" : normalizeDueToNotionFormat(text);
      if (!noDue && !due) {
        await send("Не разпознах дата. Пример: 06.01.2026 12:00");
        return { handled: true };
      }
      const result = runNodeScript(NOTION_SCRIPT, [
        "--target",
        pending.targetKey || "",
        "--title",
        pending.title || text.trim(),
        ...(noDue ? ["--body", "Без краен срок"] : ["--body", `До ${due}`]),
      ]);
      entry.pending = null;
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      if (result.status !== 0) {
        await send(`Грешка при Notion: ${result.stderr || result.stdout}`.trim());
        return { handled: true };
      }
      await send(result.stdout || "Записах задачата в Notion.");
      return { handled: true };
    }

    if (pending.type === "daily-plan") {
      const planText = text.trim();
      if (!planText) {
        await send("Опиши задачите за утре (можеш по редове).");
        return { handled: true };
      }
      const date = pending.date || new Date().toISOString().slice(0, 10);
      const lines = buildScheduleLines(planText);
      for (const line of lines) {
        runNodeScript(NOTION_SCHEDULE_SCRIPT, ["--date", date, "--text", line]);
        recordDailyLog(date, "schedule", line);
      }
      runNodeScript(REMINDERS_SCRIPT, ["--mode", "done", "--group", "daily-plan"]);
      entry.pending = null;
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      await send(`Записах графика за ${date}:\n${lines.map((l) => `• ${l}`).join("\n")}`);
      return { handled: true };
    }

    if (pending.type === "clickup-title") {
      const title = text.trim();
      if (!title) {
        await send("Напиши заглавие на задачата.");
        return { handled: true };
      }
      const args = ["--mode", "create", "--title", title];
      if (pending.assignee) args.push("--assignee", pending.assignee);
      if (pending.list) args.push("--list", pending.list);
      const result = runNodeScript(CLICKUP_SCRIPT, args);
      entry.pending = null;
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      if (result.status !== 0) {
        await send(`Грешка при ClickUp: ${result.stderr || result.stdout}`.trim());
        return { handled: true };
      }
      await send(result.stdout || "Създадох задачата в ClickUp.");
      return { handled: true };
    }

    if (pending.type === "clickup-list") {
      const listText = text.trim();
      const useDefault =
        !listText ||
        normalize(listText) === "по подразбиране" ||
        normalize(listText) === "default";
      const args = ["--mode", "create", "--title", pending.title];
      if (pending.assignee) args.push("--assignee", pending.assignee);
      if (!useDefault) args.push("--list", listText);
      const result = runNodeScript(CLICKUP_SCRIPT, args);
      entry.pending = null;
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      if (result.status !== 0) {
        await send(`Грешка при ClickUp: ${result.stderr || result.stdout}`.trim());
        return { handled: true };
      }
      await send(result.stdout || "Създадох задачата в ClickUp.");
      return { handled: true };
    }

    if (pending.type === "reminder-text") {
      const reminderText = text.trim();
      if (!reminderText) {
        await send("Какво да ти напомня?");
        return { handled: true };
      }
      const args = [
        "--mode",
        "add",
        "--text",
        reminderText,
        pending.when.kind === "in" ? "--in" : "--at",
        pending.when.value,
        "--group",
        "tasks",
      ];
      runNodeScript(REMINDERS_SCRIPT, args);
      entry.pending = null;
      state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
      saveState(state);
      return { handled: true };
    }

    if (pending.type === "reminder-time") {
      const absoluteMatch = text.match(/(\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
      const relativeMatch = text.match(/(\d+)\s*(мин(?:ути)?|м|min|час(?:а)?|h|hrs?|hour|hours|ден|дни|d)/i);
      if (absoluteMatch) {
        const when = absoluteMatch[1].trim();
        runNodeScript(REMINDERS_SCRIPT, [
          "--mode",
          "add",
          "--text",
          pending.text,
          "--at",
          when,
          "--group",
          "tasks",
        ]);
        entry.pending = null;
        state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
        saveState(state);
        return { handled: true };
      }
      if (relativeMatch) {
        const value = Number(relativeMatch[1]);
        const unit = normalize(relativeMatch[2]);
        let suffix = "m";
        if (unit.startsWith("ч") || unit.startsWith("h")) suffix = "h";
        if (unit.startsWith("д") || unit.startsWith("d")) suffix = "d";
        runNodeScript(REMINDERS_SCRIPT, [
          "--mode",
          "add",
          "--text",
          pending.text,
          "--in",
          `${value}${suffix}`,
          "--group",
          "tasks",
        ]);
        entry.pending = null;
        state.telegram = { ...(state.telegram || {}), [chatKey]: entry };
        saveState(state);
        return { handled: true };
      }
      await send("Моля, дай време (напр. 10 мин или 18:30).");
      return { handled: true };
    }
  }

  if (/^(готово|свърших|done)$/i.test(text)) {
    runNodeScript(REMINDERS_SCRIPT, ["--mode", "done", "--group", "tasks"]);
    return { handled: true };
  }

  const snoozeMatch = text.match(/^по-?късно\s+(\d+)\s*(мин(?:ути)?|м|min|час(?:а)?|h|hrs?|hour|hours)$/i);
  if (snoozeMatch) {
    const value = Number(snoozeMatch[1]);
    const unit = normalize(snoozeMatch[2]);
    const suffix = unit.startsWith("ч") || unit.startsWith("h") ? "h" : "m";
    runNodeScript(REMINDERS_SCRIPT, ["--mode", "snooze", "--in", `${value}${suffix}`, "--group", "tasks"]);
    return { handled: true };
  }
  // --- PERMANENT SMART MODE ---
  // All other logic is disabled. Pass everything to AI.
  return { handled: false };
}
