(function () {
    const MAIN_URL = "https://api.kartoons.me/api/stremio";
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
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

    function fixUrl(raw, base) {
        if (!raw) return "";
        const url = String(raw).trim();
        if (!url || url.startsWith("data:")) return "";
        if (url.startsWith("//")) return "https:" + url;
        if (/^https?:\/\//i.test(url)) return url;
        try {
            return new URL(url, base || MAIN_URL).href;
        } catch (e) {
            return url;
        }
    }

    function getHost(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch (e) {
            return "";
        }
    }

    function qualityFromText(value, fallback) {
        const raw = String(value || "");
        const size = raw.match(/(?:^|[^\d])([1-9]\d{2,3})\s*p(?:[^\d]|$)/i);
        if (size) return parseInt(size[1], 10);
        if (/4k|2160/i.test(raw)) return 2160;
        if (/1080|fhd/i.test(raw)) return 1080;
        if (/720|hd/i.test(raw)) return 720;
        if (/480|sd/i.test(raw)) return 480;
        return fallback || 0;
    }

    function dedupeStreams(streams) {
        const seen = {};
        return (streams || []).filter((stream) => {
            const key = `${stream.url}|${stream.source}`;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
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

    function mapStremioMeta(meta) {
        if (!meta) return null;
        const type = meta.type === "movie" ? "movie" : "series";
        return new MultimediaItem({
            title: meta.name || "Unknown",
            url: JSON.stringify({ id: meta.id, type: type, poster: meta.poster }),
            posterUrl: meta.poster || "",
            type: type,
            description: meta.description || ""
        });
    }

    // Dynamic Home catalogs using Stremio manifest discovery
    async function getHome(cb) {
        try {
            const manifestRes = await http_get(`${MAIN_URL}/manifest.json?token=${TOKEN}`, HEADERS);
            const manifest = safeParse(manifestRes?.body);
            if (!manifest || !manifest.catalogs) {
                throw new Error("Unable to read Stremio manifest catalogs");
            }

            const catalogs = manifest.catalogs;
            const targetCatalogs = [];

            // Find match for "Trending Now"
            const trendingCat = catalogs.find(c => /trending|featured/i.test(c.name || c.id)) || catalogs[0];
            if (trendingCat) {
                targetCatalogs.push({ ...trendingCat, displayName: "Trending Now" });
            }

            // Find match for "Popular Movies"
            const movieCat = catalogs.find(c => c.type === "movie" && !/trending/i.test(c.id)) || catalogs.find(c => c.type === "movie");
            if (movieCat) {
                targetCatalogs.push({ ...movieCat, displayName: "Popular Movies" });
            }

            // Find match for "Popular Shows"
            const seriesCat = catalogs.find(c => c.type === "series" && !/trending/i.test(c.id)) || catalogs.find(c => c.type === "series");
            if (seriesCat) {
                targetCatalogs.push({ ...seriesCat, displayName: "Popular Shows" });
            }

            const results = await mapLimit(targetCatalogs, 3, async (cat) => {
                const catUrl = `${MAIN_URL}/catalog/${cat.type}/${cat.id}.json?token=${TOKEN}`;
                const catRes = await http_get(catUrl, HEADERS);
                const data = safeParse(catRes?.body);
                const items = (data?.metas || []).map(mapStremioMeta).filter(Boolean);
                return { name: cat.displayName, items: items };
            });

            const homeData = {};
            for (const section of results) {
                if (section && section.items && section.items.length) {
                    homeData[section.name] = section.items;
                }
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    // Search functionality mapping to Stremio's catalog searching capabilities
    async function search(query, cb) {
        try {
            const manifestRes = await http_get(`${MAIN_URL}/manifest.json?token=${TOKEN}`, HEADERS);
            const manifest = safeParse(manifestRes?.body);
            if (!manifest || !manifest.catalogs) {
                throw new Error("Unable to read Stremio manifest for search");
            }

            // Query search against first movie and series catalogs
            const movieCat = manifest.catalogs.find(c => c.type === "movie");
            const seriesCat = manifest.catalogs.find(c => c.type === "series");
            const searchTargets = [movieCat, seriesCat].filter(Boolean);

            const searchResults = await mapLimit(searchTargets, 2, async (cat) => {
                const searchUrl = `${MAIN_URL}/catalog/${cat.type}/${cat.id}/search=${encodeURIComponent(query)}.json?token=${TOKEN}`;
                const res = await http_get(searchUrl, HEADERS);
                const data = safeParse(res?.body);
                return (data?.metas || []).map(mapStremioMeta).filter(Boolean);
            });

            const flatResults = [];
            for (const list of searchResults) {
                if (list) flatResults.push.apply(flatResults, list);
            }

            cb({ success: true, data: flatResults });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    // Detail page loading mapping metadata and episode arrays
    async function load(urlStr, cb) {
        try {
            const payload = safeParse(urlStr);
            if (!payload || !payload.id || !payload.type) {
                throw new Error("Invalid metadata payload");
            }

            const metaUrl = `${MAIN_URL}/meta/${payload.type}/${encodeURIComponent(payload.id)}.json?token=${TOKEN}`;
            const res = await http_get(metaUrl, HEADERS);
            const data = safeParse(res?.body);
            const meta = data?.meta;

            if (!meta) {
                throw new Error("Details could not be fetched");
            }

            const year = meta.year ? parseInt(meta.year, 10) : undefined;
            const banner = meta.background || meta.backgroundUrl || "";

            const item = new MultimediaItem({
                title: meta.name || "No Title",
                url: urlStr,
                posterUrl: meta.poster || payload.poster || "",
                bannerUrl: banner,
                description: meta.description || "",
                type: payload.type,
                year: year,
                genres: meta.genres || [],
                episodes: []
            });

            if (payload.type === "series") {
                if (meta.videos && meta.videos.length > 0) {
                    item.episodes = meta.videos.map((video) => {
                        return new Episode({
                            name: video.title || `Episode ${video.episode}`,
                            url: JSON.stringify({ id: payload.id, type: payload.type, episodeId: video.id }),
                            season: video.season || 1,
                            episode: video.episode || 1,
                            posterUrl: video.thumbnail || meta.poster || "",
                            description: video.overview || ""
                        });
                    });
                }
            } else {
                // Movies contain a single episode representation for trigger playing
                item.episodes = [
                    new Episode({
                        name: meta.name || "Play Movie",
                        url: JSON.stringify({ id: payload.id, type: payload.type }),
                        posterUrl: meta.poster || ""
                    })
                ];
            }

            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    // Extractors fallbacks to resolve embeds if the api returns embed hosting links
    async function loadExtractor(url) {
        const host = getHost(url);
        if (/\.m3u8(?:\?|$)/i.test(url)) {
            return [new StreamResult({ url: url, source: "Direct HLS", quality: qualityFromText(url, 1080), headers: HEADERS })];
        }
        if (/\.mp4(?:\?|$)/i.test(url)) {
            return [new StreamResult({ url: url, source: "Direct MP4", quality: qualityFromText(url, 1080), headers: HEADERS })];
        }
        return [];
    }

    async function resolveStream(stream) {
        const url = stream.url || stream.externalUrl;
        if (!url) return [];

        const streamHeaders = stream.behaviorHints?.headers || HEADERS;

        // Verify if stream link needs custom resolver
        const parsedHost = getHost(url);
        if (/z\.awstream\.net|beta\.awstream\.net|play\.zephyrflick\.top|as-cdn21\.top|rapid-cloud\.co|megaplay\.buzz|abyssplayer\.com|playhydrax\.com|short\.icu|pixdrive\.cfd|ghbrisk\.com|streamwish|filelions|vidmoly/i.test(parsedHost)) {
            try {
                const extracted = await loadExtractor(url);
                if (extracted && extracted.length > 0) return extracted;
            } catch (e) {}
        }

        return [new StreamResult({
            url: url,
            source: stream.title || stream.name || "Kartoons Server",
            quality: qualityFromText(stream.title || stream.name, 1080),
            headers: streamHeaders
        })];
    }

    // Stream lookup fetching streams based on metadata information
    async function loadStreams(urlInfo, cb) {
        try {
            const payload = safeParse(urlInfo);
            if (!payload) throw new Error("Invalid stream payload information");

            const streamId = payload.type === "series" ? (payload.episodeId || payload.id) : payload.id;
            const streamUrl = `${MAIN_URL}/stream/${payload.type}/${encodeURIComponent(streamId)}.json?token=${TOKEN}`;

            const res = await http_get(streamUrl, HEADERS);
            const data = safeParse(res?.body);
            const stremioStreams = data?.streams || [];

            const resolvedStreams = [];
            for (const stream of stremioStreams) {
                const resolved = await resolveStream(stream);
                if (resolved && resolved.length > 0) {
                    resolvedStreams.push.apply(resolvedStreams, resolved);
                }
            }

            cb({ success: true, data: dedupeStreams(resolvedStreams) });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    // Export global context operations
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
