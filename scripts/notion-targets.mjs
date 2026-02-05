#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGETS_PATH = path.join(os.homedir(), ".clawdbot", "notion-targets.json");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const initial = {
    targets: {
      quick_tasks: {
        name: "Quick Task/Notes",
        pageId: "db7735e775cc47e4b843c5c5e7e9c3d2",
        dbId: "",
        type: "tasks",
      },
      realtime_work_log: {
        name: "Real-time Work Log",
        pageId: "563d9a8edbaf481bbb5ae1012665544e",
        dbId: "",
        type: "tasks",
      },
      daily_schedule: {
        name: "Daily Schedule",
        pageId: "2d27b730200180c5a9f7f50463c0029a",
        dbId: "",
        type: "schedule",
      },
    },
  };
  if (fs.existsSync(TARGETS_PATH)) {
    process.stdout.write(`${TARGETS_PATH} already exists.\n`);
    return;
  }
  ensureDir(TARGETS_PATH);
  fs.writeFileSync(TARGETS_PATH, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${TARGETS_PATH}.\n`);
}

main();
