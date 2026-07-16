(function() {
    "use strict";

    var BASE_URL = (typeof manifest !== "undefined" && manifest && manifest.baseUrl) || "https://anichi.to";
    var IMG_URL = "https://anichi.to";

    var API_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL + "/home",
        "Cookie": "country_code=IN; prefered_server_type=sub"
    };

    var POST_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL + "/",
        "Origin": BASE_URL
    };

    function absUrl(path) {
        if (!path) return "";
        if (/^https?:\/\//i.test(path)) return path;
        if (path.indexOf("//") === 0) return "https:" + path;
        return IMG_URL + path;
    }

    function parseJsonSafe(text, fallback) {
        try {
            return JSON.parse(String(text || ""));
        } catch (e) {
            return fallback;
        }
    }

    function cleanHtml(value) {
        return String(value || "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#039;/g, "'")
            .replace(/&nbsp;/g, " ")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s{2,}/g, " ")
            .trim();
    }

    function guessType(typeText) {
        typeText = String(typeText || "").toLowerCase();
        if (typeText.indexOf("movie") !== -1) return "movie";
        return "anime";
    }

    async function httpGetJson(url, customHeaders) {
        try {
            var res = await http_get(url, customHeaders || API_HEADERS);
            var body = res && (res.body || res.text) ? String(res.body || res.text) : "";
            return parseJsonSafe(body, null);
        } catch (e) {
            return null;
        }
    }

    async function httpGetText(url, customHeaders) {
        try {
            var res = await http_get(url, customHeaders || API_HEADERS);
            return res && (res.body || res.text) ? String(res.body || res.text) : "";
        } catch (e) {
            return "";
        }
    }

    function parseCardsFromHtml(html) {
        var cards = [];
        // Matches common card structures inside Zoro/HiAnime/Anichi clones
        var cardRegex = /<div\s+class="[^"]*flw-item[^"]*"[\s\S]*?<a\s+href="([^"]+)"\s+class="[^"]*film-poster-ahref[^"]*"[\s\S]*?<img\s+[^>]*(?:data-src|src)="([^"]+)"[\s\S]*?<a\s+[^>]*class="[^"]*dynamic-name[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        var match;
        while ((match = cardRegex.exec(html)) !== null) {
            cards.push(new MultimediaItem({
                title: cleanHtml(match[3]),
                url: absUrl(match[1]),
                posterUrl: absUrl(match[2]),
                type: "anime"
            }));
        }

        if (cards.length === 0) {
            // General fallback matching logic
            var fallbackRegex = /<a\s+href="(\/watch\/[^"]+)"[^>]*>[\s\S]*?<img\s+[^>]*(?:data-src|src)="([^"]+)"[\s\S]*?alt="([^"]+)"/gi;
            while ((match = fallbackRegex.exec(html)) !== null) {
                cards.push(new MultimediaItem({
                    title: cleanHtml(match[3]),
                    url: absUrl(match[1]),
                    posterUrl: absUrl(match[2]),
                    type: "anime"
                }));
            }
        }
        return cards;
    }

    async function getHome(cb) {
        try {
            var result = {};

            // 1. Scrape Featured/Trending from Home Page
            var homeHtml = await httpGetText(BASE_URL + "/home");
            var trending = parseCardsFromHtml(homeHtml);
            if (trending.length) {
                result["Trending"] = trending.slice(0, 24);
            }

            // 2. Load "Recently Updated" from widget endpoint
            var updatedWidget = await httpGetJson(BASE_URL + "/ajax/home/widget/updated-all?page=1");
            if (updatedWidget && updatedWidget.html) {
                var updatedItems = parseCardsFromHtml(updatedWidget.html);
                if (updatedItems.length) {
                    result["Recently Updated"] = updatedItems;
                }
            }

            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: String(e.message || e) });
        }
    }

    async function search(query, cb) {
        try {
            if (!query || !query.trim()) return cb({ success: true, data: [] });
            var searchUrl = BASE_URL + "/search?keyword=" + encodeURIComponent(query.trim());
            var html = await httpGetText(searchUrl);
            var items = parseCardsFromHtml(html);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e.message || e) });
        }
    }

    async function load(url, cb) {
        try {
            var html = await httpGetText(url);
            
            // Extract Anichi's internal anime ID (used for retrieving AJAX episode lists)
            var idMatch = html.match(/data-id=["'](\d+)["']/i) || html.match(/id=["']watch-main["']\s+data-id=["'](\d+)["']/i);
            if (!idMatch) throw new Error("Anichi anime reference ID not found.");
            var animeId = idMatch[1];

            var titleMatch = html.match(/<h2\s+class="[^"]*film-name[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) 
                          || html.match(/<title>([\s\S]*?)<\/title>/i);
            var title = titleMatch ? cleanHtml(titleMatch[1]).replace(/Watch Anime Online.*/i, "") : "Anime";
            
            var posterMatch = html.match(/<img\s+[^>]*class="[^"]*film-poster-img[^"]*"[^>]*(?:data-src|src)="([^"]+)"/i);
            var poster = posterMatch ? absUrl(posterMatch[1]) : "";

            var descMatch = html.match(/<div\s+class="[^"]*text[^"]*">([\s\S]*?)<\/div>/i);
            var description = descMatch ? cleanHtml(descMatch[1]) : "";

            // Retrieve episodes list from Anichi's API
            var epJson = await httpGetJson(BASE_URL + "/ajax/v2/episode/list/" + animeId);
            var episodes = [];

            if (epJson && epJson.html) {
                var epRegex = /<a\s+[^>]*href="([^"]+)"\s+data-id="(\d+)"\s+title="([^"]+)"\s+class="[^"]*ep-item[^"]*"[^>]*>[\s\S]*?\<span\s+class="ss-no">(\d+)<\/span>/gi;
                var match;
                while ((match = epRegex.exec(epJson.html)) !== null) {
                    var epNum = Number(match[4]) || episodes.length + 1;
                    episodes.push(new Episode({
                        name: cleanHtml(match[3]) || ("Episode " + epNum),
                        url: JSON.stringify({ watchUrl: absUrl(match[1]), episodeId: match[2], episodeNum: epNum }),
                        season: 1,
                        episode: epNum,
                        posterUrl: poster,
                        headers: { "Referer": BASE_URL + "/" }
                    }));
                }
            }

            if (!episodes.length) {
                episodes.push(new Episode({
                    name: "Episode 1",
                    url: JSON.stringify({ watchUrl: url, episodeId: animeId, episodeNum: 1 }),
                    season: 1,
                    episode: 1,
                    posterUrl: poster,
                    headers: { "Referer": BASE_URL + "/" }
                }));
            }

            var item = new MultimediaItem({
                title: title,
                url: url,
                posterUrl: poster,
                type: guessType(title),
                description: description,
                headers: { "Referer": BASE_URL + "/" },
                episodes: episodes
            });

            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: String(e.message || e) });
        }
    }

    function normalizeSubtitles(tracks) {
        if (!tracks || !Array.isArray(tracks) || !tracks.length) return [];
        var out = [];
        var seen = {};
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            var url = t.url || t.file || t.src || "";
            if (!url || seen[url]) continue;
            seen[url] = true;
            var label = t.label || t.name || t.lang || t.language || "English";
            var lang = t.language || t.srclang || t.lang || "en";
            out.push({ url: url, label: label, lang: lang });
        }
        return out;
    }

    async function loadStreams(data, cb) {
        try {
            var episodeId = null;
            var watchUrl = BASE_URL + "/home";

            if (typeof data === "object" && data !== null) {
                episodeId = data.episodeId;
                watchUrl = data.watchUrl || watchUrl;
            } else if (typeof data === "string") {
                var parsed = parseJsonSafe(data, null);
                if (parsed && parsed.episodeId) {
                    episodeId = parsed.episodeId;
                    watchUrl = parsed.watchUrl || watchUrl;
                } else {
                    throw new Error("Episode payload needs mapping with episodeId and watchUrl");
                }
            }

            if (!episodeId) throw new Error("Missing active episode ID context.");

            // Fetch list of available streaming servers from Anichi
            var serverListJson = await httpGetJson(BASE_URL + "/ajax/v2/episode/servers?episodeId=" + episodeId);
            var streams = [];

            if (serverListJson && serverListJson.html) {
                // Parse server configurations (subbed/dubbed instances)
                var serverRegex = /<div\s+[^>]*class="[^"]*server-item[^"]*"\s+data-id="(\d+)"\s+data-type="([^"]+)"[^>]*>([\s\S]*?)<\/div>/gi;
                var match;
                while ((match = serverRegex.exec(serverListJson.html)) !== null) {
                    var serverId = match[1];
                    var type = match[2].toUpperCase(); // SUB or DUB
                    var serverName = cleanHtml(match[3]) || "Server";

                    // Fetch sources info endpoint for specific server
                    var sourceJson = await httpGetJson(BASE_URL + "/ajax/v2/episode/sources?id=" + serverId);
                    if (sourceJson && sourceJson.link) {
                        var embedUrl = sourceJson.link;

                        // Resolve Megaplay source integrations directly
                        if (/megaplay\.buzz/i.test(embedUrl)) {
                            var idMatch = embedUrl.match(/id=(\d+)/) || embedUrl.match(/\/s-\d+\/(\d+)/);
                            var mediaId = idMatch ? idMatch[1] : "";
                            if (mediaId) {
                                var sourcesUrl = "https://megaplay.buzz/stream/getSourcesNew?id=" + mediaId;
                                var hostHeaders = {
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
                                    "Referer": embedUrl
                                };
                                var streamData = await httpGetJson(sourcesUrl, hostHeaders);
                                if (streamData && streamData.sources) {
                                    var sourcesList = Array.isArray(streamData.sources) ? streamData.sources : [streamData.sources];
                                    for (var s = 0; s < sourcesList.length; s++) {
                                        var src = sourcesList[s];
                                        if (src.file || src.url) {
                                            var subtitles = normalizeSubtitles(streamData.tracks || streamData.subtitles);
                                            var stream = new StreamResult({
                                                url: src.file || src.url,
                                                source: "Anichi Megaplay [" + type + "] (" + serverName + ")",
                                                headers: hostHeaders
                                            });
                                            if (subtitles.length) stream.subtitles = subtitles;
                                            streams.push(stream);
                                        }
                                    }
                                }
                            }
                        } else {
                            // Standard stream entry fallback if redirecting to generic iframe
                            streams.push(new StreamResult({
                                url: embedUrl,
                                source: "Anichi [" + type + "] (" + serverName + ")",
                                headers: { "Referer": BASE_URL + "/" }
                            }));
                        }
                    }
                }
            }

            if (!streams.length) throw new Error("No playback streams found.");

            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(e.message || e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
