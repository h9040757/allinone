(function () {
    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // manifest is injected at runtime

    // --- Constants ---
    const API_BASE = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const CINEMETA_BASE = "https://v3-cinemeta.strem.io"; // Used only as a fallback
    
    const HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
    };

    // Cache the manifest so we don't request it multiple times
    let cachedManifest = null;

    // --- Helpers ---
    async function fetchJson(url) {
        try {
            const res = await http_get(url, HEADERS);
            if (res.status !== 200 || !res.body) return null;
            return JSON.parse(res.body);
        } catch (e) {
            console.error("Fetch JSON Error: " + e.message);
            return null;
        }
    }

    async function getManifest() {
        if (cachedManifest) return cachedManifest;
        const res = await fetchJson(`${API_BASE}/manifest.json?token=${TOKEN}`);
        if (res) cachedManifest = res;
        return cachedManifest;
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
        return undefined; // System Auto fallback
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

    // 1. Get Home Page (Reads Catalogs directly from Kartoons API)
    async function getHome(cb) {
        try {
            const manifest = await getManifest();
            const homeData = {};

            // If Kartoons provides its own catalogs, fetch them
            if (manifest && manifest.catalogs && manifest.catalogs.length > 0) {
                const fetchPromises = manifest.catalogs.map(async (cat) => {
                    // Skip catalogs that require search terms
                    if (cat.extra && cat.extra.some(e => e.name === "search" && e.isRequired)) return;

                    const catUrl = `${API_BASE}/catalog/${cat.type}/${cat.id}.json?token=${TOKEN}`;
                    const res = await fetchJson(catUrl);
                    
                    if (res && res.metas && res.metas.length > 0) {
                        const sectionName = cat.name || `Kartoons ${cat.type.charAt(0).toUpperCase() + cat.type.slice(1)}`;
                        homeData[sectionName] = res.metas.map(m => toMultimediaItem(m, cat.type)).filter(Boolean);
                    }
                });

                await Promise.allSettled(fetchPromises);
            }

            // Fallback: If Kartoons only provides streams (no catalogs), load standard Stremio lists
            if (Object.keys(homeData).length === 0) {
                const moviesRes = await fetchJson(`${CINEMETA_BASE}/catalog/movie/top.json`);
                if (moviesRes && moviesRes.metas) {
                    homeData["Trending Movies"] = moviesRes.metas.map(m => toMultimediaItem(m, "movie"));
                }
                const seriesRes = await fetchJson(`${CINEMETA_BASE}/catalog/series/top.json`);
                if (seriesRes && seriesRes.metas) {
                    homeData["Trending Series"] = seriesRes.metas.map(m => toMultimediaItem(m, "series"));
                }
            }

            if (Object.keys(homeData).length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No catalogs found" });
            }
            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // 2. Search Function (Searches Kartoons database natively)
    async function search(query, cb) {
        try {
            const encodedQuery = encodeURIComponent(query);
            const manifest = await getManifest();
            const results = [];

            let usedKartoonsSearch = false;

            if (manifest && manifest.catalogs) {
                for (const cat of manifest.catalogs) {
                    // Check if this catalog supports search
                    const supportsSearch = cat.extra && cat.extra.some(e => e.name === "search");
                    if (supportsSearch) {
                        usedKartoonsSearch = true;
                        const searchUrl = `${API_BASE}/catalog/${cat.type}/${cat.id}/search=${encodedQuery}.json?token=${TOKEN}`;
                        const res = await fetchJson(searchUrl);
                        if (res && res.metas) {
                            res.metas.forEach(m => {
                                const item = toMultimediaItem(m, cat.type);
                                if (item) results.push(item);
                            });
                        }
                    }
                }
            }

            // Fallback: If Kartoons has no search function, use Cinemeta search
            if (!usedKartoonsSearch || results.length === 0) {
                const moviesRes = await fetchJson(`${CINEMETA_BASE}/catalog/movie/top/search=${encodedQuery}.json`);
                if (moviesRes && moviesRes.metas) results.push(...moviesRes.metas.map(m => toMultimediaItem(m, "movie")));

                const seriesRes = await fetchJson(`${CINEMETA_BASE}/catalog/series/top/search=${encodedQuery}.json`);
                if (seriesRes && seriesRes.metas) results.push(...seriesRes.metas.map(m => toMultimediaItem(m, "series")));
            }

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    // 3. Load Details & Episodes (Fetches Meta from Kartoons API)
    async function load(urlStr, cb) {
        try {
            const info = JSON.parse(urlStr);
            if (!info.id || !info.type) throw new Error("Invalid URL Payload");

            // 1. Try to get metadata from Kartoons first
            let metaUrl = `${API_BASE}/meta/${info.type}/${info.id}.json?token=${TOKEN}`;
            let metaRes = await fetchJson(metaUrl);

            // 2. Fallback to Cinemeta if Kartoons doesn't host metadata for this ID
            if (!metaRes || !metaRes.meta) {
                metaUrl = `${CINEMETA_BASE}/meta/${info.type}/${info.id}.json`;
                metaRes = await fetchJson(metaUrl);
            }

            if (!metaRes || !metaRes.meta) throw new Error("Metadata not found in Kartoons or Cinemeta");

            const m = metaRes.meta;
            const isSeries = info.type === "series";
            const episodes = [];

            if (isSeries && m.videos && m.videos.length > 0) {
                // TV Show Episodes
                m.videos.forEach(vid => {
                    episodes.push(new Episode({
                        name: vid.name || vid.title || `Episode ${vid.episode}`,
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
                cast: m.cast ? m.cast.map(c => new Actor({ name: c, role: "Actor" })) : [],
                episodes: episodes
            });

            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // 4. Load Video Streams (From Kartoons.me API)
    async function loadStreams(urlStr, cb) {
        try {
            const info = JSON.parse(urlStr);
            let apiUrl = "";

            if (info.type === "movie") {
                apiUrl = `${API_BASE}/stream/movie/${info.id}.json?token=${TOKEN}`;
            } else {
                apiUrl = `${API_BASE}/stream/series/${info.id}:${info.season}:${info.episode}.json?token=${TOKEN}`;
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
                
                streamResults.push(new StreamResult({
                    url: stream.url,
                    source: stream.name || "Kartoons",
                    quality: extractedQuality,
                    headers: HEADERS
                }));
            });

            // Remove any potential duplicates
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

    // Export functions to global scope
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();