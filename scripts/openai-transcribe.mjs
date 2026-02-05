#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "gpt-4o-mini-transcribe";

function parseArgs(argv) {
  const args = { file: "", model: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--file" && argv[i + 1]) {
      args.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--model" && argv[i + 1]) {
      args.model = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const filePath = String(args.file || "").trim();
  if (!filePath) throw new Error("Missing --file for transcription.");
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY in environment.");

  const model = args.model || DEFAULT_MODEL;
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([buffer]), fileName);

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI transcription ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = String(data?.text || "").trim();
  if (!text) throw new Error("Empty transcription.");
  process.stdout.write(`${text}\n`);
}

main().catch((error) => {
  const text = error instanceof Error ? error.message : String(error);
  console.error(text);
  process.exit(1);
});
