const fs = require("fs");
const path = require("path");
const vm = require("vm");

async function main() {
  const code = fs.readFileSync(path.join(__dirname, "../plugins/tmdb_plugin.js"), "utf8");
  const sandbox = { console, JSON, encodeURIComponent, decodeURIComponent };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "tmdb_plugin.js" });
  sandbox.DEBUG = true;

  const call = (name, ...args) => {
    if (typeof sandbox[name] !== "function") throw new Error(name + " missing");
    return sandbox[name](...args);
  };

  const tmdbDetailUrl = call("getUrlDetail", "movie|1154598");
  const tmdbHtml = await fetch(tmdbDetailUrl).then((r) => r.text());
  const detail = JSON.parse(call("parseMovieDetail", tmdbHtml));
  const frenchServer = (detail.servers || []).find((s) => /FrenchStream/i.test(String(s.name || "")));
  const episode = frenchServer && frenchServer.episodes ? frenchServer.episodes[0] : null;
  if (!episode) throw new Error("No french episode");

  const searchUrl = call("getUrlDetail", episode.id);
  const searchHtml = await fetch("http://127.0.0.1:8787/fetch?url=" + encodeURIComponent(searchUrl)).then((r) => r.text());

  const items = sandbox.parseFrenchSearchItems(searchHtml);
  const meta = sandbox.parseFrenchMetaFromUrl(searchUrl);
  const targets = sandbox.buildFrenchTitleTargets(meta);

  console.log("searchUrl=", searchUrl);
  console.log("meta=", meta);
  console.log("targets=", targets);
  console.log("itemCount=", items.length);

  for (let i = 0; i < Math.min(items.length, 12); i++) {
    console.log(i + 1, "=>", items[i].title, "::", items[i].normalized, "::", items[i].href);
  }

  const chosen = sandbox.findFrenchDetailUrl(items, meta);
  console.log("chosen=", chosen);
}

main().catch((err) => {
  console.error("DEBUG_MATCH_FAIL", err && err.message ? err.message : String(err));
  process.exit(1);
});
