(function () {
    const BASE_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json"
    };

    // Helper functions
    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    async function fetchJson(url) {
        try {
            const res = await http_get(url, HEADERS);
            return safeParse(res && res.body ? res.body : null);
        } catch (e) {
            return null;
        }
    }

    function qualityFromText(value, fallback) {
        const raw = String(value || "");
        if (/2160|4k/i.test(raw)) return 2160;
        if (/1440|2k/i.test(raw)) return 1440;
        if (/1080|fhd/i.test(raw)) return 1080;
        if (/720|hd/i.test(raw)) return 720;
        if (/480|sd/i.test(raw)) return 480;
        if (/360/i.test(raw)) return 360;
        return fallback || 0;
    }

    function cleanString(str) {
        return (str || "").replace(/\s+/g, " ").trim();
    }

    function toMultimediaItem(meta) {
        if (!meta || !meta.id) return null;
        
        const type = meta.type === "series" ? "series" : "movie";
        return new MultimediaItem({
            title: cleanString(meta.name),
            url: JSON.stringify({ id: meta.id, type: type }),
            posterUrl: meta.poster || "",
            type: type,
            description: cleanString(meta.description || ""),
            year: meta.year ? parseInt(meta.year, 10) : undefined,
            genres: meta.genres || []
        });
    }

    // Dynamic catalog fetching based on manifest discovery
    async function getHome(cb) {
        try {
            const manifestUrl = `${BASE_URL}/manifest.json?token=${TOKEN}`;
            const manifest = await fetchJson(manifestUrl);
            
            if (!manifest || !manifest.catalogs) {
                return cb({ success: false, errorCode: "MANIFEST_ERROR", message: "Failed to load manifest." });
            }

            const catalogs = manifest.catalogs;
            const homeSections = {};

            // Dynamic grouping configuration matching requested categories
            const categoryMappings = [
                { key: "Trending Now", check: (c) => /trending|popular|featured/i.test(c.name) || c.id.includes("trending") },
                { key: "Popular Movies", check: (c) => c.type === "movie" },
                { key: "Popular Shows", check: (c) => c.type === "series" }
            ];

            const loadPromises = categoryMappings.map(async (mapping) => {
                // Find a catalog matching criteria, fallback to order matching if needed
                let matchedCatalog = catalogs.find(mapping.check);
                
                if (!matchedCatalog) {
                    if (mapping.key === "Popular Movies") {
                        matchedCatalog = catalogs.find(c => c.type === "movie");
                    } else if (mapping.key === "Popular Shows") {
                        matchedCatalog = catalogs.find(c => c.type === "series");
                    } else {
                        matchedCatalog = catalogs[0]; // fallback to first catalog for Trending
                    }
                }

                if (matchedCatalog) {
                    const catalogUrl = `${BASE_URL}/catalog/${matchedCatalog.type}/${matchedCatalog.id}.json?token=${TOKEN}`;
                    const data = await fetchJson(catalogUrl);
                    if (data && data.metas) {
                        const items = data.metas.map(toMultimediaItem).filter(Boolean);
                        if (items.length > 0) {
                            homeSections[mapping.key] = items;
                        }
                    }
                }
            });

            await Promise.all(loadPromises);

            cb({ success: true, data: homeSections });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    // Handles global item searching
    async function search(query, cb) {
        try {
            const manifestUrl = `${BASE_URL}/manifest.json?token=${TOKEN}`;
            const manifest = await fetchJson(manifestUrl);
            
            if (!manifest || !manifest.catalogs) {
                return cb({ success: false, errorCode: "MANIFEST_ERROR", message: "Failed to execute search." });
            }

            const searchTargets = [];
            // Get unique types from the catalogs to perform type-specific catalog searches
            manifest.catalogs.forEach(catalog => {
                if (catalog.extra && catalog.extra.some(e => e.name === "search")) {
                    searchTargets.push({ type: catalog.type, id: catalog.id });
                }
            });

            // Fallback targets if manifest doesn't explicitly expose searchable fields
            if (searchTargets.length === 0) {
                searchTargets.push({ type: "movie", id: "kartoons_movies" });
                searchTargets.push({ type: "series", id: "kartoons_series" });
            }

            const searchResults = [];
            const encodedQuery = encodeURIComponent(query);

            const queries = searchTargets.map(async (target) => {
                const searchUrl = `${BASE_URL}/catalog/${target.type}/${target.id}/search=${encodedQuery}.json?token=${TOKEN}`;
                const data = await fetchJson(searchUrl);
                if (data && data.metas) {
                    data.metas.forEach(meta => {
                        const item = toMultimediaItem(meta);
                        if (item) searchResults.push(item);
                    });
                }
            });

            await Promise.all(queries);

            // Deduplicate search results
            const uniqueResults = [];
            const seen = {};
            for (const item of searchResults) {
                const payloadStr = safeParse(item.url);
                if (payloadStr && !seen[payloadStr.id]) {
                    seen[payloadStr.id] = true;
                    uniqueResults.push(item);
                }
            }

            cb({ success: true, data: uniqueResults });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    // Resolves individual item details (Movies & Series Episodes)
    async function load(urlStr, cb) {
        try {
            const itemInfo = safeParse(urlStr);
            if (!itemInfo || !itemInfo.id || !itemInfo.type) {
                throw new Error("Invalid item mapping info");
            }

            const detailUrl = `${BASE_URL}/meta/${itemInfo.type}/${itemInfo.id}.json?token=${TOKEN}`;
            const detailData = await fetchJson(detailUrl);
            const meta = detailData && detailData.meta;

            if (!meta) {
                throw new Error("Failed to load metadata detail.");
            }

            const title = cleanString(meta.name);
            const description = cleanString(meta.description || "");
            const poster = meta.poster || "";
            const year = meta.year ? parseInt(meta.year, 10) : undefined;
            const genres = meta.genres || [];

            const episodes = [];

            if (itemInfo.type === "series") {
                const rawVideos = meta.videos || [];
                rawVideos.forEach((vid) => {
                    const epNum = vid.episode || vid.number || 1;
                    const seasonNum = vid.season || 1;
                    episodes.push(new Episode({
                        name: cleanString(vid.title || `Episode ${epNum}`),
                        url: JSON.stringify({
                            id: vid.id || itemInfo.id,
                            type: "series",
                            seriesId: itemInfo.id,
                            season: seasonNum,
                            episode: epNum
                        }),
                        posterUrl: vid.thumbnail || poster,
                        season: seasonNum,
                        episode: epNum
                    }));
                });

                // Sort episodes numerically
                episodes.sort((a, b) => {
                    if (a.season !== b.season) return a.season - b.season;
                    return a.episode - b.episode;
                });
            } else {
                // Movies use a single self-referential episode mapping
                episodes.push(new Episode({
                    name: title,
                    url: JSON.stringify({
                        id: itemInfo.id,
                        type: "movie"
                    }),
                    posterUrl: poster,
                    season: 1,
                    episode: 1
                }));
            }

            const mediaItem = new MultimediaItem({
                title: title,
                url: urlStr,
                posterUrl: poster,
                description: description,
                type: itemInfo.type,
                year: year,
                genres: genres,
                episodes: episodes
            });

            cb({ success: true, data: mediaItem });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    // Fetches stream definitions
    async function loadStreams(urlInfo, cb) {
        try {
            const streamInfo = safeParse(urlInfo);
            if (!streamInfo || !streamInfo.id || !streamInfo.type) {
                throw new Error("Invalid stream extraction mapping.");
            }

            // Construct exact video ID based on Stremio naming patterns
            let queryId = streamInfo.id;
            if (streamInfo.type === "series" && !queryId.includes(":")) {
                queryId = `${streamInfo.seriesId || streamInfo.id}:${streamInfo.season || 1}:${streamInfo.episode || 1}`;
            }

            const streamUrl = `${BASE_URL}/stream/${streamInfo.type}/${encodeURIComponent(queryId)}.json?token=${TOKEN}`;
            const responseData = await fetchJson(streamUrl);
            const streams = responseData && responseData.streams ? responseData.streams : [];

            const processedStreams = [];

            streams.forEach((item) => {
                if (!item.url && !item.externalUrl) return;

                const rawTitle = item.title || item.name || "Default Server";
                const parts = rawTitle.split("\n");
                const serverName = cleanString(parts[0] || "Kartoons Server");
                const qualityText = parts[1] || parts[0];
                const quality = qualityFromText(qualityText, 1080);

                const streamResult = new StreamResult({
                    url: item.url || item.externalUrl,
                    source: serverName,
                    quality: quality,
                    headers: HEADERS
                });

                processedStreams.push(streamResult);
            });

            // Filter duplicates out
            const uniqueStreams = [];
            const seen = {};
            for (const s of processedStreams) {
                const key = `${s.url}|${s.source}`;
                if (!seen[key]) {
                    seen[key] = true;
                    uniqueStreams.push(s);
                }
            }

            cb({ success: true, data: uniqueStreams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // Attach modules to global scope as required by SDK environments
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
