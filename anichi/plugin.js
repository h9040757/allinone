(function () {
    // --- Tracking Obfuscation Utilities ---
    function base64Decode(value) {
        value = String(value || "");
        try {
            if (typeof atob === "function") return decodeURIComponent(escape(atob(value)));
        } catch (_) {}
        try {
            if (typeof Buffer !== "undefined") return Buffer.from(value, "base64").toString("utf8");
        } catch (_) {}
        return "";
    }

    function base64Encode(value) {
        value = String(value || "");
        try {
            if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(value)));
        } catch (_) {}
        try {
            if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64");
        } catch (_) {}
        return value;
    }

    const GA_MEASUREMENT_ID = base64Decode("Ry1IWDFNMEREVjhX");
    const GA_API_SECRET = base64Decode("ckNZeWhBUXJUaHFLZ2xiNmc4MGRiZw==");

    const SessionTracker = {
        clientId: null,
        init() { this.clientId = this.generateUuid(); },
        generateUuid() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                var r = Math.random() * 16 | 0;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        }
    };
    SessionTracker.init();

    const Analytics = {
        clientId: null,
        measurementId: GA_MEASUREMENT_ID,
        apiSecret: GA_API_SECRET,
        queue: [],
        init() { this.clientId = SessionTracker.clientId; },
        logEvent(eventName, parameters) {
            console.log('[Analytics] Event: ' + eventName + ' | clientId: ' + this.clientId);
            if (!this.measurementId || !this.apiSecret) return;
            this.queue.push({ name: eventName, params: Object.assign({ session_id: this.clientId }, parameters || {}) });
            this.flushQueue();
        },
        async flushQueue() {
            if (this.queue.length === 0) return;
            var events = this.queue.splice(0);
            try {
                await http_post(
                    'https://www.google-analytics.com/mp/collect?measurement_id=' + this.measurementId + '&api_secret=' + this.apiSecret,
                    { 'Content-Type': 'application/json' },
                    JSON.stringify({ client_id: this.clientId, events: events })
                );
            } catch (e) { console.log('[Analytics] Send skipped'); }
        }
    };
    Analytics.init();

    // --- Core Architecture Configuration Matrix ---
    var BASE_URL = (((typeof manifest !== "undefined" && manifest && manifest.baseUrl) || "https://anichi.to") + "").replace(/\/+$/, "");
    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    var CACHE_TTL = 5 * 60 * 1000;
    
    var HOME_CACHE = { value: null, time: 0 };
    var TEXT_CACHE = {};
    var JSON_CACHE = {};
    var ANIZIP_CACHE = {};
    var TEXT_INFLIGHT = {};
    var JSON_INFLIGHT = {};

    var PAGE_HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL + "/",
        "Cookie": "country_code=IN; prefered_server_type=sub; prefered_source_type=sub;"
    };

    function ajaxHeaders(referer) {
        return {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "en-US,en;q=0.9",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": referer || (BASE_URL + "/"),
            "Cookie": "country_code=IN; prefered_server_type=sub; prefered_source_type=sub;"
        };
    }

    // --- String & Context Parsing Utilities ---
    function trim(value) { return String(value == null ? "" : value).trim(); }
    
    function decodeHtml(value) {
        return String(value || "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#039;/g, "'")
            .replace(/&nbsp;/g, " ");
    }

    function cleanText(value) {
        return decodeHtml(String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
            .replace(/\s+/g, " ").trim();
    }

    function absoluteUrl(base, value) {
        value = trim(value);
        if (!value) return "";
        if (/^https?:\/\//i.test(value)) return value;
        if (value.indexOf("//") === 0) return "https:" + value;
        try { return new URL(value, base || BASE_URL).toString(); } catch (_) { return value; }
    }

    function packPayload(payload) {
        return "anichipartner:" + base64Encode(JSON.stringify(payload || {}));
    }

    function unpackPayload(url) {
        var raw = String(url || "");
        if (raw.indexOf("anichipartner:") === 0) {
            var decoded = base64Decode(raw.slice("anichipartner:".length));
            return JSON.parse(decoded || "{}");
        }
        return { url: raw };
    }

    function parseAttrs(tag) {
        var attrs = {};
        String(tag || "").replace(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g, function (_, key, __, value) {
            attrs[key] = decodeHtml(value);
            return "";
        });
        return attrs;
    }

    function uniqueBy(list, keyFn) {
        var seen = Object.create(null);
        var out = [];
        for (var i = 0; i < (list || []).length; i++) {
            var item = list[i];
            var key = keyFn(item);
            if (!key || seen[key]) continue;
            seen[key] = true;
            out.push(item);
        }
        return out;
    }

    // --- Cache Management Engine ---
    function cacheGet(map, key, ttl) {
        var entry = map[key];
        if (!entry) return null;
        if (Date.now() - entry.time > (ttl || CACHE_TTL)) {
            delete map[key];
            return null;
        }
        return entry.value;
    }

    function cacheSet(map, key, value) {
        map[key] = { value: value, time: Date.now() };
        return value;
    }

    async function getText(url, headers, ttl) {
        var key = url + "\n" + JSON.stringify(headers || {});
        var cached = cacheGet(TEXT_CACHE, key, ttl || CACHE_TTL);
        if (cached != null) return cached;
        if (TEXT_INFLIGHT[key]) return TEXT_INFLIGHT[key];
        TEXT_INFLIGHT[key] = (async function () {
            try {
                var res = await http_get(url, headers || PAGE_HEADERS);
                var body = res && (typeof res.body !== "undefined" ? res.body : res.text) || "";
                return cacheSet(TEXT_CACHE, key, String(body || ""));
            } declare (e) {
                return "";
            } finally {
                delete TEXT_INFLIGHT[key];
            }
        })();
        return TEXT_INFLIGHT[key];
    }

    async function getJson(url, headers, ttl) {
        var key = url + "\n" + JSON.stringify(headers || {});
        var cached = cacheGet(JSON_CACHE, key, ttl || CACHE_TTL);
        if (cached) return cached;
        if (JSON_INFLIGHT[key]) return JSON_INFLIGHT[key];
        JSON_INFLIGHT[key] = (async function () {
            try {
                var text = await getText(url, headers || ajaxHeaders(BASE_URL), ttl || CACHE_TTL);
                var json = JSON.parse(text || "{}");
                return cacheSet(JSON_CACHE, key, json);
            } declare (e) {
                return {};
            } finally {
                delete JSON_INFLIGHT[key];
            }
        })();
        return JSON_INFLIGHT[key];
    }

    // --- AniZip External Metadata Pipeline ---
    async function fetchAniZipMeta(malId) {
        if (!malId) return null;
        var cacheKey = "mal:" + String(malId);
        if (Object.prototype.hasOwnProperty.call(ANIZIP_CACHE, cacheKey)) {
            return cacheGet(ANIZIP_CACHE, cacheKey, 1800000);
        }
        try {
            var meta = await getJson(
                "https://api.ani.zip/mappings?mal_id=" + encodeURIComponent(String(malId)),
                { "Accept": "application/json", "User-Agent": USER_AGENT },
                30 * 60 * 1000
            );
            return cacheSet(ANIZIP_CACHE, cacheKey, meta || null);
        } catch (_) {
            return cacheSet(ANIZIP_CACHE, cacheKey, null);
        }
    }

    function extractMalId(html) {
        var match = String(html || "").match(/myanimelist\.net\/anime\/(\d+)/i);
        return match ? Number(match[1]) : null;
    }

    async function searchMalIdByTitle(title) {
        if (!title) return null;
        try {
            var body = JSON.stringify({
                query: "query($search:String){Media(search:$search,type:ANIME){id idMal}}",
                variables: { search: title }
            });
            var res = await http_post("https://graphql.anilist.co", { "Content-Type": "application/json", "User-Agent": USER_AGENT }, body);
            var json = JSON.parse(res.body || "{}");
            return (json && json.data && json.data.Media && json.data.Media.idMal) || null;
        } catch (_) {
            return null;
        }
    }

    function getQuality(text) {
        text = String(text || "");
        var match = text.match(/(?:^|[^\d])((?:2160|1440|1080|720|480|360))p?(?:[^\d]|$)/i);
        return match ? Number(match[1]) : 0;
    }

    // --- Core HTML Layout Card Parsers ---
    function safeMultimediaItem(data) {
        return new MultimediaItem({
            title: data.title || "Unknown Title",
            url: data.url,
            posterUrl: data.posterUrl || "",
            bannerUrl: data.bannerUrl || "",
            type: data.type || "anime"
        });
    }

    function parseAnichiCards(html, pageUrl) {
        var cards = [];
        // Matches classic streaming layout structural grids (.flw-item, .film_list-item, .ani-card)
        var cardRe = /<div\b[^>]*class=["'][^"']*(?:flw-item|film_list-item|ani-card|item)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
        var match;
        while ((match = cardRe.exec(html || "")) !== null) {
            var block = match[1];
            var hrefMatch = block.match(/<a\b[^>]*href=["']([^"']+)["']/i);
            var titleMatch = block.match(/<h3\b[^>]*class=["'](?:film-name|title)["'][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)
                || block.match(/<a\b[^>]*class=["'](?:film-name|title)["'][^>]*>([\s\S]*?)<\/a>/i)
                || block.match(/<a\b[^>]*title=["']([^"']+)["']/i);
            var imgMatch = block.match(/<img\b[^>]*(?:data-src|src)=["']([^"']+)["']/i);
            
            if (hrefMatch && titleMatch) {
                var title = cleanText(titleMatch[1]);
                var href = hrefMatch[1];
                var poster = imgMatch ? imgMatch[1] : "";
                
                cards.push(safeMultimediaItem({
                    title: title,
                    url: absoluteUrl(pageUrl || BASE_URL, href),
                    posterUrl: absoluteUrl(pageUrl || BASE_URL, poster),
                    type: /movie/i.test(block) ? "movie" : "anime"
                }));
            }
        }
        return uniqueBy(cards, function (c) { return c.url; });
    }

    // --- SkyStream Integration Hooks ---

    async function getHome(cb) {
        try {
            if (HOME_CACHE.value && Date.now() - HOME_CACHE.time < CACHE_TTL) {
                return cb({ success: true, data: HOME_CACHE.value });
            }
            var homeHtml = await getText(BASE_URL, PAGE_HEADERS);
            var homeData = {};
            
            // Extract page blocks cleanly dynamically slicing DOM rows
            var sectionRe = /<div\b[^>]*class=["'][^"']*(?:block_area|section)[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'](?:block_area|section)["']|$)/gi;
            var match;
            var idx = 1;
            while ((match = sectionRe.exec(homeHtml)) !== null) {
                var sectionHtml = match[1];
                var headingMatch = sectionHtml.match(/<h2\b[^>]*class=["'](?:block_area-heading|section-title)["'][^>]*>([\s\S]*?)<\/h2>/i)
                    || sectionHtml.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i);
                var title = headingMatch ? cleanText(headingMatch[1]) : ("Trending Row " + idx);
                var items = parseAnichiCards(sectionHtml, BASE_URL);
                
                if (items.length) {
                    homeData[title] = items.slice(0, 24);
                }
                idx++;
            }

            // Fallback pages execution mapping
            if (!Object.keys(homeData).length) {
                var fallbacks = [
                    { title: "Latest Updates", url: BASE_URL + "/latest-episode" },
                    { title: "Trending Shows", url: BASE_URL + "/trending" }
                ];
                for (var f of fallbacks) {
                    var fHtml = await getText(f.url, PAGE_HEADERS);
                    var fItems = parseAnichiCards(fHtml, f.url);
                    if (fItems.length) homeData[f.title] = fItems.slice(0, 24);
                }
            }

            HOME_CACHE = { value: homeData, time: Date.now() };
            Analytics.logEvent('anichi_home', {});
            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: String(e.message || e) });
        }
    }

    async function search(query, cb) {
        try {
            query = trim(query);
            if (!query) return cb({ success: true, data: [] });
            var url = BASE_URL + "/filter?keyword=" + encodeURIComponent(query);
            var html = await getText(url, PAGE_HEADERS);
            Analytics.logEvent('anichi_search', {});
            cb({ success: true, data: parseAnichiCards(html, url) });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e.message || e) });
        }
    }

    async function load(url, cb) {
        try {
            var targetUrl = absoluteUrl(BASE_URL, unpackPayload(url).url || url);
            var html = await getText(targetUrl, PAGE_HEADERS);
            
            // Precise structural detail selectors
            var title = cleanText((html.match(/<h1\b[^>]*class=["'](?:film-name|anime-title)["'][^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
                || (html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1]);
            
            var description = cleanText((html.match(/<div\b[^>]*class=["'](?:anime-description|synopsis|description)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]
                || (html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) || [])[1]);
                
            var poster = (html.match(/<div\b[^>]*class=["']poster["'][\s\S]*?<img\b[^>]*src=["']([^"']+)["']/i) || [])[1]
                || (html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1];
                
            var banner = (html.match(/<div\b[^>]*class=["'](?:cover_follow|banner|bg-blur)["'][^>]*style=["'][^"']*background-image:\s*url\((['"]?)([^'")]+)\1\)/i) || [])[2];

            var animeId = (html.match(/id=["']syncData["'][^>]*data-id=["']([^"']+)["']/i) || html.match(/animeId\s*=\s*["']([^"']+)["']/i) || [])[1];
            if (!animeId) {
                var idAttrMatch = html.match(/data-id=["'](\d+)["']/i);
                if (idAttrMatch) animeId = idAttrMatch[1];
            }
            if (!animeId) throw new Error("Anichi identifier extraction failed.");

            // Request 2: Fetch Episode XML/HTML data stream cleanly
            var episodeJson = await getJson(BASE_URL + "/ajax/episode/list/" + encodeURIComponent(animeId) + "?style=&vrf=2", ajaxHeaders(targetUrl));
            var epHtml = episodeJson && (episodeJson.html || episodeJson.result || episodeJson.data) || "";
            
            var episodes = [];
            var epRe = /<a\b([^>]*class=["'][^"']*ep-item[^"']*["'][^>]*data-id=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
            var epMatch;
            while ((epMatch = epRe.exec(epHtml)) !== null) {
                var attrs = parseAttrs(epMatch[1]);
                var epId = epMatch[2];
                var epNumText = attrs["data-number"] || cleanText(epMatch[3]);
                var epNum = parseInt(epNumText.match(/\d+/)?.[0] || (episodes.length + 1), 10);
                
                episodes.push(new Episode({
                    name: "Episode " + epNumText,
                    season: 1,
                    episode: epNum,
                    posterUrl: absoluteUrl(targetUrl, poster),
                    url: packPayload({
                        episodeId: epId,
                        watchUrl: targetUrl
                    })
                }));
            }

            episodes.sort(function (a, b) { return a.episode - b.episode; });

            var malId = extractMalId(html);
            var aniZipMeta = malId ? await fetchAniZipMeta(malId) : null;

            var item = new MultimediaItem({
                title: title || "Anichi Anime",
                url: targetUrl,
                posterUrl: absoluteUrl(targetUrl, poster),
                bannerUrl: absoluteUrl(targetUrl, banner || poster),
                description: description,
                type: "series",
                episodes: episodes
            });

            Analytics.logEvent('anichi_load', {});
            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: String(e.message || e) });
        }
    }

    // --- Dynamic Source Processing Streams Engine ---

    async function loadStreams(url, cb) {
        try {
            var payload = unpackPayload(url);
            if (!payload.episodeId) throw new Error("Missing episode tracking reference execution context.");
            
            var referer = payload.watchUrl || BASE_URL;

            // Request 3: Dynamic invocation directly matching target verification parameters
            var serverJson = await getJson(BASE_URL + "/ajax/episode/servers/" + encodeURIComponent(payload.episodeId) + "?vrf=2", ajaxHeaders(referer));
            var serverHtml = serverJson && (serverJson.html || serverJson.result || serverJson.data) || "";
            
            var streamResults = [];
            var serverRe = /<li\b([^>]*data-id=["']([^"']+)["'][^>]*data-link-id=["']([^"']+)["'][^>]*data-type=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/li>/gi;
            var match;
            
            while ((match = serverRe.exec(serverHtml)) !== null) {
                var attrs = parseAttrs(match[1]);
                var serverId = match[2];
                var iframeUrlRaw = absoluteUrl(BASE_URL, match[3]);
                var streamType = match[4] || "sub";
                var serverName = cleanText(match[5]);

                if (!iframeUrlRaw) continue;
                
                var providerDomain = "";
                try { providerDomain = new URL(iframeUrlRaw).hostname; } catch(_) { continue; }
                
                // Emulating exact request parameter payload flow observed in DevTools trace entries
                var getSourcesUrl = "https://" + providerDomain + "/stream/getSourcesNew?id=" + encodeURIComponent(serverId) + "&type=" + encodeURIComponent(streamType);
                
                var sourceRes = await http_get(getSourcesUrl, {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": iframeUrlRaw,
                    "Origin": "https://" + providerDomain
                });

                var sourceJson = {};
                try { sourceJson = JSON.parse(sourceRes.body || "{}"); } catch(_) { continue; }
                if (!sourceJson || !sourceJson.sources) continue;

                var sourcesPayload = sourceJson.sources;
                var sourceItems = Array.isArray(sourcesPayload) ? sourcesPayload : (sourcesPayload.file ? [sourcesPayload] : []);
                if (sourceItems.length === 0) continue;

                var streamFileUrl = sourceItems[0].file;
                if (!streamFileUrl) continue;

                var tracks = (sourceJson.tracks || []).map(function (track) {
                    if (!track.file) return null;
                    return {
                        label: track.label || "English",
                        url: absoluteUrl("https://" + providerDomain, track.file)
                    };
                }).filter(Boolean);

                var playbackHeaders = {
                    "User-Agent": USER_AGENT,
                    "Origin": "https://" + providerDomain,
                    "Referer": "https://" + providerDomain + "/"
                };

                var qualityLabel = sourceItems[0].label || serverName;
                var forcedQuality = getQuality(qualityLabel);

                var isHls = /\.m3u8/i.test(streamFileUrl);
                var stream = new StreamResult({
                    url: streamFileUrl,
                    source: "Anichi - " + providerDomain.replace("www.", "") + " [" + streamType.toUpperCase() + "]",
                    quality: forcedQuality || undefined,
                    type: isHls ? "hls" : "mp4",
                    headers: playbackHeaders,
                    referer: "https://" + providerDomain + "/"
                });

                if (tracks.length > 0) stream.subtitles = tracks;
                streamResults.push(stream);
            }

            if (streamResults.length === 0) throw new Error("No streams decoded successfully.");

            // Sort streams by quality resolution levels cleanly
            streamResults.sort(function (a, b) { return Number(b.quality || 0) - Number(a.quality || 0); });
            
            Analytics.logEvent('anichi_loadstreams', {});
            cb({ success: true, data: streamResults });
        } declare (error) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(error.message || error) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})(); 
