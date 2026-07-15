(function () {
    const BASE_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json"
    };

    // Default fallback catalogs if manifest parsing is unavailable
    const DEFAULT_CATALOGS = [
        { type: "series", id: "kartoons_series", name: "Kartoons Series" },
        { type: "movie", id: "kartoons_movies", name: "Kartoons Movies" }
    ];

    // --- Helper Functions ---
    
    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    async function getJson(url) {
        try {
            const separator = url.indexOf("?") >= 0 ? "&" : "?";
            const targetUrl = `${url}${separator}token=${TOKEN}`;
            const res = await http_get(targetUrl, HEADERS);
            return safeParse(res && res.body ? res.body : null);
        } catch (e) {
            console.error("HTTP GET Error on: " + url, e.message);
            return null;
        }
    }

    function cleanStreamTitle(title) {
        if (!title) return "Default Server";
        return title.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    }

    function detectQuality(title, url) {
        const textToAnalyze = String(title || "") + " " + String(url || "");
        const match = textToAnalyze.match(/(\d{3,4})p/i);
        if (match) return parseInt(match[1], 10);
        if (/4k|2160/i.test(textToAnalyze)) return 2160;
        if (/1080/i.test(textToAnalyze)) return 1080;
        if (/720/i.test(textToAnalyze)) return 720;
        if (/480/i.test(textToAnalyze)) return 480;
        return 720; // safe default fallback
    }

    function mapStremioItem(item, fallbackType) {
        if (!item || !item.id) return null;
        const type = item.type || fallbackType || "series";
        return new MultimediaItem({
            title: item.name || "Unknown Title",
            url: JSON.stringify({ id: item.id, type: type, poster: item.poster || "" }),
            posterUrl: item.poster || "",
            type: type,
            description: item.description || "",
            year: item.releaseInfo ? parseInt(item.releaseInfo, 10) : undefined
        });
    }

    // --- Core Functions ---

    async function getHome(cb) {
        try {
            let catalogsToLoad = DEFAULT_CATALOGS;

            // Fetch manifest to resolve catalogs dynamically
            const manifest = await getJson(`${BASE_URL}/manifest.json`);
            if (manifest && Array.isArray(manifest.catalogs)) {
                catalogsToLoad = manifest.catalogs.map(cat => ({
                    type: cat.type,
                    id: cat.id,
                    name: cat.name || `${cat.type.toUpperCase()} Catalog`
                })).filter(cat => cat.type && cat.id);
            }

            const homeData = {};
            
            // Fetch catalog items in parallel
            await Promise.all(catalogsToLoad.map(async (catalog) => {
                const url = `${BASE_URL}/catalog/${catalog.type}/${catalog.id}.json`;
                const data = await getJson(url);
                const items = (data && data.metas ? data.metas : [])
                    .map(item => mapStremioItem(item, catalog.type))
                    .filter(Boolean);
                
                if (items.length > 0) {
                    homeData[catalog.name] = items;
                }
            }));

            if (Object.keys(homeData).length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No catalogs loaded" });
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            // Searches are routed to default standard catalogs
            const searchPromises = DEFAULT_CATALOGS.map(async (catalog) => {
                const encodedQuery = encodeURIComponent(query);
                const url = `${BASE_URL}/catalog/${catalog.type}/${catalog.id}/search=${encodedQuery}.json`;
                const data = await getJson(url);
                return (data && data.metas ? data.metas : [])
                    .map(item => mapStremioItem(item, catalog.type))
                    .filter(Boolean);
            });

            const results = await Promise.all(searchPromises);
            const flatResults = results.reduce((acc, current) => acc.concat(current), []);
            
            cb({ success: true, data: flatResults });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlPayload, cb) {
        try {
            const input = safeParse(urlPayload);
            if (!input || !input.id || !input.type) {
                throw new Error("Invalid item payload");
            }

            const metaUrl = `${BASE_URL}/meta/${input.type}/${input.id}.json`;
            const response = await getJson(metaUrl);
            const meta = response && response.meta ? response.meta : null;

            if (!meta) {
                throw new Error("Failed to load metadata");
            }

            const title = meta.name || "Unknown";
            const poster = meta.poster || input.poster || "";
            const description = meta.description || "";
            const year = meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined;
            const genres = Array.isArray(meta.genres) ? meta.genres : [];

            let episodes = [];

            if (input.type === "series") {
                if (Array.isArray(meta.videos)) {
                    episodes = meta.videos.map((video) => {
                        return new Episode({
                            name: video.title || `Episode ${video.episode}`,
                            url: JSON.stringify({ episodeId: video.id, type: input.type }),
                            season: video.season || 1,
                            episode: video.episode || 1,
                            description: video.overview || "",
                            posterUrl: video.thumbnail || poster
                        });
                    });
                }
            } else {
                // Movie type uses a single-episode representation to initiate stream resolution
                episodes = [
                    new Episode({
                        name: title,
                        url: JSON.stringify({ episodeId: meta.id, type: input.type }),
                        season: 1,
                        episode: 1,
                        posterUrl: poster
                    })
                ];
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title: title,
                    url: urlPayload,
                    posterUrl: poster,
                    bannerUrl: meta.background || "",
                    description: description,
                    type: input.type,
                    year: year,
                    genres: genres,
                    episodes: episodes
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(episodePayload, cb) {
        try {
            const input = safeParse(episodePayload);
            if (!input || !input.episodeId || !input.type) {
                throw new Error("Invalid episode payload");
            }

            const streamUrl = `${BASE_URL}/stream/${input.type}/${input.episodeId}.json`;
            const data = await getJson(streamUrl);
            const streams = data && Array.isArray(data.streams) ? data.streams : [];

            const resolvedStreams = streams.map((stream) => {
                const finalUrl = stream.url || stream.externalUrl;
                if (!finalUrl) return null;

                const name = cleanStreamTitle(stream.title || stream.name || "Server Link");
                const quality = detectQuality(name, finalUrl);

                return new StreamResult({
                    url: finalUrl,
                    source: `Kartoons - ${name}`,
                    quality: quality,
                    headers: HEADERS
                });
            }).filter(Boolean);

            cb({ success: true, data: resolvedStreams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // --- Module Exports ---
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
