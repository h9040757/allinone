(function () {
    const MAIN_URL = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://kartoons.me";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": MAIN_URL + "/"
    };

    const HOME_SECTIONS = [
        { path: "", name: "Trending Now", type: "movie" },
        { path: "movies", name: "Popular Movies", type: "movie" },
        { path: "serie", name: "Popular Shows", type: "series" }
    ];

    // --- Core Helper Functions ---

    function text(value) {
        return (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
    }

    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    function asArray(list) {
        if (!list) return [];
        try {
            return Array.from(list);
        } catch (e) {
            const out = [];
            for (let i = 0; i < list.length; i++) out.push(list[i]);
            return out;
        }
    }

    function qsa(root, selector) {
        try {
            return asArray(root.querySelectorAll(selector));
        } catch (e) {
            return [];
        }
    }

    function qs(root, selector) {
        try {
            return root.querySelector(selector);
        } catch (e) {
            return null;
        }
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
        try {
            return new URL(url, base || MAIN_URL).href;
        } catch (e) {
            return url;
        }
    }

    function getImageAttr(img, base) {
        return fixUrl(attr(img, ["data-src", "data-lazy-src", "data-original", "src"]), base);
    }

    function getHost(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch (e) {
            return "";
        }
    }

    function detectType(url, fallback) {
        if (/\/movies?\//i.test(url) || /type=movies/i.test(url)) return "movie";
        if (/\/serie\//i.test(url) || /type=series/i.test(url)) return "series";
        return fallback || "series";
    }

    function payload(url, poster, type) {
        return JSON.stringify({ url, poster: poster || "", type: type || detectType(url) });
    }

    function inputPayload(value) {
        const data = safeParse(value);
        if (data && data.url) return data;
        return { url: String(value || ""), poster: "", type: detectType(String(value || "")) };
    }

    function qualityFromText(value, fallback) {
        const raw = String(value || "");
        if (/2160|4k/i.test(raw)) return 2160;
        if (/1080/i.test(raw)) return 1080;
        if (/720/i.test(raw)) return 720;
        if (/480/i.test(raw)) return 480;
        if (/360/i.test(raw)) return 360;
        return fallback || 0;
    }

    function createStream(url, source, headers, quality, tag, type) {
        const stream = {
            url,
            source: `${source}${quality ? ` [${quality}p]` : ""}${tag ? ` [${tag}]` : ""}`,
            quality: quality || undefined,
            headers: headers || { "User-Agent": UA }
        };
        if (type) stream.type = type;
        if (stream.headers && (stream.headers.Referer || stream.headers.referer)) {
            stream.referer = stream.headers.Referer || stream.headers.referer;
        }
        return new StreamResult(stream);
    }

    async function getText(url, headers) {
        const res = await http_get(url, headers || HEADERS);
        return res && res.body ? res.body : "";
    }

    async function mapLimit(items, limit, worker) {
        const list = items || [];
        const output = new Array(list.length);
        let cursor = 0;
        async function run() {
            while (cursor < list.length) {
                const index = cursor++;
                try {
                    output[index] = await worker(list[index], index);
                } catch (e) {
                    output[index] = null;
                }
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(limit, list.length); i++) workers.push(run());
        await Promise.all(workers);
        return output;
    }

    function flatten(items) {
        const out = [];
        for (const item of items || []) {
            if (!item) continue;
            if (Array.isArray(item)) out.push.apply(out, item.filter(Boolean));
            else out.push(item);
        }
        return out;
    }

    function dedupeStreams(streams) {
        const seen = {};
        return (streams || []).filter((stream) => {
            const key = `${stream.url}|${stream.source}`;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    // --- HTML Parsing and Items mapping ---

    function toMedia(element, fallbackType, base) {
        const titleEl = qs(element, ".title a") || qs(element, "h3 a") || qs(element, "h2 a");
        const title = text(titleEl?.textContent || attr(qs(element, "img"), ["alt"]));
        const href = fixUrl(attr(titleEl || qs(element, "a"), ["href"]), base || MAIN_URL);
        if (!title || !href) return null;
        
        const poster = getImageAttr(qs(element, "img"), href);
        const type = detectType(href, fallbackType);
        return new MultimediaItem({
            title,
            url: payload(href, poster, type),
            posterUrl: poster,
            type
        });
    }

    async function parseList(html, type, base) {
        const doc = await parseHtml(html || "");
        // Select standard items from Dooplay or catalog list structures
        const items = qsa(doc, ".items .item, article.item, .poster, .movies-list .movie");
        return items.map((item) => toMedia(item, type, base)).filter(Boolean);
    }

    // --- SkyStream Core Interface Functions ---

    async function getHome(cb) {
        try {
            const sectionResults = await mapLimit(HOME_SECTIONS, 3, async (section) => {
                const sectionUrl = section.path ? `${MAIN_URL}/${section.path}/` : MAIN_URL;
                const html = await getText(sectionUrl, HEADERS);
                const items = await parseList(html, section.type, MAIN_URL);
                return { name: section.name, items };
            });

            const data = {};
            for (const section of sectionResults) {
                if (section && section.items && section.items.length) {
                    data[section.name] = section.items;
                }
            }
            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "HTTP_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const searchUrl = `${MAIN_URL}/?s=${encodeURIComponent(query)}`;
            const html = await getText(searchUrl, HEADERS);
            const items = await parseList(html, "series", MAIN_URL);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const media = inputPayload(urlStr);
            if (!media.url) throw new Error("Invalid URL data");
            
            const html = await getText(media.url, { ...HEADERS, "Referer": MAIN_URL + "/" });
            const doc = await parseHtml(html);
            
            const title = text(qs(doc, "h1")?.textContent || qs(doc, ".data h1")?.textContent) || "No Title";
            const poster = getImageAttr(qs(doc, ".poster img") || qs(doc, ".post-thumbnail img"), media.url) || media.poster || "";
            const description = text(qs(doc, "#info p") || qs(doc, ".description p") || qs(doc, "#overview-text")?.textContent);
            const type = detectType(media.url, media.type);

            const tags = qsa(doc, ".sgenres a").map(el => text(el.textContent)).filter(Boolean);
            const yearText = text(qs(doc, ".date")?.textContent || qs(doc, "span.year")?.textContent);
            const year = parseInt(yearText.match(/\d{4}/)?.[0], 10) || undefined;

            if (type === "series") {
                const episodes = [];
                // Look for seasons in standard theme layout (#seasons or .se-c)
                const seasonContainers = qsa(doc, "#seasons .se-c");
                if (seasonContainers.length > 0) {
                    seasonContainers.forEach((container, sIdx) => {
                        const seasonNum = sIdx + 1;
                        const epElements = qsa(container, ".se-a li");
                        epElements.forEach((epEl, epIdx) => {
                            const link = qs(epEl, "a");
                            const href = fixUrl(attr(link, ["href"]), MAIN_URL);
                            if (!href) return;
                            const epName = text(qs(epEl, ".episodiotitle a")?.textContent || link?.textContent) || `Episode ${epIdx + 1}`;
                            episodes.push(new Episode({
                                name: epName,
                                url: payload(href, poster, "episode"),
                                posterUrl: poster,
                                season: seasonNum,
                                episode: epIdx + 1
                            }));
                        });
                    });
                } else {
                    // Fallback for single flat list of episodes
                    const episodeElements = qsa(doc, ".episodios li, .list-episodes li");
                    episodeElements.forEach((epEl, index) => {
                        const link = qs(epEl, "a");
                        const href = fixUrl(attr(link, ["href"]), MAIN_URL);
                        if (!href) return;
                        const epName = text(link?.textContent) || `Episode ${index + 1}`;
                        episodes.push(new Episode({
                            name: epName,
                            url: payload(href, poster, "episode"),
                            posterUrl: poster,
                            season: 1,
                            episode: index + 1
                        }));
                    });
                }

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title,
                        url: payload(media.url, poster, "series"),
                        posterUrl: poster,
                        description,
                        type: "series",
                        year,
                        tags,
                        episodes,
                    })
                });
                return;
            }

            // Fallback configuration for Movies
            cb({
                success: true,
                data: new MultimediaItem({
                    title,
                    url: payload(media.url, poster, "movie"),
                    posterUrl: poster,
                    description,
                    type: "movie",
                    year,
                    tags,
                    episodes: [new Episode({
                        name: title,
                        url: payload(media.url, poster, "movie"),
                        posterUrl: poster
                    })]
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    // --- Stream Extraction Engine ---

    async function extractDirectMedia(url, source) {
        const streams = [];
        try {
            if (/\.m3u8(?:\?|$)/i.test(url)) {
                streams.push(createStream(url, source, { "User-Agent": UA }, 1080, "hls"));
            } else if (/\.mp4(?:\?|$)/i.test(url)) {
                streams.push(createStream(url, source, { "User-Agent": UA }, qualityFromText(url, 720)));
            }
        } catch (e) {}
        return streams;
    }

    async function loadExtractor(url, referer) {
        const fixed = fixUrl(url, referer);
        if (!fixed) return [];
        const host = getHost(fixed);

        // Standard dynamic handlers for universal video host providers
        if (/\.m3u8|\.mp4/i.test(fixed)) {
            return extractDirectMedia(fixed, host || "Direct Video");
        }
        
        // Pass to base fallback if host matching doesn't identify custom extraction steps
        return [createStream(fixed, host || "Embed Server", { "User-Agent": UA, "Referer": referer })];
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const media = inputPayload(urlInfo);
            if (!media.url) throw new Error("Invalid URL info data");
            const html = await getText(media.url, { ...HEADERS, "Referer": MAIN_URL + "/" });
            const doc = await parseHtml(html);

            // Scrape options from tab/embed triggers or typical option list targets
            const iframes = qsa(doc, ".play-box-iframe iframe, #player_iframe, .source-box iframe, iframe");
            const iframeUrls = iframes
                .map((iframe) => fixUrl(attr(iframe, ["data-src", "src"]), media.url))
                .filter(url => url && !/about:blank|google|facebook|disqus/i.test(url));

            // Run requests to resolve each target option
            const loaded = await mapLimit(iframeUrls, 4, (src) => loadExtractor(src, media.url));
            cb({ success: true, data: dedupeStreams(flatten(loaded)) });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
