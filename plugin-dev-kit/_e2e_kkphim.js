const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PROXY = "http://127.0.0.1:8787";

function parseRaw(raw) {
  if (raw && typeof raw === "object") return raw;
  return JSON.parse(raw);
}

function toOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function mediaProxyUrl(targetUrl, referer, origin) {
  const u = new URL(PROXY + "/media");
  u.searchParams.set("url", targetUrl);
  if (referer) u.searchParams.set("referer", referer);
  if (origin) u.searchParams.set("origin", origin);
  return u.toString();
}

async function fetchProxy(url) {
  const r = await fetch(PROXY + "/fetch?url=" + encodeURIComponent(url));
  return { status: r.status, text: await r.text() };
}

async function tryStreamProbe(streamUrl, referer, origin) {
  const m3u8 = mediaProxyUrl(streamUrl, referer, origin);
  const manifestResp = await fetch(m3u8, { headers: { Range: "bytes=0-2048" } });
  const manifestText = await manifestResp.text();

  if (!manifestResp.ok) {
    return { ok: false, stage: "manifest", status: manifestResp.status, reason: "manifest http error" };
  }

  const lines = manifestText.split("\n").map((x) => x.trim()).filter(Boolean);
  const firstSeg = lines.find((l) => l.startsWith(PROXY + "/media?url="));
  if (!firstSeg) {
    return { ok: false, stage: "manifest", status: 200, reason: "no proxied segment url" };
  }

  const head = await fetch(firstSeg, { method: "HEAD" });
  if (!head.ok) {
    return { ok: false, stage: "head", status: head.status, reason: "segment head failed" };
  }

  const seg = await fetch(firstSeg, { headers: { Range: "bytes=0-4096" } });
  const segBytes = (await seg.arrayBuffer()).byteLength;
  if (!seg.ok || segBytes <= 0) {
    return { ok: false, stage: "segment", status: seg.status, reason: "segment empty" };
  }

  return {
    ok: true,
    manifestStatus: manifestResp.status,
    headStatus: head.status,
    segStatus: seg.status,
    segBytes,
    hasEndlist: manifestText.includes("#EXT-X-ENDLIST")
  };
}

async function main() {
  const code = fs.readFileSync(path.join(__dirname, "../plugins/kkphim_plugin.js"), "utf8");
  const sandbox = { console, JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "kkphim_plugin.js" });

  const call = (name, ...args) => {
    if (typeof sandbox[name] !== "function") throw new Error(name + " missing");
    return sandbox[name](...args);
  };

  const manifest = parseRaw(call("getManifest"));
  const sections = parseRaw(call("getHomeSections"));

  const listUrl = call("getUrlList", sections[0].slug, JSON.stringify({ page: 1 }));
  const listRes = await fetchProxy(listUrl);
  const list = parseRaw(call("parseListResponse", listRes.text));
  const movie = (list.items || [])[0];
  if (!movie) throw new Error("No movie item");

  const detailUrl = call("getUrlDetail", movie.id);
  const detailRes = await fetchProxy(detailUrl);
  const detail = parseRaw(call("parseMovieDetail", detailRes.text));
  const server = (detail.servers || [])[0];
  const episode = server && (server.episodes || [])[0];
  if (!episode) throw new Error("No episode");

  const streamUrl = String(episode.id || "").trim();
  if (!/^https?:\/\//i.test(streamUrl)) {
    throw new Error("First episode is not direct URL");
  }

  const tests = [
    {
      name: "manifest-baseUrl",
      referer: manifest.baseUrl || "https://phimapi.com",
      origin: toOrigin(manifest.baseUrl || "https://phimapi.com")
    },
    {
      name: "stream-origin",
      referer: toOrigin(streamUrl) + "/",
      origin: toOrigin(streamUrl)
    },
    {
      name: "blank-headers",
      referer: "",
      origin: ""
    }
  ];

  const results = [];
  for (const t of tests) {
    try {
      const probe = await tryStreamProbe(streamUrl, t.referer, t.origin);
      results.push({
        name: t.name,
        referer: t.referer,
        origin: t.origin,
        probe
      });
    } catch (e) {
      results.push({
        name: t.name,
        referer: t.referer,
        origin: t.origin,
        probe: { ok: false, stage: "exception", reason: e.message }
      });
    }
  }

  const preferred = results.find((r) => r.probe && r.probe.ok) || null;

  console.log(JSON.stringify({
    movieId: movie.id,
    listStatus: listRes.status,
    detailStatus: detailRes.status,
    streamUrl,
    results,
    preferred: preferred ? preferred.name : null
  }, null, 2));
}

main().catch((err) => {
  console.error("KKPHIM_E2E_FAIL", err && err.message ? err.message : String(err));
  process.exit(1);
});
