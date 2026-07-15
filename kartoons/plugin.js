(function () {
    // --- Configuration ---
    const BASE_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const EXCLUDED_KEYWORDS = ["continue", "watching", "history", "library", "recent"];

    let cachedManifest = null;

    // --- Helpers ---
    function buildUrl(path) {
        return `${BASE_URL}${path}?token=${TOKEN}`;
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

    async function getManifest() {
        if (cachedManifest) return cachedManifest;
        try {
            const res = await http_get(buildUrl("/manifest.json"));
            const data = safeParse(res.body);
            if (data && data.catalogs) {
                cachedManifest = data;
                return cachedManifest;
            }
        } catch (e) {
            console.error("Failed to fetch manifest:", e);
        }
        return { catalogs: [] };
    }

    function shouldIncludeCatalog(cat) {
        const id = String(cat.id || "").toLowerCase();
        const name = String(cat.name || "").toLowerCase();
        for (const word of EXCLUDED_KEYWORDS) {
            if (id.includes(word) || name.includes(word)) {
                return false;
            }
        }
        return true;
    }

    function formatCatalogName(name) {
        const lower = name.toLowerCase().trim();
        if (lower === "trending" || lower === "trending now" || lower === "trending_now") return "Trending Now";
        if (lower === "popular movies" || lower === "popular_movies") return "Popular Movies";
        if (lower === "popular shows" || lower === "popular_shows" || lower === "popular tv" || lower === "popular_tv") return "Popular Shows";
        return name;
    }

    function parseQuality(nameStr, titleStr) {
        const text = String(nameStr + " " + titleStr).toLowerCase();
        if (text.includes("2160") || text.includes("4k")) return 2160;
        if (text.includes("1080") || text.includes("fhd")) return 1080;
        if (text.includes("720") || text.includes("hd")) return 720;
        if (text.includes("480") || text.includes("sd")) return 480;
        return undefined;
    }

    // --- Core Methods ---

    async function getHome(cb) {
        try {
            const manifest = await getManifest();
            // Filter out continue watching / history sections
            const catalogs = (manifest.catalogs || []).filter(shouldIncludeCatalog);
            const homeData = {};

            // Fetch up to 8 valid home catalogs in parallel
            const targetCatalogs = catalogs.slice(0, 8);

            const promises = targetCatalogs.map(async (cat) => {
                const catName = formatCatalogName(cat.name || cat.type);
                const path = `/catalog/${cat.type}/${cat.id}.json`;
                try {
                    const res = await http_get(buildUrl(path));
                    const data = safeParse(res.body);
                    const metas = data && data.metas ? data.metas : [];

                    if (metas.length > 0) {
                        const items = metas.map((m) => new MultimediaItem({
                            title: m.name,
                            url: JSON.stringify({ type: m.type || cat.type, id: m.id }),
                            posterUrl: m.poster,
                            type: (m.type === "movie") ? "movie" : "series",
                            description: m.description,
                            year: m.releaseInfo ? parseInt(m.releaseInfo) : undefined
                        }));
                        return { name: catName, items };
                    }
                } catch (err) {
                    console.error(`Error loading catalog ${catName}:`, err);
                }
                return null;
            });

            const results = await Promise.all(promises);
            for (const res of results) {
                if (res && res.items && res.items.length > 0) {
                    homeData[res.name] = res.items;
                }
            }

            if (Object.keys(homeData).length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No data found on home." });
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const manifest = await getManifest();
            const catalogs = (manifest.catalogs || []).filter(shouldIncludeCatalog);
            
            let searchCatalogs = catalogs.filter(c => c.extraSupported && c.extraSupported.includes("search"));
            
            if (searchCatalogs.length === 0 && catalogs.length > 0) {
                searchCatalogs = catalogs.slice(0, 2); 
            }

            let allResults = [];

            for (let i = 0; i < searchCatalogs.length; i++) {
                const cat = searchCatalogs[i];
                const path = `/catalog/${cat.type}/${cat.id}/search=${encodeURIComponent(query)}.json`;
                
                try {
                    const res = await http_get(buildUrl(path));
                    const data = safeParse(res.body);
                    const metas = data && data.metas ? data.metas : [];

                    const mapped = metas.map((m) => new MultimediaItem({
                        title: m.name,
                        url: JSON.stringify({ type: m.type || cat.type, id: m.id }),
                        posterUrl: m.poster,
                        type: (m.type === "movie") ? "movie" : "series",
                        description: m.description,
                        year: m.releaseInfo ? parseInt(m.releaseInfo) : undefined
                    }));
                    allResults = allResults.concat(mapped);
                } catch (err) {
                    console.error("Search failed for catalog:", err);
                }
            }

            const uniqueResults = [];
            const seen = new Set();
            for (const item of allResults) {
                if (!seen.has(item.url)) {
                    seen.add(item.url);
                    uniqueResults.push(item);
                }
            }

            cb({ success: true, data: uniqueResults });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const payload = safeParse(urlStr);
            if (!payload || !payload.id || !payload.type) {
                throw new Error("Invalid request payload.");
            }

            const path = `/meta/${payload.type}/${payload.id}.json`;
            const res = await http_get(buildUrl(path));
            const data = safeParse(res.body);
            const meta = data && data.meta ? data.meta : null;

            if (!meta) throw new Error("Metadata not found.");

            let episodes = [];
            
            if (meta.videos && meta.videos.length > 0) {
                episodes = meta.videos.map((v) => new Episode({
                    name: v.title || v.name || `Episode ${v.episode}`,
                    url: JSON.stringify({ type: payload.type, id: v.id }),
                    season: v.season || 1,
                    episode: v.episode,
                    posterUrl: v.thumbnail || meta.poster,
                    description: v.overview || v.description
                }));
            } else {
                episodes = [new Episode({
                    name: meta.name || "Movie",
                    url: JSON.stringify({ type: payload.type, id: payload.id }),
                    season: 1,
                    episode: 1,
                    posterUrl: meta.poster,
                    description: meta.description
                })];
            }

            const item = new MultimediaItem({
                title: meta.name,
                url: urlStr,
                posterUrl: meta.poster,
                bannerUrl: meta.background,
                type: (meta.type === "movie") ? "movie" : "series",
                description: meta.description,
                year: meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined,
                genres: meta.genres,
                score: meta.imdbRating ? parseFloat(meta.imdbRating) : undefined,
                episodes: episodes
            });

            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlStr, cb) {
        try {
            const payload = safeParse(urlStr);
            if (!payload || !payload.id || !payload.type) {
                throw new Error("Invalid request payload for streams.");
            }

            const path = `/stream/${payload.type}/${payload.id}.json`;
            const res = await http_get(buildUrl(path));
            const data = safeParse(res.body);
            const streams = data && data.streams ? data.streams : [];

            const streamResults = [];

            for (const s of streams) {
                let mediaUrl = s.url;
                
                if (!mediaUrl && s.ytId) {
                    mediaUrl = `https://www.youtube.com/watch?v=${s.ytId}`;
                }

                if (!mediaUrl) continue;

                let subtitles = [];
                if (s.subtitles && Array.isArray(s.subtitles)) {
                    subtitles = s.subtitles.map(sub => ({
                        name: sub.lang || sub.id || "Subtitle",
                        url: sub.url
                    }));
                }

                const stream = new StreamResult({
                    url: mediaUrl,
                    source: s.name || s.title || "Kartoons",
                    quality: parseQuality(s.name, s.title),
                    subtitles: subtitles.length > 0 ? subtitles : undefined,
                    headers: (s.behaviorHints && s.behaviorHints.headers) ? s.behaviorHints.headers : undefined
                });

                streamResults.push(stream);
            }

            cb({ success: true, data: streamResults });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // --- Exports ---
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();