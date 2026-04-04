---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/capabilities` there to see what I can do.

Then stop — do not generate the report.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Installed skills

List skill directories available to you:

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is an installed skill. The directory name is the skill name (e.g., `agent-browser` → `/agent-browser`).

### 2. Available tools

Read the allowed tools from your SDK configuration. You always have access to:
- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** mcp__nanoclaw__* (messaging, tasks, group management)

### 3. MCP server tools

The NanoClaw MCP server exposes these tools (via `mcp__nanoclaw__*` prefix):
- `send_message` — send a message to the user/group
- `schedule_task` — schedule a recurring or one-time task
- `list_tasks` — list scheduled tasks
- `pause_task` — pause a scheduled task
- `resume_task` — resume a paused task
- `cancel_task` — cancel and delete a task
- `update_task` — update an existing task
- `register_group` — register a new chat/group (main only)
- `group_settings` — modify per-group settings (timezone, trigger, access control, etc.). To view settings, read `/workspace/ipc/current_settings.json`.

### 4. Container skills (Bash tools)

Check for executable tools in the container:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 5. Group settings

Read the settings snapshot directly:

```bash
cat /workspace/ipc/current_settings.json
```

This is a JSON array of objects, each with: `key`, `value`, `description`, `updatable` (whether the agent can change it), and `group_update_enabled` (whether the group is allowed to update this setting). Report each setting with its value and permission flags.

### 6. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

## Report format

Present the report as a clean, readable message. Example:

```
📋 *NanoClaw Capabilities*

*Installed Skills:*
• /agent-browser — Browse the web, fill forms, extract data
• /capabilities — This report
(list all found skills)

*Tools:*
• Core: Bash, Read, Write, Edit, Glob, Grep
• Web: WebSearch, WebFetch
• Orchestration: Task, TeamCreate, SendMessage
• MCP: send_message, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group, group_settings

*Container Tools:*
• agent-browser: ✓

*Group Settings:*
(list all from `/workspace/ipc/current_settings.json` — shows values, descriptions, and permission flags)

Settings can be changed with `group_settings set <key> <value>`.
Main group can enable/disable self-modification per group with `group_settings enable <key> true/false`.

*System:*
• Group memory: yes/no
• Extra mounts: N directories
• Main channel: yes
```

Adapt the output based on what you actually find — don't list things that aren't installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
