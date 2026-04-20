const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAX_EMBED_DEPTH = 6;
const DEFAULT_RUN_COMMANDS = ["/run", "/check", "/test"];
const DEFAULT_HELP_COMMANDS = ["/help", "/start"];
const DEFAULT_OFFSET_STATE_FILE = ".runtime/telegram-command-offset.json";

const TEST_CATALOG = [
  { type: "movie", title: "Shelter", year: "2007", tmdbId: "17483", imdbId: "tt0942384" },
  { type: "movie", title: "Avatar", year: "2009", tmdbId: "19995", imdbId: "tt0499549" },
  { type: "movie", title: "Inception", year: "2010", tmdbId: "27205", imdbId: "tt1375666" },
  { type: "movie", title: "Interstellar", year: "2014", tmdbId: "157336", imdbId: "tt0816692" },
  { type: "movie", title: "Titanic", year: "1997", tmdbId: "597", imdbId: "tt0120338" },
  { type: "movie", title: "Avengers Endgame", year: "2019", tmdbId: "299534", imdbId: "tt4154796" },
  { type: "movie", title: "The Dark Knight", year: "2008", tmdbId: "155", imdbId: "tt0468569" },
  { type: "movie", title: "Spider-Man No Way Home", year: "2021", tmdbId: "634649", imdbId: "tt10872600" },
  { type: "tv", title: "Game of Thrones", year: "2011", tmdbId: "1399", imdbId: "tt0944947", season: "1", episode: "1" },
  { type: "tv", title: "Breaking Bad", year: "2008", tmdbId: "1396", imdbId: "tt0903747", season: "1", episode: "1" },
  { type: "tv", title: "Stranger Things", year: "2016", tmdbId: "66732", imdbId: "tt4574334", season: "1", episode: "1" }
];

