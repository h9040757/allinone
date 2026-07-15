(function () {
    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    const BASE_URL = (globalThis.manifest && globalThis.manifest.baseUrl) || "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json"
    };

    // --- Helper Functions ---

    function buildUrl(path) {
        const separator = path.includes("?") ? "&" : "?";
        return `${BASE_URL}/${path}${separator}token=${TOKEN}`;
    }

    async function jsonRequest(url, fallbackValue = null) {
        try {
            const response = await http_get(url, HEADERS);
            if (response && response.body) {
                return JSON.parse(response.body);
            }
        } catch (e) {
            console.error(`Request to ${url} failed:`, e.message || String(e));
        }
        return fallbackValue;
    }

    function qualityFromText(value) {
        const raw = String(value || "").toLowerCase();
        if (/2160|4k|uhd/i.test(raw)) return 2160;
        if (/1440|2k/i.test(raw)) return 1440;
        if (/1080|fhd/i.test(raw)) return 1080;
        if (/720|hd/i.test(raw)) return 720;
        if (/480|sd/i.test(raw)) return 480;
        if (/360p/i.test(raw)) return 360;
        return 0;
    }

    function toMultimediaItem(meta) {
        if (!meta) return null;
        const type = meta.type === "movie" ? "movie" : "series";
        return new MultimediaItem({
            title: meta.name || "Untitled",
            url: JSON.stringify({ id: meta.id, type: meta.type }),
            posterUrl: meta.poster || "",
            bannerUrl: meta.background || "",
            type: type,
            description: meta.description || "",
            year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
            genres: meta.genres || []
        });
    }

    // --- Core Functions ---

    /**
     * Dynamically loads the Home page categories based on the addon's manifest catalogs.
     * Filters out continue watching catalogs as requested.
     */
    async function getHome(cb) {
        try {
            const manifest = await jsonRequest(buildUrl("manifest.json"));
            if (!manifest || !manifest.catalogs) {
                return cb({ success: false, errorCode: "MANIFEST_ERROR", message: "Failed to read manifest" });
            }

            // Exclude catalogs matching "continue watching"
            const activeCatalogs = manifest.catalogs.filter(cat => {
                const name = String(cat.name || "").toLowerCase();
                const id = String(cat.id || "").toLowerCase();
                return !name.includes("continue") && !id.includes("continue");
            });

            const homeData = {};
            const promises = activeCatalogs.map(async (cat) => {
                const catalogPath = `catalog/${cat.type}/${cat.id}.json`;
                const catalogData = await jsonRequest(buildUrl(catalogPath));
                const items = (catalogData && catalogData.metas || [])
                    .map(toMultimediaItem)
                    .filter(Boolean);
                
                if (items.length > 0) {
                    homeData[cat.name] = items;
                }
            });

            await Promise.all(promises);

            if (Object.keys(homeData).length === 0) {
                return cb({ success: false, errorCode: "EMPTY_HOME", message: "No catalogs loaded" });
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    /**
     * Performs a query using search-supporting catalogs from the manifest.
     */
    async function search(query, cb) {
        try {
            const manifest = await jsonRequest(buildUrl("manifest.json"));
            if (!manifest || !manifest.catalogs) {
                return cb({ success: false, errorCode: "MANIFEST_ERROR", message: "Could not read search catalogs" });
            }

            const searchPromises = [];
            const processedKeys = new Set();

            for (const cat of manifest.catalogs) {
                const hasSearch = cat.extra && cat.extra.some(extra => extra.name === "search");
                if (hasSearch) {
                    const searchPath = `catalog/${cat.type}/${cat.id}/search=${encodeURIComponent(query)}.json`;
                    searchPromises.push((async () => {
                        const data = await jsonRequest(buildUrl(searchPath));
                        return data && data.metas ? data.metas : [];
                    })());
                }
            }

            const rawResults = await Promise.all(searchPromises);
            const finalItems = [];

            for (const list of rawResults) {
                for (const item of list) {
                    if (processedKeys.has(item.id)) continue;
                    processedKeys.add(item.id);
                    const mapped = toMultimediaItem(item);
                    if (mapped) finalItems.push(mapped);
                }
            }

            cb({ success: true, data: finalItems });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    /**
     * Loads structural metadata for a specific title.
     */
    async function load(payloadString, cb) {
        try {
            const payload = JSON.parse(payloadString);
            const metaPath = `meta/${payload.type}/${payload.id}.json`;
            const metaResponse = await jsonRequest(buildUrl(metaPath));
            
            if (!metaResponse || !metaResponse.meta) {
                return cb({ success: false, errorCode: "META_ERROR", message: "Details not available" });
            }

            const meta = metaResponse.meta;
            const isMovie = payload.type === "movie";

            let episodes = [];
            if (isMovie) {
                episodes = [
                    new Episode({
                        name: meta.name || "Play Movie",
                        url: JSON.stringify({ type: "movie", id: meta.id, videoId: meta.id }),
                        season: 1,
                        episode: 1
                    })
                ];
            } else if (meta.videos && meta.videos.length > 0) {
                episodes = meta.videos.map((video, idx) => {
                    return new Episode({
                        name: video.title || `Episode ${video.episode || video.number || (idx + 1)}`,
                        url: JSON.stringify({ type: "series", id: meta.id, videoId: video.id }),
                        season: video.season || 1,
                        episode: video.episode || video.number || (idx + 1),
                        description: video.overview || "",
                        posterUrl: video.thumbnail || meta.poster || ""
                    });
                });
            }

            const item = new MultimediaItem({
                title: meta.name || "Untitled",
                url: payloadString,
                posterUrl: meta.poster || "",
                bannerUrl: meta.background || "",
                type: isMovie ? "movie" : "series",
                description: meta.description || "",
                year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
                genres: meta.genres || [],
                episodes: episodes
            });

            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    /**
     * Resolves playable streams for an individual episode or movie.
     */
    async function loadStreams(episodePayloadString, cb) {
        try {
            const payload = JSON.parse(episodePayloadString);
            const streamPath = `stream/${payload.type}/${encodeURIComponent(payload.videoId)}.json`;
            const response = await jsonRequest(buildUrl(streamPath));

            if (!response || !response.streams || response.streams.length === 0) {
                return cb({ success: false, errorCode: "NO_STREAMS", message: "No streams found" });
            }

            const streams = response.streams.map(stream => {
                const streamUrl = stream.url || stream.externalUrl;
                if (!streamUrl) return null;

                const headers = (stream.behaviorHints && stream.behaviorHints.requestHeaders) || {};
                if (!headers["User-Agent"]) {
                    headers["User-Agent"] = UA;
                }

                return new StreamResult({
                    url: streamUrl,
                    source: stream.title || stream.name || "Kartoons",
                    quality: qualityFromText(stream.title || stream.name || streamUrl),
                    headers: headers
                });
            }).filter(Boolean);

            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // Exporting the API methods to global runtime scope
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
