(function () {
    // --- Constants ---
    const BASE_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const HEADERS = {
        "Accept": "application/json"
    };

    // --- Helpers ---
    async function fetchApi(endpoint) {
        const separator = endpoint.includes("?") ? "&" : "?";
        const url = `${BASE_URL}${endpoint}${separator}token=${TOKEN}`;
        
        try {
            const res = await http_get(url, HEADERS);
            if (!res || !res.body) return {};
            return JSON.parse(res.body);
        } catch (e) {
            console.error("API Fetch Error: ", e.message);
            return {};
        }
    }

    function qualityFromText(text) {
        const value = String(text || "").toLowerCase();
        if (/2160p|4k|uhd/.test(value)) return 2160;
        if (/1440p|2k/.test(value)) return 1440;
        if (/1080p|fhd/.test(value)) return 1080;
        if (/720p|hd/.test(value)) return 720;
        if (/480p|sd/.test(value)) return 480;
        if (/360p/.test(value)) return 360;
        return 0; // Unknown or Default
    }

    // --- Core Functions ---
    async function getHome(cb) {
        try {
            // Fetch manifest to discover available content automatically
            const manifest = await fetchApi("/manifest.json");
            const catalogs = manifest.catalogs || [];
            
            const data = {};
            
            for (const cat of catalogs) {
                const catName = (cat.name || "").toLowerCase();
                const catId = (cat.id || "").toLowerCase();
                
                // REQUIREMENT: Remove "Continue Watching"
                if (catName.includes("continue") || catId.includes("continue")) {
                    continue;
                }
                
                // Fetch catalog items
                const res = await fetchApi(`/catalog/${cat.type}/${cat.id}.json`);
                if (res && res.metas && res.metas.length > 0) {
                    
                    let displayName = cat.name || cat.id;
                    
                    // REQUIREMENT: Map to specific Home Page Categories
                    if (catName.includes("trending")) {
                        displayName = "Trending Now";
                    } else if (catName.includes("popular") && cat.type === "movie") {
                        displayName = "Popular Movies";
                    } else if (catName.includes("popular") && cat.type === "series") {
                        displayName = "Popular Shows";
                    }
                    
                    data[displayName] = res.metas.map(m => new MultimediaItem({
                        title: m.name || "Unknown",
                        url: JSON.stringify({ id: m.id, type: m.type, name: m.name, poster: m.poster }),
                        posterUrl: m.poster || "",
                        type: m.type === "series" ? "series" : "movie",
                        description: m.description || ""
                    }));
                }
            }
            
            if (Object.keys(data).length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No catalogs found." });
            }
            
            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            // Search simultaneously in movies and series (Standard Stremio behavior)
            const [movieRes, seriesRes] = await Promise.all([
                fetchApi(`/catalog/movie/search/search=${encodeURIComponent(query)}.json`),
                fetchApi(`/catalog/series/search/search=${encodeURIComponent(query)}.json`)
            ]);
            
            const metas = [...(movieRes.metas || []), ...(seriesRes.metas || [])];
            
            const items = metas.map(m => new MultimediaItem({
                title: m.name || "Unknown",
                url: JSON.stringify({ id: m.id, type: m.type, name: m.name, poster: m.poster }),
                posterUrl: m.poster || "",
                type: m.type === "series" ? "series" : "movie",
                description: m.description || ""
            }));
            
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const payload = JSON.parse(urlStr);
            const { id, type, name, poster } = payload;
            
            // Try to load metadata from the addon provider
            let meta;
            try {
                const res = await fetchApi(`/meta/${type}/${id}.json`);
                meta = res.meta;
            } catch (e) {
                meta = null; // Failsafe fallback logic handled below
            }
            
            // If the provider doesn't support full /meta endpoint, build a dummy payload with 1 single playable stream
            if (!meta) {
                const isSeries = type === "series";
                const fallbackData = new MultimediaItem({
                    title: name || "Unknown Title",
                    url: urlStr,
                    posterUrl: poster || "",
                    type: isSeries ? "series" : "movie",
                    episodes: [
                        new Episode({
                            name: name || "Play Media",
                            url: JSON.stringify({ id: id, type: type }),
                            posterUrl: poster || ""
                        })
                    ]
                });
                return cb({ success: true, data: fallbackData });
            }
            
            // Parse videos/episodes if it's a series
            let episodes = [];
            if (meta.videos && meta.videos.length > 0) {
                episodes = meta.videos.map(v => new Episode({
                    name: v.name || v.title || `Episode ${v.episode || 1}`,
                    url: JSON.stringify({ id: v.id, type: type }), // v.id contains standard format e.g tt123456:1:2
                    season: v.season || 1,
                    episode: v.episode || 1,
                    posterUrl: v.thumbnail || meta.poster || poster || "",
                    description: v.overview || v.description || ""
                }));
            } else if (type === "movie" || type === "anime") {
                episodes = [new Episode({
                    name: meta.name || name || "Movie Stream",
                    url: JSON.stringify({ id: meta.id, type: type }), 
                    posterUrl: meta.poster || poster || ""
                })];
            }

            const resultData = new MultimediaItem({
                title: meta.name || name,
                url: urlStr,
                posterUrl: meta.poster || poster || "",
                bannerUrl: meta.background || "",
                type: type === "series" ? "series" : "movie",
                description: meta.description || "",
                year: meta.year || (meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined),
                genres: meta.genres || [],
                episodes: episodes
            });

            cb({ success: true, data: resultData });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlStr, cb) {
        try {
            const { id, type } = JSON.parse(urlStr);
            
            // Fetch streams from API mapping to the exact Video ID
            const res = await fetchApi(`/stream/${type}/${id}.json`);
            const streams = res.streams || [];
            
            const streamResults = [];
            
            for (const s of streams) {
                // Ensure there is a URL available (Stremio occasionally sends infoHashes or externalUrls)
                if (!s.url) continue;

                // Identify stream source & quality tags based on strings
                const streamNameStr = String(s.name || s.title || "Kartoons Server");
                const parsedQuality = qualityFromText(s.title) || qualityFromText(s.name) || 0;
                
                streamResults.push(new StreamResult({
                    url: s.url,
                    source: streamNameStr.replace(/\n/g, ' ').trim(),
                    quality: parsedQuality,
                    headers: s.behaviorHints?.headers || {} 
                }));
            }
            
            cb({ success: true, data: streamResults });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // --- Export API ---
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
