(function () {
    const MAIN_URL = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://kartoons.me";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };

    const HOME_SECTIONS = [
        { path: "", name: "Trending Now", type: "series" },
        { path: "movies", name: "Popular Movies", type: "movie" },
        { path: "serie", name: "Popular Shows", type: "series" },
    ];

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
        if (/\/series?\//i.test(url) || /\/serie\//i.test(url) || /type=series/i.test(url)) return "series";
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
        const size = raw.match(/(?:^|[^\d])([1-9]\d{2,3})\s*p(?:[^\d]|$)/i);
        if (size) return parseInt(size[1], 10);
        if (/4k|2160/i.test(raw)) return 2160;
        if (/1440/i.test(raw)) return 1440;
        if (/1080|fhd/i.test(raw)) return 1080;
        if (/720|hd/i.test(raw)) return 720;
        if (/480|sd/i.test(raw)) return 480;
        if (/360/i.test(raw)) return 360;
        return fallback || 0;
    }

    function streamName(source, quality, tag) {
        const badge = quality ? ` [${quality}p]` : "";
        const suffix = tag ? ` [${tag}]` : "";
        return `${source}${badge}${suffix}`;
    }

    function encodeBase64String(value) {
        const input = String(value || "");
        try {
            if (typeof btoa === "function") return btoa(input);
        } catch (e) {}
        try {
            if (typeof Buffer !== "undefined") return Buffer.from(input, "binary").toString("base64");
        } catch (e) {}
        return "";
    }

    function proxifyUrl(url, headers, referer, mirrorHosts) {
        return "MAGIC_PROXY_v2" + encodeBase64String(JSON.stringify({
            url,
            headers: headers || {},
            options: {
                referer: referer || "",
                mirrorHosts: mirrorHosts || []
            }
        }));
    }

    function createStream(url, source, headers, quality, tag, type) {
        const stream = {
            url,
            source: streamName(source, quality, tag),
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

    async function postText(url, headers, body) {
        try {
            const res = await http_post(url, headers, body);
            return res && res.body ? res.body : "";
        } catch (e) {
            const res = await http_post(url, body, headers);
            return res && res.body ? res.body : "";
        }
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

    function homeUrl(path, page) {
        if (!path) {
            return page > 1 ? `${MAIN_URL}/page/${page}/` : `${MAIN_URL}/`;
        }
        return `${MAIN_URL}/${path}/page/${page}/`;
    }

    function toMedia(element, fallbackType, base) {
        const link = qs(element, "a");
        const href = fixUrl(attr(link, ["href"]), base || MAIN_URL);
        if (!href) return null;

        const titleText = text((qs(element, "header h2") || qs(element, "h2") || qs(element, "h3") || qs(element, ".title"))?.textContent);
        const altText = attr(qs(element, "img"), ["alt", "title"]);
        const title = titleText || altText || "Untitled";

        const poster = getImageAttr(qs(element, "img"), href);
        const type = detectType(href, fallbackType);
        return new MultimediaItem({
            title,
            url: payload(href, poster, type),
            posterUrl: poster,
            type
        });
    }

    async function parseArticleList(html, type, base) {
        const doc = await parseHtml(html || "");
        const items = qsa(doc, "article, .item, .poster").map((el) => toMedia(el, type, base)).filter(Boolean);
        return items;
    }

    async function getHome(cb) {
        try {
            const sectionResults = await mapLimit(HOME_SECTIONS, 3, async (section) => {
                const html = await getText(homeUrl(section.path, 1), HEADERS);
                const items = await parseArticleList(html, section.type, MAIN_URL);
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
            const items = await parseArticleList(html, "series", MAIN_URL);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    function collectTags(doc) {
        const tags = [];
        for (const el of qsa(doc, ".sgeneros a, a[href*='/genre/']")) {
            const val = text(el.textContent);
            if (val && tags.indexOf(val) < 0) tags.push(val);
        }
        return tags;
    }

    function parseYear(doc) {
        const elements = qsa(doc, ".date, .year, span, a");
        for (const el of elements) {
            const val = text(el.textContent);
            const match = val.match(/^(19|20)\d{2}$/);
            if (match) return parseInt(val, 10);
        }
        return undefined;
    }

    function seasonNumber(button, index) {
        const raw = attr(button, ["data-season", "data-num", "data-id"]) || text(button.textContent);
        const found = String(raw).match(/\d+/);
        return found ? parseInt(found[0], 10) : index + 1;
    }

    function episodeNumber(index) {
        return index + 1;
    }

    function episodeName(rawName, index) {
        const number = episodeNumber(index);
        return String(rawName || "").indexOf(`x${number}`) >= 0 ? `Episode ${number}` : rawName;
    }

    async function loadSeason(button, seasonIndex, parentPoster) {
        const postId = attr(button, ["data-post", "data-id", "data-post-id"]);
        const dataSeason = attr(button, ["data-season", "data-num"]) || String(seasonNumber(button, seasonIndex));
        if (!postId || !dataSeason) return [];
        const body = `action=action_select_season&season=${encodeURIComponent(dataSeason)}&post=${encodeURIComponent(postId)}`;
        const html = await postText(`${MAIN_URL}/wp-admin/admin-ajax.php`, {
            ...HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": `${MAIN_URL}/`
        }, body);
        const doc = await parseHtml(html);
        const season = seasonNumber(button, seasonIndex);
        return qsa(doc, "li article, article, li").map((article, index) => {
            const link = qs(article, "a");
            const href = fixUrl(attr(link, ["href"]), MAIN_URL);
            if (!href) return null;
            const rawName = text((qs(article, "h2.entry-title") || qs(article, "h2") || qs(article, "h3") || qs(article, ".episodiotitle"))?.textContent) || `Episode ${index + 1}`;
            const name = episodeName(rawName, index);
            const poster = getImageAttr(qs(article, "img"), href) || parentPoster || "";
            return new Episode({
                name,
                url: payload(href, poster, "episode"),
                posterUrl: poster,
                season,
                episode: episodeNumber(index)
            });
        }).filter(Boolean);
    }

    async function load(urlStr, cb) {
        try {
            const media = inputPayload(urlStr);
            if (!media.url) throw new Error("Invalid URL data");
            const html = await getText(media.url, { ...HEADERS, "Referer": `${MAIN_URL}/` });
            const doc = await parseHtml(html);
            const title = text((qs(doc, "h1") || qs(doc, "header h1") || qs(doc, ".data h1"))?.textContent) || "No Title";
            const poster = getImageAttr(qs(doc, ".poster img") || qs(doc, "article img") || qs(doc, "div.bd img"), media.url) || media.poster || "";
            const description = text((qs(doc, "#overview-text p") || qs(doc, ".description p") || qs(doc, ".entry-content p") || qs(doc, "#info p"))?.textContent);
            const type = detectType(media.url, media.type);
            const tags = collectTags(doc);
            const year = parseYear(doc);
            const recommendations = qsa(doc, "#single_relacionados article, .related article, .owl-item article")
                .map((article) => toMedia(article, "series", media.url))
                .filter((item) => item && item.url !== urlStr)
                .slice(0, 24);

            if (type === "series") {
                const episodes = [];
                // Look for static Dooplay episode layouts
                const staticSeasons = qsa(doc, ".se-c, #seasons .se-c");
                if (staticSeasons.length > 0) {
                    staticSeasons.forEach((seasonEl, sIdx) => {
                        const seasonNumStr = text(qs(seasonEl, ".title, .se-q")?.textContent);
                        const seasonMatch = seasonNumStr.match(/\d+/);
                        const seasonNum = seasonMatch ? parseInt(seasonMatch[0], 10) : (sIdx + 1);

                        const epList = qsa(seasonEl, ".episodios li");
                        epList.forEach((epEl, epIdx) => {
                            const link = qs(epEl, "a");
                            const href = fixUrl(attr(link, ["href"]), MAIN_URL);
                            if (!href) return;
                            const name = text(link.textContent) || `Episode ${epIdx + 1}`;
                            const posterUrl = getImageAttr(qs(epEl, "img"), href) || poster;
                            const numText = text(qs(epEl, ".numerando")?.textContent || "");
                            const numMatch = numText.match(/\d+\s*x\s*(\d+)/i);
                            const epNum = numMatch ? parseInt(numMatch[1], 10) : (epIdx + 1);

                            episodes.push(new Episode({
                                name,
                                url: payload(href, posterUrl, "episode"),
                                posterUrl,
                                season: seasonNum,
                                episode: epNum
                            }));
                        });
                    });
                }

                // Fall back to Torofilm AJAX if no static episodes exist
                if (episodes.length === 0) {
                    const buttons = qsa(doc, "div.season-buttons a, .toro-season-button");
                    const loaded = await mapLimit(buttons, 4, (button, index) => loadSeason(button, index, poster));
                    episodes.push.apply(episodes, flatten(loaded));
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
                        recommendations
                    })
                });
                return;
            }

            // Fallback default for Movies
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
                    })],
                    recommendations
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function expandHlsStreams(url, source, headers, fallbackQuality) {
        const resolvedHeaders = headers || { "User-Agent": UA };
        return [createStream(proxifyUrl(url, resolvedHeaders, resolvedHeaders.Referer || resolvedHeaders.referer || "", [getHost(url)].filter(Boolean)), source, {}, fallbackQuality || qualityFromText(url, 0), "adaptive", "hls")];
    }

    async function loadExtractor(url, referer) {
        const fixed = fixUrl(url, referer || MAIN_URL);
        if (!fixed) return [];
        const host = getHost(fixed);
        if (/\.m3u8(?:\?|$)/i.test(fixed)) return expandHlsStreams(fixed, host || "HLS", { "User-Agent": UA, "Referer": referer || `${MAIN_URL}/` });
        if (/\.mp4(?:\?|$)/i.test(fixed)) return [createStream(fixed, host || "MP4", { "User-Agent": UA, "Referer": referer || `${MAIN_URL}/` }, qualityFromText(fixed, 0))];
        return [createStream(fixed, host || "Server", { "User-Agent": UA, "Referer": referer || `${MAIN_URL}/` }, qualityFromText(fixed, 0))];
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const media = inputPayload(urlInfo);
            if (!media.url) throw new Error("Invalid URL data");
            const html = await getText(media.url, { ...HEADERS, "Referer": `${MAIN_URL}/` });
            const doc = await parseHtml(html);

            const iframeUrls = [];

            // Detect and collect AJAX player options (common in Dooplay theme configurations)
            const playerOptions = qsa(doc, "li.dooplay_player_option, .player-option");
            for (const option of playerOptions) {
                const post = attr(option, ["data-post"]);
                const nume = attr(option, ["data-nume"]);
                const type = attr(option, ["data-type"]);
                if (post && nume && type) {
                    try {
                        const body = `action=doo_player_ajax&post=${encodeURIComponent(post)}&nume=${encodeURIComponent(nume)}&type=${encodeURIComponent(type)}`;
                        const response = await postText(`${MAIN_URL}/wp-admin/admin-ajax.php`, {
                            ...HEADERS,
                            "Content-Type": "application/x-www-form-urlencoded",
                            "X-Requested-With": "XMLHttpRequest"
                        }, body);
                        const json = safeParse(response);
                        const embedUrl = json && (json.embed_url || json.url);
                        if (embedUrl) {
                            if (embedUrl.includes("<iframe")) {
                                const iframeMatch = embedUrl.match(/src=["']([^"']+)["']/i);
                                if (iframeMatch) iframeUrls.push(fixUrl(iframeMatch[1], MAIN_URL));
                            } else {
                                iframeUrls.push(fixUrl(embedUrl, MAIN_URL));
                            }
                        }
                    } catch (e) {}
                }
            }

            // Gather any static iframes fallback
            const staticIframes = qsa(doc, "#options-0 iframe, iframe, .play-box-iframe iframe")
                .map((iframe) => fixUrl(attr(iframe, ["data-src", "src"]), media.url))
                .filter(Boolean);

            const combinedUrls = Array.from(new Set(iframeUrls.concat(staticIframes)));
            const loaded = await mapLimit(combinedUrls, 6, (src) => loadExtractor(src, media.url));
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