function safeJson(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isLikelyM3U8(url, mimeType) {
  const u = String(url || "").toLowerCase();
  const m = String(mimeType || "").toLowerCase();
  return /\.m3u8(\?|$)/i.test(u) || m.includes("mpegurl");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function escapeHtmlAttr(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSlug(sample) {
  const title = encodeURIComponent(sample.title || "");
  const sourceTitle = encodeURIComponent(sample.title || "");
  const year = encodeURIComponent(sample.year || "N/A");
  const imdb = encodeURIComponent(sample.imdbId || "");

  if (sample.type === "tv") {
    return [
      "xpass_tv",
      String(sample.tmdbId || ""),
      String(sample.season || "1"),
      String(sample.episode || "1"),
      title,
      year,
      sourceTitle,
      imdb
    ].join("|");
  }

  return [
    "xpass_movie",
    String(sample.tmdbId || ""),
    title,
    year,
    sourceTitle,
    imdb
  ].join("|");
}

function createPluginApi(pluginFilePath) {
  const code = fs.readFileSync(pluginFilePath, "utf8");

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    window: null
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: pluginFilePath });

  const required = ["getServers", "parseServerResponse", "parseEmbedResponse"];
  for (const fn of required) {
    if (typeof sandbox[fn] !== "function") {
      throw new Error(`Plugin thiếu function: ${fn}`);
    }
  }

  return {
    getServers: sandbox.getServers.bind(sandbox),
    parseServerResponse: sandbox.parseServerResponse.bind(sandbox),
    parseEmbedResponse: sandbox.parseEmbedResponse.bind(sandbox),
    getUrlDetail: typeof sandbox.getUrlDetail === "function" ? sandbox.getUrlDetail.bind(sandbox) : null
  };
}

function buildFetchUrl(url) {
  const proxyBase = String(process.env.FETCH_PROXY_BASE || "").trim().replace(/\/+$/, "");
  if (!proxyBase) return url;
  return `${proxyBase}/fetch?url=${encodeURIComponent(url)}`;
}

function getMode() {
  const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
  const fromArg = modeArg ? modeArg.slice("--mode=".length) : "";
  const mode = String(fromArg || process.env.MONITOR_MODE || "report").trim().toLowerCase();
  return mode || "report";
}

function getRunCommands() {
  const raw = String(process.env.TG_RUN_COMMANDS || "").trim();
  if (!raw) return DEFAULT_RUN_COMMANDS;
  const parsed = raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((x) => (x.startsWith("/") ? x : `/${x}`));
  return parsed.length ? parsed : DEFAULT_RUN_COMMANDS;
}

function getHelpCommands() {
  return DEFAULT_HELP_COMMANDS;
}

function buildHelpText(runCommands) {
  const list = (runCommands && runCommands.length ? runCommands : DEFAULT_RUN_COMMANDS)
    .map((x) => `- ${escapeHtml(x)}`)
    .join("\n");

  return [
    "<b>Telegram Command Help</b>",
    "Gửi một trong các lệnh sau để chạy test ngay:",
    list,
    "",
    "Lưu ý: workflow poll chạy mỗi 5 phút, nên phản hồi có thể trễ 0-5 phút."
  ].join("\n");
}

function getFirstCommandToken(text) {
  const first = String(text || "").trim().split(/\s+/)[0].toLowerCase();
  if (!first.startsWith("/")) return "";
  const atIdx = first.indexOf("@");
  return atIdx === -1 ? first : first.slice(0, atIdx);
}

function getTelegramIdentity() {
  return {
    token: String(process.env.TG_BOT_TOKEN || "").trim(),
    chatId: String(process.env.TG_CHAT_ID || "").trim(),
    threadId: String(process.env.TG_THREAD_ID || "").trim()
  };
}

function buildTelegramApiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

function isTruthyEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getOffsetStateFilePath() {
  const configuredPath = String(process.env.TG_OFFSET_STATE_FILE || "").trim();
  if (!configuredPath) {
    return path.resolve(__dirname, "..", DEFAULT_OFFSET_STATE_FILE);
  }
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

function readOffsetState(offsetFilePath) {
  try {
    const parsed = safeJson(fs.readFileSync(offsetFilePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = Number(parsed.nextOffset);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.trunc(value);
  } catch {
    return null;
  }
}

function writeOffsetState(offsetFilePath, nextOffset) {
  const value = Number(nextOffset);
  if (!Number.isFinite(value) || value <= 0) return;

  fs.mkdirSync(path.dirname(offsetFilePath), { recursive: true });
  fs.writeFileSync(
    offsetFilePath,
    JSON.stringify(
      {
        nextOffset: Math.trunc(value),
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} @ ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlLikePreview(url) {
  const hasProxy = Boolean(String(process.env.FETCH_PROXY_BASE || "").trim());

  if (hasProxy) {
    return fetchWithTimeout(buildFetchUrl(url), 35000);
  }

  try {
    return await fetchWithTimeout(url, 26000);
  } catch {
    const proxyUrl = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
    return await fetchWithTimeout(proxyUrl, 28000);
  }
}

async function discoverCandidates(plugin) {
  const bySource = {};

  for (const sample of TEST_CATALOG) {
    const slug = buildSlug(sample);

    try {
      const xpassStartUrl = plugin.getUrlDetail ? plugin.getUrlDetail(slug) : "";
      if (xpassStartUrl) {
        const xpassName = "Xpass Gốc";
        if (!bySource[xpassName]) bySource[xpassName] = [];
        bySource[xpassName].push({
          sourceName: xpassName,
          sample,
          startUrl: String(xpassStartUrl),
          isEmbed: true
        });
      }
    } catch (err) {
      console.warn("Không lấy được getUrlDetail cho", sample.title, err.message || err);
    }

    const getServersUrl = plugin.getServers(slug);
    if (!getServersUrl) continue;

    let parsed;
    try {
      const html = await fetchHtmlLikePreview(getServersUrl);
      parsed = safeJson(plugin.parseServerResponse(html));
    } catch (err) {
      console.warn("Không lấy được server list cho", sample.title, err.message || err);
      continue;
    }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (!item || !item.url) continue;
      const name = String(item.name || "Unknown").trim();
      if (!bySource[name]) bySource[name] = [];
      bySource[name].push({
        sourceName: name,
        sample,
        startUrl: String(item.url),
        isEmbed: item.isEmbed !== false
      });
    }
  }

  return bySource;
}

async function resolveCandidateToM3U8(plugin, candidate) {
  let current = {
    url: candidate.startUrl,
    isEmbed: candidate.isEmbed,
    mimeType: ""
  };

  for (let depth = 0; depth < MAX_EMBED_DEPTH; depth += 1) {
    if (!current.url) {
      return { ok: false, reason: "empty_url", depth };
    }

    if (isLikelyM3U8(current.url, current.mimeType)) {
      return { ok: true, reason: "m3u8_found", depth, url: current.url };
    }

    if (current.isEmbed !== true) {
      return { ok: false, reason: "final_non_m3u8", depth, url: current.url };
    }

    let html;
    try {
      html = await fetchHtmlLikePreview(current.url);
    } catch (err) {
      return { ok: false, reason: "fetch_failed", depth, error: err.message || String(err) };
    }

    let parsed;
    try {
      parsed = safeJson(plugin.parseEmbedResponse(html, current.url));
    } catch (err) {
      return { ok: false, reason: "parse_exception", depth, error: err.message || String(err) };
    }

    if (!parsed || !parsed.url) {
      return { ok: false, reason: "parse_empty", depth };
    }

    current = {
      url: String(parsed.url || ""),
      isEmbed: parsed.isEmbed === true,
      mimeType: String(parsed.mimeType || "")
    };
  }

  if (isLikelyM3U8(current.url, current.mimeType)) {
    return { ok: true, reason: "m3u8_found_after_limit", depth: MAX_EMBED_DEPTH, url: current.url };
  }

  return { ok: false, reason: "depth_limit", depth: MAX_EMBED_DEPTH, url: current.url };
}

async function runHealthCheck(plugin) {
  const sourceCandidates = await discoverCandidates(plugin);
  const sourceNames = Object.keys(sourceCandidates).sort((a, b) => a.localeCompare(b));

  const rows = [];

  for (const sourceName of sourceNames) {
    const candidates = sourceCandidates[sourceName] || [];

    let alive = false;
    let tested = 0;
    let successTitle = "";
    let m3u8Url = "";
    let lastError = "";

    for (const candidate of candidates) {
      tested += 1;
      const res = await resolveCandidateToM3U8(plugin, candidate);
      if (res.ok) {
        alive = true;
        successTitle = candidate.sample.title;
        m3u8Url = String(res.url || "");
        lastError = "";
        break;
      } else {
        lastError = `${candidate.sample.title}: ${res.reason || "resolve_fail"}`;
      }
    }

    rows.push({
      name: sourceName,
      status: alive ? "alive" : "dead",
      tested,
      total: candidates.length,
      successTitle,
      m3u8Url,
      lastError
    });
  }

  const aliveCount = rows.filter((x) => x.status === "alive").length;
  const deadCount = rows.filter((x) => x.status === "dead").length;

  return {
    generatedAt: new Date().toISOString(),
    totalSources: rows.length,
    aliveCount,
    deadCount,
    rows
  };
}

function buildTelegramMessage(report, options = {}) {
  const lines = [];
  lines.push("<b>Source Monitor Report</b>");
  lines.push(`Time (UTC): ${escapeHtml(report.generatedAt)}`);
  if (options.triggerText) {
    lines.push(`Trigger: ${escapeHtml(options.triggerText)}`);
  }
  lines.push(`Total: <b>${report.totalSources}</b> | Alive: <b>${report.aliveCount}</b> | Dead: <b>${report.deadCount}</b>`);
  lines.push("");

  for (const row of report.rows) {
    if (row.status === "alive") {
      const linkPart = row.m3u8Url
        ? ` | <a href="${escapeHtmlAttr(row.m3u8Url)}">m3u8</a>`
        : "";
      lines.push(`✅ <b>${escapeHtml(row.name)}</b> | ${row.tested}/${row.total} | ${escapeHtml(row.successTitle || "pass")}${linkPart}`);
    } else {
      lines.push(`❌ <b>${escapeHtml(row.name)}</b> | ${row.tested}/${row.total} | ${escapeHtml(row.lastError || "no_detail")}`);
    }
  }

  let text = lines.join("\n");
  if (text.length > 3900) {
    text = text.slice(0, 3850) + "\n... (message truncated)";
  }
  return text;
}

async function sendTelegramMessage(text) {
  const { token, chatId, threadId } = getTelegramIdentity();

  if (!token) throw new Error("Missing TG_BOT_TOKEN");
  if (!chatId) throw new Error("Missing TG_CHAT_ID");

  const endpoint = buildTelegramApiUrl(token, "sendMessage");
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (threadId) {
    const parsedThreadId = Number(threadId);
    if (Number.isFinite(parsedThreadId)) {
      payload.message_thread_id = parsedThreadId;
    }
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${JSON.stringify(data)}`);
  }
}

async function deleteTelegramWebhook(token) {
  const endpoint = buildTelegramApiUrl(token, "deleteWebhook");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drop_pending_updates: false })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram deleteWebhook failed: ${res.status} ${JSON.stringify(data)}`);
  }
}

async function getTelegramUpdates(token, offset, allowWebhookRetry = true) {
  const query = new URLSearchParams({
    timeout: "0",
    limit: "30",
    allowed_updates: JSON.stringify(["message"])
  });
  if (Number.isFinite(offset)) {
    query.set("offset", String(offset));
  }

  const endpoint = `${buildTelegramApiUrl(token, "getUpdates")}?${query.toString()}`;
  const res = await fetch(endpoint, {
    method: "GET",
    cache: "no-store"
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const description = String(data && data.description ? data.description : "");
    const hasWebhookConflict = res.status === 409 || description.toLowerCase().includes("webhook");
    if (hasWebhookConflict) {
      const autoDeleteWebhook = isTruthyEnv(process.env.TG_AUTO_DELETE_WEBHOOK);
      if (allowWebhookRetry && autoDeleteWebhook) {
        await deleteTelegramWebhook(token);
        return getTelegramUpdates(token, offset, false);
      }
      throw new Error("Telegram getUpdates conflict: webhook dang bat. Hay goi deleteWebhook de dung che do polling.");
    }
    throw new Error(`Telegram getUpdates failed: ${res.status} ${JSON.stringify(data)}`);
  }

  return Array.isArray(data.result) ? data.result : [];
}

function findLatestSupportedCommandUpdate(updates, chatId, acceptedCommands) {
  const commands = new Set(acceptedCommands.map((x) => x.toLowerCase()));
  let latest = null;

  for (const update of updates) {
    const message = update && update.message;
    if (!message || !message.chat) continue;
    if (String(message.chat.id) !== chatId) continue;

    const cmd = getFirstCommandToken(message.text);
    if (!cmd || !commands.has(cmd)) continue;

    const updateId = Number(update.update_id);
    if (!Number.isFinite(updateId)) continue;

    if (!latest || updateId > latest.updateId) {
      latest = {
        updateId,
        command: cmd,
        rawText: String(message.text || "")
      };
    }
  }

  return latest;
}

async function acknowledgeTelegramUpdates(token, nextOffset) {
  await getTelegramUpdates(token, nextOffset);
}

async function pollTelegramCommand(acceptedCommands) {
  const { token, chatId } = getTelegramIdentity();
  if (!token) throw new Error("Missing TG_BOT_TOKEN");
  if (!chatId) throw new Error("Missing TG_CHAT_ID");

  const offsetFilePath = getOffsetStateFilePath();
  const savedOffset = readOffsetState(offsetFilePath);

  const updates = await getTelegramUpdates(token, savedOffset);
  if (!updates.length) return null;

  let latestSeenId = 0;
  for (const item of updates) {
    const updateId = Number(item && item.update_id);
    if (Number.isFinite(updateId) && updateId > latestSeenId) {
      latestSeenId = updateId;
    }
  }

  const matched = findLatestSupportedCommandUpdate(updates, chatId, acceptedCommands);
  if (latestSeenId > 0) {
    const nextOffset = latestSeenId + 1;
    writeOffsetState(offsetFilePath, nextOffset);
    await acknowledgeTelegramUpdates(token, nextOffset);
  }

  return matched;
}

async function executeAndSendReport(plugin, triggerText) {
  const report = await runHealthCheck(plugin);
  const text = buildTelegramMessage(report, { triggerText });

  console.log(JSON.stringify(report, null, 2));
  await sendTelegramMessage(text);
  console.log("Telegram report sent.");
}

async function main() {
  const mode = getMode();
  const pluginPath = path.resolve(__dirname, "..", "plugins", "tmdb_plugin.js");
  const plugin = createPluginApi(pluginPath);

  if (mode === "command-poll") {
    const runCommands = getRunCommands();
    const helpCommands = getHelpCommands();
    const acceptedCommands = [...runCommands, ...helpCommands];

    const commandUpdate = await pollTelegramCommand(acceptedCommands);
    if (!commandUpdate) {
      console.log("No supported Telegram command in this poll cycle.");
      return;
    }

    console.log(`Run command accepted: ${commandUpdate.command} (${commandUpdate.rawText})`);

    if (helpCommands.includes(commandUpdate.command)) {
      await sendTelegramMessage(buildHelpText(runCommands));
      console.log("Help response sent.");
      return;
    }

    await sendTelegramMessage(`<b>Da nhan lenh ${escapeHtml(commandUpdate.command)}</b>\nDang chay source monitor...`);
    await executeAndSendReport(plugin, `telegram_command ${commandUpdate.command}`);
    return;
  }

  if (mode !== "report") {
    throw new Error(`Unsupported MONITOR_MODE: ${mode}`);
  }

  await executeAndSendReport(plugin, "scheduled_or_manual");
}

main().catch(async (err) => {
  console.error("Monitor failed:", err);

  const { token, chatId } = getTelegramIdentity();
  if (token && chatId) {
    try {
      const failText = `<b>Source Monitor Failed</b>\n${escapeHtml(err.message || String(err))}`;
      await sendTelegramMessage(failText);
    } catch (sendErr) {
      console.error("Unable to send failure message:", sendErr.message || sendErr);
    }
  }

  process.exit(1);
});