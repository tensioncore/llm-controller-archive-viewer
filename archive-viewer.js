(function () {
  const state = {
    sessions: [],
    activeSessionId: null,
    fileName: null,
    fileType: null,
    attachmentCache: new Map(),
    imageCache: new Map(),
    loadId: 0
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
    const preview = document.getElementById("imagePreview");
    document.getElementById("imagePreviewClose").addEventListener("click", closeImagePreview);
    preview.addEventListener("close", () => document.getElementById("imagePreviewImage").removeAttribute("src"));
    preview.addEventListener("click", event => { if (event.target === preview) closeImagePreview(); });
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
    const loadId = ++state.loadId;
    const reader = new FileReader();
    reader.onload = () => {
      if (loadId !== state.loadId) return;
      try {
        const text = String(reader.result || "").replace(/^\uFEFF/, "");
        const type = detectType(file.name, text);
        const sessions = parseExport(type, text, file.name);

        state.attachmentCache.clear();
        state.imageCache.clear();
        closeImagePreview();
        state.fileName = file.name;
        state.fileType = type;
        state.sessions = sessions;
        state.activeSessionId = sessions[0] ? sessions[0].key : null;

        renderSidebar();
        renderChat();
        renderMeta();
      } catch (err) {
        renderError(err && err.message ? err.message : String(err));
      }
    };
    reader.onerror = () => { if (loadId === state.loadId) renderError("Failed to read file."); };
    els.fileInput.value = "";
    reader.readAsText(file);
  }

  function detectType(name, text) {
    const lower = String(name || "").toLowerCase();
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".csv")) return "csv";
    if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return "markdown";

    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "json";
    if (/llm-controller-markdown-export:\s*escaped-table-v1/i.test(trimmed)) return "markdown";
    if (trimmed.includes(",") && trimmed.includes("session_id")) return "csv";
    return "markdown";
  }

  function parseExport(type, text, fileName) {
    if (type === "json") return normalizeJson(JSON.parse(text));
    if (type === "csv") return normalizeCsv(parseCsv(text));
    return normalizeMarkdown(text, fileName);
  }

  function normalizeJson(payload) {
    if (Array.isArray(payload)) return buildSessionsFromRows(payload);
    if (!payload || payload.format !== "llm-controller-ce-chat-backup") {
      throw new Error("Expected a CE chat backup or a legacy JSON array of chat rows.");
    }
    if (payload.version !== 1) throw new Error("Unsupported CE chat backup version: " + payload.version);
    for (const field of ["chats", "projects", "chat_sessions"]) {
      if (!Array.isArray(payload[field])) throw new Error("CE chat backup requires a " + field + " array.");
    }
    const sessions = buildSessionsFromRows(payload.chats);
    const bySession = new Map(sessions.map(session => [session.key, session]));
    const projects = new Map();
    payload.projects.forEach(project => {
      if (!isRecord(project)) throw new Error("Invalid project record in CE backup.");
      projects.set(sessionKey(project.user_id, project.id), project);
    });
    payload.chat_sessions.forEach(mapping => {
      if (!isRecord(mapping) || !hasValue(mapping.session_id)) throw new Error("Invalid conversation mapping in CE backup.");
      const key = sessionKey(mapping.user_id, mapping.session_id);
      let session = bySession.get(key);
      if (!session) {
        session = { key, session_id: String(mapping.session_id), user_id: toStringOrNull(mapping.user_id), messages: [] };
        finalizeSession(session);
        sessions.push(session);
        bySession.set(key, session);
      }
      session.project_id = mapping.project_id;
      session.project = projects.get(sessionKey(mapping.user_id, mapping.project_id));
    });
    return sortSessions(sessions);
  }

  function normalizeCsv(rows) {
    return buildSessionsFromRows(rows);
  }

  function normalizeMarkdown(text, fileName) {
    const tableRows = parseCoreMarkdownTable(text);
    if (tableRows) return buildSessionsFromRows(tableRows);

    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const sessions = [];
    let currentSession = null;
    let currentMsg = null;
    let mode = null;
    let recognized = false;

    function flushMessage() {
      if (!currentSession || !currentMsg) return;
      if (
        !hasValue(currentMsg.user_message) &&
        !hasValue(currentMsg.bot_response) &&
        !hasValue(currentMsg.thoughts) &&
        !hasAttachmentContext(currentMsg.attachment_context)
      ) {
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
        session_id: slugify(title || "imported-chat") + "-" + (sessions.length + 1),
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
        recognized = true;
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
        recognized = true;
        flushMessage();
        currentMsg = blankMsg();
        mode = "user";
        const inline = line.replace(/^###\s+User\s*:?\s*/i, "").replace(/^\*\*User:\*\*\s*/i, "");
        if (inline) currentMsg.user_message += inline;
        continue;
      }

      if (/^###\s+Assistant/i.test(line) || /^\*\*Assistant:\*\*/i.test(line) || /^\*\*Bot:\*\*/i.test(line)) {
        recognized = true;
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
        recognized = true;
        if (!currentMsg) currentMsg = blankMsg();
        mode = "thoughts";
        const inline = line.replace(/^###\s+Thoughts\s*:?\s*/i, "").replace(/^\*\*Thoughts:\*\*\s*/i, "");
        if (inline) currentMsg.thoughts += inline;
        continue;
      }

      if (/^###\s+Attachment Context/i.test(line) || /^\*\*Attachment Context:\*\*/i.test(line) || /^\*\*attachment_context:\*\*/i.test(line) || /^attachment_context\s*:/i.test(line)) {
        recognized = true;
        if (!currentMsg) currentMsg = blankMsg();
        mode = "attachment_context";
        const inline = line
          .replace(/^###\s+Attachment Context\s*:?\s*/i, "")
          .replace(/^\*\*Attachment Context:\*\*\s*/i, "")
          .replace(/^\*\*attachment_context:\*\*\s*/i, "")
          .replace(/^attachment_context\s*:\s*/i, "");
        if (inline) currentMsg.attachment_context += inline;
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
      } else if (mode === "attachment_context") {
        currentMsg.attachment_context += (currentMsg.attachment_context ? "\n" : "") + rawLine;
      }
    }

    flushMessage();

    if (!sessions.length || !recognized) {
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

    if (inQuotes) throw new Error("CSV contains an unterminated quoted field.");
    if (!rows.length) throw new Error("CSV export is empty.");

    const headers = rows[0].map(h => h.trim());
    if (!isChatRow(Object.fromEntries(headers.map(header => [header, ""])))) {
      throw new Error("CSV headers do not contain recognized conversation or message fields.");
    }
    return rows.slice(1)
      .filter(r => r.some(v => String(v || "").trim() !== ""))
      .map(r => {
        const obj = {};
        headers.forEach((h, idx) => obj[h] = r[idx] != null ? r[idx] : "");
        return obj;
      });
  }

  function parseCoreMarkdownTable(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const escapedCoreTable = /llm-controller-markdown-export:\s*escaped-table-v1/i.test(String(text || ""));
    const firstTableLine = lines.findIndex(line => isMarkdownTableRow(line));
    if (firstTableLine < 0) return null;

    const headerLine = lines[firstTableLine];
    const separatorLine = lines[firstTableLine + 1] || "";
    if (!isMarkdownTableRow(headerLine) || !isMarkdownTableSeparator(separatorLine)) {
      return null;
    }

    const headers = splitMarkdownTableRow(headerLine).map(h => h.trim());
    if (!isCoreExportHeader(headers)) return null;

    const rows = [];
    for (let i = firstTableLine + 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (!isMarkdownTableRow(line)) break;

      let cells = splitMarkdownTableRow(line);
      if (!cells.length) continue;
      if (cells.length > headers.length) {
        cells = cells.slice(0, headers.length - 1).concat(cells.slice(headers.length - 1).join("|"));
      }

      const row = {};
      headers.forEach((header, idx) => {
        const cell = cells[idx] != null ? cells[idx] : "";
        row[header] = escapedCoreTable ? decodeMarkdownTableCell(cell) : cell.trim();
      });
      rows.push(row);
    }

    return rows;
  }

  function isCoreExportHeader(headers) {
    const names = new Set(headers);
    return names.has("session_id") && names.has("user_message") && names.has("bot_response");
  }

  function isMarkdownTableRow(line) {
    const trimmed = String(line || "").trim();
    return trimmed.startsWith("|") && trimmed.endsWith("|");
  }

  function isMarkdownTableSeparator(line) {
    if (!isMarkdownTableRow(line)) return false;
    const cells = splitMarkdownTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
  }

  function splitMarkdownTableRow(line) {
    let raw = String(line || "").trim();
    if (raw.startsWith("|")) raw = raw.slice(1);
    if (raw.endsWith("|")) raw = raw.slice(0, -1);

    const cells = [];
    let cell = "";
    let escaped = false;

    for (const ch of raw) {
      if (ch === "|" && !escaped) {
        cells.push(cell);
        cell = "";
        continue;
      }

      cell += ch;
      if (ch === "\\" && !escaped) {
        escaped = true;
      } else {
        escaped = false;
      }
    }

    cells.push(cell);
    return cells;
  }

  function decodeMarkdownTableCell(cell) {
    const raw = String(cell || "");
    let out = "";

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch !== "\\" || i === raw.length - 1) {
        out += ch;
        continue;
      }

      const next = raw[++i];
      if (next === "n") {
        out += "\n";
      } else if (next === "r") {
        out += "\r";
      } else if (next === "|" || next === "\\") {
        out += next;
      } else {
        out += next;
      }
    }

    return out;
  }

  function buildSessionsFromRows(rows) {
    const bySession = new Map();

    for (const raw of rows) {
      if (!isChatRow(raw)) {
        throw new Error("Archive contains an unrecognized chat row.");
      }
      const row = normalizeRow(raw);
      if (!row.session_id) {
        row.session_id = "session-" + (row.id || cryptoId());
      }

      const key = sessionKey(row.user_id, row.session_id);
      if (!bySession.has(key)) {
        bySession.set(key, {
          key,
          user_id: toStringOrNull(row.user_id),
          session_id: String(row.session_id),
          session_name: row.session_name || null,
          source: "flat-export",
          messages: [],
          last_timestamp: null
        });
      }

      const session = bySession.get(key);

      if (!session.session_name && row.session_name) {
        session.session_name = row.session_name;
      }

      const isHeaderish =
        !hasValue(row.user_message) &&
        !hasValue(row.bot_response) &&
        !hasValue(row.thoughts) &&
        !hasAttachmentContext(row.attachment_context) &&
        !hasValue(row.turn_id) && !hasValue(row.prompt_id);

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
      user_id: pick(raw, ["user_id", "userId"]),
      id: pick(raw, ["id", "ID"]),
      session_id: pick(raw, ["session_id", "sessionId", "chat_id", "chatId"]),
      session_name: pick(raw, ["session_name", "sessionName", "chat_name", "chatName"]),
      user_message: pick(raw, ["user_message", "userMessage", "prompt", "user"]),
      bot_response: pick(raw, ["bot_response", "botResponse", "response", "assistant"]),
      thoughts: pick(raw, ["thoughts", "reasoning", "thinking"]),
      attachment_context: pick(raw, ["attachment_context", "attachmentContext"]),
      timestamp: parseTimestamp(pick(raw, ["timestamp", "time", "created_at", "createdAt"])),
      model_used: pick(raw, ["model_used", "modelUsed", "model"]),
      prompt_id: pick(raw, ["prompt_id", "promptId"]),
      turn_id: pick(raw, ["turn_id", "turnId"]),
      prompt_version: pick(raw, ["prompt_version", "promptVersion"]),
      response_version: pick(raw, ["response_version", "responseVersion"]),
      active_in_chat: pick(raw, ["active_in_chat", "activeInChat"]),
      source_row_id: pick(raw, ["source_row_id", "sourceRowId"]),
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
      attachment_context: normalizeAttachmentContext(row.attachment_context),
      timestamp: parseTimestamp(row.timestamp),
      model_used: toStringOrNull(row.model_used),
      prompt_id: toStringOrNull(row.prompt_id),
      turn_id: toStringOrNull(row.turn_id),
      prompt_version: normalizeVersion(row.prompt_version),
      response_version: normalizeVersion(row.response_version),
      active_in_chat: normalizeActiveInChat(row.active_in_chat),
      source_row_id: toStringOrNull(row.source_row_id),
      response_time: toNumber(row.response_time),
      total_tokens: toNumber(row.total_tokens),
      tps: toNumber(row.tps),
      prompt_eval_tps: toNumber(row.prompt_eval_tps)
    };
  }

  function finalizeSession(session) {
    session.key = session.key || sessionKey(session.user_id, session.session_id);
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
      session.last_timestamp = session.messages.reduce((latest, msg) => Math.max(latest, toNumber(msg.timestamp) || 0), 0) || null;
    }
    // A CE turn holds every prompt edit and response regeneration. Source rows
    // describe revision ancestry, not additional chronological conversation turns.
    const turns = new Map();
    session.messages.forEach((msg, index) => {
      const key = msg.turn_id ? "turn:" + msg.turn_id : "row:" + index;
      if (!turns.has(key)) turns.set(key, { messages: [], selected: 0 });
      turns.get(key).messages.push(msg);
    });
    session.turns = Array.from(turns.values());
    session.turns.forEach(turn => {
      turn.messages.sort((a, b) => (toNumber(a.prompt_version) || 0) - (toNumber(b.prompt_version) || 0) ||
        (toNumber(a.response_version) || 0) - (toNumber(b.response_version) || 0));
      const active = turn.messages.findIndex(msg => msg.active_in_chat === true);
      turn.selected = active >= 0 ? active : 0;
    });
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isChatRow(value) {
    return isRecord(value) && ["session_id", "sessionId", "chat_id", "chatId", "user_message", "userMessage", "prompt", "user", "bot_response", "botResponse", "response", "assistant"]
      .some(key => Object.hasOwn(value, key));
  }

  function sessionKey(userId, sessionId) {
    return JSON.stringify([toStringOrNull(userId), String(sessionId)]);
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
      if (session.key === state.activeSessionId) {
        li.classList.add("archive-session-active");
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "archive-session-btn";
      btn.innerHTML = `
        <div class="archive-session-name">${escapeHtml(session.session_name || session.session_id)}</div>
        <div class="archive-session-sub">
          <span>${session.turns.length} turns${session.user_id ? " · User " + escapeHtml(session.user_id) : ""}</span>
          <span>${escapeHtml(formatTimestamp(session.last_timestamp))}</span>
        </div>
      `;
      btn.addEventListener("click", () => {
        state.activeSessionId = session.key;
        renderSidebar();
        renderChat();
      });

      li.appendChild(btn);
      els.chatHistory.appendChild(li);
    });
  }

  function renderChat() {
    const session = state.sessions.find(s => s.key === state.activeSessionId);

    if (!session) {
      els.chatMessages.innerHTML = `
        <div class="archive-empty-state">
          <h2>No chats found</h2>
          <p>This archive contains no conversations.</p>
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
          ${session.project_id != null ? " · Project: " + escapeHtml(session.project?.name || String(session.project_id)) : ""}
        </p>
      </div>
    `;

    if (!session.turns.length) html += `<p class="archive-chat-heading">This conversation has no messages.</p>`;
    session.turns.forEach((turn, turnIndex) => {
      const msg = turn.messages[turn.selected];
      if (turn.messages.length > 1) {
        html += `<div class="archive-variants"><label>Turn ${turnIndex + 1} · View version
          <select data-turn="${turnIndex}">${turn.messages.map((variant, index) =>
            `<option value="${index}" ${index === turn.selected ? "selected" : ""}>${escapeHtml(variantLabel(variant, index))}</option>`
          ).join("")}</select></label><small>Browsing a version does not change the archived selection or later turns.</small></div>`;
      }
      const meta = [];
      if (msg.turn_id || msg.source_row_id) meta.push(`<span>Row: ${escapeHtml(String(msg.id))}</span>`);
      if (msg.timestamp) meta.push(`<span>${escapeHtml(formatTimestamp(msg.timestamp))}</span>`);
      if (msg.model_used) meta.push(`<span title="${escapeHtml(msg.model_used)}">${escapeHtml(shortModel(msg.model_used))}</span>`);
      if (msg.prompt_id) meta.push(`<span>Prompt ID: ${escapeHtml(msg.prompt_id)}</span>`);
      if (msg.turn_id) meta.push(`<span>Turn ID: ${escapeHtml(msg.turn_id)}</span>`);
      if (msg.prompt_version != null) meta.push(`<span>Prompt v${escapeHtml(String(msg.prompt_version))}</span>`);
      if (msg.response_version != null) meta.push(`<span>Response v${escapeHtml(String(msg.response_version))}</span>`);
      if (msg.source_row_id) meta.push(`<span>Source row: ${escapeHtml(msg.source_row_id)}</span>`);
      if (msg.active_in_chat === true) meta.push(`<span class="archive-status-pill archive-active-pill">Active in archive</span>`);
      if (isInactiveVariant(msg)) meta.push(`<span class="archive-status-pill archive-inactive-pill">Inactive variant</span>`);

      html += `<div class="archive-row-meta">${meta.join("")}</div>`;
      html += `<div class="archive-bubble-wrap">`;

      if (msg.user_message || msg.attachment_context) {
        html += `
          <div class="chat-bubble user">
            <div class="archive-bubble-body">${renderRich(msg.user_message)}</div>
            ${renderAttachments(msg.attachment_context)}
          </div>
        `;
      }

      if (msg.bot_response || msg.thoughts) {
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
              ${msg.prompt_eval_tps != null ? `Prompt TPS: ${escapeHtml(String(msg.prompt_eval_tps))} &nbsp;` : ""}
              ${msg.response_time != null ? `Time: ${escapeHtml(String(msg.response_time))}s` : ""}
            </div>
          </div>
        `;
      }
      if (!msg.bot_response) html += `<p class="archive-row-meta">No final response recorded.</p>`;

      html += `</div>`;
    });

    els.chatMessages.innerHTML = html;
    bindImages(els.chatMessages);
    els.chatMessages.querySelectorAll("select[data-turn]").forEach(select => {
      select.addEventListener("change", () => {
        const container = document.querySelector(".archive-chat-container");
        const scrollTop = container.scrollTop;
        session.turns[Number(select.dataset.turn)].selected = Number(select.value);
        renderChat();
        container.scrollTop = scrollTop;
        els.chatMessages.querySelector(`select[data-turn="${select.dataset.turn}"]`).focus({ preventScroll: true });
      });
    });
    const chatContainer = document.querySelector(".archive-chat-container");
    if (chatContainer) chatContainer.scrollTop = 0;
  }

  function renderError(message) {
    closeImagePreview();
    state.attachmentCache.clear();
    state.imageCache.clear();
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
        return sanitizeMarkdownHtml(window.marked.parse(escapeRawHtmlForMarkdown(raw), getSafeMarkedOptions()));
      } catch (_) {}
    }

    return `<div class="streaming-plain">${escapeHtml(raw).replace(/\n/g, "<br>")}</div>`;
  }

  function variantLabel(msg, index) {
    const versions = [msg.prompt_version != null ? "Prompt v" + msg.prompt_version : "Version " + (index + 1),
      msg.response_version != null ? "response v" + msg.response_version : null];
    versions.push(msg.active_in_chat === true ? "active in archive" : msg.active_in_chat === false ? "inactive" : "selection unknown");
    return versions.filter(Boolean).join(" · ");
  }

  function renderAttachments(context) {
    if (!context) return "";
    let parsed = state.attachmentCache.get(context);
    if (!parsed) {
      try { parsed = JSON.parse(context); } catch (_) { parsed = null; }
      if (!isRecord(parsed) || parsed.type !== "llm-controller-attachments") {
        parsed = { notice: "Attachment context included. Original file data is not available in a recognized format." };
      } else if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.attachments)) {
        parsed = { notice: "Attachment data is invalid or uses an unsupported version." };
      }
      state.attachmentCache.set(context, parsed);
    }
    if (parsed.notice) return `<div class="archive-attachment-note">${escapeHtml(parsed.notice)}</div>`;
    return `<div class="archive-attachments">${parsed.attachments.map(attachment => {
      if (!isRecord(attachment)) return `<div class="archive-attachment-note">Invalid attachment record.</div>`;
      const name = toStringOrNull(attachment.name) || "Attachment";
      if (attachment.kind === "image") {
        const source = validatedImageSource(attachment.data_url, attachment.mime_type);
        return source ? imageMarkup(source, name) : `<div class="archive-attachment-note">${escapeHtml(name)} — ${attachment.data_url ? "Image data is invalid or unsupported." : "Image bytes are not included."}</div>`;
      }
      const content = typeof attachment.content === "string" ? attachment.content : "";
      return content ? `<details class="archive-attachment-text"><summary>${escapeHtml(name)}</summary><pre>${escapeHtml(content)}</pre></details>` :
        `<div class="archive-attachment-note">${escapeHtml(name)} — Attachment metadata only; file data is not included.</div>`;
    }).join("")}</div>`;
  }

  function imageMarkup(source, name) {
    return `<span class="archive-image"><img src="${escapeHtml(source)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async"><span class="archive-image-caption">${escapeHtml(name)}</span></span>`;
  }

  function normalizeImageMime(value) {
    const mime = String(value || "").toLowerCase().trim();
    return ({ "image/heic": "image/heif", "image/heic-sequence": "image/heif", "image/heif-sequence": "image/heif",
      "image/x-tiff": "image/tiff", "image/x-bmp": "image/bmp", "image/x-ms-bmp": "image/bmp" })[mime] || mime;
  }

  function validatedImageSource(value, declaredMime) {
    if (typeof value !== "string") return null;
    const cached = state.imageCache.get(value);
    if (cached !== undefined) return cached && (!declaredMime || normalizeImageMime(declaredMime) === cached.mime) ? cached.source : null;
    const match = /^data:(image\/[a-z0-9+-]+);base64,([A-Za-z0-9+/_-]+={0,2})$/i.exec(value.trim());
    let result = null;
    if (match) {
      const mime = normalizeImageMime(match[1]);
      const encoded = match[2].replace(/-/g, "+").replace(/_/g, "/");
      try {
        // Inspect the signature only; the browser decodes the complete image lazily.
        const head = atob(encoded.slice(0, 256));
        const valid = encoded.length % 4 === 0 && (
          (mime === "image/png" && head.startsWith("\x89PNG\r\n\x1a\n")) ||
          (mime === "image/jpeg" && head.startsWith("\xff\xd8\xff")) ||
          (mime === "image/gif" && /^GIF8[79]a/.test(head)) ||
          (mime === "image/webp" && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
          (mime === "image/bmp" && head.length >= 14 && head.startsWith("BM")) ||
          (mime === "image/tiff" && ["II\x2a\x00", "MM\x00\x2a", "II\x2b\x00", "MM\x00\x2b"].includes(head.slice(0, 4))) ||
          (["image/avif", "image/heif"].includes(mime) && head.slice(4, 8) === "ftyp" &&
            (mime === "image/avif" ? /^(avif|avis|mif1|msf1)$/.test(head.slice(8, 12)) : /^(heic|heix|heim|heis|hevc|hevx|hevm|hevs|mif1|msf1)$/.test(head.slice(8, 12))))
        );
        if (valid) result = { mime, source: `data:${mime};base64,${encoded}` };
      } catch (_) {}
    }
    state.imageCache.set(value, result);
    return result && (!declaredMime || normalizeImageMime(declaredMime) === result.mime) ? result.source : null;
  }

  function bindImages(root) {
    root.querySelectorAll(".archive-image img").forEach(img => {
      const wrapper = img.parentElement;
      const caption = wrapper.querySelector(".archive-image-caption");
      const fail = () => {
        caption.textContent = `${img.alt || "Image"} — Preview unavailable: damaged image or unsupported browser format.`;
        img.remove();
      };
      const ready = () => { img.classList.add("archive-image-ready"); };
      img.addEventListener("load", ready, { once: true });
      img.addEventListener("error", fail, { once: true });
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute("aria-label", "Enlarge " + (img.alt || "image"));
      const open = () => {
        const dialog = document.getElementById("imagePreview");
        const preview = document.getElementById("imagePreviewImage");
        preview.src = img.src;
        preview.alt = img.alt;
        document.getElementById("imagePreviewCaption").textContent = img.alt;
        dialog.showModal();
      };
      img.addEventListener("click", open);
      img.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      });
      if (img.complete) { if (img.naturalWidth) ready(); else fail(); }
    });
  }

  function closeImagePreview() {
    const dialog = document.getElementById("imagePreview");
    if (dialog.open) dialog.close();
    document.getElementById("imagePreviewImage").removeAttribute("src");
  }

  let safeMarkedOptions = null;

  function getSafeMarkedOptions() {
    if (safeMarkedOptions) return safeMarkedOptions;

    if (window.marked && typeof window.marked.Renderer === "function") {
      const renderer = new window.marked.Renderer();
      renderer.html = token => escapeHtml(token && token.text ? token.text : "");
      renderer.image = token => {
        const source = validatedImageSource(token.href);
        const label = token.text || "Embedded image";
        return source ? imageMarkup(source, label) : `<span>${escapeHtml(label)} (image unavailable offline)</span>`;
      };
      safeMarkedOptions = { renderer };
      return safeMarkedOptions;
    }

    safeMarkedOptions = {};
    return safeMarkedOptions;
  }

  function escapeRawHtmlForMarkdown(text) {
    return String(text || "").replace(
      /<(?=\/?[a-z][a-z0-9:-]*(?:\s|>|\/)|!(?:doctype|--|\[CDATA\[)|\?)/gi,
      "&lt;"
    );
  }

  const SAFE_MARKDOWN_TAGS = new Set([
    "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "li", "ol", "p", "pre", "s", "span", "strong", "table", "tbody", "td", "th",
    "thead", "tr", "ul", "img"
  ]);

  const DROP_MARKDOWN_TAGS = new Set([
    "script", "style", "iframe", "object", "embed", "link", "meta", "form", "input",
    "button", "textarea", "select", "option", "svg", "math"
  ]);

  const SAFE_MARKDOWN_ATTRS = {
    a: new Set(["href", "title", "target", "rel"]),
    code: new Set(["class"]),
    pre: new Set(["class"]),
    span: new Set(["class"]),
    td: new Set(["align"]),
    th: new Set(["align"]),
    img: new Set(["src", "alt", "loading", "decoding"])
  };

  function sanitizeMarkdownHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");

    function cleanNode(node) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const tagName = node.tagName.toLowerCase();

      if (DROP_MARKDOWN_TAGS.has(tagName)) {
        node.remove();
        return;
      }

      Array.from(node.childNodes).forEach(cleanNode);

      if (!SAFE_MARKDOWN_TAGS.has(tagName)) {
        const parent = node.parentNode;
        if (!parent) return;
        while (node.firstChild) {
          parent.insertBefore(node.firstChild, node);
        }
        node.remove();
        return;
      }

      const allowedAttrs = SAFE_MARKDOWN_ATTRS[tagName] || new Set();
      Array.from(node.attributes).forEach(attr => {
        const attrName = attr.name.toLowerCase();
        const attrValue = attr.value || "";

        if (attrName.startsWith("on") || !allowedAttrs.has(attrName)) {
          node.removeAttribute(attr.name);
          return;
        }

        if (tagName === "a" && attrName === "href" && !isSafeMarkdownUrl(attrValue)) {
          node.removeAttribute(attr.name);
        }
        if (tagName === "img" && attrName === "src" && !validatedImageSource(attrValue)) {
          node.removeAttribute(attr.name);
        }
      });

      if (tagName === "a" && node.getAttribute("target") === "_blank") {
        node.setAttribute("rel", "noopener noreferrer");
      }
    }

    Array.from(template.content.childNodes).forEach(cleanNode);
    return template.innerHTML;
  }

  function isSafeMarkdownUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;

    const compact = raw.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();
    if (/^(javascript|vbscript|data):/.test(compact)) {
      return false;
    }

    if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
      return true;
    }

    try {
      const parsed = new URL(raw, window.location.href);
      return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
    } catch (_) {
      return false;
    }
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

  function normalizeVersion(v) {
    if (v == null || v === "") return null;
    const s = String(v).trim();
    if (!s || /^(null|none|undefined)$/i.test(s)) return null;
    return s;
  }

  function normalizeActiveInChat(v) {
    if (v == null || v === "") return null;
    if (typeof v === "boolean") return v;

    const s = String(v).trim().toLowerCase();
    if (!s || /^(null|none|undefined)$/i.test(s)) return null;
    if (["0", "false", "no", "n", "inactive"].includes(s)) return false;
    if (["1", "true", "yes", "y", "active"].includes(s)) return true;
    return null;
  }

  function isInactiveVariant(msg) {
    return msg && msg.active_in_chat === false;
  }

  function hasValue(v) {
    return v != null && String(v).trim() !== "";
  }

  function hasAttachmentContext(v) {
    return normalizeAttachmentContext(v) !== null;
  }

  function toStringOrNull(v) {
    if (v == null) return null;
    const s = String(v);
    return s === "" ? null : s;
  }

  function normalizeAttachmentContext(v) {
    if (v == null) return null;
    if (isRecord(v)) return JSON.stringify(v);
    const s = String(v).trim();
    if (!s || /^(null|none|undefined)$/i.test(s)) return null;
    return s;
  }

  function blankMsg() {
    return {
      id: cryptoId(),
      user_message: "",
      bot_response: "",
      thoughts: "",
      attachment_context: "",
      timestamp: null,
      model_used: null,
      prompt_id: null,
      turn_id: null,
      prompt_version: null,
      response_version: null,
      active_in_chat: null,
      source_row_id: null,
      response_time: null,
      total_tokens: null,
      tps: null,
      prompt_eval_tps: null
    };
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
