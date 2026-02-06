---
name: moltbot-tools
description: Tools for MoltBot to interact with Notion, ClickUp, and Reminders.
metadata: { "clawdbot": { "emoji": "🛠️" } }
---

# MoltBot Tools

This skill provides access to the custom integrations for Notion, ClickUp, and Telegram Reminders.

## Tools

### `notion_save`

Save a note or task to a specific Notion page/database.

```bash
node {baseDir}/../../scripts/notion.mjs --target "{{target}}" --title "{{title}}" --body "{{body}}"
```

- **target**: The key/name of the Notion target (e.g., "inbox", "personal", "work"). Use `notion_list_targets` to see available options.
- **title**: The title or main text of the note.
- **body**: (Optional) Additional details or "Due Date".

### `notion_list_targets`

List all configured Notion targets/pages. Use this to find the correct `target` key for `notion_save`.

```bash
cat {baseDir}/../../notion-targets.json
```

### `clickup_create`

Create a new task in ClickUp.

```bash
node {baseDir}/../../scripts/clickup.mjs --mode create --title "{{title}}" --list "{{list}}" --assignee "{{assignee}}"
```

- **title**: The task title.
- **list**: (Optional) The ClickUp list name (or "default").
- **assignee**: (Optional) The assignee name.

### `reminder_add`

Schedule a reminder for the user.

```bash
node {baseDir}/../../scripts/telegram-reminders.mjs --mode add --text "{{text}}" --in "{{time_relative}}" --target "{{chat_id}}"
```

- **text**: What to remind about.
- **time_relative**: When to remind (e.g., "10m", "1h", "2d").
- **chat_id**: The user's Telegram Chat ID. (Ask the user for this if unknown, or use context).

### `reminder_add_absolute`

Schedule a reminder at a specific time.

```bash
node {baseDir}/../../scripts/telegram-reminders.mjs --mode add --text "{{text}}" --at "{{time_absolute}}" --target "{{chat_id}}"
```

- **text**: What to remind about.
- **time_absolute**: The time to remind (e.g., "18:30" or "2026-02-07 09:00").
- **chat_id**: The user's Telegram Chat ID.

### `reminder_snooze`

Snooze a pending reminder.

```bash
node {baseDir}/../../scripts/telegram-reminders.mjs --mode snooze --in "{{time_relative}}" --target "{{chat_id}}"
```

- **time_relative**: (Optional) How long to snooze for (e.g. "30m"). Default is 5m.
- **chat_id**: The user's Telegram Chat ID.

### `reminder_done`

Mark the last pending reminder (or specific ID) as done.

```bash
node {baseDir}/../../scripts/telegram-reminders.mjs --mode done --target "{{chat_id}}"
```

- **chat_id**: The user's Telegram Chat ID.
