(function () {
    const DEFAULT_TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json"
    };

    function getToken() {
        const url = (manifest && manifest.baseUrl) || "https://api.kartoons.me/api/stremio?token=" + DEFAULT_TOKEN;
        const match = url.match(/token=([^&]+)/);
        return match ? match[1] : DEFAULT_TOKEN;
    }

    function getBaseApiUrl() {
        const url = (manifest && manifest.baseUrl) || "https://api.kartoons.me/api/stremio";
        return url.split("?")[0].replace(/\/$/, "");
    }

    function qualityFromText(value) {
        const raw = String(value || "");
        if (/4k|2160/i.test(raw)) return 2160;
        if (/1440/i.test(raw)) return 1440;
        if (/1080|fhd/i.test(raw)) return 1080;
        if (/720|hd/i.test(raw)) return 720;
        if (/480|sd/i.test(raw)) return 480;
        if (/360/i.test(raw)) return 360;
        return 1080; // default safe fallback
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

    async function getHome(cb) {
        try {
            const base = getBaseApiUrl();
            const token = getToken();
            const manifestUrl = `${base}/manifest.json?token=${token}`;
            const res = await http_get(manifestUrl, HEADERS);
            const manifestData = JSON.parse(res.body || "{}");
            const catalogs = manifestData.catalogs || [];

            // Requested Categories mapping
            const defaultCatalogs = catalogs.length > 0 ? catalogs : [
                { id: "kartoons-trending", type: "movie", name: "Trending Now" },
                { id: "kartoons-popular-movies", type: "movie", name: "Popular Movies" },
                { id: "kartoons-popular-series", type: "series", name: "Popular Shows" }
            ];

            const results = await mapLimit(defaultCatalogs, 3, async (cat) => {
                const catUrl = `${base}/catalog/${cat.type}/${cat.id}.json?token=${token}`;
                try {
                    const catRes = await http_get(catUrl, HEADERS);
                    const catData = JSON.parse(catRes.body || "{}");
                    const metas = catData.metas || [];
                    const items = metas.map(meta => {
                        return new MultimediaItem({
                            title: meta.name,
                            url: JSON.stringify({ id: meta.id, type: meta.type || cat.type }),
                            posterUrl: meta.poster,
                            type: (meta.type || cat.type) === "movie" ? "movie" : "series",
                            year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
                            description: meta.description
                        });
                    }).filter(Boolean);

                    let displayName = cat.name;
                    if (cat.id.includes("trending")) {
                        displayName = "Trending Now";
                    } else if (cat.type === "movie" && cat.id.includes("popular")) {
                        displayName = "Popular Movies";
                    } else if (cat.type === "series" && cat.id.includes("popular")) {
                        displayName = "Popular Shows";
                    }

                    return { name: displayName, items };
                } catch (e) {
                    return null;
                }
            });

            const homeSections = {};
            for (const section of results) {
                if (section && section.items && section.items.length) {
                    homeSections[section.name] = section.items;
                }
            }

            if (Object.keys(homeSections).length === 0) {
                throw new Error("No categories returned items.");
            }

            cb({ success: true, data: homeSections });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const base = getBaseApiUrl();
            const token = getToken();
            const searchTypes = ["movie", "series"];

            const results = await Promise.all(searchTypes.map(async (type) => {
                let catalogId = "kartoons"; 
                try {
                    const manifestRes = await http_get(`${base}/manifest.json?token=${token}`, HEADERS);
                    const manifestData = JSON.parse(manifestRes.body || "{}");
                    const cat = (manifestData.catalogs || []).find(c => c.type === type && c.extra && c.extra.some(e => e.name === "search"));
                    if (cat) catalogId = cat.id;
                } catch (e) {}

                const searchUrl = `${base}/catalog/${type}/${catalogId}/search=${encodeURIComponent(query)}.json?token=${token}`;
                const res = await http_get(searchUrl, HEADERS);
                const data = JSON.parse(res.body || "{}");
                return (data.metas || []).map(meta => {
                    return new MultimediaItem({
                        title: meta.name,
                        url: JSON.stringify({ id: meta.id, type: meta.type || type }),
                        posterUrl: meta.poster,
                        type: (meta.type || type) === "movie" ? "movie" : "series",
                        year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
                        description: meta.description
                    });
                });
            }));

            const flatResults = [];
            for (const list of results) {
                if (list) flatResults.push.apply(flatResults, list);
            }

            cb({ success: true, data: flatResults });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const media = JSON.parse(urlStr);
            const base = getBaseApiUrl();
            const token = getToken();

            const metaUrl = `${base}/meta/${media.type}/${media.id}.json?token=${token}`;
            const res = await http_get(metaUrl, HEADERS);
            const data = JSON.parse(res.body || "{}");
            const meta = data.meta;

            if (!meta) throw new Error("Metadata details not found.");

            let episodes = [];
            if (media.type === "series") {
                episodes = (meta.videos || []).map((video) => {
                    return new Episode({
                        name: video.title || `Episode ${video.number}`,
                        url: JSON.stringify({ id: meta.id, type: "series", videoId: video.id, season: video.season, episode: video.number }),
                        season: video.season || 1,
                        episode: video.number,
                        posterUrl: video.thumbnail || meta.poster || ""
                    });
                });
            } else {
                episodes = [
                    new Episode({
                        name: meta.name,
                        url: JSON.stringify({ id: meta.id, type: "movie" }),
                        posterUrl: meta.poster || ""
                    })
                ];
            }

            const result = new MultimediaItem({
                title: meta.name,
                url: urlStr,
                posterUrl: meta.poster,
                bannerUrl: meta.background,
                description: meta.description,
                type: media.type,
                year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
                genres: meta.genres || [],
                episodes: episodes
            });

            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const media = JSON.parse(urlInfo);
            const base = getBaseApiUrl();
            const token = getToken();
            const targetId = media.videoId || media.id;

            const streamUrl = `${base}/stream/${media.type}/${targetId}.json?token=${token}`;
            const res = await http_get(streamUrl, HEADERS);
            const data = JSON.parse(res.body || "{}");
            const streams = data.streams || [];

            const results = streams.map(stream => {
                let resolvedUrl = stream.url || stream.externalUrl;
                if (!resolvedUrl) return null;

                const headers = (stream.behaviorHints && stream.behaviorHints.headers) || {};
                if (!headers["User-Agent"]) {
                    headers["User-Agent"] = UA;
                }

                return new StreamResult({
                    url: resolvedUrl,
                    source: stream.title || stream.name || "Kartoons",
                    quality: qualityFromText(stream.title || stream.name),
                    headers: headers
                });
            }).filter(Boolean);

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();