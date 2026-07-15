(function () {
    const TOKEN = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ";
    const BASE_API_URL = "https://api.kartoons.me/api/stremio";
    const MANIFEST_URL = `${BASE_API_URL}/manifest.json?token=${TOKEN}`;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://kartoons.me/",
        "Origin": "https://kartoons.me"
    };

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
        const val = String(text || "").toLowerCase();
        if (/2160|4k/i.test(val)) return 2160;
        if (/1440|2k/i.test(val)) return 1440;
        if (/1080|fhd/i.test(val)) return 1080;
        if (/720|hd/i.test(val)) return 720;
        if (/480|sd/i.test(val)) return 480;
        if (/360/i.test(val)) return 360;
        return 1080;
    }

    function toMultimediaItem(meta) {
        if (!meta) return null;
        const payloadData = {
            id: meta.id,
            type: meta.type || "movie",
            poster: meta.poster || ""
        };
        return new MultimediaItem({
            title: meta.name || "Untitled",
            url: JSON.stringify(payloadData),
            posterUrl: meta.poster || "",
            type: meta.type === "movie" ? "movie" : "series",
            year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined,
            description: meta.description || ""
        });
    }

    async function safeHttpGet(url) {
        try {
            const res = await http_get(url, HEADERS);
            return res && res.body ? res.body : null;
        } catch (e) {
            console.error("HTTP GET failed for: " + url + " Error: " + e.message);
            return null;
        }
    }

    async function getHome(cb) {
        try {
            let movieCatalogId = "kartoons_movies";
            let seriesCatalogId = "kartoons_series";
            let trendingCatalogId = "kartoons_movies";

            const manifestBody = await safeHttpGet(MANIFEST_URL);
            if (manifestBody) {
                const manifest = safeParse(manifestBody);
                if (manifest && manifest.catalogs) {
                    const catalogs = manifest.catalogs;
                    const movieCats = catalogs.filter(c => c.type === "movie");
                    const seriesCats = catalogs.filter(c => c.type === "series");

                    if (movieCats.length > 0) {
                        movieCatalogId = movieCats[0].id;
                        trendingCatalogId = movieCats[0].id;
                    }
                    if (seriesCats.length > 0) {
                        seriesCatalogId = seriesCats[0].id;
                    }
                    const trendingCat = catalogs.find(c => /trending|featured/i.test(c.name || c.id));
                    if (trendingCat) {
                        trendingCatalogId = trendingCat.id;
                    }
                }
            }

            const trendingUrl = `${BASE_API_URL}/catalog/movie/${trendingCatalogId}.json?token=${TOKEN}`;
            const moviesUrl = `${BASE_API_URL}/catalog/movie/${movieCatalogId}.json?token=${TOKEN}`;
            const seriesUrl = `${BASE_API_URL}/catalog/series/${seriesCatalogId}.json?token=${TOKEN}`;

            const [trendingBody, moviesBody, seriesBody] = await Promise.all([
                safeHttpGet(trendingUrl),
                safeHttpGet(moviesUrl),
                safeHttpGet(seriesUrl)
            ]);

            const homeData = {};

            if (trendingBody) {
                const metas = safeParse(trendingBody)?.metas || [];
                const items = metas.map(toMultimediaItem).filter(Boolean);
                if (items.length > 0) homeData["Trending Now"] = items;
            }

            if (moviesBody) {
                const metas = safeParse(moviesBody)?.metas || [];
                const items = metas.map(toMultimediaItem).filter(Boolean);
                if (items.length > 0) homeData["Popular Movies"] = items;
            }

            if (seriesBody) {
                const metas = safeParse(seriesBody)?.metas || [];
                const items = metas.map(toMultimediaItem).filter(Boolean);
                if (items.length > 0) homeData["Popular Shows"] = items;
            }

            if (Object.keys(homeData).length === 0) {
                throw new Error("No categories loaded from api");
            }

            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const queryEscaped = encodeURIComponent(query);
            const searchMovieUrl = `${BASE_API_URL}/catalog/movie/kartoons_movies/search=${queryEscaped}.json?token=${TOKEN}`;
            const searchSeriesUrl = `${BASE_API_URL}/catalog/series/kartoons_series/search=${queryEscaped}.json?token=${TOKEN}`;

            const [movieBody, seriesBody] = await Promise.all([
                safeHttpGet(searchMovieUrl),
                safeHttpGet(searchSeriesUrl)
            ]);

            const results = [];
            if (movieBody) {
                const metas = safeParse(movieBody)?.metas || [];
                metas.forEach(meta => {
                    const item = toMultimediaItem(meta);
                    if (item) results.push(item);
                });
            }
            if (seriesBody) {
                const metas = safeParse(seriesBody)?.metas || [];
                metas.forEach(meta => {
                    const item = toMultimediaItem(meta);
                    if (item) results.push(item);
                });
            }

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    async function load(urlStr, cb) {
        try {
            const media = safeParse(urlStr);
            if (!media || !media.id) throw new Error("Invalid payload data");

            const type = media.type || "movie";
            const id = media.id;
            const metaUrl = `${BASE_API_URL}/meta/${type}/${id}.json?token=${TOKEN}`;

            const metaBody = await safeHttpGet(metaUrl);
            const meta = safeParse(metaBody)?.meta;

            if (!meta) throw new Error("Metadata response was empty");

            const title = meta.name || "Untitled";
            const poster = meta.poster || media.poster || "";
            const banner = meta.background || "";
            const description = meta.description || "";
            const year = meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined;
            const genres = meta.genres || [];

            let episodes = [];
            if (type === "series") {
                episodes = (meta.videos || []).map((video) => {
                    const epPayload = {
                        id: id,
                        type: "series",
                        videoId: video.id
                    };
                    return new Episode({
                        name: video.title || `Episode ${video.episode}`,
                        url: JSON.stringify(epPayload),
                        posterUrl: video.thumbnail || poster,
                        season: video.season || 1,
                        episode: video.episode || 1
                    });
                });
            } else {
                const moviePayload = { id: id, type: "movie" };
                episodes = [new Episode({
                    name: title,
                    url: JSON.stringify(moviePayload),
                    posterUrl: poster
                })];
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title,
                    url: urlStr,
                    posterUrl: poster,
                    bannerUrl: banner,
                    description,
                    type,
                    year,
                    genres,
                    episodes
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    async function loadStreams(urlInfo, cb) {
        try {
            const media = safeParse(urlInfo);
            if (!media || !media.id) throw new Error("Invalid payload data");

            const type = media.type || "movie";
            const reqId = media.videoId || media.id;
            const streamUrl = `${BASE_API_URL}/stream/${type}/${reqId}.json?token=${TOKEN}`;

            const streamBody = await safeHttpGet(streamUrl);
            const streamsObj = safeParse(streamBody);
            const streamResults = [];

            if (streamsObj && streamsObj.streams) {
                for (const stream of streamsObj.streams) {
                    let directUrl = stream.url;
                    if (!directUrl && stream.externalUrl) {
                        directUrl = stream.externalUrl;
                    }
                    if (!directUrl) continue;

                    const sourceName = stream.name || "Kartoons";
                    const subtitleText = stream.title || "";
                    const label = subtitleText ? `${sourceName} - ${subtitleText.split('\n')[0]}` : sourceName;
                    const quality = qualityFromText(subtitleText) || qualityFromText(sourceName);

                    streamResults.push(new StreamResult({
                        url: directUrl,
                        source: label,
                        quality: quality,
                        headers: HEADERS
                    }));
                }
            }

            cb({ success: true, data: streamResults });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
