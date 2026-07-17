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

    // --- Utility Methods ---
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
            const res = await http_get(urlStr, HTML_HEADERS);
            if (!res || !res.body) throw new Error("Item landing container unavailable.");

            const doc = await parseHtml(res.body);
            const title = text(qs(doc, "h1, .film-name")?.textContent) || "Untitled Anime";
            const poster = fixUrl(attr(qs(doc, ".poster img, .film-poster img"), ["src"]), urlStr);
            const description = text(qs(doc, ".description, .overview")?.textContent);

            // FIX 1: Robust extraction layer for Anime ID (DOM checking + Regex checking)
            let animeId = attr(qs(doc, "[data-anime-id]"), ["data-anime-id"]);
            if (!animeId) {
                const match = res.body.match(/anime_id["']?\s*[:=]\s*["']?(\d+)/i);
                if (match) animeId = match[1];
            }
            if (!animeId) {
                throw new Error("Anime ID not found.");
            }

            const mediaItem = new MultimediaItem({
                title,
                url: urlStr,
                posterUrl: poster,
                description,
                type: urlStr.includes("/movie/") ? "movie" : "anime",
                episodes: []
            });

            const epApiUrl = `${BASE_URL}/ajax/episode/list/${animeId}?style=&vrf=2`;
            const epRes = await http_get(epApiUrl, API_HEADERS);
            if (!epRes || !epRes.body) throw new Error("Failed to load tracking episode listing table route.");

            const epJson = safeParse(epRes.body);
            const epHtml = epJson && (epJson.html || epJson.content) ? (epJson.html || epJson.content) : epRes.body;
            const epDoc = await parseHtml(epHtml);
            
            // FIX 2: Expanded, safer adaptive node selector matching for episodes
            const epLinks = qsa(epDoc, "a.ep-item, .ss-list a, [data-episode-id], [data-id]");
            if (epLinks.length > 0) {
                mediaItem.episodes = epLinks.map((el, idx) => {
                    const number = parseInt(attr(el, ["data-number", "data-ep"]) || text(el.textContent).match(/\d+/)?.[0] || (idx + 1), 10);
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

            // CRITICAL ACTION & FIX 1: Exact DevTools mapping route setup to match your browser captures
            // Update the string literal here once verified via the DevTools network tab (e.g., `/server/`, `/servers/`)
            const serverFetchUrl = `${BASE_URL}/ajax/episode/server/${params.epId}?vrf=2`;
            const serverRes = await http_get(serverFetchUrl, API_HEADERS);
            if (!serverRes || !serverRes.body) throw new Error("Secure server map allocation list empty.");

            const sJson = safeParse(serverRes.body);
            const sHtml = sJson && (sJson.html || sJson.content) ? (sJson.html || sJson.content) : serverRes.body;
            const sDoc = await parseHtml(sHtml);

            // FIX 10: Expanded Server Node selectors supporting multiple page layouts
            const serverNodes = qsa(sDoc, "[data-server-id], [data-id], .server-item, .server");
            
            await mapLimit(serverNodes, 3, async (node) => {
                const serverId = attr(node, ["data-id", "data-server-id"]);
                const serverName = text(node.textContent).toLowerCase();
                
                if (!serverId) return;

                // FIX 4: Dynamically capture the stream mode from element configurations instead of guessing
                const mode = attr(node, ["data-type", "data-sub"]) || "sub";

                try {
                    // FIX 3: Strict engine matching isolation loops (removed collision-prone general "stream" strings)
                    if (serverName.includes("vidtube")) {
                        const iframeUrl = `${VIDTUBE_BASE}/stream/${serverId}/${mode}?autostart=true`;
                        const sourceUrl = `${VIDTUBE_BASE}/stream/getSourcesNew?id=${serverId}&type=${mode}`;
                        
                        // FIX 2 & FIX 4: Synchronized dynamic validation headers passing the dynamic iframe referer
                        const headers = {
                            "User-Agent": UA,
                            "Referer": iframeUrl,
                            "X-Requested-With": "XMLHttpRequest"
                        };
                        
                        const resObj = await http_get(sourceUrl, headers);
                        const dataObj = safeParse(resObj?.body);
                        if (dataObj) {
                            processNekostreamPayload(dataObj, "Vidtube", streams);
                        }
                    } 
                    else if (serverName.includes("megaplay")) {
                        const iframeUrl = `${MEGAPLAY_BASE}/stream/s-5/${serverId}/${mode}?autostart=true`;
                        
                        // FIX 5: Multi-parameter query array cloning logic to pass exactly matching structures (?id=X&id=X)
                        const sourceUrl = `${MEGAPLAY_BASE}/stream/getSourcesNew?id=${serverId}&id=${serverId}`;
                        
                        // FIX 3 & FIX 4: Target structural headers validation maps matching accurate MegaPlay structures
                        const headers = {
                            "User-Agent": UA,
                            "Referer": iframeUrl,
                            "X-Requested-With": "XMLHttpRequest"
                        };

                        const resObj = await http_get(sourceUrl, headers);
                        const dataObj = safeParse(resObj?.body);
                        if (dataObj) {
                            processNekostreamPayload(dataObj, "MegaPlay", streams);
                        }
                    }
                } catch (innerError) {
                    console.error("Aggregation node loop handling encountered error:", innerError);
                }
            });

            // Clean duplication elements inside streams result payload array mapping
            const seen = {};
            const uniqueStreams = streams.filter(s => {
                const key = `${s.url}|${s.source}`;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            // FIX 9: Throw clear error state if array validation yields no active streams
            if (!uniqueStreams.length) {
                throw new Error("No playable streams found.");
            }

            cb({ success: true, data: uniqueStreams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    function processNekostreamPayload(rootData, engineLabel, outputStreamArray) {
        // FIX 6: Robust exception handling layer against encrypted string payloads or format shifts
        if (rootData.encrypted) {
            throw new Error("Encrypted sources block triggered.");
        }
        if (!rootData || !Array.isArray(rootData.sources)) {
            throw new Error("Invalid sources layout format returned.");
        }

        const sources = rootData.sources;
        
        // FIX 7: Dynamic structural tracking across standard multiple configuration properties
        const tracks = rootData.tracks || rootData.captions || rootData.subtitle_tracks || [];

        const parsedSubtitles = tracks.map(t => {
            if (!t.file && !t.url) return null;
            // FIX 7: Expanded translation configurations object maps passing clean identifiers
            return {
                label: t.label || "English",
                lang: t.language || t.lang || "en",
                url: fixUrl(t.file || t.url)
            };
        }).filter(Boolean);

        sources.forEach(src => {
            if (!src.file && !src.url) return;
            const streamFinalUrl = fixUrl(src.file || src.url);
            
            // FIX 8: Robust non-destructive integer normalization map parsing 
            const match = (src.label || "").match(/\d+/);
            const qualityScore = match ? Number(match[0]) : 720;

            // FIX 6: Track and inject the strict source provider into final media tracking headers
            const streamHeaders = {
                "User-Agent": UA,
                "Referer": engineLabel.startsWith("Vidtube") ? "https://vidtube.site/" : "https://megaplay.buzz/",
                "Origin": engineLabel.startsWith("Vidtube") ? "https://vidtube.site" : "https://megaplay.buzz"
            };

            const resultItem = new StreamResult({
                url: streamFinalUrl,
                source: `${engineLabel} (${src.label || "Auto"})`,
                quality: qualityScore,
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
