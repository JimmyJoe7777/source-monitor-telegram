// =============================================================================
// TMDB Plugin cho nền tảng VAAPP - Cập nhật lõi cào link Vidsrc Mạng VIP (Không giật lag)
// Trích xuất trực tiếp M3U8 Stream 100% bằng Javascript (Không cần WebView/Captcha)
// =============================================================================

var TMDB_API_KEY = "5e515caadf8d52a665cf230e3676ee63";
var BASE_URL = "https://api.themoviedb.org/3";
var IMG_BASE_URL = "https://image.tmdb.org/t/p/w500";
// Chuyển sang tiếng anh để tên phim chuẩn khớp với data Vidsrc
var LANG = "en-US"; 

var FRENCH_STREAM_DOMAIN = "https://french-stream.one";
var CLOUDNESTRA_DOMAIN = "https://cloudnestra.com";
var MOVIESAPI_DOMAIN = "https://moviesapi.to";
var MOVIESAPI_WW2_DOMAIN = "https://ww2.moviesapi.to";
var FRENCH_STREAM_COOKIE = "";
var FRENCH_STREAM_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
var HLS_MIME_TYPE = "application/x-mpegURL";
var DEBUG = false;
var _LAST_FRENCH_META = null;
var _LAST_FRENCH_SEARCH_URL = "";
var _LAST_DETAIL_REQUEST_URL = "";
var _LAST_RESOLVE_ERROR = "";
var _SERVER_SWITCH_CANDIDATES = [];

function debugLog() {
    if (!DEBUG || typeof console === "undefined" || !console.log) return;
    try {
        console.log.apply(console, arguments);
    } catch (e) {}
}

function clearResolveError() {
    _LAST_RESOLVE_ERROR = "";
}

function setResolveError(message) {
    var text = String(message || "").trim();
    if (!text) return;
    if (!_LAST_RESOLVE_ERROR) {
        _LAST_RESOLVE_ERROR = text;
    }
    debugLog("[ResolveError]", text);
}

function getManifest() {
    return JSON.stringify({
        "id": "tmdb_xpass",
        "name": "Phim TMDB Cao Cấp",
        "version": "1.8.0",
        "baseUrl": BASE_URL,
        "type": "video",
        "author": "Antigravity",
        "description": "Nguồn phim quốc tế TMDB, hỗ trợ Xpass + FrenchStream + MoviesAPI và trích xuất M3U8 trực tiếp"
    });
}

function getHomeSections() {
    return JSON.stringify([
        { slug: "movie_popular", title: "Phim Lẻ Phổ Biến" },
        { slug: "tv_popular", title: "Phim Bộ Phổ Biến" },
        { slug: "movie_now_playing", title: "Phim Lẻ Đang Chiếu" },
        { slug: "tv_on_the_air", title: "Phim Bộ Đang Chiếu" },
        { slug: "movie_top_rated", title: "Top Phim Lẻ" },
        { slug: "tv_top_rated", title: "Top Phim Bộ" }
    ]);
}

function getUrlList(slug, filtersJson) {
    var page = JSON.parse(filtersJson || "{}").page || 1;
    var url = "";

    if (slug === "movie_popular") url = "/movie/popular";
    else if (slug === "tv_popular") url = "/tv/popular";
    else if (slug === "movie_now_playing") url = "/movie/now_playing";
    else if (slug === "tv_on_the_air") url = "/tv/on_the_air";
    else if (slug === "movie_top_rated") url = "/movie/top_rated";
    else if (slug === "tv_top_rated") url = "/tv/top_rated";
    
    if (!url) return "";
    return BASE_URL + url + buildParams(page);
}

function getUrlSearch(keyword, filtersJson) {
    var page = JSON.parse(filtersJson || "{}").page || 1;
    return BASE_URL + "/search/multi" + buildParams(page) + "&query=" + encodeURIComponent(keyword);
}

function buildParams(page) {
    return "?api_key=" + TMDB_API_KEY + "&language=" + LANG + "&page=" + page;
}

function parseListResponse(html) {
    try {
        var obj = JSON.parse(html);
        var items = [];
        var resItems = obj.results || [];
        for (var i = 0; i < resItems.length; i++) {
            var item = resItems[i];
            var type = item.media_type; 
            
            if (!type) {
                type = (item.first_air_date !== undefined || item.name !== undefined) ? "tv" : "movie";
            }
            if (type !== "movie" && type !== "tv") continue;

            var dateRaw = item.release_date || item.first_air_date;
            var year = dateRaw ? dateRaw.split("-")[0] : "N/A";

            items.push({
                id: type + "|" + item.id,
                title: item.title || item.name,
                posterUrl: item.poster_path ? IMG_BASE_URL + item.poster_path : "",
                backdropUrl: item.backdrop_path ? IMG_BASE_URL + item.backdrop_path : "",
                type: type === "movie" ? "MOVIE" : "TV SERIES",
                lang: item.original_language ? item.original_language.toUpperCase() : "EN",
                year: year,
                episode_current: item.vote_average ? "⭐ " + item.vote_average.toFixed(1) : "?",
                description: item.overview || "Đang cập nhật nội dung..."
            });
        }
        return JSON.stringify({
            items: items,
            pagination: {
                currentPage: obj.page,
                totalPages: obj.total_pages
            }
        });
    } catch (e) {
        return JSON.stringify({ items: [] });
    }
}

// =====================================================================
// CORE PLAYBACK ROUTER
// =====================================================================
// Adapter này chỉ dùng để sinh danh sách tập ban đầu (server mặc định trong parseMovieDetail).
// Các nguồn chuyển server (French/MoviesAPI/OPhim) vẫn đi qua getServers + resolver chain.
var SOURCE_ADAPTERS = [
    {
        key: "xpass",
        supportsMovie: true,
        supportsTv: true,
        movieServerName: "Nguồn VIP - Xpass",
        movieEpisodeName: "Full HD",
        tvServerPrefix: "Xpass - Phần ",
        buildMovieEpisodeId: function(context) {
            return "xpass_movie|" +
                context.tmdbId + "|" +
                encodeURIComponent(context.finalTitle || "") + "|" +
                encodeURIComponent(context.year || "N/A") + "|" +
                encodeURIComponent(context.sourceTitle || "") + "|" +
                encodeURIComponent(context.imdbId || "");
        },
        buildTvEpisodeId: function(context, seasonNumber, episodeNumber) {
            return "xpass_tv|" +
                context.tmdbId + "|" +
                seasonNumber + "|" +
                episodeNumber + "|" +
                encodeURIComponent(context.finalTitle || "") + "|" +
                encodeURIComponent(context.year || "N/A") + "|" +
                encodeURIComponent(context.sourceTitle || "") + "|" +
                encodeURIComponent(context.imdbId || "");
        }
    }
];

var DETAIL_ROUTE_HANDLERS = {
    "xpass_tv": buildXpassTvWatchUrl,
    "xpass_movie": buildXpassMovieWatchUrl,
    "frs_tv": buildFrenchTvSearchUrl,
    "frs_movie": buildFrenchMovieSearchUrl,
    "mapi_tv": buildMoviesApiTvUrl,
    "mapi_movie": buildMoviesApiMovieUrl
};

