const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PROXY = "http://127.0.0.1:8787";

function parseRaw(raw) {
  if (raw && typeof raw === "object") return raw;
  return JSON.parse(raw);
}

async function fetchProxy(url) {
  const r = await fetch(PROXY + "/fetch?url=" + encodeURIComponent(url));
  return { status: r.status, text: await r.text() };
}

async function requestProxy(url, headers) {
  const r = await fetch(PROXY + "/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: "GET",
      headers: headers || {},
      body: ""
    })
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error("request proxy failed " + r.status + ": " + text.slice(0, 180));
  }
  return text;
}

async function main() {
  const code = fs.readFileSync(path.join(__dirname, "../plugins/tmdb_plugin.js"), "utf8");
  const sandbox = { console, JSON, encodeURIComponent, decodeURIComponent };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "tmdb_plugin.js" });

  const call = (name, ...args) => {
    if (typeof sandbox[name] !== "function") throw new Error(name + " missing");
    return sandbox[name](...args);
  };

  const tmdbDetailUrl = call("getUrlDetail", "movie|1154598");
  const tmdbDetailRes = await fetchProxy(tmdbDetailUrl);
  if (tmdbDetailRes.status !== 200) throw new Error("tmdb detail status " + tmdbDetailRes.status);

  const movieDetail = parseRaw(call("parseMovieDetail", tmdbDetailRes.text));
  const frenchServer = (movieDetail.servers || []).find((s) => /FrenchStream/i.test(String(s.name || "")));
  if (!frenchServer) throw new Error("FrenchStream server not found in parseMovieDetail");

  const episode = (frenchServer.episodes || [])[0];
  if (!episode) throw new Error("No french episode");

  const searchUrl = call("getUrlDetail", episode.id);
  const searchRes = await fetchProxy(searchUrl);
  console.log("DEBUG search status:", searchRes.status);

  const step1 = parseRaw(call("parseDetailResponse", searchRes.text, searchUrl));
  if (!step1 || !step1.url) throw new Error("parseDetailResponse did not return first URL");
  console.log("DEBUG step1 URL:", step1.url);

  let current = step1;
  let finalPayload = null;
  const hops = [];

  for (let depth = 1; depth <= 6; depth++) {
    if (!current || !current.url) throw new Error("empty payload at depth " + depth);

    if (!current.isEmbed) {
      finalPayload = current;
      break;
    }

    const body = await requestProxy(current.url, current.headers || {});
    const next = parseRaw(call("parseEmbedResponse", body, current.url));
    if (!next || !next.url) throw new Error("parseEmbedResponse returned empty URL at depth " + depth);

    hops.push({
      depth,
      inUrl: current.url,
      outUrl: next.url,
      isEmbed: !!next.isEmbed
    });

    current = next;
  }

  if (!finalPayload) {
    if (current && current.url && !current.isEmbed) {
      finalPayload = current;
    } else {
      throw new Error("did not resolve final stream payload");
    }
  }

  const mediaUrl = new URL(PROXY + "/media");
  mediaUrl.searchParams.set("url", finalPayload.url);
  if (finalPayload.headers && finalPayload.headers.Referer) mediaUrl.searchParams.set("referer", finalPayload.headers.Referer);
  if (finalPayload.headers && finalPayload.headers.Origin) mediaUrl.searchParams.set("origin", finalPayload.headers.Origin);

  const manifestResp = await fetch(mediaUrl.toString(), { headers: { Range: "bytes=0-2048" } });
  const manifestText = await manifestResp.text();
  if (!manifestResp.ok) throw new Error("manifest status " + manifestResp.status);

  const firstSeg = manifestText
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith(PROXY + "/media?url="));
  if (!firstSeg) throw new Error("no first segment in manifest");

  const head = await fetch(firstSeg, { method: "HEAD" });
  if (!head.ok) throw new Error("segment head status " + head.status);

  const seg = await fetch(firstSeg, { headers: { Range: "bytes=0-4096" } });
  const segBytes = (await seg.arrayBuffer()).byteLength;
  if (!seg.ok || segBytes <= 0) throw new Error("segment read failed");

  console.log(
    JSON.stringify(
      {
        tmdbDetailStatus: tmdbDetailRes.status,
        searchStatus: searchRes.status,
        frenchEpisodeId: episode.id,
        searchUrl,
        step1Url: step1.url,
        hops,
        finalStreamUrl: finalPayload.url,
        manifestStatus: manifestResp.status,
        headStatus: head.status,
        segStatus: seg.status,
        segBytes
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("TMDB_FRENCH_E2E_FAIL", err && err.message ? err.message : String(err));
  process.exit(1);
});
