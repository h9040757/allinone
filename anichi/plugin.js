(function () {
    // --- Configuration & Constants ---
    const BASE_URL = "https://anichi.to";
    const MAPPER_BASE = "https://mapper.nekostream.site/api/mal/";
    
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
    const COOKIE_STRING = "country_code=IN; prefered_server_type=sub; prefered_server_id=8e4";

    const API_HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL + "/home",
        "Origin": BASE_URL,
        "Cookie": COOKIE_STRING
    };

    const HTML_HEADERS = {
        "User-Agent": UA,
        "Accept": "text/html",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL + "/",
        "Cookie": COOKIE_STRING
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
        if (!url || url.startsWith("data:")) return "";
        if (url.startsWith("//")) return "https:" + url;
        if (/^https?:\/\//i.test(url)) return url;
        try { return new URL(url, base || BASE_URL).href; } catch (e) { return url; }
    }

    function qualityFromText(value) {
        const raw = String(value || "").toLowerCase();
        if (/2160p|4k/i.test(raw)) return 2160;
        if (/1080p|fhd/i.test(raw)) return 1080;
        if (/720p|hd/i.test(raw)) return 720;
        if (/480p|sd/i.test(raw)) return 480;
        return 720;
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

    async function parseHtmlResponseIntoItems(htmlStr, fallbackType) {
        if (!htmlStr) return [];
        const doc = await parseHtml(htmlStr);
        const cards = qsa(doc, ".ani-card, .item, article, .flw-item, .item-list");
        return cards.map(c => {
            const link = qs(c, "a");
            const href = fixUrl(attr(link, ["href"]), BASE_URL);
            const title = text(qs(c, ".title, .name, h2, h3, .film-name")?.textContent);
            if (!title || !href) return null;

            const poster = fixUrl(attr(qs(c, "img"), ["data-src", "src"]), BASE_URL);
            const type = href.includes("/movie/") ? "movie" : fallbackType || "anime";

            const malId = attr(c, ["data-mal", "data-id"]);
            const slug = attr(c, ["data-slug"]) || href.split("/").pop();
            const timestamp = attr(c, ["data-timestamp"]) || String(Date.now());

            return new MultimediaItem({
                title,
                url: JSON.stringify({ url: href, malId, slug, timestamp, type }),
                posterUrl: poster,
                type
            });
        }).filter(Boolean);
    }

    // --- Core Hooks ---

    async function getHome(cb) {
        try {
            const WIDGET_SECTIONS = [
                { endpoint: "/ajax/home/widget/trending?page=1", name: "Trending Anime", isApi: true, type: "anime" },
                { endpoint: "/ajax/home/widget/updated-sub", name: "Latest Updated (SUB)", isApi: true, type: "anime" },
                { endpoint: "/ajax/home/widget/updated-dub?page=1", name: "Latest Updated (DUB)", isApi: true, type: "anime" },
                { endpoint: "/ajax/home/widget/updated-all", name: "Latest Episodes (ALL)", isApi: true, type: "anime" },
                { endpoint: "/status/not-yet-aired", name: "Upcoming Anime", isApi: false, type: "anime" },
                { endpoint: "/latest-updated", name: "Latest Updated", isApi: false, type: "anime" },
                { endpoint: "/new-release", name: "New Release", isApi: false, type: "anime" },
                { endpoint: "/most-viewed", name: "Most Viewed", isApi: false, type: "movie" }
            ];

            const sections = await mapLimit(WIDGET_SECTIONS, 4, async (sec) => {
                const targetUrl = `${BASE_URL}${sec.endpoint}`;
                const headers = sec.isApi ? API_HEADERS : HTML_HEADERS;
                
                const res = await http_get(targetUrl, headers);
                if (!res || !res.body) return null;

                let items = [];
                if (sec.isApi) {
                    // Stremio/AJAX widgets typically return a JSON block containing HTML structure fragments
                    const json = safeParse(res.body);
                    const htmlContent = json && (json.html || json.content || json.data) ? (json.html || json.content || json.data) : res.body;
                    items = await parseHtmlResponseIntoItems(htmlContent, sec.type);
                } else {
                    items = await parseHtmlResponseIntoItems(res.body, sec.type);
                }

                return { name: sec.name, items };
            });

            const data = {};
            for (const s of sections) {
                if (s && s.items.length) data[s.name] = s.items;
            }

            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            // Evaluates using the official filter interface mapping the dynamic query keyword parameters
            const targetUrl = `${BASE_URL}/filter?keyword=${encodeURIComponent(query)}`;
            const res = await http_get(targetUrl, HTML_HEADERS);
            if (!res || !res.body) return cb({ success: true, data: [] });

            const items = await parseHtmlResponseIntoItems(res.body, "anime");
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const metaInput = safeParse(urlStr);
            if (!metaInput || !metaInput.url) throw new Error("Invalid item structure details profile.");

            const res = await http_get(metaInput.url, HTML_HEADERS);
            if (!res || !res.body) throw new Error("Could not populate element target parsing container reference.");

            const doc = await parseHtml(res.body);
            const title = text(qs(doc, "h1, .name, .film-name")?.textContent) || "Unknown Title";
            const poster = fixUrl(attr(qs(doc, ".poster img, .ani-poster img, .film-poster img"), ["src"]), metaInput.url);
            const description = text(qs(doc, ".description, .overview, .film-description")?.textContent);

            const result = new MultimediaItem({
                title,
                url: urlStr,
                posterUrl: poster,
                description,
                type: metaInput.type,
                episodes: []
            });

            if (metaInput.type === "movie") {
                result.episodes = [new Episode({
                    name: title,
                    url: urlStr
                })];
            } else {
                const epElements = qsa(doc, ".episodes-list a, .ep-item, #episodes a, .ss-list a");
                if (epElements.length > 0) {
                    result.episodes = epElements.map((el, i) => {
                        const href = fixUrl(attr(el, ["href"]), metaInput.url);
                        const epNum = parseInt(attr(el, ["data-number"]) || attr(el, ["data-ep"]) || text(el.textContent).match(/\d+/)?.[0] || (i + 1), 10);
                        return new Episode({
                            name: text(el.textContent) || `Episode ${epNum}`,
                            url: JSON.stringify({
                                ...metaInput,
                                url: href,
                                epNumber: epNum
                            }),
                            season: 1,
                            episode: epNum
                        });
                    });
                } else {
                    result.episodes = [new Episode({
                        name: "Episode 1",
                        url: urlStr,
                        season: 1,
                        episode: 1
                    })];
                }
            }

            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const target = safeParse(urlInfo);
            if (!target || !target.url) throw new Error("Failed validation parameters loop inside dynamic stream block.");

            const streams = [];

            // Method 1: Extraction of inline servers inside target page structure
            const htmlRes = await http_get(target.url, HTML_HEADERS);
            if (htmlRes && htmlRes.body) {
                const doc = await parseHtml(htmlRes.body);
                const iframes = qsa(doc, "iframe, #player-iframe, .player-iframe");
                for (const iframe of iframes) {
                    const src = fixUrl(attr(iframe, ["src"]), target.url);
                    if (src && !src.includes("about:blank")) {
                        streams.push(new StreamResult({
                            url: src,
                            source: "Standard Internal Player",
                            quality: 720,
                            headers: { "User-Agent": UA, "Referer": target.url }
                        }));
                    }
                }
            }

            // Method 2: Consolidation layer querying KuMapper logic
            if (target.malId && target.slug && target.timestamp) {
                const mapperUrl = `${MAPPER_BASE}${encodeURIComponent(target.malId)}/${encodeURIComponent(target.slug)}/${encodeURIComponent(target.timestamp)}`;
                try {
                    const mapperRes = await http_get(mapperUrl, { "User-Agent": UA, "Accept": "application/json" });
                    const mapperData = safeParse(mapperRes?.body);
                    
                    if (mapperData && typeof mapperData === "object") {
                        Object.keys(mapperData).forEach((sourceKey) => {
                            if (sourceKey === "status") return;
                            const entry = mapperData[sourceKey];
                            if (!entry || typeof entry !== "object") return;

                            ["sub", "dub"].forEach((bucket) => {
                                const stream = entry[bucket];
                                if (!stream || !stream.url) return;

                                const resolvedUrl = fixUrl(stream.url);
                                const sourceLabel = sourceKey.charAt(0).toUpperCase() + sourceKey.slice(1);

                                streams.push(new StreamResult({
                                    url: resolvedUrl,
                                    source: `KuMapper (${sourceLabel} - ${bucket.toUpperCase()})`,
                                    quality: qualityFromText(resolvedUrl),
                                    headers: { "User-Agent": UA, "Cookie": COOKIE_STRING }
                                }));
                            });
                        });
                    }
                } catch (err) {
                    console.error("[KuMapper Extraction Loop Interrupted]", err);
                }
            }

            // Clean duplication elements inside streams result payload array mapping
            const seen = {};
            const finalStreams = streams.filter(s => {
                const key = `${s.url}|${s.source}`;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            cb({ success: true, data: finalStreams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // Register routines globally to match internal interface layer hooks
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
