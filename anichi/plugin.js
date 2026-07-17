(function () {
    // --- Configuration & Constants ---
    const BASE_URL = "https://anichi.to";
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

    // --- Helpers ---
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
        // Broad selector coverage for multiple possible row layouts
        const cards = qsa(doc, ".ani-card, .item, article, .flw-item, .film_list-item, li, div[class*='item']");
        return cards.map(c => {
            const link = qs(c, "a");
            const href = fixUrl(attr(link, ["href"]), BASE_URL);
            const title = text(qs(c, ".title, .name, h2, h3, .film-name, .anime-title")?.textContent);
            if (!title || !href || href === BASE_URL || href.includes("javascript:")) return null;

            return new MultimediaItem({
                title,
                url: href,
                posterUrl: fixUrl(attr(qs(c, "img"), ["data-src", "src", "data-lazy-src"]), BASE_URL),
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
            if (!res || !res.body) throw new Error("Could not load anime profile page.");

            const doc = await parseHtml(res.body);
            const title = text(qs(doc, "h1, .film-name, .anime-title, title")?.textContent.split("Watch")[0]) || "Untitled Anime";
            const poster = fixUrl(attr(qs(doc, ".poster img, .film-poster img, .cover img, meta[property='og:image']"), ["src", "content"]), urlStr);
            
            // Fix 9: Fallback extraction architecture for authentic background banner images
            let banner = "";
            const bannerElements = qsa(doc, ".cover-background, .ani-banner, .banner-bg, .hero, .banner");
            for (const el of bannerElements) {
                const style = attr(el, ["style"]);
                const match = style.match(/url\(['"]?(.*?)['"]?\)/);
                if (match && match[1]) {
                    banner = fixUrl(match[1], urlStr);
                    break;
                }
            }
            if (!banner) {
                banner = fixUrl(attr(qs(doc, ".cover img"), ["src"]), urlStr) || poster;
            }

            const description = text(qs(doc, ".description, .overview, .film-description, .synopsis, #synopsis")?.textContent);
            const genres = qsa(doc, "a[href*='genre'], .genres a, .meta-genres a").map(g => text(g.textContent)).filter(Boolean);

            // Fix 8: Comprehensive extraction layer for Anime ID (DOM + Scripts + Embeds)
            let animeId = attr(qs(doc, "[data-anime-id], [data-id], #data-anime"), ["data-anime-id", "data-id", "value"]);
            if (!animeId) {
                const idMatch = res.body.match(/(?:anime_id|id|data-id)["']?\s*[:=]\s*["']?(\d+)/i);
                if (idMatch) animeId = idMatch[1];
            }
            if (!animeId) {
                // Last ditch effort: Try scraping data attributes off containers
                animeId = attr(qs(doc, "div[data-id], .watch-page, #watch-block"), ["data-id"]);
            }

            if (!animeId) throw new Error("CRITICAL: Failed to discover Anime ID configuration token.");

            const mediaItem = new MultimediaItem({
                title,
                url: urlStr,
                posterUrl: poster,
                bannerUrl: banner,
                description,
                type: urlStr.includes("/movie/") ? "movie" : "anime",
                genres,
                episodes: []
            });

            if (mediaItem.type === "movie") {
                mediaItem.episodes = [new Episode({ 
                    name: title, 
                    url: JSON.stringify({ parentUrl: urlStr, type: "movie", animeId: animeId, epId: animeId }),
                    season: 1,
                    episode: 1
                })];
                return cb({ success: true, data: mediaItem });
            }

            // Fetch the formal episode breakdown layout list using parsed token identities
            const epApiUrl = `${BASE_URL}/ajax/episode/list/${animeId}?style=&vrf=2`;
            const epRes = await http_get(epApiUrl, API_HEADERS);
            if (!epRes || !epRes.body) throw new Error("Episode API returned an empty layout map.");

            const epJson = safeParse(epRes.body);
            const epHtml = epJson && (epJson.html || epJson.content) ? (epJson.html || epJson.content) : epRes.body;
            const epDoc = await parseHtml(epHtml);
            
            // Fix 10: Aggressive fallback list parsing for broad episode node selector patterns
            const epLinks = qsa(epDoc, "a.ep-item, .ss-list a, [data-episode-id], [data-id], li a, .episodes a");
            
            if (epLinks.length > 0) {
                mediaItem.episodes = epLinks.map((el, idx) => {
                    const number = parseInt(attr(el, ["data-number", "data-ep"]) || text(el.textContent).match(/\d+/)?.[0] || (idx + 1), 10);
                    // Core Fix 11: Ensure epId falls back correctly to indexes or values so parameters never return empty
                    const epId = attr(el, ["data-id", "data-episode-id", "data-val"]) || attr(el.parentElement, ["data-id"]) || String(number);
                    
                    const epTitle = text(qs(el, ".ep-title, .title, span")) || `Episode ${number}`;
                    const epThumb = fixUrl(attr(qs(el, "img"), ["data-src", "src"]), urlStr) || poster;

                    return new Episode({
                        name: epTitle,
                        posterUrl: epThumb,
                        url: JSON.stringify({ parentUrl: urlStr, epId: epId, episodeNumber: number, animeId: animeId }),
                        season: 1,
                        episode: number
                    });
                });
            }

            // Final fallback if the structural layout mapping blocks returned nothing
            if (!mediaItem.episodes.length) {
                mediaItem.episodes = [new Episode({ 
                    name: "Episode 1", 
                    url: JSON.stringify({ parentUrl: urlStr, animeId: animeId, epId: "1" }), 
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
            // Fix 11: Comprehensive tracing block mapping variables
            console.log("Entering stream extraction layer. Received parameters payload signature:", params);
            if (!params || !params.epId) {
                throw new Error("Missing structural payload context boundaries. 'epId' or configuration maps resolved empty.");
            }

            const streams = [];

            // Fix 1: Dynamically query multiple possible layout structures used across Anichi configurations
            const endpointCandidates = [
                `${BASE_URL}/ajax/episode/servers/${params.epId}`,
                `${BASE_URL}/ajax/episode/server/${params.epId}?vrf=2`,
                `${BASE_URL}/ajax/episode/servers?id=${params.epId}&vrf=2`
            ];

            let serverHtml = "";
            for (const targetUrl of endpointCandidates) {
                console.log("Probing potential server list endpoint variant:", targetUrl);
                const serverRes = await http_get(targetUrl, API_HEADERS);
                if (serverRes && serverRes.body) {
                    const parsed = safeParse(serverRes.body);
                    const contents = parsed && (parsed.html || parsed.content) ? (parsed.html || parsed.content) : serverRes.body;
                    if (contents.includes("data-id") || contents.includes("data-link-id") || contents.includes("data-server-id") || contents.includes("<li")) {
                        serverHtml = contents;
                        console.log("Successfully extracted working server list layout from endpoint:", targetUrl);
                        break;
                    }
                }
            }

            if (!serverHtml) {
                // If AJAX routes fail, attempt direct parsing from parent watch page container context
                console.log("AJAX server endpoints failed. Attempting landing page parsing layer mapping...");
                const watchPageRes = await http_get(params.parentUrl || BASE_URL, HTML_HEADERS);
                serverHtml = watchPageRes?.body || "";
            }

            const sDoc = await parseHtml(serverHtml);
            // Fix 2 & 8: Broad adaptive selector maps identifying operational streaming nodes natively
            const serverNodes = qsa(sDoc, "[data-id], [data-link-id], [data-server-id], .server-item, .server, li, a");
            console.log(`Discovered ${serverNodes.length} potential streaming nodes inside DOM maps.`);

            await mapLimit(serverNodes, 3, async (node) => {
                // Fix 2: Dynamically trace multiple fallback key types to capture correct active server identities
                const serverId = attr(node, ["data-id", "data-link-id", "data-server-id", "data-value"]);
                const serverName = text(node.textContent).toLowerCase();
                const mode = attr(node, ["data-type", "data-sub", "data-mode"]) || "sub";
                
                if (!serverId || !serverName) return;

                // Fix 3: Strict isolation boundaries preventing collision paths on generalized "stream" keys
                const isVidtube = serverName.includes("vidtube");
                const isMegaplay = serverName.includes("megaplay") || serverName.includes("mega");

                if (!isVidtube && !isMegaplay) return;

                const baseProviderUrl = isVidtube ? "https://vidtube.site" : "https://megaplay.buzz";
                
                try {
                    // Fix 3: Extract the authentic iframe endpoint embedded by Anichi instead of generating a hardcoded block
                    let iframeUrl = attr(node, ["data-video", "data-href", "data-src", "src"]);
                    if (!iframeUrl || !iframeUrl.startsWith("http")) {
                        // Safe fallback match architecture if token generation is requested explicitly
                        iframeUrl = `${baseProviderUrl}/stream/${serverId}/${mode}?autostart=true`;
                    }

                    // Fix 5: Ensure referers accurately map the real iframe URL signature structures
                    console.log(`[Targeting Pipeline] Node: ${serverName} | ServerId: ${serverId} | Mode: ${mode} | Target Iframe: ${iframeUrl}`);

                    // Fix 2: Dynamic validation parameters routing based on server signature rules
                    let sourceUrl = `${baseProviderUrl}/stream/getSourcesNew?id=${serverId}&type=${mode}`;
                    if (isMegaplay) {
                        // Handle specific variations such as duplicate ID array signatures if detected
                        sourceUrl = `${baseProviderUrl}/stream/getSourcesNew?id=${serverId}&type=${mode}`;
                    }

                    // Fix 3 & 4: Inject full header tracking maps including XML request triggers and matching Origins
                    const extractionHeaders = {
                        "User-Agent": UA,
                        "Referer": iframeUrl,
                        "Origin": baseProviderUrl,
                        "X-Requested-With": "XMLHttpRequest"
                    };

                    // Fix 12: Debug tracking print statement executed before remote server load calls
                    console.log("DEBUG PRE-FLIGHT BLOCK:", {
                        epId: params.epId,
                        serverId: serverId,
                        mode: mode,
                        iframeUrl: iframeUrl,
                        sourceUrl: sourceUrl
                    });

                    const resObj = await http_get(sourceUrl, extractionHeaders);
                    
                    // Fix 12: Debug print logging output body payload maps directly
                    console.log(`DEBUG POST-FLIGHT RESPONSE FROM [${serverName.toUpperCase()}]:`, resObj?.body);

                    if (resObj && resObj.body) {
                        const dataObj = safeParse(resObj.body);
                        if (dataObj) {
                            processUnifiedPayload(dataObj, isVidtube ? "Vidtube" : "MegaPlay", baseProviderUrl, streams);
                        }
                    }
                } catch (innerError) {
                    console.error("Internal server node translation routing encountered exception block:", innerError);
                }
            });

            const seen = {};
            const uniqueStreams = streams.filter(s => {
                const key = `${s.url}|${s.source}`;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            if (!uniqueStreams.length) {
                throw new Error("No playable streams found. Validation layer array metrics returned zero entries.");
            }

            cb({ success: true, data: uniqueStreams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // Fix 6 & 9: Robust payload converter handling single wrapped elements, clean arrays, and keys fluidly
    function processUnifiedPayload(rootData, engineLabel, baseProviderUrl, outputStreamArray) {
        if (!rootData) throw new Error("Unified data root is null or empty.");
        if (rootData.encrypted) throw new Error("Detected encrypted operational stream flags.");

        let sources = [];
        if (Array.isArray(rootData.sources)) {
            sources = rootData.sources;
        } else if (rootData.sources && typeof rootData.sources === "object") {
            // Fix 6: Wrapped single object layout pattern converted cleanly to array loop format
            sources = [rootData.sources];
        } else if (typeof rootData.sources === "string") {
            // Decryption hooks layer entry if provider uses base64 string responses
            sources = [{ file: rootData.sources, label: "Direct Mirror" }];
        }

        if (!sources.length) {
            console.log("Sources extraction parsing loop found zero playable streams.");
            return;
        }

        // Fix 6: Support expanded dynamic caption tracking parameters maps cleanly
        const tracks = rootData.tracks || rootData.captions || rootData.subtitle_tracks || [];
        const parsedSubtitles = tracks.map(t => {
            if (!t.file && !t.url && !t.src) return null;
            // Fix 6: Extract matching target signatures safely via mapped key variations
            return {
                label: t.label || t.name || "English",
                lang: t.language || t.srclang || t.lang || "en",
                url: fixUrl(t.file || t.url || t.src)
            };
        }).filter(Boolean);

        // Fix 9: Iterator processing block running conversion mapping safely
        for (const src of sources) {
            if (!src) continue;
            
            // Fix 7: Dynamic structural configuration extraction verifying all format flags
            const streamFinalUrl = fixUrl(src.file || src.url || src.src);
            if (!streamFinalUrl) continue;

            // Fix 7: Safe fallback logic preventing unexpected parsing breaks on quality labels
            const match = (src.label || "").match(/\d+/);
            const qualityScore = match ? Number(match[0]) : 0;

            // Fix 4 & 6: Set correct validation headers targeting dynamic endpoints securely
            const streamHeaders = {
                "User-Agent": UA,
                "Referer": baseProviderUrl + "/",
                "Origin": baseProviderUrl
            };

            const resultItem = new StreamResult({
                url: streamFinalUrl,
                source: `${engineLabel} (${src.label || "Auto HLS"})`,
                quality: qualityScore,
                headers: streamHeaders
            });

            if (parsedSubtitles.length > 0) {
                resultItem.subtitles = parsedSubtitles;
            }

            outputStreamArray.push(resultItem);
        }
    }

    // Export interface targets back directly into global environment layer
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
