(function () {
    // --- Configuration & Constants ---
    const MANIFEST_URL = "https://api.kartoons.me/api/stremio/manifest.json?token=1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const API_BASE_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json"
    };

    // --- Utilities & Serialization ---
    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    function payload(id, type, poster) {
        return JSON.stringify({ id: String(id), type: String(type), poster: poster || "" });
    }

    function inputPayload(value) {
        const data = safeParse(value);
        if (data && data.id) return data;
        return { id: String(value || ""), type: "series", poster: "" };
    }

    async function fetchJson(url) {
        const res = await http_get(url, HEADERS);
        if (res && res.body) {
            return safeParse(res.body);
        }
        throw new Error("Failed to load response from API route: " + url);
    }

    function mapStremioMetaToMedia(meta) {
        if (!meta || !meta.id) return null;
        
        let type = "series";
        if (meta.type === "movie") type = "movie";
        else if (meta.type === "anime") type = "anime";

        return new MultimediaItem({
            title: meta.name || "Untitled Content",
            url: payload(meta.id, meta.type || "series", meta.poster),
            posterUrl: meta.poster || "",
            bannerUrl: meta.background || "",
            description: meta.description || "",
            type: type,
            year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
            genres: meta.genres || []
        });
    }

    async function mapLimit(items, limit, worker) {
        const list = items || [];
        const output = new Array(list.length);
        let cursor = 0;
        async function run() {
            while (cursor < list.length) {
                const index = cursor++;
                try {
                    output[index] = await worker(list[index], index);
                } catch (e) {
                    output[index] = null;
                }
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(limit, list.length); i++) workers.push(run());
        await Promise.all(workers);
        return output;
    }

    // --- Core SkyStream Hooks ---

    async function getHome(cb) {
        try {
            // Step 1: Query root Stremio Manifest to dynamically collect catalog layouts (Movies, Series, Trending, etc.)
            const manifest = await fetchJson(MANIFEST_URL);
            const catalogs = manifest.catalogs || [];

            if (!catalogs.length) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No operational catalogs found inside manifest definitions." });
            }

            // Step 2: Extract and fetch content across all discovered catalogs asynchronously
            const homeSections = await mapLimit(catalogs, 6, async (cat) => {
                const catalogId = cat.id;
                const type = cat.type;
                const sectionName = cat.name || `${type} Section`;

                // Build the correct Stremio URL mapping parameters for categories like Trending Now
                const catalogUrl = `${API_BASE_URL}/catalog/${type}/${catalogId}.json?token=${TOKEN}`;
                try {
                    const catalogData = await fetchJson(catalogUrl);
                    const rawMetas = catalogData.metas || [];
                    const mappedItems = rawMetas.map(mapStremioMetaToMedia).filter(Boolean);
                    
                    return { name: sectionName, items: mappedItems };
                } catch (err) {
                    console.error("Error building catalog row for: " + sectionName, err);
                    return null;
                }
            });

            const finalHomeData = {};
            for (const section of homeSections) {
                if (section && section.items && section.items.length) {
                    finalHomeData[section.name] = section.items;
                }
            }

            cb({ success: true, data: finalHomeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const manifest = await fetchJson(MANIFEST_URL);
            const catalogs = manifest.catalogs || [];
            
            if (!catalogs.length) {
                return cb({ success: true, data: [] });
            }

            // Target search against primary structural collections using strict escape structures
            const primaryCatalog = catalogs[0];
            const searchUrl = `${API_BASE_URL}/catalog/${primaryCatalog.type}/${primaryCatalog.id}/search=${encodeURIComponent(query)}.json?token=${TOKEN}`;
            
            const searchData = await fetchJson(searchUrl);
            const rawMetas = searchData.metas || [];
            const items = rawMetas.map(mapStremioMetaToMedia).filter(Boolean);

            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const metaInput = inputPayload(urlStr);
            const detailUrl = `${API_BASE_URL}/meta/${metaInput.type}/${metaInput.id}.json?token=${TOKEN}`;
            
            const detailData = await fetchJson(detailUrl);
            const meta = detailData.meta;
            if (!meta) throw new Error("Meta asset parsing yielded null pointer data object response.");

            let itemType = "series";
            if (meta.type === "movie") itemType = "movie";
            else if (meta.type === "anime") itemType = "anime";

            const resultItem = new MultimediaItem({
                title: meta.name || "Untitled",
                url: payload(meta.id, meta.type, meta.poster),
                posterUrl: meta.poster || metaInput.poster || "",
                bannerUrl: meta.background || "",
                description: meta.description || "",
                type: itemType,
                year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
                genres: meta.genres || [],
                episodes: []
            });

            if (meta.type === "movie") {
                resultItem.episodes = [new Episode({
                    name: meta.name || "Play Video",
                    url: JSON.stringify({ id: meta.id, type: "movie", videoId: meta.id }),
                    season: 1,
                    episode: 1
                })];
            } else if (meta.videos && meta.videos.length > 0) {
                resultItem.episodes = meta.videos.map((vid) => {
                    return new Episode({
                        name: vid.title || `Episode ${vid.episode || 1}`,
                        url: JSON.stringify({ 
                            id: meta.id, 
                            type: meta.type, 
                            videoId: vid.id,
                            season: vid.season || 1,
                            episode: vid.episode || 1
                        }),
                        season: vid.season || 1,
                        episode: vid.episode || 1,
                        description: vid.description || "",
                        posterUrl: vid.thumbnail || meta.poster || ""
                    });
                });
            } else {
                resultItem.episodes = [new Episode({
                    name: meta.name || "Default Episode Stream",
                    url: JSON.stringify({ id: meta.id, type: meta.type, videoId: meta.id }),
                    season: 1,
                    episode: 1
                })];
            }

            cb({ success: true, data: resultItem });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const streamInput = safeParse(urlInfo);
            if (!streamInput || !streamInput.videoId) {
                throw new Error("Invalid structure provided to stream retrieval loop pipeline block.");
            }

            const streamFetchUrl = `${API_BASE_URL}/stream/${streamInput.type}/${encodeURIComponent(streamInput.videoId)}.json?token=${TOKEN}`;
            const streamResponse = await fetchJson(streamFetchUrl);
            const rawStreams = streamResponse.streams || [];

            const streamResults = rawStreams.map((st) => {
                let directUrl = st.url;
                if (!directUrl && st.infoHash) {
                    directUrl = `magnet:?xt=urn:btih:${st.infoHash}`;
                }

                if (!directUrl) return null;

                return new StreamResult({
                    url: directUrl,
                    source: st.title || st.name || "Kartoons Engine Stream",
                    quality: st.title ? (parseInt(st.title.match(/\b(720|1080|2160|480)p\b/)?.[1], 10) || 720) : 720,
                    headers: HEADERS
                });
            }).filter(Boolean);

            cb({ success: true, data: streamResults });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // Register hooks globally to map into the application runtime layout engine
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
