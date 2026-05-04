#!/usr/bin/env node
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const app = express();
const PORT = 3456;
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), ".claude");
const REMOTE_DIR = process.env.REMOTE_DIR || path.join(os.homedir(), ".claude-remote", "burak");
const REMOTE_HOST = process.env.REMOTE_HOST || "burak-jump-host-local";
const REMOTE_CLAUDE_PATH = process.env.REMOTE_CLAUDE_PATH || "~/.claude/";

if (!fs.existsSync(CLAUDE_DIR)) {
  console.error(`CLAUDE_DIR "${CLAUDE_DIR}" does not exist. Set CLAUDE_DIR in .env or ensure ~/.claude exists.`);
  process.exit(1);
}

// Per-model-family rates ($/MTok → $/token after dividing by 1e6)
const MODEL_RATES = {
  haiku: {
    input:      parseFloat(process.env.RATE_HAIKU_INPUT       ?? "1.0")  / 1e6,
    output:     parseFloat(process.env.RATE_HAIKU_OUTPUT      ?? "5.0")  / 1e6,
    cacheWrite: parseFloat(process.env.RATE_HAIKU_CACHE_WRITE ?? "1.25") / 1e6,
    cacheRead:  parseFloat(process.env.RATE_HAIKU_CACHE_READ  ?? "0.10") / 1e6,
  },
  sonnet: {
    input:      parseFloat(process.env.RATE_SONNET_INPUT       ?? "3.0")  / 1e6,
    output:     parseFloat(process.env.RATE_SONNET_OUTPUT      ?? "15.0") / 1e6,
    cacheWrite: parseFloat(process.env.RATE_SONNET_CACHE_WRITE ?? "3.75") / 1e6,
    cacheRead:  parseFloat(process.env.RATE_SONNET_CACHE_READ  ?? "0.30") / 1e6,
  },
  opus: {
    input:      parseFloat(process.env.RATE_OPUS_INPUT       ?? "5.0")  / 1e6,
    output:     parseFloat(process.env.RATE_OPUS_OUTPUT      ?? "25.0") / 1e6,
    cacheWrite: parseFloat(process.env.RATE_OPUS_CACHE_WRITE ?? "6.25") / 1e6,
    cacheRead:  parseFloat(process.env.RATE_OPUS_CACHE_READ  ?? "0.50") / 1e6,
  },
};

function getRates(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku"))  return MODEL_RATES.haiku;
  if (m.includes("sonnet")) return MODEL_RATES.sonnet;
  if (m.includes("opus"))   return MODEL_RATES.opus;
  return MODEL_RATES.sonnet; // safe default for unknown models
}

// Track sync state
let syncState = { running: false, lastSync: null, error: null };

/**
 * Returns all active source directories to read from.
 * Always includes local. Includes remote if it exists and has been synced.
 */
function getSourceDirs() {
  const sources = [{ dir: CLAUDE_DIR, node: "local" }];
  if (fs.existsSync(REMOTE_DIR) && fs.existsSync(path.join(REMOTE_DIR, "history.jsonl"))) {
    sources.push({ dir: REMOTE_DIR, node: "burak" });
  }
  return sources;
}

app.use(express.static(__dirname));

// GET /api/remote-status — sync state and whether remote data is available
app.get("/api/remote-status", (req, res) => {
  const remoteAvailable = fs.existsSync(REMOTE_DIR) &&
    fs.existsSync(path.join(REMOTE_DIR, "history.jsonl"));
  res.json({
    remoteAvailable,
    running: syncState.running,
    lastSync: syncState.lastSync,
    error: syncState.error,
    remoteHost: REMOTE_HOST,
  });
});

// POST /api/sync-remote — rsync from remote host into REMOTE_DIR
app.post("/api/sync-remote", (req, res) => {
  if (syncState.running) {
    return res.json({ status: "already_running" });
  }

  // Ensure target directory exists
  fs.mkdirSync(REMOTE_DIR, { recursive: true });

  syncState.running = true;
  syncState.error = null;

  const args = [
    "-az",
    "--delete",
    "-e", "ssh",
    `${REMOTE_HOST}:${REMOTE_CLAUDE_PATH}`,
    `${REMOTE_DIR}/`,
  ];

  const proc = spawn("rsync", args);

  proc.on("close", (code) => {
    syncState.running = false;
    if (code === 0) {
      syncState.lastSync = new Date().toISOString();
      syncState.error = null;
    } else {
      syncState.error = `rsync exited with code ${code}`;
    }
  });

  proc.on("error", (err) => {
    syncState.running = false;
    syncState.error = err.message;
  });

  res.json({ status: "started" });
});

