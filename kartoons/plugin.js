(function () {
    const BASE_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };

    // Helper to safely parse strings
    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    // Determine video stream resolution
    function qualityFromText(value) {
        const raw = String(value || "").toLowerCase();
        if (/2160|4k/i.test(raw)) return 2160;
        if (/1440|2k/i.test(raw)) return 1440;
        if (/1080|fhd/i.test(raw)) return 1080;
        if (/720|hd/i.test(raw)) return 720;
        if (/480|sd/i.test(raw)) return 480;
        if (/360/i.test(raw)) return 360;
        return 1080; 
    }

    // Fetches the remote addon manifest configurations
    async function fetchManifest() {
        try {
            const url = `${BASE_URL}/manifest.json?token=${TOKEN}`;
            const res = await http_get(url, HEADERS);
            return safeParse(res.body) || {};
        } catch (e) {
            // Default fallback if dynamic lookup is offline
            return {
                catalogs: [
                    { id: "kartoons_trending", type: "movie", name: "Trending Now" },
                    { id: "kartoons_movies", type: "movie", name: "Popular Movies" },
                    { id: "kartoons_series", type: "series", name: "Popular Shows" }
                ]
            };
        }
    }

    // Converts Stremio metadata structure to SkyStream model
    function toMultimediaItem(meta, fallbackType) {
        if (!meta) return null;
        const type = meta.type || fallbackType || "movie";
        return new MultimediaItem({
            title: meta.name || "Unknown Title",
            url: JSON.stringify({ id: meta.id, type: type, poster: meta.poster }),
            posterUrl: meta.poster,
            bannerUrl: meta.background,
            type: type === "series" ? "series" : "movie",
            year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
            description: meta.description || ""
        });
    }

    // Dynamic home section generation from Stremio Catalog entries
    async function getHome(cb) {
        try {
            const manifest = await fetchManifest();
            
            // Filters out specified/recent/continue watching lists as requested
            const catalogs = (manifest.catalogs || []).filter(cat => {
                const catId = String(cat.id || "").toLowerCase();
                const catName = String(cat.name || "").toLowerCase();
                return !catId.includes("continue") && 
                       !catName.includes("continue") && 
                       !catId.includes("recent") && 
                       !catName.includes("recent");
            });

            const homeData = {};

            const results = await Promise.allSettled(catalogs.map(async (catalog) => {
                const catUrl = `${BASE_URL}/catalog/${catalog.type}/${catalog.id}.json?token=${TOKEN}`;
                const res = await http_get(catUrl, HEADERS);
                const data = safeParse(res.body) || {};
                const items = (data.metas || []).map(meta => toMultimediaItem(meta, catalog.type));
                
                // Map API catalog names directly into target home headers
                let mappedName = catalog.name || "";
                if (/trending/i.test(mappedName)) mappedName = "Trending Now";
                else if (/movie/i.test(mappedName)) mappedName = "Popular Movies";
                else if (/series|show/i.test(mappedName)) mappedName = "Popular Shows";
                
                return {
                    name: mappedName || "Trending Now",
                    items: items.filter(Boolean)
                };
            }));

            results.forEach(res => {
                if (res.status === "fulfilled" && res.value && res.value.items.length > 0) {
                    homeData[res.value.name] = res.value.items;
                }
            });

            if (!Object.keys(homeData).length) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No catalog items found." });
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    // Handles query processing by targeting search-supported catalogs
    async function search(query, cb) {
        try {
            const manifest = await fetchManifest();
            const searchCatalogs = (manifest.catalogs || []).filter(cat => {
                if (cat.extra) {
                    return cat.extra.some(ex => ex.name === "search");
                }
                return true; 
            });

            const results = await Promise.allSettled(searchCatalogs.map(async (catalog) => {
                const searchUrl = `${BASE_URL}/catalog/${catalog.type}/${catalog.id}/search=${encodeURIComponent(query)}.json?token=${TOKEN}`;
                const res = await http_get(searchUrl, HEADERS);
                const data = safeParse(res.body) || {};
                return (data.metas || []).map(meta => toMultimediaItem(meta, catalog.type));
            }));

            const items = [];
            results.forEach(res => {
                if (res.status === "fulfilled" && res.value) {
                    items.push(...res.value);
                }
            });

            // Deduplicate items
            const seen = new Set();
            const uniqueItems = items.filter(item => {
                if (!item) return false;
                if (seen.has(item.url)) return false;
                seen.add(item.url);
                return true;
            });

            cb({ success: true, data: uniqueItems });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    // Resolves metadata details and compiles episode lists
    async function load(urlStr, cb) {
        try {
            const media = safeParse(urlStr);
            if (!media || !media.id) throw new Error("Invalid structure data");

            const metaUrl = `${BASE_URL}/meta/${media.type}/${media.id}.json?token=${TOKEN}`;
            const res = await http_get(metaUrl, HEADERS);
            const data = safeParse(res.body) || {};
            const meta = data.meta;

            if (!meta) {
                throw new Error("Metadata details unavailable");
            }

            const title = meta.name || "Unknown Title";
            const poster = meta.poster || media.poster || "";
            const banner = meta.background || "";
            const description = meta.description || "";
            const type = meta.type || media.type;
            const year = meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined;
            const genres = meta.genres || [];

            if (type === "series" && meta.videos && meta.videos.length > 0) {
                const episodes = meta.videos.map(video => {
                    const seasonNum = video.season || 1;
                    const epNum = video.episode || video.number || 1;
                    return new Episode({
                        name: video.title || `Episode ${epNum}`,
                        url: JSON.stringify({ 
                            id: meta.id, 
                            type: "series", 
                            streamId: video.id, 
                            poster: video.thumbnail || poster 
                        }),
                        posterUrl: video.thumbnail || poster,
                        season: seasonNum,
                        episode: epNum,
                        description: video.overview || ""
                    });
                });

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title,
                        url: urlStr,
                        posterUrl: poster,
                        bannerUrl: banner,
                        description,
                        type: "series",
                        year,
                        genres,
                        episodes
                    })
                });
            } else {
                // Movie
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title,
                        url: urlStr,
                        posterUrl: poster,
                        bannerUrl: banner,
                        description,
                        type: "movie",
                        year,
                        genres,
                        episodes: [new Episode({
                            name: title,
                            url: JSON.stringify({ 
                                id: meta.id, 
                                type: "movie", 
                                streamId: meta.id, 
                                poster: poster 
                            }),
                            posterUrl: poster
                        })]
                    })
                });
            }
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    // Queries the streams for the selected movie or episode
    async function loadStreams(urlStr, cb) {
        try {
            const media = safeParse(urlStr);
            if (!media || !media.streamId) throw new Error("Invalid stream configuration payload");

            const streamUrl = `${BASE_URL}/stream/${media.type}/${encodeURIComponent(media.streamId)}.json?token=${TOKEN}`;
            const res = await http_get(streamUrl, HEADERS);
            const data = safeParse(res.body) || {};
            const streams = data.streams || [];

            const results = [];
            for (const stream of streams) {
                let fileUrl = stream.url || stream.externalUrl;
                if (!fileUrl) continue;

                if (fileUrl.startsWith("//")) {
                    fileUrl = "https:" + fileUrl;
                }

                // Restrict results strictly to play-supported HTTP protocols
                if (!fileUrl.startsWith("http://") && !fileUrl.startsWith("https://")) {
                    continue;
                }

                const serverName = stream.name || "Kartoons Server";
                const details = stream.title || stream.description || "";
                const quality = qualityFromText(details) || qualityFromText(fileUrl);

                results.push(new StreamResult({
                    url: fileUrl,
                    source: serverName + (details ? ` - ${details}` : ""),
                    quality: quality,
                    headers: HEADERS
                }));
            }

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // Export interface functions to global context
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
