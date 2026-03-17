(function () {
  const state = {
    sessions: [],
    activeSessionId: null,
    fileName: null,
    fileType: null
  };

  const els = {
    dropPanel: document.getElementById("dropPanel"),
    fileInput: document.getElementById("fileInput"),
    pickFileBtn: document.getElementById("pickFileBtn"),
    pickFileBtnSecondary: document.getElementById("pickFileBtnSecondary"),
    archiveMeta: document.getElementById("archiveMeta"),
    chatHistory: document.getElementById("chatHistory"),
    chatMessages: document.getElementById("chatMessages")
  };

  bindUi();

  function bindUi() {
    els.pickFileBtn.addEventListener("click", () => els.fileInput.click());
    els.pickFileBtnSecondary.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadFile(file);
    });

    ["dragenter", "dragover"].forEach(evt => {
      els.dropPanel.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        els.dropPanel.classList.add("drag-over");
      });
    });

    ["dragleave", "dragend"].forEach(evt => {
      els.dropPanel.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        els.dropPanel.classList.remove("drag-over");
      });
    });

    els.dropPanel.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropPanel.classList.remove("drag-over");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    });
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const type = detectType(file.name, text);
        const sessions = parseExport(type, text, file.name);

        state.fileName = file.name;
        state.fileType = type;
        state.sessions = sessions;
        state.activeSessionId = sessions[0] ? sessions[0].session_id : null;

        renderSidebar();
        renderChat();
        renderMeta();
      } catch (err) {
        renderError(err && err.message ? err.message : String(err));
      }
    };
    reader.onerror = () => renderError("Failed to read file.");
    reader.readAsText(file);
  }

  function detectType(name, text) {
    const lower = String(name || "").toLowerCase();
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".csv")) return "csv";
    if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return "markdown";

    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "json";
    if (trimmed.includes(",") && trimmed.includes("session_id")) return "csv";
    return "markdown";
  }

  function parseExport(type, text, fileName) {
    if (type === "json") return normalizeJson(JSON.parse(text));
    if (type === "csv") return normalizeCsv(parseCsv(text));
    return normalizeMarkdown(text, fileName);
  }

  function normalizeJson(rows) {
    if (!Array.isArray(rows)) {
      throw new Error("JSON export must be an array of rows.");
    }
    return buildSessionsFromRows(rows);
  }

  function normalizeCsv(rows) {
    if (!rows.length) throw new Error("CSV export is empty.");
    return buildSessionsFromRows(rows);
  }

  function normalizeMarkdown(text, fileName) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const sessions = [];
    let currentSession = null;
    let currentMsg = null;
    let mode = null;

    function flushMessage() {
      if (!currentSession || !currentMsg) return;
      if (!hasValue(currentMsg.user_message) && !hasValue(currentMsg.bot_response) && !hasValue(currentMsg.thoughts)) {
        currentMsg = null;
        mode = null;
        return;
      }
      currentSession.messages.push(cleanMessage(currentMsg));
      currentMsg = null;
      mode = null;
    }

    function ensureSession(title) {
      flushMessage();
      currentSession = {
        session_id: slugify(title || "imported-chat-" + (sessions.length + 1)),
        session_name: (title || "Imported Chat " + (sessions.length + 1)).trim(),
        source: "markdown",
        messages: [],
        last_timestamp: null
      };
      sessions.push(currentSession);
    }

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (/^#\s+/.test(line) || /^##\s+Session:/i.test(line) || /^##\s+Chat:/i.test(line)) {
        const title = line
          .replace(/^##\s+Session:\s*/i, "")
          .replace(/^##\s+Chat:\s*/i, "")
          .replace(/^#\s+/, "");
        ensureSession(title);
        continue;
      }

      if (!currentSession && line.trim()) {
        ensureSession(fileName.replace(/\.[^.]+$/, ""));
      }

      if (/^###\s+User/i.test(line) || /^\*\*User:\*\*/i.test(line)) {
        flushMessage();
        currentMsg = blankMsg();
        mode = "user";
        const inline = line.replace(/^###\s+User\s*:?\s*/i, "").replace(/^\*\*User:\*\*\s*/i, "");
        if (inline) currentMsg.user_message += inline;
        continue;
      }

      if (/^###\s+Assistant/i.test(line) || /^\*\*Assistant:\*\*/i.test(line) || /^\*\*Bot:\*\*/i.test(line)) {
        if (!currentMsg) currentMsg = blankMsg();
        mode = "assistant";
        const inline = line
          .replace(/^###\s+Assistant\s*:?\s*/i, "")
          .replace(/^\*\*Assistant:\*\*\s*/i, "")
          .replace(/^\*\*Bot:\*\*\s*/i, "");
        if (inline) currentMsg.bot_response += inline;
        continue;
      }

      if (/^###\s+Thoughts/i.test(line) || /^\*\*Thoughts:\*\*/i.test(line)) {
        if (!currentMsg) currentMsg = blankMsg();
        mode = "thoughts";
        const inline = line.replace(/^###\s+Thoughts\s*:?\s*/i, "").replace(/^\*\*Thoughts:\*\*\s*/i, "");
        if (inline) currentMsg.thoughts += inline;
        continue;
      }

      if (/^\*\*Timestamp:\*\*/i.test(line)) {
        if (!currentMsg) currentMsg = blankMsg();
        currentMsg.timestamp = parseTimestamp(line.replace(/^\*\*Timestamp:\*\*\s*/i, ""));
        continue;
      }

      if (/^\*\*Model:\*\*/i.test(line)) {
        if (!currentMsg) currentMsg = blankMsg();
        currentMsg.model_used = line.replace(/^\*\*Model:\*\*\s*/i, "");
        continue;
      }

      if (!currentMsg) continue;

      if (mode === "user") {
        currentMsg.user_message += (currentMsg.user_message ? "\n" : "") + rawLine;
      } else if (mode === "assistant") {
        currentMsg.bot_response += (currentMsg.bot_response ? "\n" : "") + rawLine;
      } else if (mode === "thoughts") {
        currentMsg.thoughts += (currentMsg.thoughts ? "\n" : "") + rawLine;
      }
    }

    flushMessage();

    if (!sessions.length) {
      throw new Error("Markdown export format was not recognized.");
    }

    sessions.forEach(finalizeSession);
    return sortSessions(sessions);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (ch === '"') {
        if (inQuotes && next === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        row.push(cell);
        cell = "";
      } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
        if (ch === "\r" && next === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += ch;
      }
    }

    if (cell.length || row.length) {
      row.push(cell);
      rows.push(row);
    }

    if (!rows.length) return [];

    const headers = rows[0].map(h => h.trim());
    return rows.slice(1)
      .filter(r => r.some(v => String(v || "").trim() !== ""))
      .map(r => {
        const obj = {};
        headers.forEach((h, idx) => obj[h] = r[idx] != null ? r[idx] : "");
        return obj;
      });
  }

  function buildSessionsFromRows(rows) {
    const bySession = new Map();

    for (const raw of rows) {
      const row = normalizeRow(raw);
      if (!row.session_id) {
        row.session_id = "session-" + (row.id || cryptoId());
      }

      if (!bySession.has(row.session_id)) {
        bySession.set(row.session_id, {
          session_id: row.session_id,
          session_name: row.session_name || null,
          source: "flat-export",
          messages: [],
          last_timestamp: null
        });
      }

      const session = bySession.get(row.session_id);

      if (!session.session_name && row.session_name) {
        session.session_name = row.session_name;
      }

      const isHeaderish =
        !hasValue(row.user_message) &&
        !hasValue(row.bot_response) &&
        !hasValue(row.thoughts);

      if (!isHeaderish) {
        session.messages.push(cleanMessage(row));
      }

      const ts = toNumber(row.timestamp);
      if (ts && (!session.last_timestamp || ts > session.last_timestamp)) {
        session.last_timestamp = ts;
      }
    }

    const sessions = Array.from(bySession.values());
    sessions.forEach(finalizeSession);
    return sortSessions(sessions);
  }

  function normalizeRow(raw) {
    return {
      id: pick(raw, ["id", "ID"]),
      session_id: pick(raw, ["session_id", "sessionId", "chat_id", "chatId"]),
      session_name: pick(raw, ["session_name", "sessionName", "chat_name", "chatName"]),
      user_message: pick(raw, ["user_message", "userMessage", "prompt", "user"]),
      bot_response: pick(raw, ["bot_response", "botResponse", "response", "assistant"]),
      thoughts: pick(raw, ["thoughts", "reasoning", "thinking"]),
      timestamp: parseTimestamp(pick(raw, ["timestamp", "time", "created_at", "createdAt"])),
      model_used: pick(raw, ["model_used", "modelUsed", "model"]),
      prompt_id: pick(raw, ["prompt_id", "promptId"]),
      response_time: toNumber(pick(raw, ["response_time", "responseTime"])),
      total_tokens: toNumber(pick(raw, ["total_tokens", "totalTokens"])),
      tps: toNumber(pick(raw, ["tps"])),
      prompt_eval_tps: toNumber(pick(raw, ["prompt_eval_tps", "promptEvalTps"]))
    };
  }

  function cleanMessage(row) {
    return {
      id: row.id || cryptoId(),
      user_message: toStringOrNull(row.user_message),
      bot_response: toStringOrNull(row.bot_response),
      thoughts: toStringOrNull(row.thoughts),
      timestamp: parseTimestamp(row.timestamp),
      model_used: toStringOrNull(row.model_used),
      prompt_id: toStringOrNull(row.prompt_id),
      response_time: toNumber(row.response_time),
      total_tokens: toNumber(row.total_tokens),
      tps: toNumber(row.tps),
      prompt_eval_tps: toNumber(row.prompt_eval_tps)
    };
  }

  function finalizeSession(session) {
    session.messages.sort((a, b) => {
      const ta = toNumber(a.timestamp) || 0;
      const tb = toNumber(b.timestamp) || 0;
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });

    if (!session.session_name) {
      const firstPrompt = session.messages.find(m => m.user_message);
      session.session_name = firstPrompt ? firstPrompt.user_message.slice(0, 48) : session.session_id;
    }

    if (!session.last_timestamp) {
      session.last_timestamp = Math.max(0, ...session.messages.map(m => toNumber(m.timestamp) || 0)) || null;
    }
  }

  function sortSessions(sessions) {
    return sessions.sort((a, b) => (toNumber(b.last_timestamp) || 0) - (toNumber(a.last_timestamp) || 0));
  }

  function renderMeta() {
    els.archiveMeta.innerHTML = `
      <div><b>File:</b> ${escapeHtml(state.fileName || "—")}</div>
      <div><b>Type:</b> ${escapeHtml((state.fileType || "").toUpperCase() || "—")}</div>
      <div><b>Chats:</b> ${state.sessions.length}</div>
    `;
  }

  function renderSidebar() {
    els.chatHistory.innerHTML = "";

    if (!state.sessions.length) {
      els.chatHistory.innerHTML = `<li><span>No chats found.</span></li>`;
      return;
    }

    state.sessions.forEach(session => {
      const li = document.createElement("li");
      if (session.session_id === state.activeSessionId) {
        li.classList.add("archive-session-active");
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "archive-session-btn";
      btn.innerHTML = `
        <div class="archive-session-name">${escapeHtml(session.session_name || session.session_id)}</div>
        <div class="archive-session-sub">
          <span>${session.messages.length} rows</span>
          <span>${escapeHtml(formatTimestamp(session.last_timestamp))}</span>
        </div>
      `;
      btn.addEventListener("click", () => {
        state.activeSessionId = session.session_id;
        renderSidebar();
        renderChat();
      });

      li.appendChild(btn);
      els.chatHistory.appendChild(li);
    });
  }

  function renderChat() {
    const session = state.sessions.find(s => s.session_id === state.activeSessionId);

    if (!session) {
      els.chatMessages.innerHTML = `
        <div class="archive-empty-state">
          <h2>No chat selected</h2>
          <p>Select a chat from the archive sidebar.</p>
        </div>
      `;
      return;
    }

    let html = `
      <div class="archive-chat-heading">
        <h2>${escapeHtml(session.session_name || session.session_id)}</h2>
        <p>
          <span class="archive-file-pill">${escapeHtml(session.session_id)}</span>
          &nbsp; Read-only archive view
        </p>
      </div>
    `;

    session.messages.forEach(msg => {
      const meta = [];
      if (msg.timestamp) meta.push(`<span>${escapeHtml(formatTimestamp(msg.timestamp))}</span>`);
      if (msg.model_used) meta.push(`<span>${escapeHtml(shortModel(msg.model_used))}</span>`);
      if (msg.prompt_id) meta.push(`<span>Prompt ID: ${escapeHtml(msg.prompt_id)}</span>`);

      html += `<div class="archive-row-meta">${meta.join("")}</div>`;
      html += `<div class="archive-bubble-wrap">`;

      if (msg.user_message) {
        html += `
          <div class="chat-bubble user">
            <div class="archive-bubble-body">${renderRich(msg.user_message)}</div>
          </div>
        `;
      }

      if (msg.bot_response) {
        html += `
          <div class="chat-bubble bot">
            <div class="archive-bubble-body">${renderRich(msg.bot_response)}</div>
            ${msg.thoughts ? `
              <details class="thoughts archive-thoughts">
                <summary>Show Thoughts</summary>
                <div class="thoughts-content">${escapeHtml(msg.thoughts)}</div>
              </details>
            ` : ""}
            <div class="archive-footer">
              ${msg.tps != null ? `TPS: ${escapeHtml(String(msg.tps))} &nbsp;` : ""}
              ${msg.total_tokens != null ? `Tokens: ${escapeHtml(String(msg.total_tokens))} &nbsp;` : ""}
              ${msg.response_time != null ? `Time: ${escapeHtml(String(msg.response_time))}s` : ""}
            </div>
          </div>
        `;
      }

      html += `</div>`;
    });

    els.chatMessages.innerHTML = html;
    const chatContainer = document.querySelector(".archive-chat-container");
    if (chatContainer) chatContainer.scrollTop = 0;
  }

  function renderError(message) {
    state.sessions = [];
    state.activeSessionId = null;
    els.chatHistory.innerHTML = `<li><span>Import failed</span></li>`;
    els.archiveMeta.textContent = "Import failed.";
    els.chatMessages.innerHTML = `
      <div class="archive-empty-state">
        <h2>Import failed</h2>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }

  function renderRich(text) {
    const raw = String(text || "");
    if (!raw) return "";

    if (window.marked && typeof window.marked.parse === "function") {
      try {
        return window.marked.parse(raw);
      } catch (_) {}
    }

    return `<div class="streaming-plain">${escapeHtml(raw).replace(/\n/g, "<br>")}</div>`;
  }

  function pick(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== "") return obj[k];
    }
    return null;
  }

  function parseTimestamp(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return Number(s);
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    return null;
  }

  function toNumber(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function hasValue(v) {
    return v != null && String(v).trim() !== "";
  }

  function toStringOrNull(v) {
    if (v == null) return null;
    const s = String(v);
    return s === "" ? null : s;
  }

  function formatTimestamp(ts) {
    const n = toNumber(ts);
    if (!n) return "Unknown time";
    try {
      return new Date(n * 1000).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  }

  function shortModel(path) {
    const parts = String(path || "").split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }

  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || cryptoId();
  }

  function cryptoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + "-" + Date.now();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();