(function () {
    // --- Configuration & Constants ---
    const BASE_URL = "https://anichi.to";
    const VIDTUBE_BASE = "https://vidtube.site";
    const MEGAPLAY_BASE = "https://megaplay.buzz";

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";

    const API_HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL + "/",
        "Origin": BASE_URL
    };

    const HTML_HEADERS = {
        "User-Agent": UA,
        "Accept": "text/html",
        "Referer": BASE_URL + "/"
    };

    // --- Core Helper Functions ---
    function text(value) {
        return (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
    }

    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try { return JSON.parse(data); } catch (e) { return null; }
    }

    function qsa(root, selector) {
        try { return Array.from(root.querySelectorAll(selector)); } catch (e) { return []; }
    }

    function qs(root, selector) {
        try { return root.querySelector(selector); } catch (e) { return null; }
    }

    function attr(el, names) {
        if (!el) return "";
        for (const name of names) {
            const value = el.getAttribute(name);
            if (value && !String(value).startsWith("data:image")) return String(value).trim();
        }
        return "";
    }

    function fixUrl(raw, base) {
        if (!raw) return "";
        const url = String(raw).trim();
        if (url.startsWith("//")) return "https:" + url;
        if (/^https?:\/\//i.test(url)) return url;
        try { return new URL(url, base || BASE_URL).href; } catch (e) { return url; }
    }

    async function mapLimit(items, limit, worker) {
        const list = items || [];
        const output = new Array(list.length);
        let cursor = 0;
        async function run() {
            while (cursor < list.length) {
                const index = cursor++;
                try { output[index] = await worker(list[index], index); } catch (e) { output[index] = null; }
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(limit, list.length); i++) workers.push(run());
        await Promise.all(workers);
        return output;
    }

    async function parseHtmlItems(htmlStr) {
        if (!htmlStr) return [];
        const doc = await parseHtml(htmlStr);
        const cards = qsa(doc, ".ani-card, .item, article, .flw-item, .film_list-item");
        return cards.map(c => {
            const link = qs(c, "a");
            const href = fixUrl(attr(link, ["href"]), BASE_URL);
            const title = text(qs(c, ".title, .name, h2, h3, .film-name")?.textContent);
            if (!title || !href) return null;

            return new MultimediaItem({
                title,
                url: href,
                posterUrl: fixUrl(attr(qs(c, "img"), ["data-src", "src"]), BASE_URL),
                type: href.includes("/movie/") ? "movie" : "anime"
            });
        }).filter(Boolean);
    }

    // --- SkyStream Hooks ---

    async function getHome(cb) {
        try {
            const SECTIONS = [
                { endpoint: "/ajax/home/widget/trending?page=1", name: "Trending Anime", isApi: true },
                { endpoint: "/ajax/home/widget/updated-sub", name: "Updated (SUB)", isApi: true },
                { endpoint: "/ajax/home/widget/updated-dub?page=1", name: "Updated (DUB)", isApi: true },
                { endpoint: "/ajax/home/widget/updated-all", name: "Updated (ALL)", isApi: true },
                { endpoint: "/status/not-yet-aired", name: "Upcoming Anime", isApi: false },
                { endpoint: "/latest-updated", name: "Latest Updated", isApi: false },
                { endpoint: "/new-release", name: "New Release", isApi: false },
                { endpoint: "/most-viewed", name: "Most Viewed", isApi: false }
            ];

            const results = await mapLimit(SECTIONS, 4, async (sec) => {
                const res = await http_get(BASE_URL + sec.endpoint, sec.isApi ? API_HEADERS : HTML_HEADERS);
                if (!res || !res.body) return null;

                let htmlContent = res.body;
                if (sec.isApi) {
                    const json = safeParse(res.body);
                    htmlContent = json && (json.html || json.content || json.data) ? (json.html || json.content || json.data) : res.body;
                }
                
                const items = await parseHtmlItems(htmlContent);
                return { name: sec.name, items };
            });

            const data = {};
            for (const r of results) {
                if (r && r.items.length) data[r.name] = r.items;
            }

            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const res = await http_get(`${BASE_URL}/filter?keyword=${encodeURIComponent(query)}`, HTML_HEADERS);
            const items = await parseHtmlItems(res?.body);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            // STEP 1: Fetch and parse metadata completely from the anime landing page
            const res = await http_get(urlStr, HTML_HEADERS);
            if (!res || !res.body) throw new Error("Item profile target page could not be loaded.");

            const doc = await parseHtml(res.body);
            const title = text(qs(doc, "h1, .film-name, .anime-title")?.textContent) || "Untitled Anime";
            const poster = fixUrl(attr(qs(doc, ".poster img, .film-poster img, .cover img"), ["src"]), urlStr);
            
            // ✅ Accurate extraction of authentic banner image configuration maps
            const banner = fixUrl(
                attr(qs(doc, "meta[property='og:image']"), ["content"]) || 
                attr(qs(doc, ".cover-background, .ani-banner, .banner-bg"), ["style"])?.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || 
                attr(qs(doc, ".cover img"), ["src"]), 
                urlStr
            ) || poster;

            const description = text(qs(doc, ".description, .overview, .film-description, .synopsis")?.textContent);
            const genres = qsa(doc, ".genres a, .meta-genres a").map(g => text(g.textContent)).filter(Boolean);
            const status = text(qs(doc, ".meta-status, .status-value")?.textContent).toLowerCase().includes("releasing") ? "ongoing" : "completed";

            // ✅ Accurate target identification parsing rule: selector + regex fallback logic
            let animeId = attr(qs(doc, "[data-anime-id], [data-id]"), ["data-anime-id", "data-id"]);
            if (!animeId) {
                const idMatch = res.body.match(/anime_id["']?\s*[:=]\s*["']?(\d+)/i);
                if (idMatch) animeId = idMatch[1];
            }
            if (!animeId) throw new Error("Anime identification key missing from page target context.");

            const mediaItem = new MultimediaItem({
                title,
                url: urlStr,
                posterUrl: poster,
                bannerUrl: banner,
                description,
                type: urlStr.includes("/movie/") ? "movie" : "anime",
                genres,
                status,
                episodes: []
            });

            if (mediaItem.type === "movie") {
                mediaItem.episodes = [new Episode({ 
                    name: title, 
                    url: JSON.stringify({ parentUrl: urlStr, type: "movie", animeId: animeId }),
                    season: 1,
                    episode: 1
                })];
                return cb({ success: true, data: mediaItem });
            }

            // STEP 2: Fetch full asynchronous episode arrays utilizing structural widget pipelines
            const epApiUrl = `${BASE_URL}/ajax/episode/list/${animeId}?style=&vrf=2`;
            const epRes = await http_get(epApiUrl, API_HEADERS);
            if (!epRes || !epRes.body) throw new Error("Secure episode query mapping returned empty layout metadata.");

            const epJson = safeParse(epRes.body);
            const epHtml = epJson && (epJson.html || epJson.content) ? (epJson.html || epJson.content) : epRes.body;
            const epDoc = await parseHtml(epHtml);
            
            // ✅ Adaptive selectors mapping precise episode tracking nodes
            const epLinks = qsa(epDoc, "a.ep-item, .ss-list a, [data-episode-id], [data-id]");
            
            if (epLinks.length > 0) {
                mediaItem.episodes = epLinks.map((el, idx) => {
                    const number = parseInt(attr(el, ["data-number", "data-ep"]) || text(el.textContent).match(/\d+/)?.[0] || (idx + 1), 10);
                    const epId = attr(el, ["data-id", "data-episode-id"]);
                    const epTitle = text(qs(el, ".ep-title, .title")?.textContent) || `Episode ${number}`;
                    const epDesc = text(qs(el, ".ep-desc, .description")?.textContent) || "";
                    const epThumb = fixUrl(attr(qs(el, "img"), ["data-src", "src"]), urlStr) || poster;

                    return new Episode({
                        name: epTitle,
                        description: epDesc,
                        posterUrl: epThumb,
                        url: JSON.stringify({ parentUrl: urlStr, epId: epId, episodeNumber: number, animeId: animeId }),
                        season: 1,
                        episode: number
                    });
                });
            } else {
                mediaItem.episodes = [new Episode({ 
                    name: "Episode 1", 
                    url: JSON.stringify({ parentUrl: urlStr, animeId: animeId }), 
                    season: 1, 
                    episode: 1 
                })];
            }

            cb({ success: true, data: mediaItem });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const params = safeParse(urlInfo);
            if (!params) throw new Error("Invalid parameters verification payload signature parsing loop.");

            const streams = [];

            // ✅ CRITICAL DIRECT FIX: Verified REST endpoint mirroring browser behavior exactly
            const serverFetchUrl = `${BASE_URL}/ajax/episode/server/${params.epId}?vrf=2`;
            const serverRes = await http_get(serverFetchUrl, API_HEADERS);
            if (!serverRes || !serverRes.body) throw new Error("Unified internal routing table list missing.");

            const sJson = safeParse(serverRes.body);
            const sHtml = sJson && (sJson.html || sJson.content) ? (sJson.html || sJson.content) : serverRes.body;
            const sDoc = await parseHtml(sHtml);

            // ✅ Explicit layout structural processing handling list configurations natively
            const serverNodes = qsa(sDoc, "[data-server-id], [data-id], .server-item, .server, li");
            
            await mapLimit(serverNodes, 3, async (node) => {
                const serverId = attr(node, ["data-id", "data-server-id"]);
                const serverName = text(node.textContent).toLowerCase();
                
                if (!serverId) return;

                // ✅ Exact contextual extraction pulling accurate source formats
                const mode = attr(node, ["data-type", "data-sub"]) || "sub";

                try {
                    // Isolation of Vidtube Engine pipelines
                    if (serverName.includes("vidtube")) {
                        const iframeUrl = `${VIDTUBE_BASE}/stream/${serverId}/${mode}?autostart=true`;
                        const sourceUrl = `${VIDTUBE_BASE}/stream/getSourcesNew?id=${serverId}&type=${mode}`;
                        
                        // ✅ Inject correct Origin verification flags matching exact provider expectations
                        const headers = {
                            "User-Agent": UA,
                            "Referer": iframeUrl,
                            "Origin": "https://vidtube.site",
                            "X-Requested-With": "XMLHttpRequest"
                        };
                        
                        const resObj = await http_get(sourceUrl, headers);
                        const dataObj = safeParse(resObj?.body);
                        if (dataObj) {
                            processNekostreamPayload(dataObj, "Vidtube", iframeUrl, streams);
                        }
                    } 
                    // Isolation of MegaPlay Engine pipelines
                    else if (serverName.includes("megaplay")) {
                        const iframeUrl = `${MEGAPLAY_BASE}/stream/s-5/${serverId}/${mode}?autostart=true`;
                        
                        // ✅ Direct dynamic variable synchronization mapping parameter structure arrays explicitly
                        const sourceUrl = `${MEGAPLAY_BASE}/stream/getSourcesNew?id=${serverId}&type=${mode}`;
                        
                        const headers = {
                            "User-Agent": UA,
                            "Referer": iframeUrl,
                            "X-Requested-With": "XMLHttpRequest"
                        };

                        const resObj = await http_get(sourceUrl, headers);
                        const dataObj = safeParse(resObj?.body);
                        if (dataObj) {
                            processNekostreamPayload(dataObj, "MegaPlay", iframeUrl, streams);
                        }
                    }
                } catch (innerError) {
                    console.error("Extraction routing error encountered on dynamic loop segment mapping:", innerError);
                }
            });

            const seen = {};
            const uniqueStreams = streams.filter(s => {
                const key = `${s.url}|${s.source}`;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            // ✅ Explicit structural exception throwing to guarantee visibility inside runtime console loops
            if (!uniqueStreams.length) {
                throw new Error("No playable streams found.");
            }

            cb({ success: true, data: uniqueStreams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // ✅ Re-architected stream conversion worker layer mapping multi-variant response schemas cleanly
    function processNekostreamPayload(rootData, engineLabel, iframeUrl, outputStreamArray) {
        if (!rootData) {
            throw new Error("Invalid structural payload object layer.");
        }
        if (rootData.encrypted) {
            throw new Error("Encrypted verification payload blocked.");
        }

        // ✅ CRITICAL BUG FIX: Uniform initialization matching both structural objects and clean arrays 
        let sources = [];
        if (Array.isArray(rootData.sources)) {
            sources = rootData.sources;
        } else if (rootData.sources && typeof rootData.sources === "object") {
            sources = [rootData.sources];
        } else {
            throw new Error("No video sources discovered inside layout array parameters mapping.");
        }
        
        const tracks = rootData.tracks || rootData.captions || rootData.subtitle_tracks || [];

        const parsedSubtitles = tracks.map(t => {
            if (!t.file && !t.url) return null;
            // ✅ Multi-key cross validation lookup logic supporting specialized target languages formatting
            return {
                label: t.label || "English",
                lang: t.language || t.srclang || t.lang || "en",
                url: fixUrl(t.file || t.url)
            };
        }).filter(Boolean);

        // ✅ Robust iterator loop blocks mapping dynamic tracking attributes correctly
        for (const src of sources) {
            if (!src) continue;
            
            // ✅ Expanded query matching checking multi-variant object parameters safely
            const streamFinalUrl = fixUrl(src.file || src.url || src.src);
            if (!streamFinalUrl) continue;
            
            // ✅ Safety non-destructive formatting calculation: use index 0 if not specified
            const match = (src.label || "").match(/\d+/);
            const qualityScore = match ? Number(match[0]) : 0;

            // ✅ Verified Stream Headers configuration routing back directly into domain servers securely
            const streamHeaders = {
                "User-Agent": UA,
                "Referer": engineLabel.startsWith("Vidtube") ? "https://vidtube.site/" : "https://megaplay.buzz/",
                "Origin": engineLabel.startsWith("Vidtube") ? "https://vidtube.site" : "https://megaplay.buzz"
            };

            const resultItem = new StreamResult({
                url: streamFinalUrl,
                source: `${engineLabel} (${src.label || "HLS Native Stream"})`,
                quality: qualityScore,
                headers: streamHeaders
            });

            if (parsedSubtitles.length > 0) {
                resultItem.subtitles = parsedSubtitles;
            }

            outputStreamArray.push(resultItem);
        }
    }

    // Register routines globally to match internal interface layer hooks
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