// GET /api/stats — return stats-cache.json (local only; remote may not have it)
app.get("/api/stats", (req, res) => {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(CLAUDE_DIR, "stats-cache.json"), "utf8"),
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history — parse history.jsonl from all sources
app.get("/api/history", (req, res) => {
  try {
    const entries = [];
    for (const { dir, node } of getSourceDirs()) {
      const histFile = path.join(dir, "history.jsonl");
      if (!fs.existsSync(histFile)) continue;
      const lines = fs.readFileSync(histFile, "utf8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          entries.push({
            display: obj.display,
            timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
            project: obj.project,
            sessionId: obj.sessionId,
            node,
          });
        } catch {}
      }
    }
    entries.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions — read sessions/*.json from all sources
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = [];
    for (const { dir, node } of getSourceDirs()) {
      const sessionsDir = path.join(dir, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8"));
        sessions.push({ ...s, node });
      }
    }
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tool-calls — aggregate tool calls from all sources
app.get("/api/tool-calls", async (req, res) => {
  try {
    const toolCounts = {};
    const toolsByProject = {};

    for (const { dir, node } of getSourceDirs()) {
      const projectsDir = path.join(dir, "projects");
      if (!fs.existsSync(projectsDir)) continue;

      const projectDirs = fs
        .readdirSync(projectsDir)
        .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

      for (const projDir of projectDirs) {
        const projPath = path.join(projectsDir, projDir);
        const jsonlFiles = findJsonlFiles(projPath);
        const projKey = `${node}:${projDir}`;
        for (const file of jsonlFiles) {
          await parseJsonlForTools(file, projKey, toolCounts, toolsByProject);
        }
      }
    }

    const sorted = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, count]) => ({ tool, count }));

    res.json({ tools: sorted, byProject: toolsByProject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tool-details/:toolName — return individual calls for a specific tool across all sources
app.get("/api/tool-details/:toolName", async (req, res) => {
  try {
    const toolName = req.params.toolName;
    const calls = [];

    for (const { dir, node } of getSourceDirs()) {
      const projectsDir = path.join(dir, "projects");
      if (!fs.existsSync(projectsDir)) continue;

      const projectDirs = fs
        .readdirSync(projectsDir)
        .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

      for (const projDir of projectDirs) {
        const projPath = path.join(projectsDir, projDir);
        const jsonlFiles = findJsonlFiles(projPath);
        for (const file of jsonlFiles) {
          await parseJsonlForToolDetails(file, projDir, toolName, calls, node);
        }
      }
    }

    calls.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects — project-level summary from all sources
app.get("/api/projects", (req, res) => {
  try {
    const projects = {};

    for (const { dir, node } of getSourceDirs()) {
      const histFile = path.join(dir, "history.jsonl");
      if (!fs.existsSync(histFile)) continue;

      const lines = fs.readFileSync(histFile, "utf8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const obj = JSON.parse(line);
        const proj = obj.project || "unknown";
        const key = `${node}:${proj}`;
        if (!projects[key]) {
          projects[key] = {
            name: proj,
            node,
            messages: 0,
            sessions: new Set(),
            firstSeen: null,
            lastSeen: null,
          };
        }
        projects[key].messages++;
        projects[key].sessions.add(obj.sessionId);
        const ts = obj.timestamp;
        if (!projects[key].firstSeen || ts < projects[key].firstSeen) projects[key].firstSeen = ts;
        if (!projects[key].lastSeen || ts > projects[key].lastSeen) projects[key].lastSeen = ts;
      }
    }

    const result = Object.values(projects).map((data) => ({
      name: data.name,
      shortName: data.name.split("/").pop(),
      messages: data.messages,
      sessions: data.sessions.size,
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
      node: data.node,
    }));

    result.sort((a, b) => b.messages - a.messages);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/daily-costs — token usage and estimated cost per day merged across all sources
// Optional ?node=local|burak to filter to a specific node
app.get("/api/daily-costs", async (req, res) => {
  try {
    const nodeFilter = req.query.node || null;
    const daily = {};

    for (const { dir, node } of getSourceDirs()) {
      if (nodeFilter && node !== nodeFilter) continue;
      const projectsDir = path.join(dir, "projects");
      if (!fs.existsSync(projectsDir)) continue;

      const projectDirs = fs
        .readdirSync(projectsDir)
        .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

      for (const projDir of projectDirs) {
        const projPath = path.join(projectsDir, projDir);
        const jsonlFiles = findJsonlFiles(projPath);
        for (const file of jsonlFiles) {
          await parseDailyCosts(file, daily);
        }
      }
    }

    const days = Object.keys(daily)
      .sort()
      .map((date) => {
        const d = daily[date];
        return {
          date,
          messages: d.messages,
          toolCalls: d.toolCalls,
          sessions: d.sessions.size,
          input: d.input,
          output: d.output,
          cacheRead: d.cacheRead,
          cacheCreate: d.cacheCreate,
          cost: Math.round(d.cost * 10000) / 10000,
          noCacheCost: Math.round(d.noCacheCost * 10000) / 10000,
          models: d.models,
        };
      });

    const totals = days.reduce(
      (acc, d) => {
        acc.messages += d.messages;
        acc.toolCalls += d.toolCalls;
        acc.sessions += d.sessions;
        acc.input += d.input;
        acc.output += d.output;
        acc.cacheRead += d.cacheRead;
        acc.cacheCreate += d.cacheCreate;
        acc.cost += d.cost;
        acc.noCacheCost += d.noCacheCost;
        return acc;
      },
      { messages: 0, toolCalls: 0, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0, noCacheCost: 0, models: {} },
    );
    totals.cost = Math.round(totals.cost * 10000) / 10000;

    for (const d of days) {
      for (const [model, count] of Object.entries(d.models || {})) {
        totals.models[model] = (totals.models[model] || 0) + count;
      }
    }

    res.json({ days, totals, rates: MODEL_RATES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events — SSE for real-time updates (watches both local and remote dirs)
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("data: connected\n\n");

  let debounce = null;
  const watchers = [];

  const notify = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try { res.write("data: refresh\n\n"); } catch {}
    }, 1500);
  };

  for (const { dir } of [{ dir: CLAUDE_DIR }, { dir: REMOTE_DIR }]) {
    if (!fs.existsSync(dir)) continue;
    try {
      watchers.push(fs.watch(dir, { recursive: true }, notify));
    } catch {
      try {
        const histFile = path.join(dir, "history.jsonl");
        if (fs.existsSync(histFile)) watchers.push(fs.watch(histFile, notify));
      } catch {}
    }
  }

  req.on("close", () => {
    clearTimeout(debounce);
    for (const w of watchers) try { w.close(); } catch {}
  });
});

// GET /api/session/:sessionId — full conversation thread, checks all sources
app.get("/api/session/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const messages = [];

    for (const { dir, node } of getSourceDirs()) {
      const projectsDir = path.join(dir, "projects");
      if (!fs.existsSync(projectsDir)) continue;

      const projectDirs = fs
        .readdirSync(projectsDir)
        .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

      let found = false;
      for (const projDir of projectDirs) {
        const candidate = path.join(projectsDir, projDir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          await parseSessionMessages(candidate, sessionId, messages, node);
          found = true;
          break;
        }
      }

      if (!found) {
        for (const projDir of projectDirs) {
          const projPath = path.join(projectsDir, projDir);
          const jsonlFiles = findJsonlFiles(projPath);
          for (const file of jsonlFiles) {
            await parseSessionMessages(file, sessionId, messages, node);
          }
        }
      }
    }

    messages.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findJsonlFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseJsonlForTools(filePath, projDir, toolCounts, toolsByProject) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "assistant" || !obj.message) return;
        const content = obj.message.content;
        if (!Array.isArray(content)) return;

        for (const item of content) {
          if (item.type === "tool_use") {
            const tool = item.name;
            toolCounts[tool] = (toolCounts[tool] || 0) + 1;
            if (!toolsByProject[projDir]) toolsByProject[projDir] = {};
            toolsByProject[projDir][tool] = (toolsByProject[projDir][tool] || 0) + 1;
          }
        }
      } catch {}
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

function parseDailyCosts(filePath, daily) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        const ts = obj.timestamp;
        if (!ts) return;
        const day = ts.slice(0, 10);

        if (!daily[day]) {
          daily[day] = {
            input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
            messages: 0, toolCalls: 0, sessions: new Set(), models: {},
            cost: 0, noCacheCost: 0,
          };
        }

        const sid = obj.sessionId || "";

        if (obj.type === "user") {
          daily[day].messages++;
          daily[day].sessions.add(sid);
        }

        if (obj.type === "assistant" && obj.message) {
          const usage = obj.message.usage || {};
          const model = obj.message.model || "unknown";
          const rates = getRates(model);

          const inp   = usage.input_tokens || 0;
          const out   = usage.output_tokens || 0;
          const cRead = usage.cache_read_input_tokens || 0;
          const cWrit = usage.cache_creation_input_tokens || 0;

          daily[day].input      += inp;
          daily[day].output     += out;
          daily[day].cacheRead  += cRead;
          daily[day].cacheCreate+= cWrit;
          daily[day].cost       += inp * rates.input + out * rates.output
                                 + cRead * rates.cacheRead + cWrit * rates.cacheWrite;
          // what this day would have cost with no caching (all tokens at full input rate)
          daily[day].noCacheCost += (inp + cRead + cWrit) * rates.input + out * rates.output;

          daily[day].models[model] = (daily[day].models[model] || 0) + 1;

          const content = obj.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === "tool_use") daily[day].toolCalls++;
            }
          }
        }
      } catch {}
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

function parseJsonlForToolDetails(filePath, projDir, toolName, calls, node) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "assistant" || !obj.message) return;
        const content = obj.message.content;
        if (!Array.isArray(content)) return;

        for (const item of content) {
          if (item.type === "tool_use" && item.name === toolName) {
            const input = item.input || {};
            const detail = { project: projDir, timestamp: obj.timestamp, node };

            if (toolName === "Bash") {
              detail.command = input.command || "";
              detail.description = input.description || "";
            } else if (toolName === "Read") {
              detail.file_path = input.file_path || "";
            } else if (toolName === "Edit") {
              detail.file_path = input.file_path || "";
            } else if (toolName === "Write") {
              detail.file_path = input.file_path || "";
            } else if (toolName === "Grep") {
              detail.pattern = input.pattern || "";
              detail.path = input.path || "";
              detail.glob = input.glob || "";
            } else if (toolName === "Glob") {
              detail.pattern = input.pattern || "";
              detail.path = input.path || "";
            } else if (toolName === "Agent") {
              detail.description = input.description || "";
              detail.subagent_type = input.subagent_type || "";
            } else {
              detail.input = JSON.stringify(input).slice(0, 200);
            }

            calls.push(detail);
          }
        }
      } catch {}
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

function parseSessionMessages(filePath, sessionId, messages, node) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.sessionId !== sessionId) return;
        if (obj.type !== "user" && obj.type !== "assistant") return;

        const msg = { type: obj.type, timestamp: obj.timestamp, node };

        if (obj.type === "user" && obj.message) {
          const content = obj.message.content;
          if (typeof content === "string") {
            msg.text = content.slice(0, 3000);
          } else if (Array.isArray(content)) {
            msg.text = content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n")
              .slice(0, 3000);
            msg.hasAttachment = content.some((c) => c.type !== "text" && c.type !== "tool_result");
          }
        } else if (obj.type === "assistant" && obj.message) {
          const content = obj.message.content;
          if (Array.isArray(content)) {
            msg.text = content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n")
              .slice(0, 3000);
            msg.toolUses = content
              .filter((c) => c.type === "tool_use")
              .map((c) => ({
                name: c.name,
                summary: JSON.stringify(c.input || {}).slice(0, 120),
              }));
          }
          msg.model = obj.message.model;
          const usage = obj.message.usage || {};
          msg.tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
        }

        messages.push(msg);
      } catch {}
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

app.listen(PORT, () => {
  console.log(`Claude Lens running at http://localhost:${PORT}`);
});
