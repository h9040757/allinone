(function () {
    // --- Configuration & Constants ---
    const BASE_URL = "https://anichi.to";
    const VIDTUBE_BASE = "https://vidtube.site";
    const MEGAPLAY_BASE = "https://megaplay.buzz";

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    const COOKIE_STRING = "country_code=IN; prefered_server_type=sub; prefered_server_id=8e4";

    const API_HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL + "/",
        "Origin": BASE_URL,
        "Cookie": COOKIE_STRING
    };

    const HTML_HEADERS = {
        "User-Agent": UA,
        "Accept": "text/html",
        "Referer": BASE_URL + "/",
        "Cookie": COOKIE_STRING
    };

    // --- Utility Parsers ---
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

    // --- SkyStream Core Hooks ---

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
            // Step 1: Request root HTML item landing page configuration parameters
            const res = await http_get(urlStr, HTML_HEADERS);
            if (!res || !res.body) throw new Error("Item landing container unavailable.");

            const doc = await parseHtml(res.body);
            const title = text(qs(doc, "h1, .film-name")?.textContent) || "Untitled Anime";
            const poster = fixUrl(attr(qs(doc, ".poster img, .film-poster img"), ["src"]), urlStr);
            const description = text(qs(doc, ".description, .overview")?.textContent);

            // Extract tracking IDs embedded inside the document wrapper elements
            const animeId = attr(qs(doc, "[data-anime-id], #data-anime"), ["data-anime-id", "data-id", "value"]);
            const watchOrderId = attr(qs(doc, "[data-watch-order]"), ["data-watch-order"]);

            const mediaItem = new MultimediaItem({
                title,
                url: urlStr,
                posterUrl: poster,
                description,
                type: urlStr.includes("/movie/") ? "movie" : "anime",
                episodes: []
            });

            if (!animeId) {
                // Movie structure or raw fallback mapping path
                mediaItem.episodes = [new Episode({ name: title, url: JSON.stringify({ parentUrl: urlStr, type: "movie" }) })];
                return cb({ success: true, data: mediaItem });
            }

            // Step 2: Query secure AJAX routing table to resolve individual structural ep node entries
            const epApiUrl = `${BASE_URL}/ajax/episode/list/${animeId}?style=&vrf=2`;
            const epRes = await http_get(epApiUrl, API_HEADERS);
            if (!epRes || !epRes.body) throw new Error("Failed validation tracking episode listing table route.");

            const epJson = safeParse(epRes.body);
            const epHtml = epJson && (epJson.html || epJson.content) ? (epJson.html || epJson.content) : epRes.body;
            const epDoc = await parseHtml(epHtml);
            
            // Map links containing specific targeting server tracking arrays
            const epLinks = qsa(epDoc, "a.ep-item, .ss-list a");
            if (epLinks.length > 0) {
                mediaItem.episodes = epLinks.map((el, idx) => {
                    const number = parseInt(attr(el, ["data-number", "data-ep"]) || (idx + 1), 10);
                    const epId = attr(el, ["data-id", "data-episode-id"]);
                    return new Episode({
                        name: text(el.textContent) || `Episode ${number}`,
                        url: JSON.stringify({ parentUrl: urlStr, epId: epId, episodeNumber: number, animeId: animeId }),
                        season: 1,
                        episode: number
                    });
                });
            } else {
                mediaItem.episodes = [new Episode({ name: "Episode 1", url: JSON.stringify({ parentUrl: urlStr, animeId: animeId }), season: 1, episode: 1 })];
            }

            cb({ success: true, data: mediaItem });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const params = safeParse(urlInfo);
            if (!params) throw new Error("Invalid parameters signature configuration mapping.");

            const streams = [];

            // Fetch structural list servers associated directly with tracking context identifiers
            const serverFetchUrl = `${BASE_URL}/ajax/episode/servers?id=${params.epId || params.animeId}&vrf=2`;
            const serverRes = await http_get(serverFetchUrl, API_HEADERS);
            if (!serverRes || !serverRes.body) throw new Error("Secure server map allocation list empty.");

            const sJson = safeParse(serverRes.body);
            const sHtml = sJson && (sJson.html || sJson.content) ? (sJson.html || sJson.content) : serverRes.body;
            const sDoc = await parseHtml(sHtml);

            // Scrape targeted endpoints referencing specialized internal multi-hop video mirrors
            const serverNodes = qsa(sDoc, "[data-server-id], [data-id]");
            
            await mapLimit(serverNodes, 3, async (node) => {
                const serverId = attr(node, ["data-id", "data-server-id"]);
                const serverName = text(node.textContent).toLowerCase();
                
                if (!serverId) return;

                try {
                    // Route 1: Mirror operational tracking parameters using Vidtube architecture engines
                    if (serverName.includes("vidtube") || serverName.includes("stream")) {
                        const types = ["sub", "dub", "hsub"];
                        for (const mode of types) {
                            const sourceUrl = `${VIDTUBE_BASE}/stream/getSourcesNew?id=${serverId}&type=${mode}`;
                            const resObj = await http_get(sourceUrl, { "Referer": BASE_URL + "/", "User-Agent": UA });
                            
                            const dataObj = safeParse(resObj?.body);
                            if (dataObj && dataObj.sources) {
                                processNekostreamPayload(dataObj, `Vidtube [${mode.toUpperCase()}]`, streams);
                            }
                        }
                    } 
                    // Route 2: Mirror operational tracking parameters using MegaPlay configuration architecture
                    else if (serverName.includes("mega") || serverName.includes("play")) {
                        const domainCheckUrl = `${MEGAPLAY_BASE}/domains?h=${Date.now()}`;
                        await http_get(domainCheckUrl, { "Referer": MEGAPLAY_BASE + "/", "User-Agent": UA });

                        const sourceUrl = `${MEGAPLAY_BASE}/stream/getSourcesNew?id=${serverId}`;
                        const resObj = await http_get(sourceUrl, { "Referer": MEGAPLAY_BASE + "/", "User-Agent": UA });
                        
                        const dataObj = safeParse(resObj?.body);
                        if (dataObj && dataObj.sources) {
                            processNekostreamPayload(dataObj, "MegaPlay", streams);
                        }
                    }
                } catch (innerError) {
                    console.error("Aggregation node loop handling encountered error:", innerError);
                }
            });

            if (streams.length === 0) {
                // Fallback: Scrape raw internal structural inline frame parameters if external engine collection fails
                const landingRes = await http_get(params.parentUrl, HTML_HEADERS);
                if (landingRes && landingRes.body) {
                    const lDoc = await parseHtml(landingRes.body);
                    const iframes = qsa(lDoc, "iframe");
                    for (const iframe of iframes) {
                        const srcUrl = fixUrl(attr(iframe, ["src"]), params.parentUrl);
                        if (srcUrl && !srcUrl.includes("about:blank")) {
                            streams.push(new StreamResult({
                                url: srcUrl,
                                source: "Internal Native Player",
                                quality: 720,
                                headers: { "User-Agent": UA, "Referer": params.parentUrl }
                            }));
                        }
                    }
                }
            }

            // Deduplicate references matching matching signatures found inside operational pipelines
            const seen = {};
            const uniqueStreams = streams.filter(s => {
                const key = `${s.url}|${s.source}`;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            cb({ success: true, data: uniqueStreams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    function processNekostreamPayload(rootData, engineLabel, outputStreamArray) {
        const sources = rootData.sources || [];
        const tracks = rootData.tracks || rootData.captions || [];

        // Build cleanly unified subtitles format tracks list targeting cross-site assets configurations
        const parsedSubtitles = tracks.map(t => {
            if (!t.file && !t.url) return null;
            return {
                name: t.label || t.name || "English",
                url: fixUrl(t.file || t.url)
            };
        }).filter(Boolean);

        sources.forEach(src => {
            if (!src.file && !src.url) return;
            const streamFinalUrl = fixUrl(src.file || src.url);
            
            // Lock and cross-authenticate stream connection mapping references exactly to host protocols
            const streamHeaders = {
                "User-Agent": UA,
                "Referer": streamFinalUrl.includes("vidtube") ? "https://vidtube.site/" : "https://megaplay.buzz/",
                "Origin": streamFinalUrl.includes("vidtube") ? "https://vidtube.site" : "https://megaplay.buzz"
            };

            const resultItem = new StreamResult({
                url: streamFinalUrl,
                source: `${engineLabel} (${src.label || "Auto HLS"})`,
                quality: src.label ? (parseInt(src.label.match(/\b(360|480|720|1080|2160)\b/)?.[1], 10) || 720) : 720,
                headers: streamHeaders
            });

            if (parsedSubtitles.length > 0) {
                resultItem.subtitles = parsedSubtitles;
            }

            outputStreamArray.push(resultItem);
        });
    }

    // Register active functional layers securely inside client instance globally
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
