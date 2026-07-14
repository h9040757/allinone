(function () {
    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // manifest is injected at runtime

    // --- Constants ---
    const KARTOONS_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
    
    const HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "Accept": "application/json"
    };

    // --- Helpers ---
    async function fetchJson(url) {
        try {
            const res = await http_get(url, HEADERS);
            if (res.status !== 200 || !res.body) {
                return null;
            }
            return JSON.parse(res.body);
        } catch (e) {
            console.error("Fetch JSON Error: " + e.message);
            return null;
        }
    }

    function createPayload(id, type, season, episode) {
        return JSON.stringify({ 
            id: id, 
            type: type, 
            season: season || null, 
            episode: episode || null 
        });
    }

    function qualityFromText(text) {
        const value = String(text || "").toLowerCase();
        if (/(^|[^0-9])2160p([^0-9]|$)|(^|[^a-z0-9])4k([^a-z0-9]|$)|(^|[^a-z0-9])uhd([^a-z0-9]|$)/.test(value)) return 2160;
        if (/(^|[^0-9])1440p([^0-9]|$)|(^|[^a-z0-9])2k([^a-z0-9]|$)/.test(value)) return 1440;
        if (/(^|[^0-9])1080p([^0-9]|$)|(^|[^a-z0-9])fhd([^a-z0-9]|$)/.test(value)) return 1080;
        if (/(^|[^0-9])720p([^0-9]|$)|(^|[^a-z0-9])hd([^a-z0-9]|$)/.test(value)) return 720;
        if (/(^|[^0-9])480p([^0-9]|$)|(^|[^a-z0-9])sd([^a-z0-9]|$)/.test(value)) return 480;
        if (/(^|[^0-9])360p([^0-9]|$)/.test(value)) return 360;
        return undefined; // Let system fallback to Auto/Unknown
    }

    function toMultimediaItem(meta, typeOverride) {
        if (!meta) return null;
        const type = typeOverride || meta.type || "movie";
        return new MultimediaItem({
            title: meta.name || "Unknown",
            url: createPayload(meta.id, type),
            posterUrl: meta.poster,
            type: type === "series" ? "series" : "movie",
            year: meta.year ? parseInt(String(meta.year).substring(0, 4)) : undefined,
            description: meta.description
        });
    }

    // --- Core Functions ---

    async function getHome(cb) {
        try {
            const homeData = {};

            // Fetch Top Movies
            const moviesRes = await fetchJson(`${CINEMETA_BASE}/catalog/movie/top.json`);
            if (moviesRes && moviesRes.metas && moviesRes.metas.length > 0) {
                homeData["Trending Movies"] = moviesRes.metas.map(m => toMultimediaItem(m, "movie")).filter(Boolean);
            }

            // Fetch Top Series
            const seriesRes = await fetchJson(`${CINEMETA_BASE}/catalog/series/top.json`);
            if (seriesRes && seriesRes.metas && seriesRes.metas.length > 0) {
                homeData["Trending Series"] = seriesRes.metas.map(m => toMultimediaItem(m, "series")).filter(Boolean);
            }

            if (!Object.keys(homeData).length) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No home sections available" });
            }
            
            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    async function search(query, cb) {
        try {
            const encodedQuery = encodeURIComponent(query);
            const results = [];

            // Search Movies
            const moviesRes = await fetchJson(`${CINEMETA_BASE}/catalog/movie/top/search=${encodedQuery}.json`);
            if (moviesRes && moviesRes.metas) {
                moviesRes.metas.forEach(m => {
                    const item = toMultimediaItem(m, "movie");
                    if (item) results.push(item);
                });
            }

            // Search Series
            const seriesRes = await fetchJson(`${CINEMETA_BASE}/catalog/series/top/search=${encodedQuery}.json`);
            if (seriesRes && seriesRes.metas) {
                seriesRes.metas.forEach(m => {
                    const item = toMultimediaItem(m, "series");
                    if (item) results.push(item);
                });
            }

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    async function load(urlStr, cb) {
        try {
            const info = JSON.parse(urlStr);
            if (!info.id || !info.type) throw new Error("Invalid Content Payload Data");

            // Fetch full details from Cinemeta
            const metaRes = await fetchJson(`${CINEMETA_BASE}/meta/${info.type}/${info.id}.json`);
            if (!metaRes || !metaRes.meta) throw new Error("Metadata not found in Cinemeta");

            const m = metaRes.meta;
            const isSeries = info.type === "series";

            const episodes = [];

            if (isSeries && m.videos && m.videos.length > 0) {
                // TV Show Episodes
                m.videos.forEach(vid => {
                    episodes.push(new Episode({
                        name: vid.name || `Episode ${vid.episode}`,
                        url: createPayload(info.id, "series", vid.season, vid.episode),
                        posterUrl: vid.thumbnail || m.poster,
                        season: vid.season,
                        episode: vid.episode,
                        description: vid.overview || ""
                    }));
                });
            } else {
                // Movie single episode
                episodes.push(new Episode({
                    name: m.name,
                    url: createPayload(info.id, "movie"),
                    posterUrl: m.poster,
                    season: 1,
                    episode: 1
                }));
            }

            const result = new MultimediaItem({
                title: m.name,
                url: urlStr,
                posterUrl: m.poster,
                bannerUrl: m.background,
                type: isSeries ? "series" : "movie",
                description: m.description,
                year: m.year ? parseInt(String(m.year).substring(0, 4)) : undefined,
                genres: m.genres || [],
                status: m.status,
                cast: m.cast ? m.cast.map(c => ({ name: c, role: "Actor" })) : [],
                episodes: episodes
            });

            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    async function loadStreams(urlStr, cb) {
        try {
            const info = JSON.parse(urlStr);
            let apiUrl = "";

            // Stremio URL structure formulation based on type
            if (info.type === "movie") {
                apiUrl = `${KARTOONS_URL}/stream/movie/${info.id}.json?token=${TOKEN}`;
            } else {
                apiUrl = `${KARTOONS_URL}/stream/series/${info.id}:${info.season}:${info.episode}.json?token=${TOKEN}`;
            }

            const res = await fetchJson(apiUrl);
            if (!res || !res.streams) {
                return cb({ success: true, data: [] });
            }

            const streamResults = [];

            res.streams.forEach(stream => {
                if (!stream.url) return;

                const rawTitle = stream.title || stream.name || stream.description || "Auto";
                const extractedQuality = qualityFromText(rawTitle) || 720;
                
                // Construct standard SkyStream StreamResult object
                streamResults.push(new StreamResult({
                    url: stream.url,
                    source: stream.name || "Kartoons API",
                    quality: extractedQuality,
                    headers: HEADERS
                }));
            });

            // Remove any potential duplicates based on exact URL
            const deduped = [];
            const seen = new Set();
            streamResults.forEach(item => {
                const key = item.url;
                if (seen.has(key)) return;
                seen.add(key);
                deduped.push(item);
            });

            cb({ success: true, data: deduped });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message });
        }
    }

    // Export functions to global scope for SkyStream App
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();