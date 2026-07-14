(function () {
    const KARTOONS_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const CINEMETA_BASE = "https://v3-cinemeta.strem.io";

    // Helper: Safely fetch JSON responses
    async function fetchJson(url) {
        try {
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            });
            if (!response.ok) return null;
            return await response.json();
        } catch (e) {
            console.error("Fetch Error:", e);
            return null;
        }
    }

    // Helper: Create standardized URL payloads to pass between functions
    function createPayload(id, type, season = null, episode = null) {
        return JSON.stringify({ id, type, season, episode });
    }

    // 1. Load Home Page Catalogs (Uses Cinemeta for Metadata)
    async function getHome(cb) {
        try {
            const data = {};

            // Fetch Top Movies
            const moviesRes = await fetchJson(`${CINEMETA_BASE}/catalog/movie/top.json`);
            if (moviesRes && moviesRes.metas) {
                data["Trending Movies"] = moviesRes.metas.map(m => ({
                    title: m.name,
                    posterUrl: m.poster,
                    url: createPayload(m.id, "movie"),
                    type: "movie"
                }));
            }

            // Fetch Top Series
            const seriesRes = await fetchJson(`${CINEMETA_BASE}/catalog/series/top.json`);
            if (seriesRes && seriesRes.metas) {
                data["Trending Series"] = seriesRes.metas.map(m => ({
                    title: m.name,
                    posterUrl: m.poster,
                    url: createPayload(m.id, "series"),
                    type: "series"
                }));
            }

            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: String(e) });
        }
    }

    // 2. Search Function
    async function search(query, cb) {
        try {
            const encodedQuery = encodeURIComponent(query);
            const results = [];

            // Search Movies
            const moviesRes = await fetchJson(`${CINEMETA_BASE}/catalog/movie/top/search=${encodedQuery}.json`);
            if (moviesRes && moviesRes.metas) {
                moviesRes.metas.forEach(m => {
                    results.push({
                        title: m.name,
                        posterUrl: m.poster,
                        url: createPayload(m.id, "movie"),
                        type: "movie"
                    });
                });
            }

            // Search Series
            const seriesRes = await fetchJson(`${CINEMETA_BASE}/catalog/series/top/search=${encodedQuery}.json`);
            if (seriesRes && seriesRes.metas) {
                seriesRes.metas.forEach(m => {
                    results.push({
                        title: m.name,
                        posterUrl: m.poster,
                        url: createPayload(m.id, "series"),
                        type: "series"
                    });
                });
            }

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e) });
        }
    }

    // 3. Load Metadata Details & Episodes
    async function load(urlStr, cb) {
        try {
            const info = JSON.parse(urlStr);
            if (!info.id || !info.type) throw new Error("Invalid Content Data");

            // Get full metadata from Cinemeta
            const metaRes = await fetchJson(`${CINEMETA_BASE}/meta/${info.type}/${info.id}.json`);
            if (!metaRes || !metaRes.meta) throw new Error("Metadata not found");

            const m = metaRes.meta;
            const isSeries = info.type === "series";

            const resultData = {
                title: m.name,
                url: urlStr,
                posterUrl: m.poster,
                description: m.description,
                type: info.type,
                year: m.year ? parseInt(m.year.substring(0, 4)) : null,
                tags: m.genres || [],
                episodes: []
            };

            // Map TV Episodes or Single Movie Episode
            if (isSeries && m.videos && m.videos.length > 0) {
                resultData.episodes = m.videos.map(vid => ({
                    name: vid.name || `Episode ${vid.episode}`,
                    url: createPayload(info.id, "series", vid.season, vid.episode),
                    posterUrl: vid.thumbnail || m.poster,
                    season: vid.season,
                    episode: vid.episode
                }));
            } else {
                resultData.episodes = [{
                    name: m.name,
                    url: createPayload(info.id, "movie"),
                    posterUrl: m.poster
                }];
            }

            cb({ success: true, data: resultData });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: String(e) });
        }
    }

    // 4. Load Video Streams from Kartoons API
    async function loadStreams(urlStr, cb) {
        try {
            const info = JSON.parse(urlStr);
            let apiUrl = "";

            // Format correct Stremio Path based on Movie vs Series
            if (info.type === "movie") {
                apiUrl = `${KARTOONS_URL}/stream/movie/${info.id}.json?token=${TOKEN}`;
            } else {
                apiUrl = `${KARTOONS_URL}/stream/series/${info.id}:${info.season}:${info.episode}.json?token=${TOKEN}`;
            }

            const res = await fetchJson(apiUrl);
            const streams = [];

            if (res && res.streams) {
                res.streams.forEach(stream => {
                    if (!stream.url) return;

                    // Extract Quality dynamically
                    const titleText = (stream.title || stream.name || "").toLowerCase();
                    let quality = 0;
                    if (titleText.includes("2160") || titleText.includes("4k")) quality = 2160;
                    else if (titleText.includes("1080")) quality = 1080;
                    else if (titleText.includes("720")) quality = 720;
                    else if (titleText.includes("480")) quality = 480;

                    streams.push({
                        url: stream.url,
                        source: stream.name || "Kartoons API",
                        quality: quality || 720,
                        type: stream.url.includes(".m3u8") ? "hls" : "mp4"
                    });
                });
            }

            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(e) });
        }
    }

    // Export functions to standard App bindings
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();