(function () {
    const API_BASE = "https://api.kartoons.me/api/stremio";
    const TOKEN_QUERY = "token=1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json"
    };

    // --- Helpers ---

    function text(value) {
        return (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
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

    async function getJson(url) {
        const res = await http_get(url, HEADERS);
        return safeParse(res && res.body ? res.body : "{}") || {};
    }

    function toMultimediaItem(meta) {
        if (!meta) return null;
        const type = meta.type === "movie" ? "movie" : "series";
        return new MultimediaItem({
            title: text(meta.name),
            url: JSON.stringify({ id: meta.id, type: type }),
            posterUrl: meta.poster,
            type: type,
            description: meta.description ? text(meta.description) : undefined,
            year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined
        });
    }

    // --- SkyStream Implementation ---

    async function getHome(cb) {
        try {
            // Retrieve dynamic catalogs configured in the Stremio manifest
            const manifestUrl = `${API_BASE}/manifest.json?${TOKEN_QUERY}`;
            const manifest = await getJson(manifestUrl);
            const catalogs = manifest.catalogs || [];

            const homeData = {};
            
            // Map catalog items in parallel
            await Promise.all(catalogs.map(async (catalog) => {
                const catalogUrl = `${API_BASE}/catalog/${catalog.type}/${catalog.id}.json?${TOKEN_QUERY}`;
                const response = await getJson(catalogUrl);
                const items = (response.metas || []).map(toMultimediaItem).filter(Boolean);
                
                if (items.length > 0) {
                    homeData[catalog.name] = items;
                }
            }));

            // Handle edge case where no data is loaded
            if (Object.keys(homeData).length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No catalogs populated" });
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const manifestUrl = `${API_BASE}/manifest.json?${TOKEN_QUERY}`;
            const manifest = await getJson(manifestUrl);
            const catalogs = manifest.catalogs || [];
            
            // Fetch first series and movie catalog search targets
            const movieCatalog = catalogs.find(c => c.type === "movie") || { id: "kartoons-movies", type: "movie" };
            const seriesCatalog = catalogs.find(c => c.type === "series") || { id: "kartoons-shows", type: "series" };

            const searchTargets = [movieCatalog, seriesCatalog];
            const searchResults = [];

            await Promise.all(searchTargets.map(async (target) => {
                const searchUrl = `${API_BASE}/catalog/${target.type}/${target.id}/search=${encodeURIComponent(query)}.json?${TOKEN_QUERY}`;
                const response = await getJson(searchUrl);
                const items = (response.metas || []).map(toMultimediaItem).filter(Boolean);
                searchResults.push(...items);
            }));

            cb({ success: true, data: searchResults });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const payload = safeParse(urlStr);
            if (!payload || !payload.id) throw new Error("Invalid item payload data");

            const metaUrl = `${API_BASE}/meta/${payload.type}/${payload.id}.json?${TOKEN_QUERY}`;
            const response = await getJson(metaUrl);
            const meta = response.meta;

            if (!meta) throw new Error("Metadata empty or item not found");

            const title = text(meta.name);
            const poster = meta.poster || "";
            const description = meta.description ? text(meta.description) : "";
            const year = meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined;
            const genres = meta.genres || [];

            let episodes = [];

            if (payload.type === "series") {
                const videos = meta.videos || [];
                episodes = videos.map((video) => {
                    // Stremio episode IDs normally formatted as id:season:episode
                    const epPayload = {
                        id: payload.id,
                        type: "series",
                        episodeId: video.id
                    };
                    return new Episode({
                        name: video.title ? text(video.title) : `Episode ${video.episode}`,
                        url: JSON.stringify(epPayload),
                        posterUrl: poster,
                        season: video.season || 1,
                        episode: video.episode
                    });
                });
            } else {
                // Movie structure has one single default episode target
                const epPayload = {
                    id: payload.id,
                    type: "movie",
                    episodeId: payload.id
                };
                episodes = [new Episode({
                    name: title,
                    url: JSON.stringify(epPayload),
                    posterUrl: poster
                })];
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title,
                    url: urlStr,
                    posterUrl: poster,
                    bannerUrl: meta.background,
                    description,
                    type: payload.type,
                    year,
                    tags: genres,
                    episodes
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const payload = safeParse(urlInfo);
            if (!payload) throw new Error("Invalid stream payload information");

            const idToQuery = payload.episodeId || payload.id;
            const typeToQuery = payload.type || "movie";

            const streamUrl = `${API_BASE}/stream/${typeToQuery}/${encodeURIComponent(idToQuery)}.json?${TOKEN_QUERY}`;
            const response = await getJson(streamUrl);
            const apiStreams = response.streams || [];

            const streams = apiStreams.map((st) => {
                const url = st.url;
                if (!url) return null;
                
                const titleStr = st.title || st.name || "Kartoons Engine";
                const source = text(titleStr.split("\n")[0]);
                const quality = qualityFromText(titleStr, 1080);

                return new StreamResult({
                    url: url,
                    source: source,
                    quality: quality,
                    headers: { "User-Agent": UA }
                });
            }).filter(Boolean);

            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    function qualityFromText(rawText, fallback) {
        const text = String(rawText || "").toLowerCase();
        if (/2160|4k/i.test(text)) return 2160;
        if (/1080/i.test(text)) return 1080;
        if (/720/i.test(text)) return 720;
        if (/480/i.test(text)) return 480;
        return fallback;
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
