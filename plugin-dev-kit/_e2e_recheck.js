const fs = require("fs");
const path = require("path");
const vm = require("vm");

function parseRaw(raw) {
  if (raw && typeof raw === "object") return raw;
  return JSON.parse(raw);
}

function pickId(obj) {
  if (!obj || typeof obj !== "object") return "";
  const c = [obj.id, obj.slug, obj.url, obj.link, obj.path];
  for (const x of c) if (x != null && String(x).trim()) return String(x).trim();
  return "";
}

function uniqueNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (v == null) continue;
    const t = String(v).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function fetchProxy(url) {
  const r = await fetch("http://127.0.0.1:8787/fetch?url=" + encodeURIComponent(url));
  return { status: r.status, text: await r.text() };
}

async function run() {
  const code = fs.readFileSync(path.join(__dirname, "../plugins/hh3d_plugin.js"), "utf8");
  const sandbox = { console, JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "hh3d_plugin.js" });

  const call = (name, ...args) => {
    if (typeof sandbox[name] !== "function") throw new Error(name + " missing");
    return sandbox[name](...args);
  };

  const sections = parseRaw(call("getHomeSections"));
  const listUrl = call("getUrlList", sections[0].slug || "", JSON.stringify({ page: 1 }));
  const listRes = await fetchProxy(listUrl);
  const list = parseRaw(call("parseListResponse", listRes.text));
  const movie = (list.items || [])[0];
  if (!movie) throw new Error("No movie item");

  const detailUrl = call("getUrlDetail", pickId(movie));
  const detailRes = await fetchProxy(detailUrl);
  const detail = parseRaw(call("parseMovieDetail", detailRes.text));
  const server = (detail.servers || [])[0];
  const episode = (server && server.episodes || [])[0];
  if (!episode) throw new Error("No episode");

  const candidates = uniqueNonEmpty([pickId(episode), episode.slug, episode.url, episode.link]);
  let payload = null;
  let epUrl = "";
  let epRes = null;

  for (const cand of candidates) {
    epUrl = call("getUrlDetail", cand);
    epRes = await fetchProxy(epUrl);

    try {
      const p = parseRaw(call("parseDetailResponse", epRes.text));
      if (p && p.url) {
        payload = p;
        break;
      }
    } catch {}

    const cfgMatch = epRes.text.match(/var\s+halim_cfg\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
    if (!cfgMatch) continue;

    const cfg = JSON.parse(cfgMatch[1]);
    const q = new URLSearchParams();
    q.set("episode_slug", cfg.episode_slug);
    q.set("server_id", String(cfg.server || "1"));
    q.set("subsv_id", "");
    q.set("post_id", String(cfg.post_id));
    const endpoint = String(cfg.player_url).replace(/\\\//g, "/") + "?" + q.toString();

    const rr = await fetch("http://127.0.0.1:8787/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: endpoint,
        method: "POST",
        headers: {
          Referer: epUrl,
          Origin: "https://hoathinh3d.co",
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json, text/javascript, */*; q=0.01"
        },
        body: ""
      })
    });

    const body = await rr.text();
    const p = parseRaw(call("parseDetailResponse", body));
    if (p && p.url) {
      payload = p;
      break;
    }
  }

  if (!payload) throw new Error("No stream URL from any episode candidate");

  const m3u8Url = new URL("http://127.0.0.1:8787/media");
  m3u8Url.searchParams.set("url", payload.url);
  m3u8Url.searchParams.set("referer", payload.headers?.Referer || "https://hoathinh3d.co/");
  m3u8Url.searchParams.set("origin", payload.headers?.Origin || "https://hoathinh3d.co");

  const manifest = await fetch(m3u8Url.toString(), { headers: { Range: "bytes=0-1024" } }).then(r => r.text());
  if (!manifest.includes("#EXT-X-ENDLIST")) throw new Error("Manifest incomplete under range");

  const firstSeg = manifest.split("\n").find(l => l.startsWith("http://127.0.0.1:8787/media?url="));
  if (!firstSeg) throw new Error("No segment URL in manifest");

  const head = await fetch(firstSeg, { method: "HEAD" });
  if (!head.ok) throw new Error("HEAD segment failed " + head.status);

  const seg = await fetch(firstSeg, { headers: { Range: "bytes=0-4096" } });
  const bytes = (await seg.arrayBuffer()).byteLength;
  if (!seg.ok || !bytes) throw new Error("Segment fetch failed");

  console.log("E2E_OK", JSON.stringify({
    listStatus: listRes.status,
    detailStatus: detailRes.status,
    headStatus: head.status,
    segStatus: seg.status,
    segBytes: bytes,
    streamUrl: payload.url
  }));
}

run().catch(err => {
  console.error("E2E_FAIL", err && err.message ? err.message : String(err));
  process.exit(1);
});