var DETAIL_RESOLVERS = [
    resolveMoviesApiDetailStep,
    resolveXpassPlaylistFromHtml,
    resolveFrenchSearchStep
];

var EMBED_RESOLVERS = [
    resolveDirectManifestText,
    resolveMoviesApiDetailStep,
    resolveMoviesApiVidoraEmbedStep,
    resolveFrenchSearchStep,
    resolveOphimSearchStep,
    resolveOphimPayload,
    resolveXpassEmbedStep,
    resolveFrenchDetailToApiStep,
    resolveFrenchFilmApiStep,
    resolveFrenchPackedEmbedStep,
    resolveXpassPlaylistJsonStep
];

function getUrlDetail(slug) {
    var parsed = parseSourceSlug(slug);
    var routeHandler = DETAIL_ROUTE_HANDLERS[parsed.prefix];

    if (routeHandler) {
        var routedUrl = routeHandler(parsed.parts);
        _LAST_DETAIL_REQUEST_URL = String(routedUrl || "");
        return routedUrl;
    }

    if (parsed.prefix === "tv" || parsed.prefix === "movie") {
        var tmdbUrl = buildTmdbDetailUrl(parsed.prefix, parsed.parts[1]);
        _LAST_DETAIL_REQUEST_URL = String(tmdbUrl || "");
        return tmdbUrl;
    }

    return "";
}

function parseMovieDetail(html) {
    var json = tryParseJson(html);
    if (!json || !json.id) {
        return JSON.stringify({ title: "Không tải được dữ liệu", servers: [] });
    }

    var title = json.title || json.name || "";
    var original = json.original_title || json.original_name || "";
    var finalTitle = title && original && title !== original ? title + " (" + original + ")" : (title || original);
    var sourceTitle = original || title || finalTitle;

    var catList = extractGenres(json.genres);
    var director = extractDirector(json.credits);
    var cast = extractTopCast(json.credits);
    var year = extractYear(json.release_date || json.first_air_date);
    var duration = json.runtime || (json.episode_run_time ? json.episode_run_time[0] : 0) || 0;

    var sourceContext = {
        tmdbId: String(json.id || ""),
        finalTitle: finalTitle,
        sourceTitle: sourceTitle,
        imdbId: cleanImdbId(json.imdb_id || ""),
        year: year
    };

    var servers = hasValidSeasons(json.seasons)
        ? buildTvServersByAdapters(sourceContext, json.seasons)
        : buildMovieServersByAdapters(sourceContext);

    return JSON.stringify({
        title: finalTitle,
        description: json.overview || "",
        backdropUrl: json.backdrop_path ? IMG_BASE_URL + json.backdrop_path : "",
        posterUrl: json.poster_path ? IMG_BASE_URL + json.poster_path : "",
        year: year,
        quality: "HD",
        status: json.status || "Full",
        rating: json.vote_average ? json.vote_average.toFixed(1) : "?",
        duration: duration ? duration + " Phút" : "N/A",
        category: catList.length > 0 ? catList.join(", ") : "N/A",
        director: director || "N/A",
        casts: cast || "N/A",
        servers: servers,
        headers: {},
        isEmbed: true
    });
}

function parseDetailResponse(html, sourceUrl) {
    clearResolveError();
    var requestUrl = String(sourceUrl || _LAST_DETAIL_REQUEST_URL || _LAST_FRENCH_SEARCH_URL || "");
    var payload = runResolverChain(DETAIL_RESOLVERS, String(html || ""), requestUrl);
    if (!payload || !payload.url) {
        if (_LAST_RESOLVE_ERROR) {
            throw new Error(_LAST_RESOLVE_ERROR);
        }
        throw new Error("[TMDB] Không resolve được URL detail cho server đã chọn");
    }
    return JSON.stringify(payload || { url: "" });
}

function parseEmbedResponse(html, url) {
    clearResolveError();
    var payload = runResolverChain(EMBED_RESOLVERS, String(html || ""), String(url || ""));
    if (!payload || !payload.url) {
        if (_LAST_RESOLVE_ERROR) {
            throw new Error(_LAST_RESOLVE_ERROR);
        }
        throw new Error("[TMDB] Không resolve được stream URL cho server đã chọn");
    }
    return JSON.stringify(payload || { url: "", isEmbed: false });
}

function parseSourceSlug(slug) {
    var value = String(slug || "");
    var parts = value.split("|");
    return {
        raw: value,
        parts: parts,
        prefix: parts[0] || ""
    };
}

function buildTmdbDetailUrl(typePrefix, tmdbId) {
    var id = String(tmdbId || "").trim();
    if (!id) return "";
    return BASE_URL + "/" + typePrefix + "/" + id + "?api_key=" + TMDB_API_KEY + "&language=" + LANG + "&append_to_response=videos,credits";
}

function buildXpassTvWatchUrl(parts) {
    return "https://play.xpass.top/e/tv/" + (parts[1] || "") + "/" + (parts[2] || "") + "/" + (parts[3] || "");
}

function buildXpassMovieWatchUrl(parts) {
    return "https://play.xpass.top/e/movie/" + (parts[1] || "");
}

function buildFrenchTvSearchUrl(parts) {
    return rememberFrenchSearch({
        source: "french_stream",
        type: "tv",
        tmdbId: parts[1] || "",
        season: parts[2] || "",
        episode: parts[3] || "",
        year: parts[4] || "",
        title: safeDecodeURIComponent(parts[5] || "")
    });
}

function buildFrenchMovieSearchUrl(parts) {
    return rememberFrenchSearch({
        source: "french_stream",
        type: "movie",
        tmdbId: parts[1] || "",
        year: parts[2] || "",
        title: safeDecodeURIComponent(parts[3] || "")
    });
}

function buildMoviesApiMovieUrl(parts) {
    var tmdbId = String(parts[1] || "").trim();
    var imdbId = cleanImdbId(parts[2] || "");
    var id = tmdbId || imdbId;
    if (!id) return "";
    return MOVIESAPI_DOMAIN + "/movie/" + encodeURIComponent(id);
}

function buildMoviesApiTvUrl(parts) {
    var tmdbId = String(parts[1] || "").trim();
    var season = String(parts[2] || "1").trim() || "1";
    var episode = String(parts[3] || "1").trim() || "1";
    var imdbId = cleanImdbId(parts[4] || "");
    var id = tmdbId || imdbId;
    if (!id) return "";
    return MOVIESAPI_DOMAIN + "/tv/" + encodeURIComponent(id) + "-" + encodeURIComponent(season) + "-" + encodeURIComponent(episode);
}

function rememberFrenchSearch(meta) {
    _LAST_FRENCH_META = meta || null;
    _LAST_FRENCH_SEARCH_URL = buildFrenchSearchUrl(meta || {});
    return _LAST_FRENCH_SEARCH_URL;
}

