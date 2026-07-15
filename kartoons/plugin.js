(function () {
    // --- Configuration & Constants ---
    const BASE_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const HEADERS = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    };

    // --- Helpers ---
    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    function qualityFromText(text) {
        const value = String(text || "").toLowerCase();
        if (/2160|4k|uhd/.test(value)) return 2160;
        if (/1440|2k/.test(value)) return 1440;
        if (/1080|fhd/.test(value)) return 1080;
        if (/720|hd/.test(value)) return 720;
        if (/480|sd/.test(value)) return 480;
        if (/360/.test(value)) return 360;
        return undefined;
    }

    // Stremio URL Builders
    function getCatalogUrl(type, id, searchParams) {
        if (searchParams) {
            return `${BASE_URL}/catalog/${type}/${id}/search=${encodeURIComponent(searchParams)}.json?token=${TOKEN}`;
        }
        return `${BASE_URL}/catalog/${type}/${id}.json?token=${TOKEN}`;
    }

    function getMetaUrl(type, id) {
        return `${BASE_URL}/meta/${type}/${encodeURIComponent(id)}.json?token=${TOKEN}`;
    }

    function getStreamUrl(type, id) {
        return `${BASE_URL}/stream/${type}/${encodeURIComponent(id)}.json?token=${TOKEN}`;
    }

    // Convert Stremio Metadata to Skystream MultimediaItem
    function toMultimediaItem(meta) {
        if (!meta || !meta.id) return null;

        // Bundle essential stremio mapping data into the Skystream URL payload
        const payload = JSON.stringify({
            id: meta.id,
            type: meta.type || "movie"
        });

        return new MultimediaItem({
            title: meta.name || "Unknown",
            url: payload,
            posterUrl: meta.poster,
            bannerUrl: meta.background,
            type: meta.type === "series" ? "series" : "movie",
            year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
            description: meta.description,
            score: meta.imdbRating ? parseFloat(meta.imdbRating) : undefined,
            headers: HEADERS
        });
    }

    // --- Core API Methods ---

    async function getHome(cb) {
        try {
            // First, dynamically fetch the Stremio manifest to get active catalogs
            const manifestRes = await http_get(`${BASE_URL}/manifest.json?token=${TOKEN}`, HEADERS);
            const manifest = safeParse(manifestRes?.body) || {};
            const catalogs = manifest.catalogs || [];

            const homeData = {};

            // Fallback identifiers if precise name matches fail
            let trendingCat = catalogs.find(c => c.name?.toLowerCase().includes("trending") || c.id?.includes("trending")) || catalogs.find(c => c.type === "series" || c.type === "movie");
            let popMovieCat = catalogs.find(c => c.type === "movie" && (c.name?.toLowerCase().includes("popular") || c.id?.includes("popular"))) || catalogs.find(c => c.type === "movie");
            let popSeriesCat = catalogs.find(c => c.type === "series" && (c.name?.toLowerCase().includes("popular") || c.id?.includes("popular"))) || catalogs.find(c => c.type === "series");

            const tasks = [];

            // 1. Trending Now
            if (trendingCat) {
                tasks.push(
                    http_get(getCatalogUrl(trendingCat.type, trendingCat.id), HEADERS).then(res => {
                        const data = safeParse(res?.body);
                        return { name: "Trending Now", items: data?.metas || [] };
                    }).catch(() => null)
                );
            }

            // 2. Popular Movies
            if (popMovieCat) {
                tasks.push(
                    http_get(getCatalogUrl("movie", popMovieCat.id), HEADERS).then(res => {
                        const data = safeParse(res?.body);
                        return { name: "Popular Movies", items: data?.metas || [] };
                    }).catch(() => null)
                );
            }

            // 3. Popular Shows
            if (popSeriesCat) {
                tasks.push(
                    http_get(getCatalogUrl("series", popSeriesCat.id), HEADERS).then(res => {
                        const data = safeParse(res?.body);
                        return { name: "Popular Shows", items: data?.metas || [] };
                    }).catch(() => null)
                );
            }

            const results = await Promise.all(tasks);

            results.forEach(result => {
                if (!result || !result.items || result.items.length === 0) return;
                
                // Safety filter: Explicitly remove any "continue watching" if it got caught
                if (result.name.toLowerCase().includes("continue watching")) return;
                
                homeData[result.name] = result.items.map(toMultimediaItem).filter(Boolean);
            });

            if (Object.keys(homeData).length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No catalogs loaded." });
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const manifestRes = await http_get(`${BASE_URL}/manifest.json?token=${TOKEN}`, HEADERS);
            const manifest = safeParse(manifestRes?.body) || {};
            const catalogs = manifest.catalogs || [];

            // Find catalogs that explicitly support search, otherwise use the first generic ones
            const searchCatalogs = catalogs.filter(c => c.extra && c.extra.some(e => e.name === "search"));
            let movieCat = searchCatalogs.find(c => c.type === "movie") || catalogs.find(c => c.type === "movie");
            let seriesCat = searchCatalogs.find(c => c.type === "series") || catalogs.find(c => c.type === "series");

            const tasks = [];
            if (movieCat) tasks.push(http_get(getCatalogUrl("movie", movieCat.id, query), HEADERS).catch(() => null));
            if (seriesCat) tasks.push(http_get(getCatalogUrl("series", seriesCat.id, query), HEADERS).catch(() => null));

            const results = await Promise.all(tasks);
            const items = [];
            const seen = new Set();

            results.forEach(res => {
                if (!res) return;
                const data = safeParse(res?.body);
                const metas = data?.metas || [];
                
                metas.forEach(m => {
                    const mappedItem = toMultimediaItem(m);
                    if (mappedItem && !seen.has(mappedItem.url)) {
                        seen.add(mappedItem.url);
                        items.push(mappedItem);
                    }
                });
            });

            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const payload = safeParse(urlStr);
            if (!payload || !payload.id || !payload.type) {
                throw new Error("Invalid payload data from URL");
            }

            const metaRes = await http_get(getMetaUrl(payload.type, payload.id), HEADERS);
            const data = safeParse(metaRes?.body);
            const meta = data?.meta;

            if (!meta) {
                return cb({ success: false, message: "Metadata not found on Kartoons." });
            }

            const resultItem = toMultimediaItem(meta);
            
            // Enrich with full meta details
            resultItem.genres = meta.genres;
            resultItem.status = meta.status;
            if (meta.runtime) {
                const rtMatch = meta.runtime.match(/(\d+)/);
                if (rtMatch) resultItem.duration = parseInt(rtMatch[1], 10);
            }

            if (meta.cast && Array.isArray(meta.cast)) {
                // @ts-ignore (Assuming Actor model structure based on user example)
                resultItem.cast = meta.cast.map(c => new Actor({ name: c }));
            }

            // Map Stremio Videos/Episodes to Skystream Episodes
            if (meta.videos && meta.videos.length > 0) {
                resultItem.episodes = meta.videos.map((v, index) => {
                    // Bundle episode stream lookup details
                    const epPayload = JSON.stringify({
                        id: v.id, // Direct ID needed for stream API (e.g. tt12345:1:1)
                        type: payload.type
                    });
                    
                    return new Episode({
                        name: v.name || `Episode ${v.episode || (index + 1)}`,
                        url: epPayload,
                        season: v.season || 1,
                        episode: v.episode || (index + 1),
                        posterUrl: v.thumbnail || meta.poster,
                        description: v.description,
                        headers: HEADERS
                    });
                });
            } else if (payload.type === "movie") {
                // Skystream often requires at least one "Episode" to represent a Movie's playback entry
                resultItem.episodes = [new Episode({
                    name: meta.name || "Movie",
                    url: urlStr, // Reuse the movie's payload string for the stream call
                    posterUrl: meta.poster,
                    headers: HEADERS
                })];
            }

            cb({ success: true, data: resultItem });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlStr, cb) {
        try {
            const payload = safeParse(urlStr);
            if (!payload || !payload.id || !payload.type) {
                throw new Error("Invalid stream payload configuration");
            }

            const streamRes = await http_get(getStreamUrl(payload.type, payload.id), HEADERS);
            const data = safeParse(streamRes?.body);
            const streams = data?.streams || [];

            const streamResults = streams.map(s => {
                let streamUrl = s.url;

                // Handle YouTube trailers mapped as streams
                if (!streamUrl && s.ytId) {
                    streamUrl = `https://www.youtube.com/watch?v=${s.ytId}`;
                }

                if (!streamUrl) return null;

                const streamName = s.name || "Kartoons";
                const streamDesc = s.description || s.title || "";
                const fullSourceName = `${streamName} ${streamDesc}`.trim();
                
                return new StreamResult({
                    url: streamUrl,
                    source: fullSourceName,
                    quality: qualityFromText(fullSourceName),
                    headers: HEADERS
                });
            }).filter(Boolean);

            cb({ success: true, data: streamResults });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // --- Export Module Methods ---
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
