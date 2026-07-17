(function () {
    // =========================================================================
    // DEVTOOLS CONFIGURATION MATRIX (Fill these in exactly from your browser)
    // =========================================================================
    const CONFIG = {
        // [Cookies caught in your network panel]
        COOKIE_STRING: "country_code=IN; prefered_server_type=sub; prefered_server_id=323; prefered_source_type=sub;",
        
        // [The precise endpoints checked in your network tab]
        ENDPOINTS: {
            SEARCH_ROUTE: "/filter", // Verify if /filter or /search is used by your browser
            EPISODE_LIST: "/ajax/episode/list/", // Exact base route before the ID concatenation
            SERVER_LIST: "/ajax/episode/servers/" // Exact base route before the Ep ID concatenation
        },

        // [The exact HTML selectors scraped from the live DOM inspect panel]
        SELECTORS: {
            // Home & Catalog Card Elements
            CARD_ITEM: ".flw-item", 
            CARD_ANCHOR: "a.film-poster-ahref",
            CARD_TITLE: ".film-name a",
            CARD_POSTER: "img.film-poster",

            // Meta Details Panel Elements
            META_TITLE: "h1.film-name",
            META_DESC: ".film-description .text",
            META_POSTER: "img.film-poster",
            META_BANNER: ".cover_follow",
            
            // Critical Identification Selectors
            ANIME_ID_CONTAINER: "#syncData", // The DOM element holding the ID attribute
            ANIME_ID_ATTR: "data-id",        // e.g., 'data-id', 'value', 'movie-id'
            
            // Episode list structural nodes
            EPISODE_NODE: ".ep-item",        // Target specific list elements, not broad 'a' tags
            EPISODE_ID_ATTR: "data-id",      // Attribute carrying the true numeric episode reference
            
            // Server target list element nodes
            SERVER_NODE: ".server-item",     // Target specific button lists
            SERVER_ID_ATTR: "data-id",       // Attribute mapped to the server identifier query
            SERVER_TYPE_ATTR: "data-type",   // e.g., returns 'sub' or 'dub' dynamically
            SERVER_LINK_ATTR: "data-link"    // Target attribute containing the embed/iframe URL
        }
    };

    // Global Base Configuration Environment
    const MAIN_URL = (typeof manifest !== 'undefined' && manifest.baseUrl) || "https://anichi.to";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    
    const BASE_HEADERS = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cookie": CONFIG.COOKIE_STRING
    };

    const AJAX_HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.5",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": CONFIG.COOKIE_STRING
    };

    // --- Core Helper Functions ---
    function text(value) { return (value == null ? "" : String(value)).replace(/\s+/g, " ").trim(); }
    function safeParse(data) { if (!data) return null; if (typeof data === "object") return data; try { return JSON.parse(data); } catch (e) { return null; } }
    function asArray(list) { const out = []; if(list) { for (let i = 0; i < list.length; i++) out.push(list[i]); } return out; }
    function qsa(root, selector) { try { return asArray(root.querySelectorAll(selector)); } catch (e) { return []; } }
    function qs(root, selector) { try { return root.querySelector(selector); } catch (e) { return null; } }
    function attr(el, name) { return el ? String(el.getAttribute(name) || "").trim() : ""; }
    function fixUrl(raw, base) { if (!raw) return ""; const url = String(raw).trim(); if (url.startsWith("//")) return "https:" + url; if (/^https?:\/\//i.test(url)) return url; try { return new URL(url, base || MAIN_URL).href; } catch (e) { return url; } }

    // --- Core SkyStream Integration Hooks ---

    async function getHome(cb) {
        try {
            const html = await http_get(MAIN_URL, BASE_HEADERS);
            const doc = await parseHtml(html.body || "");
            const data = {};

            const sections = qsa(doc, ".block_area");
            sections.forEach((section, idx) => {
                const titleText = text(qs(section, ".block_area-heading")?.textContent) || `Catalog Row ${idx + 1}`;
                const cards = qsa(section, CONFIG.SELECTORS.CARD_ITEM);
                
                const items = cards.map(card => {
                    const link = qs(card, CONFIG.SELECTORS.CARD_ANCHOR);
                    const href = fixUrl(attr(link, "href"), MAIN_URL);
                    const title = text(qs(card, CONFIG.SELECTORS.CARD_TITLE)?.textContent || link?.textContent);
                    if (!href || !title) return null;

                    const poster = fixUrl(attr(qs(card, CONFIG.SELECTORS.CARD_POSTER), "src"), MAIN_URL);
                    return new MultimediaItem({
                        title,
                        url: JSON.stringify({ url: href, poster: poster }),
                        posterUrl: poster,
                        type: "series"
                    });
                }).filter(Boolean);

                if (items.length > 0) data[titleText] = items;
            });

            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    async function search(query, cb) {
        try {
            const targetUrl = `${MAIN_URL}${CONFIG.ENDPOINTS.SEARCH_ROUTE}?keyword=${encodeURIComponent(query)}`;
            const response = await http_get(targetUrl, BASE_HEADERS);
            const doc = await parseHtml(response.body || "");
            
            const cards = qsa(doc, CONFIG.SELECTORS.CARD_ITEM);
            const items = cards.map(card => {
                const link = qs(card, CONFIG.SELECTORS.CARD_ANCHOR);
                const href = fixUrl(attr(link, "href"), MAIN_URL);
                const title = text(qs(card, CONFIG.SELECTORS.CARD_TITLE)?.textContent);
                if (!href || !title) return null;

                const poster = fixUrl(attr(qs(card, CONFIG.SELECTORS.CARD_POSTER), "src"), MAIN_URL);
                return new MultimediaItem({
                    title,
                    url: JSON.stringify({ url: href, poster: poster }),
                    posterUrl: poster,
                    type: "series"
                });
            }).filter(Boolean);

            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    async function load(urlStr, cb) {
        try {
            const payloadInput = safeParse(urlStr) || { url: urlStr };
            const response = await http_get(payloadInput.url, { ...BASE_HEADERS, "Origin": MAIN_URL });
            const doc = await parseHtml(response.body || "");

            const title = text(qs(doc, CONFIG.SELECTORS.META_TITLE)?.textContent) || "Untitled Anime";
            const description = text(qs(doc, CONFIG.SELECTORS.META_DESC)?.textContent);
            const poster = fixUrl(attr(qs(doc, CONFIG.SELECTORS.META_POSTER), "src"), payloadInput.url) || payloadInput.poster;
            const banner = fixUrl(attr(qs(doc, CONFIG.SELECTORS.META_BANNER), "src"), payloadInput.url);

            // Fetch the verified target mapping ID directly out of the defined tag matrix
            const animeId = attr(qs(doc, CONFIG.SELECTORS.ANIME_ID_CONTAINER), CONFIG.SELECTORS.ANIME_ID_ATTR);
            if (!animeId) throw new Error(`CRITICAL: Element or attribute mapping failed for [${CONFIG.SELECTORS.ANIME_ID_CONTAINER} -> ${CONFIG.SELECTORS.ANIME_ID_ATTR}]`);

            // Query dynamic AJAX episode list endpoint mirroring browser params exactly
            const episodeListUrl = `${MAIN_URL}${CONFIG.ENDPOINTS.EPISODE_LIST}${animeId}?style=&vrf=2`;
            const epRes = await http_get(episodeListUrl, { ...AJAX_HEADERS, "Referer": payloadInput.url });
            
            const epJson = safeParse(epRes.body) || {};
            const htmlFragment = epJson.html || epJson.result || epJson.data || String(epRes.body || "");
            const epDoc = await parseHtml(htmlFragment);
            
            const epElements = qsa(epDoc, CONFIG.SELECTORS.EPISODE_NODE);
            const episodes = epElements.map((el, idx) => {
                const episodeId = attr(el, CONFIG.SELECTORS.EPISODE_ID_ATTR);
                const labelText = text(el.textContent);
                const parsedNum = parseInt(labelText.match(/\d+/)?.[0] || (idx + 1), 10);
                
                if (!episodeId) return null;
                
                return new Episode({
                    name: labelText.includes("Episode") ? labelText : `Episode ${labelText}`,
                    url: JSON.stringify({ episodeId: episodeId, parentWatchUrl: payloadInput.url }),
                    episode: parsedNum,
                    season: 1,
                    posterUrl: poster
                });
            }).filter(Boolean);

            cb({
                success: true,
                data: new MultimediaItem({
                    title, url: urlStr, posterUrl: poster, bannerUrl: banner, description, type: "series", episodes: episodes
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const transactionContext = safeParse(urlInfo);
            if (!transactionContext || !transactionContext.episodeId) throw new Error("Context processing failed: Missing episodeId context identifier.");

            // Target the dynamic server matching structure route perfectly
            const serverApiUrl = `${MAIN_URL}${CONFIG.ENDPOINTS.SERVER_LIST}${transactionContext.episodeId}?vrf=2`;
            const serverRes = await http_get(serverApiUrl, {
                ...AJAX_HEADERS,
                "Referer": transactionContext.parentWatchUrl || MAIN_URL,
                "Origin": MAIN_URL
            });

            const serverJson = safeParse(serverRes.body) || {};
            const htmlFragment = serverJson.html || serverJson.result || serverJson.data || String(serverRes.body || "");
            const serverDoc = await parseHtml(htmlFragment);
            
            const nodes = qsa(serverDoc, CONFIG.SELECTORS.SERVER_NODE);
            const streamResults = [];

            for (const node of nodes) {
                const serverId = attr(node, CONFIG.SELECTORS.SERVER_ID_ATTR);
                const streamType = attr(node, CONFIG.SELECTORS.SERVER_TYPE_ATTR) || "sub"; 
                const explicitEmbedUrl = attr(node, CONFIG.SELECTORS.SERVER_LINK_ATTR);
                
                // Deterministic Stream Identifier Choice: use specific explicit embedded tracking or fall back on server list identifier mapping
                const streamIdentifier = explicitEmbedUrl ? explicitEmbedUrl : serverId;
                if (!streamIdentifier) continue;

                let providerDomain = "vidtube.site"; // Default template fallback hostname mapping
                let finalIframeUrl = explicitEmbedUrl;

                if (explicitEmbedUrl) {
                    try { providerDomain = new URL(explicitEmbedUrl).hostname; } catch(e) {}
                } else {
                    // If serverId acts directly as your file code inside your specific network stream trace logs
                    finalIframeUrl = `https://${providerDomain}/stream/${streamIdentifier}/${streamType}`;
                }

                // Deterministic network trace emulator endpoint targeting /stream/getSourcesNew directly
                const getSourcesUrl = `https://${providerDomain}/stream/getSourcesNew?id=${encodeURIComponent(serverId)}&type=${encodeURIComponent(streamType)}`;
                
                const response = await http_get(getSourcesUrl, {
                    "User-Agent": UA,
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": finalIframeUrl,
                    "Origin": `https://${providerDomain}`,
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Site": "same-site"
                });

                const sourceJson = safeParse(response.body);
                if (!sourceJson || !sourceJson.sources) continue;

                // Handle both variations seamlessly (Object vs Array format payload checks)
                const sourcesPayload = sourceJson.sources;
                const sourceItems = Array.isArray(sourcesPayload) ? sourcesPayload : (sourcesPayload.file ? [sourcesPayload] : []);
                if (sourceItems.length === 0) continue;

                const targetFileUrl = sourceItems[0].file;
                if (!targetFileUrl) continue;

                // Safely translate subtitles using precise SDK signature naming maps
                const tracks = (sourceJson.tracks || []).map(track => {
                    if (!track.file) return null;
                    return {
                        label: track.label || "English",
                        url: fixUrl(track.file, `https://${providerDomain}`)
                    };
                }).filter(Boolean);

                const playbackHeaders = {
                    "User-Agent": UA,
                    "Origin": `https://${providerDomain}`,
                    "Referer": `https://${providerDomain}/`,
                    "Accept": "*/*"
                };

                const resultStream = new StreamResult({
                    url: targetFileUrl, // Clean URL passed directly to standard player logic
                    source: `Anichi - ${providerDomain.replace("www.", "")}`,
                    quality: sourceItems[0].label ? parseInt(sourceItems[0].label.match(/\d+/)?.[0] || "0", 10) : 0, 
                    type: /\.m3u8/i.test(targetFileUrl) ? "hls" : "mp4",
                    headers: playbackHeaders
                });

                if (tracks.length > 0) {
                    resultStream.subtitles = tracks;
                }

                streamResults.push(resultStream);
            }

            if (streamResults.length === 0) throw new Error("No playable tracks successfully decoded from the stream layout query engine.");
            cb({ success: true, data: streamResults });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message });
        }
    }

    // Assign safe core execution namespaces to global context pipelines
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