function extractGenres(genres) {
    var out = [];
    var list = genres || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].name) out.push(list[i].name);
    }
    return out;
}

function extractDirector(credits) {
    var crew = credits && credits.crew ? credits.crew : [];
    for (var i = 0; i < crew.length; i++) {
        if (crew[i] && crew[i].job === "Director") {
            return crew[i].name || "";
        }
    }
    return "";
}

function extractTopCast(credits) {
    if (!credits || !credits.cast) return "";
    return credits.cast.slice(0, 5).map(function(c) {
        return c.name;
    }).join(", ");
}

function extractYear(dateRaw) {
    var raw = String(dateRaw || "");
    return raw ? raw.split("-")[0] : "N/A";
}

function hasValidSeasons(seasons) {
    return seasons && seasons.length > 0;
}

function buildMovieServersByAdapters(context) {
    var servers = [];
    var adapter = SOURCE_ADAPTERS[0] || null;
    if (!adapter || adapter.supportsMovie === false) return servers;

    var episodeId = adapter.buildMovieEpisodeId(context);
    if (!episodeId) return servers;

    servers.push({
        name: adapter.movieServerName,
        episodes: [{
            id: episodeId,
            name: adapter.movieEpisodeName,
            slug: "full"
        }]
    });

    return servers;
}

function buildTvServersByAdapters(context, seasons) {
    var servers = [];
    var adapter = SOURCE_ADAPTERS[0] || null;
    if (!adapter || adapter.supportsTv === false) return servers;

    for (var s = 0; s < seasons.length; s++) {
        var season = seasons[s] || {};
        var seasonNumber = parseInt(season.season_number, 10);
        var episodeCount = parseInt(season.episode_count, 10);
        if (!seasonNumber || seasonNumber <= 0 || !episodeCount || episodeCount <= 0) continue;

        var episodes = [];

        for (var ep = 1; ep <= episodeCount; ep++) {
            var episodeId = adapter.buildTvEpisodeId(context, seasonNumber, ep);
            if (!episodeId) continue;

            episodes.push({
                id: episodeId,
                name: "Tập " + ep,
                slug: seasonNumber + "_" + ep
            });
        }

        if (episodes.length === 0) continue;

        servers.push({
            name: adapter.tvServerPrefix + seasonNumber,
            episodes: episodes
        });
    }

    return servers;
}

function runResolverChain(resolvers, html, sourceUrl) {
    for (var i = 0; i < resolvers.length; i++) {
        try {
            var payload = resolvers[i](html, sourceUrl);
            if (payload && payload.url) {
                return payload;
            }
        } catch (e) {
            debugLog("[Resolver Error]", e && e.message ? e.message : e);
        }
    }
    return null;
}

function resolveXpassPlaylistFromHtml(html, sourceUrl) {
    var playlistUrl = extractXpassPlaylistUrl(html);
    if (!playlistUrl) return null;

    var switchTag = extractSwitchTagFromUrl(sourceUrl);

    return {
        url: appendSwitchTag(playlistUrl, switchTag),
        headers: buildXpassHeaders("https://play.xpass.top/"),
        isEmbed: true
    };
}

function resolveMoviesApiDetailStep(html, requestUrl) {
    var url = String(requestUrl || "").trim();
    if (!isMoviesApiDomainUrl(url)) {
        return null;
    }

    if (/\/api\/(movie|tv)\//i.test(url)) {
        var apiPayload = tryParseJson(html);
        var embedFromApi = extractMoviesApiEmbedUrl(apiPayload);
        if (!embedFromApi) {
            setResolveError("[MOVIESAPI] API không trả video_url hợp lệ");
            return null;
        }

        if (isLikelyHlsUrl(embedFromApi)) {
            return {
                url: embedFromApi,
                headers: guessStreamHeaders(embedFromApi),
                mimeType: HLS_MIME_TYPE,
                subtitles: [],
                isEmbed: false
            };
        }

        return {
            url: embedFromApi,
            headers: buildMoviesApiHeaders(url),
            isEmbed: true
        };
    }

    var iframeUrl = extractFirstIframeUrl(html, url);
    if (iframeUrl) {
        return {
            url: iframeUrl,
            headers: buildMoviesApiHeaders(url),
            isEmbed: true
        };
    }

    var mappedApiUrl = buildMoviesApiApiUrlFromDetail(url);
    if (mappedApiUrl) {
        return {
            url: mappedApiUrl,
            headers: buildMoviesApiHeaders(mappedApiUrl),
            isEmbed: true
        };
    }

    setResolveError("[MOVIESAPI] Không tìm thấy iframe player trên trang detail");
    return null;
}
// PRODUCTION
function resolveMoviesApiVidoraEmbedStep(html, sourceUrl) {
    var url = String(sourceUrl || "");
    if (!/^https?:\/\/vidora\.stream\/embed\//i.test(url)) {
        return null;
    }

    var streamUrl = extractPackedM3u8Url(html);
    if (!streamUrl) {
        setResolveError("[MOVIESAPI] Không extract được m3u8 từ Vidora embed");
        return null;
    }

    var streamHeaders = buildVidoraHeaders(url);
    if (/netrocdn\.site|\.urlset\/master\.m3u8/i.test(streamUrl)) {
        var proxiedStreamUrl = buildLocalProxyMediaUrl(streamUrl, streamHeaders);
        if (proxiedStreamUrl) {
            return {
                url: proxiedStreamUrl,
                headers: {},
                mimeType: HLS_MIME_TYPE,
                subtitles: [],
                isEmbed: false
            };
        }
    }

    return {
        url: streamUrl,
        headers: streamHeaders,
        mimeType: HLS_MIME_TYPE,
        subtitles: [],
        isEmbed: false
    };
}


// Build APP
// function resolveMoviesApiVidoraEmbedStep(html, sourceUrl) {
//     var url = String(sourceUrl || "");
//     if (!/^https?:\/\/vidora\.stream\/embed\//i.test(url)) {
//         return null;
//     }

//     var streamUrl = extractPackedM3u8Url(html);
//     if (!streamUrl) {
//         setResolveError("[MOVIESAPI] Không extract được m3u8 từ Vidora embed");
//         return null;
//     }

//     var streamHeaders = buildVidoraHeaders(url);

//     return {
//         url: streamUrl,
//         headers: streamHeaders,
//         mimeType: HLS_MIME_TYPE,
//         subtitles: [],
//         isEmbed: false
//     };
// }

