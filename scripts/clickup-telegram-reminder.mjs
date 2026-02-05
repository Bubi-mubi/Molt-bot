#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_ENV_FILE = path.join(os.homedir(), ".clawdbot", "clickup-reminder.env");
const DEFAULT_STATE_FILE = path.join(os.homedir(), ".clawdbot", "clickup-reminder-state.json");
const DEFAULT_LOG_FILE = path.join(os.homedir(), ".clawdbot", "logs", "clickup-reminder.log");
const DEFAULT_TARGET = "1443342610";
const REPO_CWD = "/Users/lyrra/MyAPPS/moltbot-2026.1.24";

function parseArgs(argv) {
  const args = {
    mode: "poll",
    dryRun: false,
    title: "",
    description: "",
    assignee: "",
    space: "",
    folder: "",
    list: "",
    due: "",
    priority: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--mode" && argv[i + 1]) {
      args.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--title" && argv[i + 1]) {
      args.title = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--description" && argv[i + 1]) {
      args.description = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--assignee" && argv[i + 1]) {
      args.assignee = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--space" && argv[i + 1]) {
      args.space = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--folder" && argv[i + 1]) {
      args.folder = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--list" && argv[i + 1]) {
      args.list = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--due" && argv[i + 1]) {
      args.due = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--priority" && argv[i + 1]) {
      args.priority = argv[i + 1];
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

function toMs(value) {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function appendLog(line) {
  const dir = path.dirname(DEFAULT_LOG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(DEFAULT_LOG_FILE, `${new Date().toISOString()} ${line}\n`);
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) return { knownTaskIds: {}, firstPollDone: false };
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { knownTaskIds: {}, firstPollDone: false };
  }
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clickupRequest(apiKey, requestPath, params = {}) {
  const url = new URL(`https://api.clickup.com/api/v2${requestPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ClickUp API ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

async function clickupPost(apiKey, requestPath, payload) {
  const url = new URL(`https://api.clickup.com/api/v2${requestPath}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ClickUp API ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

async function resolveUserId(apiKey, userName) {
  const data = await clickupRequest(apiKey, "/team");
  const teams = Array.isArray(data.teams) ? data.teams : [];
  const needle = (userName || "").trim().toLowerCase();

  for (const team of teams) {
    const members = Array.isArray(team.members) ? team.members : [];
    for (const member of members) {
      const user = member.user || {};
      const candidates = [user.username, user.email, user.initials, user.id]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      if (needle && candidates.some((v) => v.includes(needle))) {
        return { userId: String(user.id), teams };
      }
    }
  }

  throw new Error(`Could not resolve ClickUp user '${userName}'.`);
}

async function fetchAllTasks(apiKey, teams, userId) {
  const byId = new Map();

  for (const team of teams) {
    let page = 0;
    while (true) {
      const data = await clickupRequest(apiKey, `/team/${team.id}/task`, {
        "assignees[]": [userId],
        include_closed: "false",
        subtasks: "true",
        page,
      });
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      for (const task of tasks) {
        if (task?.id) byId.set(String(task.id), task);
      }
      if (tasks.length === 0) break;
      page += 1;
      if (page > 30) break;
    }
  }

  return [...byId.values()];
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function parseDueDate(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ts = Date.parse(`${raw}T17:00:00`);
    return Number.isFinite(ts) ? ts : null;
  }
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function parsePriority(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  if (raw === "urgent" || raw === "1") return 1;
  if (raw === "high" || raw === "2") return 2;
  if (raw === "normal" || raw === "3" || raw === "medium") return 3;
  if (raw === "low" || raw === "4") return 4;
  return null;
}

function findMatches(items, query) {
  const needle = normalizeText(query);
  if (!needle) return [];
  const byId = items.filter((item) => String(item.id) === query.trim());
  if (byId.length > 0) return byId;
  const exact = items.filter((item) => normalizeText(item.name) === needle);
  if (exact.length > 0) return exact;
  return items.filter((item) => normalizeText(item.name).includes(needle));
}

function ensureSingleMatch(items, query, label) {
  const matches = findMatches(items, query);
  if (matches.length === 0) {
    throw new Error(`No ${label} found for "${query}".`);
  }
  if (matches.length > 1) {
    const options = matches
      .slice(0, 8)
      .map((item) => `${item.name} (${item.id})`)
      .join(", ");
    throw new Error(`Ambiguous ${label} "${query}". Matches: ${options}`);
  }
  return matches[0];
}

async function fetchCatalog(apiKey, teams) {
  const members = [];
  const spaces = [];
  const lists = [];

  for (const team of teams) {
    const teamMembers = Array.isArray(team.members) ? team.members : [];
    for (const member of teamMembers) {
      const user = member.user || {};
      if (!user.id) continue;
      members.push({
        id: String(user.id),
        name: user.username || user.email || String(user.id),
      });
    }

    const spacesResp = await clickupRequest(apiKey, `/team/${team.id}/space`, { archived: "false" });
    const teamSpaces = Array.isArray(spacesResp.spaces) ? spacesResp.spaces : [];
    for (const space of teamSpaces) {
      const spaceId = String(space.id);
      spaces.push({ id: spaceId, name: space.name, teamId: String(team.id) });

      const folderResp = await clickupRequest(apiKey, `/space/${spaceId}/folder`, { archived: "false" });
      const folders = Array.isArray(folderResp.folders) ? folderResp.folders : [];
      for (const folder of folders) {
        const folderId = String(folder.id);
        const listResp = await clickupRequest(apiKey, `/folder/${folderId}/list`, { archived: "false" });
        const folderLists = Array.isArray(listResp.lists) ? listResp.lists : [];
        for (const list of folderLists) {
          lists.push({
            id: String(list.id),
            name: list.name,
            spaceId,
            spaceName: space.name,
            folderId,
            folderName: folder.name,
          });
        }
      }

      const rootListResp = await clickupRequest(apiKey, `/space/${spaceId}/list`, { archived: "false" });
      const rootLists = Array.isArray(rootListResp.lists) ? rootListResp.lists : [];
      for (const list of rootLists) {
        lists.push({
          id: String(list.id),
          name: list.name,
          spaceId,
          spaceName: space.name,
          folderId: null,
          folderName: null,
        });
      }
    }
  }

  const uniq = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.id)) map.set(row.id, row);
    }
    return [...map.values()];
  };

  return { members: uniq(members), spaces: uniq(spaces), lists: uniq(lists) };
}

function resolveList(catalog, args) {
  let candidateLists = [...catalog.lists];

  if (args.space) {
    const space = ensureSingleMatch(catalog.spaces, args.space, "space");
    candidateLists = candidateLists.filter((list) => list.spaceId === space.id);
  }

  if (args.folder) {
    const folders = candidateLists
      .filter((list) => list.folderId)
      .map((list) => ({ id: list.folderId, name: list.folderName }))
      .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i);
    const folder = ensureSingleMatch(folders, args.folder, "folder");
    candidateLists = candidateLists.filter((list) => list.folderId === folder.id);
  }

  if (args.list) {
    return ensureSingleMatch(candidateLists, args.list, "list");
  }

  if (candidateLists.length === 1) return candidateLists[0];

  const sample = candidateLists
    .slice(0, 10)
    .map((list) =>
      `${list.name} (space=${list.spaceName}${list.folderName ? `, folder=${list.folderName}` : ""}, id=${list.id})`,
    )
    .join("; ");
  throw new Error(
    `Missing list. Please specify --list. Candidate lists: ${sample || "none found in selected scope"}`,
  );
}

function resolveAssignees(catalog, assigneeInput) {
  const raw = String(assigneeInput || "").trim();
  if (!raw) return [];
  const names = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const ids = [];
  for (const name of names) {
    const user = ensureSingleMatch(catalog.members, name, "assignee");
    ids.push(user.id);
  }
  return ids;
}

async function createTask(apiKey, catalog, args) {
  const title = String(args.title || "").trim();
  if (!title) throw new Error("Missing task title. Use --title \"...\".");

  const list = resolveList(catalog, args);
  const assignees = resolveAssignees(catalog, args.assignee);
  const dueDate = parseDueDate(args.due);
  const priority = parsePriority(args.priority);

  const payload = { name: title };
  if (String(args.description || "").trim()) payload.description = String(args.description || "").trim();
  if (assignees.length > 0) payload.assignees = assignees;
  if (dueDate) payload.due_date = dueDate;
  if (priority) payload.priority = priority;

  if (args.dryRun) {
    return {
      dryRun: true,
      list,
      payload,
    };
  }

  const created = await clickupPost(apiKey, `/list/${list.id}/task`, payload);
  return { dryRun: false, list, created };
}

function formatTaskLine(task) {
  const status = task?.status?.status || "unknown";
  const dueMs = toMs(task?.due_date);
  const dueText = dueMs ? ` | due ${new Date(dueMs).toLocaleDateString("bg-BG")}` : "";
  const url = task?.url ? `\n${task.url}` : "";
  return `- [${status}] ${task.name}${dueText}${url}`;
}

function buildDailyMessage(tasks) {
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const overdue = [];
  const dueToday = [];
  const noDue = [];

  for (const task of tasks) {
    const dueMs = toMs(task?.due_date);
    if (!dueMs) {
      noDue.push(task);
      continue;
    }
    if (dueMs < now) overdue.push(task);
    else if (dueMs >= startOfDay.getTime() && dueMs <= endOfDay.getTime()) dueToday.push(task);
    else noDue.push(task);
  }

  const lines = [];
  lines.push(`ClickUp daily reminder: ${tasks.length} open tasks for Dani`);
  lines.push(`Overdue: ${overdue.length} | Due today: ${dueToday.length}`);
  lines.push("");

  if (overdue.length > 0) {
    lines.push("Overdue:");
    for (const task of overdue.slice(0, 10)) lines.push(formatTaskLine(task));
    lines.push("");
  }

  if (dueToday.length > 0) {
    lines.push("Due today:");
    for (const task of dueToday.slice(0, 10)) lines.push(formatTaskLine(task));
    lines.push("");
  }

  lines.push("Top open tasks:");
  for (const task of tasks.slice(0, 20)) lines.push(formatTaskLine(task));

  return lines.join("\n").slice(0, 3500);
}

function buildPlainTasks(tasks) {
  const lines = [];
  lines.push(`ClickUp tasks for Dani: ${tasks.length} open`);
  lines.push("");
  for (const task of tasks.slice(0, 50)) lines.push(formatTaskLine(task));
  if (tasks.length > 50) lines.push(`...and ${tasks.length - 50} more.`);
  return lines.join("\n");
}

function buildDailyPlanner(tasks) {
  const top = tasks.slice(0, 8);
  const morning = top.slice(0, 3);
  const afternoon = top.slice(3, 6);
  const evening = top.slice(6, 8);
  const lines = [];
  lines.push("Daily planner (ClickUp):");
  lines.push("");
  lines.push("Morning:");
  if (morning.length === 0) lines.push("- (no tasks)");
  for (const task of morning) lines.push(`- ${formatTaskLine(task)}`);
  lines.push("");
  lines.push("Afternoon:");
  if (afternoon.length === 0) lines.push("- (no tasks)");
  for (const task of afternoon) lines.push(`- ${formatTaskLine(task)}`);
  lines.push("");
  lines.push("Evening:");
  if (evening.length === 0) lines.push("- (no tasks)");
  for (const task of evening) lines.push(`- ${formatTaskLine(task)}`);
  return lines.join("\n");
}

function buildCatalogText(catalog) {
  const lines = [];
  lines.push(`ClickUp catalog`);
  lines.push(`Members: ${catalog.members.length}`);
  for (const member of catalog.members.slice(0, 50)) {
    lines.push(`- ${member.name} (${member.id})`);
  }
  lines.push("");
  lines.push(`Lists: ${catalog.lists.length}`);
  for (const list of catalog.lists.slice(0, 80)) {
    lines.push(
      `- ${list.name} | space=${list.spaceName}${list.folderName ? ` | folder=${list.folderName}` : ""} | id=${list.id}`,
    );
  }
  if (catalog.lists.length > 80) lines.push(`...and ${catalog.lists.length - 80} more lists.`);
  return lines.join("\n");
}

function buildNewTasksMessage(newTasks) {
  const lines = [];
  lines.push(`New ClickUp task${newTasks.length > 1 ? "s" : ""} assigned to Dani:`);
  lines.push("");
  for (const task of newTasks.slice(0, 10)) {
    lines.push(formatTaskLine(task));
    lines.push("");
  }
  if (newTasks.length > 10) lines.push(`...and ${newTasks.length - 10} more.`);
  return lines.join("\n").slice(0, 3500);
}

function sendTelegramMessage(target, message, dryRun) {
  if (dryRun) {
    appendLog(`[dry-run] would send to telegram target=${target}: ${message.slice(0, 180)}`);
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
    throw new Error(`Failed to send Telegram message (exit ${result.status}): ${stderr}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const fileEnv = parseEnvFile(DEFAULT_ENV_FILE);
  const env = { ...fileEnv, ...process.env };

  const apiKey = env.CLICKUP_API_KEY;
  const clickupUserName = env.CLICKUP_USER_NAME || "Dani";
  const configuredUserId = env.CLICKUP_USER_ID || "";
  const telegramTarget = env.TELEGRAM_TARGET || DEFAULT_TARGET;
  const stateFile = env.CLICKUP_STATE_FILE || DEFAULT_STATE_FILE;
  const defaultSpace = env.CLICKUP_DEFAULT_SPACE || "";
  const defaultFolder = env.CLICKUP_DEFAULT_FOLDER || "";
  const defaultList = env.CLICKUP_DEFAULT_LIST || "";
  const defaultAssignee = env.CLICKUP_DEFAULT_ASSIGNEE || "";

  if (!apiKey) {
    throw new Error(`Missing CLICKUP_API_KEY. Put it in ${DEFAULT_ENV_FILE}.`);
  }

  const teamsData = await clickupRequest(apiKey, "/team");
  const teams = Array.isArray(teamsData.teams) ? teamsData.teams : [];
  if (teams.length === 0) throw new Error("No ClickUp teams found for this API key.");

  let userId = configuredUserId;
  if (!userId) {
    const resolved = await resolveUserId(apiKey, clickupUserName);
    userId = resolved.userId;
  }

  const tasks = await fetchAllTasks(apiKey, teams, userId);
  tasks.sort((a, b) => {
    const ad = toMs(a?.due_date) ?? Number.MAX_SAFE_INTEGER;
    const bd = toMs(b?.due_date) ?? Number.MAX_SAFE_INTEGER;
    return ad - bd;
  });

  const state = loadState(stateFile);
  state.knownTaskIds ||= {};

  const effectiveArgs = {
    ...args,
    assignee: args.assignee || defaultAssignee,
    space: args.space || defaultSpace,
    folder: args.folder || defaultFolder,
    list: args.list || defaultList,
  };

  if (args.mode === "print") {
    process.stdout.write(`${buildPlainTasks(tasks)}\n`);
    appendLog(`[print] returned ${tasks.length} tasks`);
  } else if (args.mode === "daily-print") {
    process.stdout.write(`${buildDailyPlanner(tasks)}\n`);
    appendLog(`[daily-print] returned ${tasks.length} tasks`);
  } else if (args.mode === "catalog") {
    const catalog = await fetchCatalog(apiKey, teams);
    process.stdout.write(`${buildCatalogText(catalog)}\n`);
    appendLog(`[catalog] returned members=${catalog.members.length} lists=${catalog.lists.length}`);
  } else if (args.mode === "create") {
    const catalog = await fetchCatalog(apiKey, teams);
    const result = await createTask(apiKey, catalog, effectiveArgs);
    if (result.dryRun) {
      process.stdout.write(
        `DRY RUN: task would be created in list "${result.list.name}" (${result.list.id}) with payload:\n${JSON.stringify(result.payload, null, 2)}\n`,
      );
      appendLog(`[create] dry-run title="${effectiveArgs.title}" list=${result.list.id}`);
    } else {
      const created = result.created || {};
      process.stdout.write(
        `Created ClickUp task "${created.name || effectiveArgs.title}" in list "${result.list.name}" (${result.list.id}).\n${created.url || ""}\n`,
      );
      appendLog(`[create] created task ${created.id || "unknown"} list=${result.list.id}`);
    }
  } else if (args.mode === "daily") {
    const message = buildDailyMessage(tasks);
    sendTelegramMessage(telegramTarget, message, args.dryRun);
    appendLog(`[daily] sent summary (${tasks.length} tasks) to ${telegramTarget}`);
  } else {
    const knownIds = new Set(Object.keys(state.knownTaskIds));
    const newTasks = tasks.filter((task) => task?.id && !knownIds.has(String(task.id)));

    if (!state.firstPollDone) {
      state.firstPollDone = true;
      appendLog(`[poll] bootstrap completed (${tasks.length} known tasks), no notification sent`);
    } else if (newTasks.length > 0) {
      const message = buildNewTasksMessage(newTasks);
      sendTelegramMessage(telegramTarget, message, args.dryRun);
      appendLog(`[poll] sent ${newTasks.length} new-task alerts to ${telegramTarget}`);
    }

    state.knownTaskIds = Object.fromEntries(tasks.map((task) => [String(task.id), Date.now()]));
  }

  saveState(stateFile, state);
}

main().catch((error) => {
  const text = error instanceof Error ? error.message : String(error);
  appendLog(`[error] ${text}`);
  console.error(text);
  process.exit(1);
});
