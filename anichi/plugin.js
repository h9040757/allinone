(function() {
    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // manifest is injected at runtime

    // --- Constants ---
    const API_URL = "https://api.allanime.day/api";
    const API_ENDPOINT = "https://allanime.day";
    const HEADERS = {
        "app-version": "android_c-247",
        "from-app": "allmanga",
        "platformstr": "android_c",
        "Referer": "https://allmanga.to"
    };

    const HASHES = {
        main: "e42a4466d984b2c0a2cecae5dd13aa68867f634b16ee0f17b380047d14482406",
        popular: "60f50b84bb545fa25ee7f7c8c0adbf8f5cea40f7b1ef8501cbbff70e38589489",
        detail: "bb263f91e5bdd048c1c978f324613aeccdfe2cbc694a419466a31edb58c0cc0b",
        server: "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec",
        mainPage: "a24c500a1b765c68ae1d8dd85174931f661c71369c89b92b88b75a725afc471c",
        showsMetadata: "9de1b73e302fa5e471990ed8229c9ad330b3f82a92a288743fb67309520a1996"
    };


    // --- Helpers ---
    function encodeQueryParts(variables, hash) {
        return "variables=" + encodeURIComponent(JSON.stringify(variables || {}))
            + "&extensions=" + encodeURIComponent(JSON.stringify({
                persistedQuery: {
                    version: 1,
                    sha256Hash: hash
                }
            }));
    }

    async function queryGraph(variables, hash, method, silent) {
        const body = {
            variables: variables,
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: hash
                }
            }
        };
        
        const requestMethod = method || "GET";
        try {
            let res;
            if (requestMethod === "GET") {
                const url = API_URL + "?" + encodeQueryParts(variables, hash);
                res = await http_get(url, HEADERS);
            } else {
                try {
                    res = await http_post(API_URL, HEADERS, JSON.stringify(body));
                } catch (_) {
                    res = await http_post(API_URL, JSON.stringify(body), HEADERS);
                }
            }
            const bodyStr = res.body || "";
            if (res.status !== 200 || bodyStr.trim().startsWith("<")) {
               throw new Error("HTTP_BLOCK: Cloudflare or Network Error (HTML returned)");
            }
            return JSON.parse(bodyStr);
        } catch (e) {
            if (!silent) {
                console.error("GraphQL Error: " + e.message);
            }
            throw e;
        }
    }

    async function safeQueryGraph(variables, hash, method) {
        try {
            return await queryGraph(variables, hash, method, true);
        } catch (_) {
            return null;
        }
    }

    function hasEpisodes(edge) {
        const available = edge && edge.availableEpisodes;
        return !available || !(
            Number(available.raw || 0) === 0 &&
            Number(available.sub || 0) === 0 &&
            Number(available.dub || 0) === 0
        );
    }

    function toMultimediaItem(edge) {
        if (!edge) return null;
        const posterUrl = edge.thumbnail?.startsWith("http") 
            ? edge.thumbnail 
            : edge.thumbnail ? `https://wp.youtube-anime.com/aln.youtube-anime.com/${edge.thumbnail}` : null;

        return new MultimediaItem({
            title: edge.name || edge.englishName || edge.nativeName || "Unknown",
            url: edge._id || edge.showId, 
            posterUrl: posterUrl,
            type: edge.type?.toLowerCase().includes("movie") ? "movie" : "anime",
            year: edge.airedStart?.year,
            description: edge.description?.replace(/<[^>]*>/g, ""),
            headers: HEADERS
        });
    }

    // --- Core Functions ---

    async function getHome(cb) {
        try {
            const now = new Date();
            const month = now.getMonth() + 1;
            const year = now.getFullYear();
            const season = month <= 3 ? "Winter" : month <= 6 ? "Spring" : month <= 9 ? "Summer" : "Fall";
            const transType = getPreference("translation_type") || "sub";

            const categories = {
                "New Series": { search: { season, year }, translationType: transType, countryOrigin: "ALL" },
                "Latest Anime": { search: {}, translationType: transType, countryOrigin: "ALL" },
                "Latest Donghua": { search: {}, translationType: transType, countryOrigin: "CN" },
                "Movies": { search: { types: ["Movie"] }, translationType: transType, countryOrigin: "ALL" }
            };

            const homeData = {};
            const categoryEntries = Object.entries(categories);
            const sectionResults = await Promise.allSettled(categoryEntries.map(async function (entry) {
                const name = entry[0];
                const variables = entry[1];
                const res = await queryGraph({ ...variables, limit: 26, page: 1 }, HASHES.mainPage, "GET");
                const items = (res.data?.shows?.edges || []).filter(hasEpisodes).map(toMultimediaItem).filter(Boolean);
                return { name: name, items: items };
            }));

            sectionResults.forEach(function (result) {
                if (result.status !== "fulfilled") return;
                if (!result.value.items.length) return;
                homeData[result.value.name] = result.value.items;
            });

            const popularRes = await safeQueryGraph(
                { type: "anime", size: 30, dateRange: 1, page: 1, allowAdult: true, allowUnknown: false },
                HASHES.popular,
                "GET"
            );
            const popularItems = (popularRes?.data?.queryPopular?.recommendations || [])
                .map(function (r) { return toMultimediaItem(r.anyCard); })
                .filter(Boolean)
                .filter(hasEpisodes);
            if (popularItems.length > 0) homeData["Trending"] = popularItems;

            if (!Object.keys(homeData).length) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No home sections available" });
            }
            cb({ success: true, data: homeData });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    async function search(query, cb) {
        try {
            const transType = getPreference("translation_type") || "sub";
            const variables = {
                search: { query: query },
                limit: 26,
                page: 1,
                translationType: transType,
                countryOrigin: "ALL"
            };

            const res = await queryGraph(variables, HASHES.mainPage, "GET");
            const items = (res.data?.shows?.edges || []).filter(hasEpisodes).map(toMultimediaItem).filter(Boolean);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    async function getAniListMedia(title, year, season, type) {
        const query = `
        query ($search: String, $type: MediaType, $season: MediaSeason, $year: String, $format: [MediaFormat]) {
          Page(page: 1, perPage: 1) {
            media(search: $search, type: $type, season: $season, startDate_like: $year, format_in: $format) {
              id idMal bannerImage
              coverImage { extraLarge large medium }
              title { english romaji native }
              startDate { year }
              genres description averageScore status
              nextAiringEpisode { episode }
              recommendations { edges { node { id mediaRecommendation { id title { english romaji } coverImage { large } } } } }
            }
          }
        }`;
        
        const variables = {
            search: title,
            type: "ANIME",
            season: type?.toLowerCase() === "ona" ? undefined : season?.toUpperCase(),
            year: year ? `${year}%` : undefined,
            format: [type?.toUpperCase()]
        };

        const payload = JSON.stringify({ query, variables });
        let res;
        try {
            res = await http_post("https://graphql.anilist.co", { "Content-Type": "application/json" }, payload);
        } catch (_) {
            res = await http_post("https://graphql.anilist.co", payload, { "Content-Type": "application/json" });
        }
        const data = JSON.parse(res.body || "{}");
        return data.data?.Page?.media?.[0] || null;
    }

    async function getTmdbLogo(tmdbId, type) {
        if (!tmdbId) return null;
        const apiKey = "98ae14df2b8d8f8f8136499daf79f0e0";
        const url = `https://api.themoviedb.org/3/${type === "movie" ? "movie" : "tv"}/${tmdbId}/images?api_key=${apiKey}`;
        try {
            const res = await http_get(url);
            const data = JSON.parse(res.body);
            const logos = data.logos || [];
            if (logos.length === 0) return null;
            // Prefer English
            const logo = logos.find(l => l.iso_639_1 === "en") || logos[0];
            return `https://image.tmdb.org/t/p/w500${logo.file_path}`;
        } catch (e) {
            return null;
        }
    }

    async function getAniZipData(malId) {
        if (!malId) return null;
        try {
            const res = await http_get(`https://api.ani.zip/mappings?mal_id=${malId}`);
            return JSON.parse(res.body);
        } catch (e) {
            return null;
        }
    }

    async function getRelatedShows(showIds) {
        const ids = (showIds || []).filter(Boolean);
        if (!ids.length) return [];
        const batches = [];
        for (let i = 0; i < ids.length; i += 12) {
            batches.push(ids.slice(i, i + 12));
        }
        const results = await Promise.allSettled(batches.map(async function (batch) {
            const res = await safeQueryGraph({ showIds: batch }, HASHES.showsMetadata, "POST");
            if (!res) return [];
            return res.data?.showsMetadata || res.data?.shows || [];
        }));
        return results
            .filter(function (result) { return result.status === "fulfilled"; })
            .flatMap(function (result) { return result.value || []; });
    }

    async function load(url, cb) {
        try {
            const res = await queryGraph({ _id: url }, HASHES.detail, "GET");
            const show = res.data?.show;
            if (!show) return cb({ success: false, message: "Show not found" });

            const title = show.name;
            const year = show.airedStart?.year;
            const season = show.season?.quarter;
            const type = show.type;

            // Fetch extra metadata in parallel
            const [primaryAniMedia, aniZip] = await Promise.all([
                getAniListMedia(title, year, season, type),
                show.idMal ? getAniZipData(show.idMal) : Promise.resolve(null)
            ]);
            const aniMedia = primaryAniMedia || await getAniListMedia(show.altNames?.[0], year, season, type);

            const tmdbId = aniZip?.mappings?.themoviedb_id;
            const logoUrl = await getTmdbLogo(tmdbId, show.type?.toLowerCase().includes("movie") ? "movie" : "tv");

            const episodes = (show.availableEpisodesDetail?.sub || []).map(epNum => {
                const aniEp = aniZip?.episodes?.[epNum];
                return new Episode({
                    name: aniEp?.title?.en || aniEp?.title?.ja || `Episode ${epNum}`,
                    url: JSON.stringify({ hash: show._id, dubStatus: "sub", episode: epNum, idMal: show.idMal }),
                    season: 1,
                    episode: parseInt(epNum),
                    description: aniEp?.overview || "No summary available",
                    posterUrl: aniEp?.image || toMultimediaItem(show).posterUrl,
                    runtime: aniEp?.runtime,
                    dubStatus: "sub",
                    headers: HEADERS
                });
            });

            const dubEpisodes = (show.availableEpisodesDetail?.dub || []).map(epNum => {
                const aniEp = aniZip?.episodes?.[epNum];
                return new Episode({
                    name: aniEp?.title?.en || aniEp?.title?.ja || `Episode ${epNum} (Dub)`,
                    url: JSON.stringify({ hash: show._id, dubStatus: "dub", episode: epNum, idMal: show.idMal }),
                    season: 1,
                    episode: parseInt(epNum),
                    description: aniEp?.overview || "No summary available",
                    posterUrl: aniEp?.image || toMultimediaItem(show).posterUrl,
                    runtime: aniEp?.runtime,
                    dubStatus: "dub",
                    headers: HEADERS
                });
            });

            // Resolve recommendations metadata
            const relatedIds = (show.relatedShows || []).map(r => r.showId).filter(id => id);
            const metaShows = await getRelatedShows(relatedIds);
            const recommendations = metaShows.map(toMultimediaItem).filter(function (item) { return item; });

            const result = new MultimediaItem({
                title: title,
                url: url,
                posterUrl: toMultimediaItem(show).posterUrl,
                bannerUrl: aniMedia?.bannerImage || show.banner,
                logoUrl: logoUrl,
                type: show.type?.toLowerCase().includes("movie") ? "movie" : "anime",
                description: show.description?.replace(/<[^>]*>/g, ""),
                year: year,
                score: show.averageScore / 10,
                status: show.status?.toLowerCase() === "releasing" ? "ongoing" : "completed",
                genres: show.genres,
                tags: show.tags,
                contentRating: show.rating,
                duration: show.episodeDuration ? Math.floor(show.episodeDuration / 60000) : undefined,
                cast: (show.characters || []).map(c => new Actor({
                    name: c.name?.full || c.name?.native,
                    role: c.role,
                    image: c.image?.large || c.image?.medium
                })),
                trailers: (show.prevideos || []).filter(v => v).map(v => new Trailer({
                    name: "Trailer",
                    url: `https://www.youtube.com/watch?v=${v}`
                })),
                episodes: episodes,
                recommendations: recommendations,
                headers: HEADERS
            });

            // If we have DUB episodes, we might want to expose them. 
            // In SkyStream, we usually combine them or let user choose.
            // For now, let's just use SUB episodes as default but store both in manifest if needed.
            // Actually, the app logic handles sub/dub via the url payload we created.
            if (dubEpisodes.length > 0) {
                // We add dub episodes to the end or interleaved?
                // Standard: the provider handles it.
                result.episodes = episodes.concat(dubEpisodes);
            }

            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    function decryptHex(hex) {
        if (!hex) return "";
        let cleanHex = hex;
        if (cleanHex.startsWith("--")) cleanHex = cleanHex.slice(2);
        if (cleanHex.startsWith("-")) cleanHex = cleanHex.split("-").pop();
        let str = "";
        for (let i = 0; i < cleanHex.length; i += 2) {
            const byte = parseInt(cleanHex.substring(i, i + 2), 16);
            str += String.fromCharCode(byte ^ 56);
        }
        return str;
    }

    function getHostName(url) {
        try {
            const host = new URL(url.startsWith("//") ? ("https:" + url) : url).hostname;
            const parts = host.split(".");
            return parts.length >= 2 ? parts[parts.length - 2] : host;
        } catch (_) {
            return "source";
        }
    }

    function qualityFromText(text) {
        const value = String(text || "").toLowerCase();
        if (/(^|[^0-9])2160p([^0-9]|$)|(^|[^a-z0-9])4k([^a-z0-9]|$)|(^|[^a-z0-9])uhd([^a-z0-9]|$)/.test(value)) return 2160;
        if (/(^|[^0-9])1440p([^0-9]|$)|(^|[^a-z0-9])2k([^a-z0-9]|$)/.test(value)) return 1440;
        if (/(^|[^0-9])1080p([^0-9]|$)|(^|[^a-z0-9])fhd([^a-z0-9]|$)/.test(value)) return 1080;
        if (/(^|[^0-9])720p([^0-9]|$)|(^|[^a-z0-9])hd([^a-z0-9]|$)/.test(value)) return 720;
        if (/(^|[^0-9])480p([^0-9]|$)|(^|[^a-z0-9])sd([^a-z0-9]|$)/.test(value)) return 480;
        if (/(^|[^0-9])360p([^0-9]|$)/.test(value)) return 360;
        if (/sub/.test(value)) return 720;
        return undefined;
    }

    function attachSubtitles(stream, subtitles) {
        if (!subtitles || !subtitles.length) return stream;
        stream.subtitles = subtitles;
        return stream;
    }

    function buildSubtitleList(subtitles) {
        return (subtitles || []).map(function (sub) {
            return {
                name: sub.lang || sub.label || "Unknown",
                url: sub.src || sub.url
            };
        }).filter(function (item) { return item.url; });
    }

    function decodeEscapedString(value) {
        if (!value) return value;
        return String(value)
            .replace(/\\u0026/g, "&")
            .replace(/\\\//g, "/")
            .replace(/\\"/g, "\"")
            .replace(/\\\\/g, "\\");
    }

    function findMediaUrlsInHtml(html) {
        const text = String(html || "");
        const results = [];
        const patterns = [
            /https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/gi,
            /https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/gi,
            /https?:\/\/[^"'\\\s]+\.mpd[^"'\\\s]*/gi
        ];
        patterns.forEach(function (pattern) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                results.push(decodeEscapedString(match[0]));
            }
        });

        const okMeta = text.match(/data-options="([^"]+)"/i);
        if (okMeta) {
            try {
                const decoded = decodeEscapedString(okMeta[1].replace(/&quot;/g, "\""));
                const hlsMatch = decoded.match(/"hlsMasterPlaylistUrl":"([^"]+)"/);
                if (hlsMatch) results.push(decodeEscapedString(hlsMatch[1]));
                const dashMatch = decoded.match(/"metadataEmbedded":"([^"]+)"/);
                if (dashMatch) {
                    const embedded = JSON.parse(decodeURIComponent(dashMatch[1]));
                    const hls = embedded?.hlsMasterPlaylistUrl;
                    const dash = embedded?.metadata?.hlsMasterPlaylistUrl;
                    if (hls) results.push(hls);
                    if (dash) results.push(dash);
                }
            } catch (_) {}
        }

        return Array.from(new Set(results.filter(Boolean)));
    }

    function normalizeSourceUrl(rawUrl, sourceName) {
        if (!rawUrl) return null;
        let url = String(rawUrl).replace(/ /g, "%20");
        if (sourceName === "Ak" || url.includes("/player/vitemb")) {
            try {
                const payload = url.split("=").pop();
                const decoded = JSON.parse(atob(payload));
                url = decoded.idUrl || url;
            } catch (_) {}
        }
        return url;
    }

    async function withTimeout(promise, ms, fallback) {
        let timer;
        const timeoutPromise = new Promise(function (resolve) {
            timer = setTimeout(function () {
                resolve(fallback);
            }, ms);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            clearTimeout(timer);
        }
    }

    function toAbsoluteUrl(url) {
        if (!url) return null;
        if (url.startsWith("//")) return "https:" + url;
        if (/^https?:\/\//i.test(url)) return url;
        try {
            if (url.includes(".json?")) return API_ENDPOINT + url;
            const queryIndex = url.indexOf("?");
            if (queryIndex === -1) return new URL(url, API_ENDPOINT).toString();
            const path = url.substring(0, queryIndex);
            const query = url.substring(queryIndex + 1);
            return new URL(path + ".json?" + query, API_ENDPOINT).toString();
        } catch (_) {
            return null;
        }
    }

    async function resolveServerRedirect(url) {
        if (!url || !/streamsb\.net/i.test(url)) return url;
        try {
            const res = await http_get(url, HEADERS);
            const match = (res.body || "").match(/window\.location\.replace\('([^']+)'\)/);
            return match ? match[1] : url;
        } catch (_) {
            return url;
        }
    }

    async function resolveEmbeddedSource(url, sourceName, subtitles, streamResults) {
        try {
            const shouldProbe = /vidstreaming|mp4upload|ok\.ru|streamsb/i.test(String(url || ""));
            if (!shouldProbe) return false;
            const res = await withTimeout(http_get(url, {
                ...HEADERS,
                "Referer": "https://allmanga.to/"
            }), 2500, null);
            if (!res || !res.body) return false;
            const mediaUrls = findMediaUrlsInHtml(res.body);
            if (!mediaUrls.length) return false;
            mediaUrls.forEach(function (mediaUrl) {
                const stream = new StreamResult({
                    url: mediaUrl,
                    source: `AllAnime - ${sourceName || getHostName(url)}`,
                    quality: qualityFromText(mediaUrl) || qualityFromText(sourceName),
                    headers: {
                        ...HEADERS,
                        "Referer": url
                    }
                });
                streamResults.push(attachSubtitles(stream, subtitles));
            });
            return true;
        } catch (_) {
            return false;
        }
    }

    async function resolveSourceEntries(source, streamResults) {
        let rawLink = source.sourceUrl;
        if (!rawLink) return;
        const downloadSubtitles = buildSubtitleList(source?.subtitles);

        let link = String(rawLink).startsWith("--") || String(rawLink).startsWith("-")
            ? decryptHex(rawLink)
            : rawLink;
        link = normalizeSourceUrl(link, source.sourceName);
        if (!link) return;

        if (!/^https?:\/\//i.test(link) && !link.startsWith("//")) {
            const fixedLink = toAbsoluteUrl(link);
            if (!fixedLink) return;
            try {
                const jsonRes = await withTimeout(http_get(fixedLink, HEADERS), 2500, null);
                if (!jsonRes || !jsonRes.body) return;
                const videoData = JSON.parse(jsonRes.body || "{}");
                const links = videoData.links || [];
                const subtitles = buildSubtitleList(videoData.subtitles);
                links.forEach(function (l) {
                    if (!l.link) return;
                    const referer = l.headers?.referer;
                    const stream = new StreamResult({
                        url: l.link,
                        source: `AllAnime - ${getHostName(l.link)}${l.resolutionStr ? " (" + l.resolutionStr + ")" : ""}`,
                        quality: qualityFromText(l.resolutionStr) || qualityFromText(l.link),
                        headers: referer ? { ...HEADERS, "Referer": referer } : HEADERS
                    });
                    streamResults.push(attachSubtitles(stream, subtitles));
                });
            } catch (_) {}
        } else {
            const fixed = link.startsWith("//") ? ("https:" + link) : link;
            const finalUrl = await resolveServerRedirect(fixed);
            const extracted = await resolveEmbeddedSource(finalUrl, source.sourceName || getHostName(finalUrl), downloadSubtitles, streamResults);
            if (!extracted) {
                streamResults.push(new StreamResult({
                    url: finalUrl,
                    source: `AllAnime - ${source.sourceName || getHostName(finalUrl)}`,
                    quality: qualityFromText(source.sourceName) || qualityFromText(finalUrl),
                    headers: HEADERS
                }));
            }
        }

        const downloadUrl = source.downloads?.downloadUrl;
        if (downloadUrl && /^https?:\/\//i.test(downloadUrl)) {
            const downloadId = downloadUrl.includes("id=") ? downloadUrl.substring(downloadUrl.indexOf("id=") + 3) : "";
            if (!downloadId) return;
            try {
                const clockRes = await withTimeout(http_get(`https://allanime.day/apivtwo/clock.json?id=${downloadId}`, HEADERS), 2500, null);
                if (!clockRes || !clockRes.body) return;
                const clockData = JSON.parse(clockRes.body || "{}");
                (clockData.links || []).forEach(function (item) {
                    if (!item.link) return;
                    streamResults.push(new StreamResult({
                        url: item.link,
                        source: `AllAnime [${String(source.downloads?.sourceName || source.sourceName || "Download")}]`,
                        quality: qualityFromText(item.link) || qualityFromText(source.downloads?.sourceName) || 1080,
                        headers: HEADERS
                    }));
                });
            } catch (_) {}
        }
    }

    async function loadStreams(url, cb) {
        try {
            const data = JSON.parse(url);
            const variables = {
                showId: data.hash,
                translationType: data.dubStatus,
                episodeString: data.episode.toString()
            };

            const res = await queryGraph(variables, HASHES.server, "GET");
            const sources = res.data?.episode?.sourceUrls || [];

            const streamResults = [];
            await Promise.all(sources.map(function (source) {
                return resolveSourceEntries(source, streamResults);
            }));

            const deduped = [];
            const seen = new Set();
            streamResults.forEach(item => {
                const key = `${item.url}|${item.source}`;
                if (seen.has(key)) return;
                seen.add(key);
                deduped.push(item);
            });
            cb({ success: true, data: deduped });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message });
        }
    }

    // Export
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