function resolveFrenchSearchStep(html, requestUrl) {
    var isFrenchSearchUrl = requestUrl.indexOf(FRENCH_STREAM_DOMAIN) !== -1 && (
        requestUrl.indexOf("subaction=search") !== -1 || requestUrl.indexOf("/xfsearch/") !== -1
    );
    if (!isFrenchSearchUrl && !isLikelyFrenchSearchResponse(html)) {
        return null;
    }

    var meta = parseMetaFromUrl(requestUrl);
    if (!meta || !meta.tmdbId) {
        meta = _LAST_FRENCH_META || {};
    }

    var headers = buildFrenchHeaders(requestUrl);
    var items = parseFrenchSearchItems(html);
    var detailUrl = findFrenchDetailUrl(items, meta);
    var blocked = isFrenchSearchBlocked(html);

    debugLog("[FrenchStream] urlRequest:", requestUrl);
    debugLog("[FrenchStream] headers:", JSON.stringify(headers));
    debugLog("[FrenchStream] item count:", items.length);
    if (blocked) {
        debugLog("[FrenchStream] search appears blocked/challenge page");
        setResolveError("[FRENCH_STREAM] Search bị chặn bởi challenge (Cloudflare)");
        return null;
    }

    if (!items.length) {
        setResolveError("[FRENCH_STREAM] Không tìm thấy kết quả search phù hợp");
        return null;
    }

    if (detailUrl) {
        var newsId = extractFrenchNewsIdFromUrl(detailUrl);
        if (newsId) {
            var apiUrl = FRENCH_STREAM_DOMAIN + "/engine/ajax/film_api.php?id=" + newsId;
            debugLog("[FrenchStream] search -> api:", apiUrl);
            return {
                url: apiUrl,
                headers: buildFrenchHeaders(detailUrl),
                isEmbed: true
            };
        }

        return {
            url: detailUrl,
            headers: headers,
            isEmbed: true
        };
    }

    setResolveError("[FRENCH_STREAM] Không match được phim trên trang search");
    return null;
}

function resolveDirectManifestText(html, sourceUrl) {
    if (html.indexOf("#EXTM3U") === -1 || !sourceUrl) return null;

    return {
        url: sourceUrl,
        headers: guessStreamHeaders(sourceUrl),
        mimeType: HLS_MIME_TYPE,
        subtitles: [],
        isEmbed: false
    };
}

function resolveOphimSearchStep(html, sourceUrl) {
    if (!sourceUrl || sourceUrl.indexOf("ophim1.com/v1/api/tim-kiem") === -1) {
        return null;
    }

    var data = tryParseJson(html);
    if (!data || !data.data || !data.data.items || !data.data.items.length) {
        return null;
    }

    var first = data.data.items[0] || {};
    var slug = String(first.slug || "").trim();
    if (!slug) return null;

    var targetEpisode = extractOphimEpisodeTarget(sourceUrl);
    return {
        url: "https://ophim1.com/v1/api/phim/" + slug + "?ep=" + encodeURIComponent(targetEpisode),
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://ophim1.com"
        },
        isEmbed: true
    };
}

function resolveOphimPayload(html, sourceUrl) {
    if (!sourceUrl || sourceUrl.indexOf("ophim1.com/v1/api/phim/") === -1) {
        return null;
    }

    var data = tryParseJson(html);
    if (!data) return null;

    var targetEpisode = extractOphimEpisodeTarget(sourceUrl);
    var streamUrl = extractOphimStreamUrl(data, targetEpisode);
    if (!streamUrl) return null;

    return {
        url: streamUrl,
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://ophim1.com"
        },
        mimeType: isLikelyHlsUrl(streamUrl) ? HLS_MIME_TYPE : "",
        subtitles: [],
        isEmbed: false
    };
}

function resolveXpassEmbedStep(html, sourceUrl) {
    if (!sourceUrl || sourceUrl.indexOf("play.xpass.top/e/") === -1) {
        return null;
    }

    var playlistUrl = extractXpassPlaylistUrl(html);
    if (!playlistUrl) return null;
    var switchTag = extractSwitchTagFromUrl(sourceUrl);

    return {
        url: appendSwitchTag(playlistUrl, switchTag),
        headers: buildXpassHeaders(sourceUrl),
        isEmbed: true
    };
}

function resolveFrenchDetailToApiStep(html, sourceUrl) {
    if (!sourceUrl || sourceUrl.indexOf(FRENCH_STREAM_DOMAIN) === -1 || sourceUrl.indexOf("/engine/ajax/film_api.php") !== -1) {
        return null;
    }

    var newsIdMatch = html.match(/data-newsid\s*=\s*"?(\d+)/i);
    if (!newsIdMatch) {
        setResolveError("[FRENCH_STREAM] Không tìm thấy data-newsid trên trang detail");
        return null;
    }

    var apiUrl = FRENCH_STREAM_DOMAIN + "/engine/ajax/film_api.php?id=" + newsIdMatch[1];
    debugLog("[FrenchStream] detail -> api:", apiUrl);
    return {
        url: apiUrl,
        headers: buildFrenchHeaders(sourceUrl),
        isEmbed: true
    };
}

function resolveFrenchFilmApiStep(html, sourceUrl) {
    if (!sourceUrl || sourceUrl.indexOf("/engine/ajax/film_api.php") === -1) {
        return null;
    }

    var api = tryParseJson(html);
    if (!api) {
        setResolveError("[FRENCH_STREAM] Payload film_api không hợp lệ");
        return null;
    }

    var pickedUrl = pickFrenchPlayerUrl(api.players || {});
    if (!pickedUrl) {
        setResolveError("[FRENCH_STREAM] Không có player URL hợp lệ trong film_api");
        return null;
    }

    debugLog("[FrenchStream] picked player URL:", pickedUrl);
    return {
        url: pickedUrl,
        headers: {
            "Referer": FRENCH_STREAM_DOMAIN + "/",
            "Origin": FRENCH_STREAM_DOMAIN,
            "User-Agent": FRENCH_STREAM_USER_AGENT,
            "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        isEmbed: true
    };
}

function resolveFrenchPackedEmbedStep(html, sourceUrl) {
    if (!sourceUrl) return null;
    if (sourceUrl.indexOf("vidzy.live/embed-") === -1 && sourceUrl.indexOf("fsvid.lol/embed-") === -1) {
        return null;
    }

    var streamFromPacked = extractPackedM3u8Url(html);
    if (!streamFromPacked) {
        setResolveError("[FRENCH_STREAM] Không extract được m3u8 từ trang embed");
        return null;
    }

    var originHost = sourceUrl.indexOf("fsvid.lol") !== -1 ? "https://fsvid.lol" : "https://vidzy.live";
    debugLog("[FrenchStream] extracted m3u8:", streamFromPacked);
    return {
        url: streamFromPacked,
        headers: {
            "Referer": originHost + "/",
            "Origin": originHost,
            "User-Agent": FRENCH_STREAM_USER_AGENT,
            "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        mimeType: HLS_MIME_TYPE,
        subtitles: [],
        isEmbed: false
    };
}

function resolveXpassPlaylistJsonStep(html, sourceUrl) {
    var json = tryParseJson(html);
    if (!json || !json.playlist || !json.playlist.length) return null;

    var first = json.playlist[0] || {};
    var sources = first.sources || [];
    if (!sources.length || !sources[0].file) return null;

    var switchTag = extractSwitchTagFromUrl(sourceUrl);
    var taggedUrl = appendSwitchTag(sources[0].file, switchTag);

    return {
        url: taggedUrl,
        headers: buildXpassHeaders("https://play.xpass.top/"),
        mimeType: HLS_MIME_TYPE,
        subtitles: [],
        isEmbed: false
    };
}

function extractXpassPlaylistUrl(html) {
    var match = String(html || "").match(/"playlist"\s*:\s*"([^"]+)"/i);
    if (!match || !match[1]) return "";

    var path = match[1];
    return /^https?:\/\//i.test(path) ? path : "https://play.xpass.top" + path;
}

function extractOphimEpisodeTarget(url) {
    var match = String(url || "").match(/[?&]ep=([^&]+)/i);
    if (!match || !match[1]) return "1";
    return String(match[1]).trim() || "1";
}

function extractOphimStreamUrl(data, targetEpisode) {
    var rawEpisodes = data.episodes || (data.data && data.data.item && data.data.item.episodes) || [];
    if (!rawEpisodes.length) return "";

    var serverData = rawEpisodes[0] && rawEpisodes[0].server_data ? rawEpisodes[0].server_data : [];
    if (!serverData.length) return "";

    var target = String(targetEpisode || "1").toLowerCase();
    var selected = serverData[0];

    for (var i = 0; i < serverData.length; i++) {
        var name = String(serverData[i] && serverData[i].name ? serverData[i].name : "").toLowerCase();
        if (name === target || (target === "full" && name === "full")) {
            selected = serverData[i];
            break;
        }
    }

    return selected ? (selected.link_m3u8 || selected.link_embed || "") : "";
}

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value || "";
    }
}

