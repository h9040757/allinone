(function () {
    // --- Configuration & Constants ---
    const MAIN_URL = "https://anichi.to";
    const MAPPER_BASE = "https://mapper.nekostream.site/api/mal/";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": MAIN_URL + "/",
        "X-Requested-With": "XMLHttpRequest"
    };

    // We change the structural paths to query the dynamic AJAX widget layer directly
    const HOME_SECTIONS = [
        { path: "ajax/home/widget/trending?page=1", name: "Trending Anime", type: "anime" },
        { path: "ajax/home/widget/recent-sub?page=1", name: "Recently Updated (SUB)", type: "anime" },
        { path: "ajax/home/widget/recent-dub?page=1", name: "Recently Updated (DUB)", type: "anime" },
        { path: "ajax/home/widget/movie?page=1", name: "Anime Movies", type: "movie" }
    ];

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
        try { return new URL(url, base || MAIN_URL).href; } catch (e) { return url; }
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

    function toMedia(element, fallbackType) {
        const link = qs(element, "a");
        const href = fixUrl(attr(link, ["href"]), MAIN_URL);
        const title = text(qs(element, ".title, .name, h2, h3, .film-name")?.textContent);
        if (!title || !href) return null;
        
        const poster = fixUrl(attr(qs(element, "img"), ["data-src", "src"]), MAIN_URL);
        const type = href.includes("/movie/") ? "movie" : fallbackType || "anime";

        const malId = attr(element, ["data-mal", "data-id"]);
        const slug = attr(element, ["data-slug"]) || href.split("/").pop();
        const timestamp = attr(element, ["data-timestamp"]) || String(Date.now());

        return new MultimediaItem({
            title,
            url: JSON.stringify({ url: href, malId, slug, timestamp, type }),
            posterUrl: poster,
            type
        });
    }

    // --- Core Hooks ---

    async function getHome(cb) {
        try {
            const sections = await mapLimit(HOME_SECTIONS, 4, async (section) => {
                const targetUrl = `${MAIN_URL}/${section.path}`;
                const res = await http_get(targetUrl, HEADERS);
                if (!res || !res.body) return null;

                // Checking if the widget responds inside a JSON wrapper or pure HTML strings
                let htmlContent = res.body;
                const json = safeParse(res.body);
                if (json && json.html) {
                    htmlContent = json.html;
                }

                const doc = await parseHtml(htmlContent);
                // Class targeting expanded to include generic stremio/anime boilerplate elements (.flw-item)
                const cards = qsa(doc, ".ani-card, .item, article, .flw-item, .item-anime");
                const items = cards.map(c => toMedia(c, section.type)).filter(Boolean);

                return { name: section.name, items };
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
            const targetUrl = `${MAIN_URL}/search?keyword=${encodeURIComponent(query)}`;
            const res = await http_get(targetUrl, HEADERS);
            if (!res || !res.body) return cb({ success: true, data: [] });

            const doc = await parseHtml(res.body);
            const cards = qsa(doc, ".ani-card, .item, article, .flw-item, .item-anime");
            const items = cards.map(c => toMedia(c, "anime")).filter(Boolean);

            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const metaInput = safeParse(urlStr);
            if (!metaInput || !metaInput.url) throw new Error("Invalid structure data parameters.");

            const res = await http_get(metaInput.url, HEADERS);
            if (!res || !res.body) throw new Error("Failed to load root item data view container.");

            const doc = await parseHtml(res.body);
            const title = text(qs(doc, "h1, .name, .film-name")?.textContent) || "Unknown Anime";
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
                const epElements = qsa(doc, ".episodes-list a, .ep-item, #episodes a, .ssl-item");
                if (epElements.length > 0) {
                    result.episodes = epElements.map((el, i) => {
                        const href = fixUrl(attr(el, ["href"]), metaInput.url);
                        const epNum = parseInt(attr(el, ["data-number", "data-ep"]) || text(el.textContent).match(/\d+/)?.[0] || (i + 1), 10);
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
            if (!target || !target.url) throw new Error("Invalid stream verification structure.");

            const streams = [];

            const htmlRes = await http_get(target.url, HEADERS);
            if (htmlRes && htmlRes.body) {
                const doc = await parseHtml(htmlRes.body);
                const iframes = qsa(doc, "iframe, #player-iframe, .player-iframe");
                for (const iframe of iframes) {
                    const src = fixUrl(attr(iframe, ["src"]), target.url);
                    if (src && !src.includes("about:blank")) {
                        streams.push(new StreamResult({
                            url: src,
                            source: "Internal Player Mirror",
                            quality: 720,
                            headers: { "User-Agent": UA, "Referer": target.url }
                        }));
                    }
                }
            }

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
                                    headers: { "User-Agent": UA }
                                }));
                            });
                        });
                    }
                } catch (err) {
                    console.error("[KuMapper Extraction Loop Interrupted]", err);
                }
            }

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

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
