#!/usr/bin/env node
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const app = express();
const PORT = 3456;
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), ".claude");

if (!fs.existsSync(CLAUDE_DIR)) {
  console.error(`CLAUDE_DIR "${CLAUDE_DIR}" does not exist. Set CLAUDE_DIR in .env or ensure ~/.claude exists.`);
  process.exit(1);
}

const RATES = {
  input: parseFloat(process.env.RATE_INPUT ?? "5.0") / 1e6,
  output: parseFloat(process.env.RATE_OUTPUT ?? "25.0") / 1e6,
  cacheRead: parseFloat(process.env.RATE_CACHE_READ ?? "0.5") / 1e6,
  cacheCreate: parseFloat(process.env.RATE_CACHE_CREATE ?? "6.25") / 1e6,
};

app.use(express.static(__dirname));

// GET /api/stats — return stats-cache.json as-is
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

// GET /api/history — parse history.jsonl
app.get("/api/history", (req, res) => {
  try {
    const lines = fs
      .readFileSync(path.join(CLAUDE_DIR, "history.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const entries = lines.map((line) => {
      const obj = JSON.parse(line);
      return {
        display: obj.display,
        timestamp: obj.timestamp,
        project: obj.project,
        sessionId: obj.sessionId,
      };
    });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions — read sessions/*.json
app.get("/api/sessions", (req, res) => {
  try {
    const sessionsDir = path.join(CLAUDE_DIR, "sessions");
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"));
    const sessions = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8")),
    );
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tool-calls — aggregate tool calls from all project session JSONL files
app.get("/api/tool-calls", async (req, res) => {
  try {
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const toolCounts = {};
    const toolsByProject = {};

    const projectDirs = fs
      .readdirSync(projectsDir)
      .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

    for (const projDir of projectDirs) {
      const projPath = path.join(projectsDir, projDir);
      const jsonlFiles = findJsonlFiles(projPath);

      for (const file of jsonlFiles) {
        await parseJsonlForTools(file, projDir, toolCounts, toolsByProject);
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

// GET /api/tool-details/:toolName — return individual calls for a specific tool
app.get("/api/tool-details/:toolName", async (req, res) => {
  try {
    const toolName = req.params.toolName;
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const calls = [];

    const projectDirs = fs
      .readdirSync(projectsDir)
      .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

    for (const projDir of projectDirs) {
      const projPath = path.join(projectsDir, projDir);
      const jsonlFiles = findJsonlFiles(projPath);

      for (const file of jsonlFiles) {
        await parseJsonlForToolDetails(file, projDir, toolName, calls);
      }
    }

    calls.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects — project-level summary from history.jsonl
app.get("/api/projects", (req, res) => {
  try {
    const lines = fs
      .readFileSync(path.join(CLAUDE_DIR, "history.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());

    const projects = {};
    for (const line of lines) {
      const obj = JSON.parse(line);
      const proj = obj.project || "unknown";
      if (!projects[proj]) {
        projects[proj] = {
          messages: 0,
          sessions: new Set(),
          firstSeen: null,
          lastSeen: null,
        };
      }
      projects[proj].messages++;
      projects[proj].sessions.add(obj.sessionId);
      const ts = obj.timestamp;
      if (!projects[proj].firstSeen || ts < projects[proj].firstSeen) {
        projects[proj].firstSeen = ts;
      }
      if (!projects[proj].lastSeen || ts > projects[proj].lastSeen) {
        projects[proj].lastSeen = ts;
      }
    }

    const result = Object.entries(projects).map(([name, data]) => ({
      name,
      shortName: name.split("/").pop(),
      messages: data.messages,
      sessions: data.sessions.size,
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
    }));

    result.sort((a, b) => b.messages - a.messages);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/daily-costs — token usage and estimated cost per day
app.get("/api/daily-costs", async (req, res) => {
  try {
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const daily = {};

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

    const days = Object.keys(daily)
      .sort()
      .map((date) => {
        const d = daily[date];
        const cost =
          d.input * RATES.input +
          d.output * RATES.output +
          d.cacheRead * RATES.cacheRead +
          d.cacheCreate * RATES.cacheCreate;
        return {
          date,
          messages: d.messages,
          toolCalls: d.toolCalls,
          sessions: d.sessions.size,
          input: d.input,
          output: d.output,
          cacheRead: d.cacheRead,
          cacheCreate: d.cacheCreate,
          cost: Math.round(cost * 10000) / 10000,
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
        return acc;
      },
      {
        messages: 0,
        toolCalls: 0,
        sessions: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        cost: 0,
        models: {},
      },
    );
    totals.cost = Math.round(totals.cost * 10000) / 10000;

    for (const d of days) {
      for (const [model, count] of Object.entries(d.models || {})) {
        totals.models[model] = (totals.models[model] || 0) + count;
      }
    }

    res.json({ days, totals, rates: RATES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events — Server-Sent Events for real-time dashboard updates
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("data: connected\n\n");

  let debounce = null;
  let watcher = null;

  const notify = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try { res.write("data: refresh\n\n"); } catch {}
    }, 1500);
  };

  try {
    watcher = fs.watch(CLAUDE_DIR, { recursive: true }, notify);
  } catch {
    // recursive not supported on Linux — watch key files individually
    try {
      const histFile = path.join(CLAUDE_DIR, "history.jsonl");
      if (fs.existsSync(histFile)) fs.watch(histFile, notify);
    } catch {}
    try {
      const projDir = path.join(CLAUDE_DIR, "projects");
      if (fs.existsSync(projDir)) fs.watch(projDir, notify);
    } catch {}
  }

  req.on("close", () => {
    clearTimeout(debounce);
    if (watcher) try { watcher.close(); } catch {}
  });
});

// GET /api/session/:sessionId — full conversation thread for a session
app.get("/api/session/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const messages = [];

    const projectDirs = fs
      .readdirSync(projectsDir)
      .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

    // First try direct lookup: projects/<proj>/<sessionId>.jsonl
    let found = false;
    for (const projDir of projectDirs) {
      const candidate = path.join(projectsDir, projDir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        await parseSessionMessages(candidate, sessionId, messages);
        found = true;
        break;
      }
    }

    // Fallback: scan all JSONL files
    if (!found) {
      for (const projDir of projectDirs) {
        const projPath = path.join(projectsDir, projDir);
        const jsonlFiles = findJsonlFiles(projPath);
        for (const file of jsonlFiles) {
          await parseSessionMessages(file, sessionId, messages);
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
      } catch {
        // skip malformed lines
      }
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
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheCreate: 0,
            messages: 0,
            toolCalls: 0,
            sessions: new Set(),
            models: {},
          };
        }

        const sid = obj.sessionId || "";

        if (obj.type === "user") {
          daily[day].messages++;
          daily[day].sessions.add(sid);
        }

        if (obj.type === "assistant" && obj.message) {
          const usage = obj.message.usage || {};
          daily[day].input += usage.input_tokens || 0;
          daily[day].output += usage.output_tokens || 0;
          daily[day].cacheRead += usage.cache_read_input_tokens || 0;
          daily[day].cacheCreate += usage.cache_creation_input_tokens || 0;

          const model = obj.message.model || "unknown";
          daily[day].models[model] = (daily[day].models[model] || 0) + 1;

          const content = obj.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === "tool_use") daily[day].toolCalls++;
            }
          }
        }
      } catch {
        // skip
      }
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

function parseJsonlForToolDetails(filePath, projDir, toolName, calls) {
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
            const detail = { project: projDir, timestamp: obj.timestamp };

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
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

// Parse a JSONL file and extract messages belonging to a specific session
function parseSessionMessages(filePath, sessionId, messages) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.sessionId !== sessionId) return;
        if (obj.type !== "user" && obj.type !== "assistant") return;

        const msg = { type: obj.type, timestamp: obj.timestamp };

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
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

app.listen(PORT, () => {
  console.log(`Claude Lens running at http://localhost:${PORT}`);
});