function decodeHtmlEntities(text) {
    return String(text || "")
        .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
        .replace(/&#x([0-9a-f]+);/gi, function(_, n) { return String.fromCharCode(parseInt(n, 16)); })
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ");
}

function normalizeTitleForCompare(text) {
    var value = decodeHtmlEntities(text || "");
    value = value.replace(/<[^>]*>/g, " ");
    if (typeof value.normalize === "function") {
        value = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    value = value.toLowerCase();
    value = value.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    return value;
}

function toAbsoluteUrl(base, url) {
    var clean = String(url || "").trim();
    if (!clean) return "";
    if (/^https?:\/\//i.test(clean)) return clean;
    if (clean.indexOf("//") === 0) return "https:" + clean;
    if (clean.charAt(0) === "/") return String(base || "").replace(/\/$/, "") + clean;
    return String(base || "").replace(/\/$/, "") + "/" + clean.replace(/^\//, "");
}

function buildFrenchSearchUrl(meta) {
    var title = String(meta && meta.title ? meta.title : "").toLowerCase().trim();
    var story = encodeURIComponent(title).replace(/%20/g, "+");
    var urlRequest = FRENCH_STREAM_DOMAIN + "/xfsearch/" + story + "/";

    try {
        urlRequest += "?va_meta=" + encodeURIComponent(JSON.stringify(meta || {}));
    } catch (e) {
        // no-op
    }

    return urlRequest;
}

function parseMetaFromUrl(url) {
    var query = String(url || "");
    var match = query.match(/[?&]va_meta=([^&]+)/i);
    if (!match) return {};

    try {
        return JSON.parse(decodeURIComponent(match[1]));
    } catch (e) {
        return {};
    }
}

function isMoviesApiDomainUrl(url) {
    var source = String(url || "").toLowerCase();
    if (!/^https?:\/\//.test(source)) return false;
    return source.indexOf("moviesapi.to") !== -1 || source.indexOf("moviesapi.club") !== -1;
}

function buildMoviesApiApiUrlFromDetail(url) {
    var source = String(url || "").split("#")[0].split("?")[0];
    if (!source || /\/api\/(movie|tv)\//i.test(source)) {
        return "";
    }

    var origin = getUrlOrigin(source);
    if (!origin || !isMoviesApiDomainUrl(origin)) {
        origin = MOVIESAPI_DOMAIN;
    }
    var apiOrigin = origin.indexOf("ww2.moviesapi.to") !== -1 ? origin : MOVIESAPI_WW2_DOMAIN;

    var movieMatch = source.match(/\/movie\/([^\/?#]+)/i);
    if (movieMatch && movieMatch[1]) {
        return apiOrigin + "/api/movie/" + encodeURIComponent(movieMatch[1]);
    }

    var tvDashMatch = source.match(/\/tv\/([^\/?#]+)-(\d+)-(\d+)$/i);
    if (tvDashMatch && tvDashMatch[1]) {
        return apiOrigin + "/api/tv/" + encodeURIComponent(tvDashMatch[1]) + "/" + encodeURIComponent(tvDashMatch[2]) + "/" + encodeURIComponent(tvDashMatch[3]);
    }

    var tvSlashMatch = source.match(/\/tv\/([^\/?#]+)\/(\d+)\/(\d+)$/i);
    if (tvSlashMatch && tvSlashMatch[1]) {
        return apiOrigin + "/api/tv/" + encodeURIComponent(tvSlashMatch[1]) + "/" + encodeURIComponent(tvSlashMatch[2]) + "/" + encodeURIComponent(tvSlashMatch[3]);
    }

    return "";
}

function extractMoviesApiEmbedUrl(payload) {
    if (!payload || typeof payload !== "object") return "";

    var url = String(payload.video_url || payload.upn_url || payload.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return "";
    return url;
}

function extractFirstIframeUrl(html, baseUrl) {
    var source = String(html || "");
    var match = source.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!match || !match[1]) return "";

    return toAbsoluteUrl(baseUrl || "", decodeHtmlEntities(match[1]));
}

function buildFrenchHeaders(urlRequest) {
    var referer = String(urlRequest || FRENCH_STREAM_DOMAIN + "/");
    if (referer.indexOf(FRENCH_STREAM_DOMAIN) !== 0) {
        referer = FRENCH_STREAM_DOMAIN + "/";
    }
    var origin = getUrlOrigin(referer) || FRENCH_STREAM_DOMAIN;
    var headers = {
        "Referer": referer,
        "Origin": origin,
        "User-Agent": FRENCH_STREAM_USER_AGENT,
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "*/*"
    };

    if (FRENCH_STREAM_COOKIE) {
        headers["Cookie"] = FRENCH_STREAM_COOKIE;
    }

    return headers;
}

function buildCloudnestraHeaders(refererUrl) {
    var referer = String(refererUrl || CLOUDNESTRA_DOMAIN + "/");
    if (referer.indexOf(CLOUDNESTRA_DOMAIN) !== 0) {
        referer = CLOUDNESTRA_DOMAIN + "/";
    }

    return {
        "Referer": referer,
        "Origin": CLOUDNESTRA_DOMAIN,
        "User-Agent": FRENCH_STREAM_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*"
    };
}

function buildMoviesApiHeaders(refererUrl) {
    var referer = String(refererUrl || MOVIESAPI_DOMAIN + "/");
    if (!isMoviesApiDomainUrl(referer)) {
        referer = MOVIESAPI_DOMAIN + "/";
    }

    var origin = getUrlOrigin(referer);
    if (!origin || !isMoviesApiDomainUrl(origin)) {
        origin = MOVIESAPI_DOMAIN;
    }

    return {
        "Referer": referer,
        "Origin": origin,
        "User-Agent": FRENCH_STREAM_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*"
    };
}

function buildVidoraHeaders(refererUrl) {
    var referer = String(refererUrl || "https://vidora.stream/");
    if (referer.indexOf("https://vidora.stream") !== 0) {
        referer = "https://vidora.stream/";
    }

    return {
        "Referer": referer,
        "Origin": "https://vidora.stream",
        "User-Agent": FRENCH_STREAM_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*"
    };
}

function buildLocalProxyMediaUrl(targetUrl, headers) {
    var target = String(targetUrl || "").trim();
    if (!/^https?:\/\//i.test(target)) return "";

    var proxyUrl = "http://127.0.0.1:8787/media?url=" + encodeURIComponent(target);
    var requestHeaders = headers || {};

    var referer = String(requestHeaders.Referer || requestHeaders.referer || "").trim();
    if (referer) {
        proxyUrl += "&referer=" + encodeURIComponent(referer);
    }

    var origin = String(requestHeaders.Origin || requestHeaders.origin || "").trim();
    if (origin) {
        proxyUrl += "&origin=" + encodeURIComponent(origin);
    }

    return proxyUrl;
}

function buildXpassHeaders(refererUrl) {
    var referer = String(refererUrl || "https://play.xpass.top/");
    if (!/^https?:\/\//i.test(referer)) {
        referer = "https://play.xpass.top/";
    }
    if (referer.indexOf("play.xpass.top") === -1) {
        referer = "https://play.xpass.top/";
    }
    if (referer.indexOf("/mdata/") !== -1 || referer.indexOf("/mvid/") !== -1 || referer.indexOf("/playlist") !== -1) {
        referer = "https://play.xpass.top/";
    }

    return {
        "Referer": referer,
        "Origin": "https://play.xpass.top",
        "User-Agent": FRENCH_STREAM_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*"
    };
}

function guessStreamHeaders(streamUrl) {
    var url = String(streamUrl || "");
    if (!url) return {};

    // MoviesAPI/vidora stream host requires vidora referer/origin.
    if (/netrocdn\.site|\.urlset\/master\.m3u8/i.test(url)) {
        var frToken = extractQueryParam(url, "fr");
        var vidoraReferer = frToken
            ? ("https://vidora.stream/embed/" + encodeURIComponent(frToken))
            : "https://vidora.stream/";
        return buildVidoraHeaders(vidoraReferer);
    }

    if (/play\.xpass\.top|trovianaworks\.online/i.test(url)) {
        return buildXpassHeaders("https://play.xpass.top/");
    }

    if (/cloudnestra\.com|tmstr\d+\.|fasdf\d+\.|app\d+\./i.test(url)) {
        return buildCloudnestraHeaders(CLOUDNESTRA_DOMAIN + "/");
    }

    var origin = getUrlOrigin(url);
    if (!origin) return {};

    return {
        "Referer": origin + "/",
        "Origin": origin,
        "User-Agent": FRENCH_STREAM_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*"
    };
}

function isLikelyHlsUrl(url) {
    return /\.m3u8(\?|$)/i.test(String(url || ""));
}

function getUrlOrigin(url) {
    var source = String(url || "");
    var m = source.match(/^(https?:\/\/[^\/]+)/i);
    return m ? m[1] : "";
}

function extractQueryParam(url, key) {
    var source = String(url || "");
    var name = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var match = source.match(new RegExp("[?&]" + name + "=([^&#]*)", "i"));
    if (!match || !match[1]) return "";

    var value = String(match[1]).replace(/\+/g, " ");
    return safeDecodeURIComponent(value);
}

function extractSwitchTagFromUrl(url) {
    var source = String(url || "");
    if (!source) return "";

    var queryTag = extractQueryParam(source, "sv");
    if (queryTag) return String(queryTag).trim();

    var hashMatch = source.match(/#(?:[^#]*&)?sv=([^&#]+)/i);
    if (!hashMatch || !hashMatch[1]) return "";
    return safeDecodeURIComponent(hashMatch[1]);
}

function appendSwitchTag(url, tag) {
    var targetUrl = String(url || "").trim();
    var sourceTag = String(tag || "").trim();
    if (!targetUrl || !sourceTag) return targetUrl;

    if (/[#&]sv=/i.test(targetUrl)) {
        return targetUrl;
    }

    var encodedTag = encodeURIComponent(sourceTag);
    if (targetUrl.indexOf("#") === -1) {
        return targetUrl + "#sv=" + encodedTag;
    }

    return targetUrl + "&sv=" + encodedTag;
}

function parseFrenchSearchItems(html) {
    var out = [];
    var source = String(html || "");
    var pairRegex = /<a[^>]*class=['"][^'"]*short-poster[^'"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>[\s\S]*?<div[^>]*class=['"][^'"]*short-title[^'"]*['"][^>]*>([\s\S]*?)<\/div>/gi;
    var match;

    while ((match = pairRegex.exec(source)) !== null) {
        var href = toAbsoluteUrl(FRENCH_STREAM_DOMAIN, match[1]);
        var title = decodeHtmlEntities(match[2]).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (!href || !title) continue;

        out.push({
            href: href,
            title: title,
            normalized: normalizeTitleForCompare(title)
        });
    }

    // Fallback parser cho markup cũ.
    if (out.length === 0) {
        var chunks = source.split(/<div[^>]*class=['"][^'"]*\bshort\b[^'"]*['"][^>]*>/i);

        for (var i = 1; i < chunks.length; i++) {
            var chunk = chunks[i];
            var hrefMatch = chunk.match(/class=['"][^'"]*short-poster[^'"]*['"][^>]*href=['"]([^'"]+)['"]/i);
            var titleMatch = chunk.match(/class=['"][^'"]*short-title[^'"]*['"][^>]*>\s*([\s\S]*?)\s*<\/div>/i);

            if (!hrefMatch || !titleMatch) continue;

            var href2 = toAbsoluteUrl(FRENCH_STREAM_DOMAIN, hrefMatch[1]);
            var title2 = decodeHtmlEntities(titleMatch[1]).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

            if (!href2 || !title2) continue;
            out.push({
                href: href2,
                title: title2,
                normalized: normalizeTitleForCompare(title2)
            });
        }
    }

    // Fallback cho layout item-poster ở một số mirror.
    if (out.length === 0) {
        var itemRegex = /<a[^>]*class=['"][^'"]*item-poster[^'"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>[\s\S]*?<div[^>]*class=['"][^'"]*item-poster__title[^'"]*['"][^>]*>([\s\S]*?)<\/div>/gi;

        while ((match = itemRegex.exec(source)) !== null) {
            var href3 = toAbsoluteUrl(FRENCH_STREAM_DOMAIN, match[1]);
            var title3 = decodeHtmlEntities(match[2]).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

            if (!href3 || !title3) continue;
            out.push({
                href: href3,
                title: title3,
                normalized: normalizeTitleForCompare(title3)
            });
        }
    }

    return out;
}

function isFrenchSearchBlocked(html) {
    var source = String(html || "");
    if (!source) return true;

    return /<title>\s*Chargement en cours\s*<\/title>/i.test(source) ||
        /attention required/i.test(source) ||
        /cf-browser-verification/i.test(source) ||
        /just a moment/i.test(source);
}

function isLikelyFrenchSearchResponse(html) {
    var source = String(html || "");
    if (!source) return false;

    return /short-poster/i.test(source) ||
        /short-title/i.test(source) ||
    /item-poster/i.test(source) ||
    /item-poster__title/i.test(source) ||
        /<title>\s*Chargement en cours\s*<\/title>/i.test(source);
}

function buildFrenchTitleTargets(meta) {
    var title = String(meta && meta.title ? meta.title : "").trim();
    var year = String(meta && meta.year ? meta.year : "").trim();
    var season = String(meta && meta.season ? meta.season : "").trim();
    var type = String(meta && meta.type ? meta.type : "movie").toLowerCase();

    var targets = [];
    if (!title) return targets;

    if (type === "tv") {
        if (season) {
            targets.push(title + " - Saison " + season);
            targets.push(title + " Saison " + season);
            targets.push(title + ": Saison " + season);
        }
        targets.push(title);
    } else {
        targets.push(title);
        if (year && year !== "N/A") {
            targets.push(title + "(" + year + ")");
            targets.push(title + " (" + year + ")");
            targets.push(title + " " + year);
        }
    }

    var normalized = [];
    var seen = {};

    for (var i = 0; i < targets.length; i++) {
        var norm = normalizeTitleForCompare(targets[i]);
        if (!norm || seen[norm]) continue;
        seen[norm] = true;
        normalized.push(norm);
    }

    return normalized;
}

function isFrenchTitleMatch(candidate, target) {
    if (!candidate || !target) return false;
    if (candidate === target) return true;
    if (candidate.indexOf(target) !== -1) return true;
    if (target.indexOf(candidate) !== -1) {
        var minLen = Math.max(8, Math.floor(target.length * 0.85));
        if (candidate.length >= minLen) return true;
    }
    return false;
}

function computeTitleSimilarity(candidate, target) {
    if (!candidate || !target) return 0;
    if (isFrenchTitleMatch(candidate, target)) return 1;

    var candParts = candidate.split(/\s+/).filter(Boolean);
    var targetParts = target.split(/\s+/).filter(Boolean);
    if (candParts.length === 0 || targetParts.length === 0) return 0;

    var lookup = {};
    for (var i = 0; i < targetParts.length; i++) {
        lookup[targetParts[i]] = true;
    }

    var common = 0;
    for (var j = 0; j < candParts.length; j++) {
        if (lookup[candParts[j]]) common += 1;
    }

    var denom = Math.max(targetParts.length, candParts.length);
    return denom > 0 ? (common / denom) : 0;
}

function countSharedTitleTokens(candidate, target) {
    if (!candidate || !target) return 0;

    var candParts = candidate.split(/\s+/).filter(Boolean);
    var targetParts = target.split(/\s+/).filter(Boolean);
    if (candParts.length === 0 || targetParts.length === 0) return 0;

    var targetLookup = {};
    for (var i = 0; i < targetParts.length; i++) {
        targetLookup[targetParts[i]] = true;
    }

    var counted = {};
    var common = 0;
    for (var j = 0; j < candParts.length; j++) {
        var token = candParts[j];
        if (!token || counted[token]) continue;
        if (targetLookup[token]) {
            counted[token] = true;
            common += 1;
        }
    }

    return common;
}

function findFrenchDetailUrl(items, meta) {
    if (!items || items.length === 0) return "";
    var targets = buildFrenchTitleTargets(meta || {});
    var bestItem = null;
    var bestScore = 0;
    var bestSharedItem = null;
    var bestSharedCount = 0;
    var bestSharedCoverage = 0;
    var bestSharedTargetLength = 0;

    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        debugLog("[FrenchStream] compare title:", item.title);

        for (var j = 0; j < targets.length; j++) {
            var target = targets[j];
            var score = computeTitleSimilarity(item.normalized, target);
            if (score > bestScore) {
                bestScore = score;
                bestItem = item;
            }

            var targetParts = target.split(/\s+/).filter(Boolean);
            var targetPartCount = targetParts.length;
            var sharedCount = countSharedTitleTokens(item.normalized, target);
            var sharedCoverage = targetPartCount > 0 ? (sharedCount / targetPartCount) : 0;

            if (
                sharedCoverage > bestSharedCoverage ||
                (sharedCoverage === bestSharedCoverage && sharedCount > bestSharedCount)
            ) {
                bestSharedCoverage = sharedCoverage;
                bestSharedCount = sharedCount;
                bestSharedItem = item;
                bestSharedTargetLength = targetPartCount;
            }

            if (score >= 0.96) {
                debugLog("[FrenchStream] matched detail:", item.href);
                return item.href;
            }
        }
    }

    if (bestItem && bestScore >= 0.65) {
        debugLog("[FrenchStream] fuzzy matched detail:", bestItem.href, "score=", bestScore);
        return bestItem.href;
    }

    if (bestSharedItem && bestSharedTargetLength >= 4 && bestSharedCount >= 3 && bestSharedCoverage >= 0.5) {
        debugLog(
            "[FrenchStream] token matched detail:",
            bestSharedItem.href,
            "shared=",
            bestSharedCount,
            "coverage=",
            bestSharedCoverage
        );
        return bestSharedItem.href;
    }

    debugLog("[FrenchStream] no title match for requested media");
    return "";
}

function extractFrenchNewsIdFromUrl(url) {
    var source = String(url || "");
    if (!source) return "";

    var directMatch = source.match(/[?&](?:id|newsid)=(\d+)/i);
    if (directMatch && directMatch[1]) {
        return directMatch[1];
    }

    var slugMatch = source.match(/-(\d+)\.html?(?:[?#]|$)/i);
    if (slugMatch && slugMatch[1]) {
        return slugMatch[1];
    }

    var prefixedSlugMatch = source.match(/\/(\d+)-[^\/]+\.html?(?:[?#]|$)/i);
    if (prefixedSlugMatch && prefixedSlugMatch[1]) {
        return prefixedSlugMatch[1];
    }

    var pathMatch = source.match(/\/(\d+)(?:\/|$|\?|#)/);
    if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
    }

    return "";
}

function cleanImdbId(value) {
    var raw = String(value || "").toLowerCase();
    if (!raw) return "";

    var strictMatch = raw.match(/(?:^|[^a-z0-9])(tt\d{6,9})(?:$|[^0-9])/i);
    if (strictMatch && strictMatch[1]) {
        return strictMatch[1].toLowerCase();
    }

    var relaxedMatch = raw.match(/tt(\d{6,14})/i);
    if (!relaxedMatch || !relaxedMatch[1]) return "";

    var digits = relaxedMatch[1];
    if (digits.length > 9) {
        digits = digits.slice(0, 8);
    }
    if (digits.length < 6) return "";

    return "tt" + digits;
}

function pickFrenchPlayerUrl(players) {
    if (!players || typeof players !== "object") return "";

    var candidates = [
        players.vidzy && players.vidzy["default"],
        players.vidzy && players.vidzy.vostfr,
        players.vidzy && players.vidzy.vfq,
        players.vidzy && players.vidzy.vff,
        players.premium && players.premium["default"],
        players.uqload && players.uqload["default"],
        players.voe && players.voe["default"],
        players.filmoon && players.filmoon["default"],
        players.dood && players.dood["default"]
    ];

    if (players.netu && players.netu["default"]) {
        candidates.push("https://1.multiup.us/player/embed_player.php?vid=" + players.netu["default"] + "&autoplay=no");
    }

    for (var i = 0; i < candidates.length; i++) {
        var url = String(candidates[i] || "").trim();
        if (/^https?:\/\//i.test(url)) {
            return url;
        }
    }

    return "";
}

function unpackEvalScripts(html) {
    var source = String(html || "");
    var scripts = [];
    var regex = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('[\s\S]*?\.split\('\|'\)\)\)/g;
    var match;

    while ((match = regex.exec(source)) !== null) {
        try {
            var expression = match[0].slice(5, -1); // remove eval( ... )
            var decoded = (new Function("return (" + expression + ");"))();
            if (decoded) scripts.push(String(decoded));
        } catch (e) {
            debugLog("[FrenchStream] unpack eval error:", e.message || e);
        }
    }

    return scripts;
}

function extractPackedM3u8Url(html) {
    var rawHtml = String(html || "");
    var normalizedHtml = rawHtml.replace(/\\\//g, "/");
    var direct = normalizedHtml.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
    if (direct && direct[0]) {
        return decodeHtmlEntities(direct[0]);
    }

    var decodedScripts = unpackEvalScripts(rawHtml);
    for (var i = 0; i < decodedScripts.length; i++) {
        var m3u8Match = decodedScripts[i].match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
        if (m3u8Match && m3u8Match[0]) {
            return decodeHtmlEntities(m3u8Match[0]);
        }
    }

    return "";
}

function getUrlCategories() { return ""; }
function getUrlCountries() { return ""; }
function getUrlYears() { return ""; }
function parseCountriesResponse(html) { return "[]"; }
function parseYearsResponse(html) { return "[]"; }
function parseCategoriesResponse(html) { return "[]"; }

// =====================================================================
// BƯỚC 3: HỆ THỐNG GET SERVERS (CHUYỂN NGUỒN TRONG PLAYER)
// =====================================================================

function getServers(slug) {
    var meta = extractServerSwitchMeta(slug);
    _SERVER_SWITCH_CANDIDATES = buildServerSwitchCandidates(meta);
    if (!_SERVER_SWITCH_CANDIDATES.length) return "";

    // URL mồi ổn định để App/Preview luôn gọi parseServerResponse.
    return BASE_URL + "/configuration?api_key=" + TMDB_API_KEY;
}

function parseServerResponse(html) {
    var out = [];
    for (var i = 0; i < _SERVER_SWITCH_CANDIDATES.length; i++) {
        var item = _SERVER_SWITCH_CANDIDATES[i] || {};
        if (!item.url) continue;

        out.push({
            name: item.name || ("Server " + (i + 1)),
            url: item.url,
            isEmbed: item.isEmbed !== false
        });
    }

    _SERVER_SWITCH_CANDIDATES = [];
    return JSON.stringify(out);
}

function extractServerSwitchMeta(slug) {
    var parsed = parseSourceSlug(slug);
    var parts = parsed.parts;
    var prefix = parsed.prefix;

    if (prefix === "xpass_movie") {
        return {
            type: "movie",
            tmdbId: String(parts[1] || "").trim(),
            season: "",
            episode: "full",
            finalTitle: safeDecodeURIComponent(parts[2] || ""),
            year: safeDecodeURIComponent(parts[3] || "N/A"),
            sourceTitle: safeDecodeURIComponent(parts[4] || ""),
            imdbId: cleanImdbId(safeDecodeURIComponent(parts[5] || ""))
        };
    }

    if (prefix === "xpass_tv") {
        return {
            type: "tv",
            tmdbId: String(parts[1] || "").trim(),
            season: String(parts[2] || "1").trim() || "1",
            episode: String(parts[3] || "1").trim() || "1",
            finalTitle: safeDecodeURIComponent(parts[4] || ""),
            year: safeDecodeURIComponent(parts[5] || "N/A"),
            sourceTitle: safeDecodeURIComponent(parts[6] || ""),
            imdbId: cleanImdbId(safeDecodeURIComponent(parts[7] || ""))
        };
    }

    return null;
}

function buildServerSwitchCandidates(meta) {
    if (!meta) return [];

    var tmdbId = String(meta.tmdbId || "").trim();
    var imdbId = cleanImdbId(meta.imdbId || "");
    if (!tmdbId && !imdbId) return [];

    var title = String(meta.sourceTitle || meta.finalTitle || "").trim();
    var year = String(meta.year || "N/A").trim() || "N/A";
    var season = String(meta.season || "1").trim() || "1";
    var episode = String(meta.episode || "1").trim() || "1";
    var candidates = [];

    if (meta.type === "tv") {
        pushServerCandidate(candidates, "FrenchStream", buildFrenchTvSearchUrl([
            "frs_tv",
            tmdbId || imdbId,
            season,
            episode,
            year,
            encodeURIComponent(title)
        ]));

        pushServerCandidate(candidates, "MoviesAPI", buildMoviesApiTvUrl([
            "mapi_tv",
            tmdbId || imdbId,
            season,
            episode,
            imdbId
        ]));

        pushServerCandidate(candidates, "OPhim Dự Phòng", buildOphimSearchUrl(title, episode));
        return candidates;
    }

    pushServerCandidate(candidates, "FrenchStream", buildFrenchMovieSearchUrl([
        "frs_movie",
        tmdbId || imdbId,
        year,
        encodeURIComponent(title)
    ]));

    pushServerCandidate(candidates, "MoviesAPI", buildMoviesApiMovieUrl([
        "mapi_movie",
        tmdbId || imdbId,
        imdbId
    ]));

    pushServerCandidate(candidates, "OPhim Dự Phòng", buildOphimSearchUrl(title, "full"));
    return candidates;
}

function pushServerCandidate(list, name, url) {
    var normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) return;

    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].url === normalizedUrl) {
            return;
        }
    }

    list.push({
        name: name,
        url: normalizedUrl,
        isEmbed: true
    });
}

function buildOphimSearchUrl(title, episodeTarget) {
    var keyword = String(title || "").trim();
    if (!keyword) return "";

    var episode = String(episodeTarget || "1").trim() || "1";
    return "https://ophim1.com/v1/api/tim-kiem?keyword=" + encodeURIComponent(keyword) + "&ep=" + encodeURIComponent(episode);
}
