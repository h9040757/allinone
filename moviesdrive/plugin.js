(function() {
    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // var manifest is injected at runtime

    class JNode {
        constructor(tag = null, attrs = {}, parent = null) {
            this.tag = tag;
            this.attrs = attrs;
            this.parent = parent;
            this.children = [];
            this.ownText = "";
        }
        attr(name) { return this.attrs[name] || ""; }
        textContent() {
            if (!this.tag) return this.ownText;
            let t = "";
            for (const c of this.children) t += c.textContent();
            return t;
        }
        text() { return this.textContent(); }
        html() { return this.children.map(c => c.outerHTML()).join(""); }
        outerHTML() {
            if (!this.tag) return this.ownText;
            const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
            return `<${this.tag}${attrs}>${this.html()}</${this.tag}>`;
        }
        matches(selector) {
            if (!this.tag) return false;
            selector = String(selector || "").trim();
            if (!selector) return false;

            const idMatch = selector.match(/^([a-z0-9-]*)#([a-z0-9_-]+)$/i);
            if (idMatch) {
                const [, tagName, id] = idMatch;
                return (!tagName || this.tag === tagName.toLowerCase()) && this.attrs.id === id;
            }
            if (selector.startsWith("#")) return this.attrs.id === selector.slice(1);

            const attrMatch = selector.match(/^([a-z0-9-]*)\[([a-z0-9-]+)(?:[*^$]?=(["']?)([^"'\]]+)\3)?\]$/i);
            if (attrMatch) {
                const [, tagName, attrName, , attrValue] = attrMatch;
                if (tagName && this.tag !== tagName.toLowerCase()) return false;
                const actual = this.attr(attrName.toLowerCase());
                return attrValue === undefined ? actual !== "" : actual.includes(attrValue);
            }

            const parts = selector.split(".");
            const tagName = parts[0];
            const classes = parts.slice(1).filter(Boolean);
            if (classes.length > 0) {
                const tagMatch = !tagName || this.tag === tagName.toLowerCase();
                const nodeClasses = (this.attrs.class || "").split(/\s+/);
                return tagMatch && classes.every(c => nodeClasses.includes(c));
            }

            return this.tag === selector.toLowerCase();
        }
        collect(selector, out) {
            for (const c of this.children) {
                if (c.matches(selector)) out.push(c);
                c.collect(selector, out);
            }
        }
        selectFirst(selector) {
            const matches = this.select(selector);
            return matches[0] || null;
        }
        first() { return this; }
        find(selector) { return this.selectFirst(selector); }
        select(selector, out = []) {
            selector = String(selector || "").trim();
            if (!selector) return out;
            if (selector.includes(">")) {
                const parts = selector.split(">").map(s => s.trim()).filter(Boolean);
                let current = [this];
                parts.forEach((part, idx) => {
                    const next = [];
                    current.forEach(node => {
                        if (idx === 0) {
                            node.collect(part, next);
                        } else {
                            node.children.forEach(child => {
                                if (child.matches && child.matches(part)) next.push(child);
                            });
                        }
                    });
                    current = next;
                });
                out.push(...current);
                return out;
            }
            if (selector.includes(" ")) {
                let current = [this];
                selector.split(/\s+/).forEach(part => {
                    const next = [];
                    current.forEach(node => node.collect(part, next));
                    current = next;
                });
                out.push(...current);
                return out;
            }
            for (const c of this.children) {
                if (c.matches(selector)) out.push(c);
                c.select(selector, out);
            }
            return out;
        }
    }

    class JsoupLite {
        constructor(html) {
            this.root = new JNode("root");
            let current = this.root;
            const re = /<\/?[a-z0-9]+(?:\s+[a-z0-9-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>|[^<]+/gi;
            let m;
            while ((m = re.exec(html))) {
                const token = m[0];
                if (token.startsWith("</")) {
                    if (current.parent) current = current.parent;
                    continue;
                }
                if (token.startsWith("<")) {
                    const tagNameMatch = token.match(/^<([a-z0-9]+)/i);
                    const tag = tagNameMatch ? tagNameMatch[1].toLowerCase() : "unknown";
                    const selfClosing = token.endsWith("/>") || /^(?:img|br|hr|input|meta|link)$/i.test(tag);
                    
                    const attrs = {};
                    const attrRe = /([a-z0-9-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
                    let am;
                    while ((am = attrRe.exec(token))) {
                        attrs[am[1].toLowerCase()] = am[2] || am[3] || am[4];
                    }
                    
                    const node = new JNode(tag, attrs, current);
                    current.children.push(node);
                    if (!selfClosing) {
                        current = node;
                        if (tag === "script" || tag === "style") {
                            const endTag = `</${tag}>`;
                            const endIndex = html.indexOf(endTag, re.lastIndex);
                            if (endIndex !== -1) {
                                const content = html.substring(re.lastIndex, endIndex);
                                const t = new JNode(null, {}, current);
                                t.text = content;
                                current.children.push(t);
                                re.lastIndex = endIndex + endTag.length;
                                current = current.parent;
                            }
                        }
                    }
                    continue;
                }
                const text = token.replace(/&nbsp;/g, " ").trim();
                if (text) {
                    const t = new JNode(null, {}, current);
                    t.ownText = text;
                    current.children.push(t);
                }
            }
        }
        find(selector) { return this.root.find(selector); }
        select(selector) { return this.root.select(selector); }
        static parse(html) { return new JsoupLite(html); }
    }

    const CommonHeaders = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36" };
    const MetaUrl = "https://aiometadata.elfhosted.com/stremio/9197a4a9-2f5b-4911-845e-8704c520bdf7/meta";
    const DomainConfigUrl = "https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json";
    let cachedBaseUrl = null;

    async function getBaseUrl() {
        if (cachedBaseUrl) return cachedBaseUrl;
        const fallback = String(manifest.baseUrl || "https://moviesdrive.forum").replace(/\/+$/, "");
        try {
            const res = await http_get(DomainConfigUrl, CommonHeaders);
            const remote = JSON.parse(res?.body || "{}").moviesdrive;
            cachedBaseUrl = String(remote || fallback).replace(/\/+$/, "");
        } catch {
            cachedBaseUrl = fallback;
        }
        return cachedBaseUrl;
    }

    function fixUrl(u, base) {
        if (!u) return "";
        if (u.startsWith("//")) return "https:" + u;
        if (u.startsWith("/")) return (base || cachedBaseUrl || String(manifest.baseUrl || "").replace(/\/+$/, "")) + u;
        try {
            const parsed = new URL(u, base || cachedBaseUrl || manifest.baseUrl);
            return parsed.href;
        } catch {}
        return u;
    }

    function getQuality(t) {
        if (!t) return "Auto";
        const l = t.toLowerCase();
        if (l.includes("2160p") || l.includes("4k")) return "4K";
        if (l.includes("1080p")) return "1080p";
        if (l.includes("720p")) return "720p";
        if (l.includes("480p")) return "480p";
        return "Auto";
    }

    function unescapeHTML(str) {
        if (!str) return "";
        return str.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
                  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                  .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—");
    }

    function cleanText(value) {
        return unescapeHTML(String(value || "")).replace(/\s+/g, " ").trim();
    }

    function inferType(title) {
        return /episode|season\s*\d+|series/i.test(String(title || "")) ? "series" : "movie";
    }

    function toSearchItemFromAnchor(anchor, baseUrl) {
        const title = cleanText((anchor.find("p") || anchor.find("h2") || anchor.find("h3") || anchor.find(".poster-title"))?.text())
            .replace(/^Download\s+/i, "");
        const href = fixUrl(anchor.attr("href"), baseUrl);
        const img = anchor.find("img");
        const poster = fixUrl(img?.attr("src") || img?.attr("data-src"), baseUrl);
        if (!href || !title || href.includes("javascript")) return null;
        return new MultimediaItem({ title, url: href, posterUrl: poster, type: inferType(title) });
    }

    function parseCards(html, baseUrl) {
        const doc = JsoupLite.parse(html);
        const items = [];
        const seen = new Set();
        ["#moviesGridMain > a", "a.movie-card", "a.poster-card"].flatMap(selector => doc.select(selector)).forEach(anchor => {
            const item = toSearchItemFromAnchor(anchor, baseUrl);
            if (!item || seen.has(item.url)) return;
            seen.add(item.url);
            items.push(item);
        });

        if (items.length > 0) return items;

        const cardRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?(?:movie-card|poster-card|<p>)[\s\S]*?)<\/a>/gi;
        let cm;
        while ((cm = cardRe.exec(html))) {
            const href = fixUrl(cm[1], baseUrl);
            const content = cm[2];
            const titleMatch = /<(?:p|h\d)[^>]*>([\s\S]*?)<\/(?:p|h\d)>/.exec(content);
            const imgMatch = /<img[^>]+(?:src|data-src)="([^"]+)"/.exec(content);
            const title = cleanText((titleMatch ? titleMatch[1] : "").replace(/<[^>]+>/g, "")).replace(/^Download\s+/i, "");
            const poster = imgMatch ? fixUrl(imgMatch[1], baseUrl) : "";
            if (!href || !title || seen.has(href) || href.includes("javascript")) continue;
            seen.add(href);
            items.push(new MultimediaItem({ title, url: href, posterUrl: poster, type: inferType(title) }));
        }

        return items;
    }

    async function fetchAioMeta(imdbId, type) {
        if (!imdbId) return null;
        try {
            const metaRes = await http_get(`${MetaUrl}/${type}/${imdbId}.json`, CommonHeaders);
            return JSON.parse(metaRes?.body || "{}").meta || null;
        } catch {
            return null;
        }
    }

    async function fetchMany(requests) {
        const normalized = requests.map(req => ({
            url: req.url,
            headers: req.headers || CommonHeaders,
            meta: req.meta
        }));

        if (typeof http_parallel === "function") {
            try {
                const responses = await http_parallel(normalized.map(req => ({ url: req.url, headers: req.headers })));
                if (Array.isArray(responses)) {
                    return responses.map((response, index) => ({ ...(response || {}), meta: normalized[index].meta }));
                }
            } catch {}
        }

        return await Promise.all(normalized.map(async req => {
            try {
                const response = await http_get(req.url, req.headers);
                return { ...(response || {}), meta: req.meta };
            } catch {
                return { body: "", meta: req.meta };
            }
        }));
    }

    function makeActor(castMember) {
        if (!castMember?.name) return null;
        try {
            if (typeof Actor !== "undefined") {
                return new Actor({ name: castMember.name, role: castMember.character, image: castMember.photo });
            }
        } catch {}
        return { name: castMember.name, role: castMember.character, image: castMember.photo };
    }

    function buildMetaData(meta, fallback) {
        const cast = (meta?.app_extras?.cast || []).map(makeActor).filter(Boolean);
        const syncData = {};
        if (meta?.imdb_id || fallback.imdbId) syncData.imdb = meta?.imdb_id || fallback.imdbId;
        if (meta?.moviedb_id) syncData.tmdb = String(meta.moviedb_id);
        return {
            title: meta?.name || fallback.title,
            posterUrl: meta?.poster || fallback.poster,
            bannerUrl: meta?.background || fallback.poster,
            description: meta?.description || "",
            tags: meta?.genre || undefined,
            score: parseFloat(meta?.imdbRating) || undefined,
            year: parseInt(meta?.year, 10) || undefined,
            logoUrl: meta?.logo || undefined,
            cast: cast.length ? cast : undefined,
            syncData
        };
    }

    function episodeMeta(meta, season, episode) {
        return (meta?.videos || []).find(v => Number(v?.season) === Number(season) && Number(v?.episode) === Number(episode)) || null;
    }

    function previousElementText(node) {
        const parent = node?.parent;
        if (!parent) return "";
        const index = parent.children.indexOf(node);
        for (let i = index - 1; i >= 0; i--) {
            if (parent.children[i]?.tag) return parent.children[i].text();
        }
        return "";
    }

    function findSeason(value) {
        return parseInt(String(value || "").match(/(?:Season|S)\s*(\d+)/i)?.[1] || "1", 10) || 1;
    }

    function findEpisode(value, fallback) {
        return parseInt(String(value || "").match(/(?:Ep|Episode)\s*0*(\d+)/i)?.[1] || "", 10) || fallback;
    }

    function parseSources(dataStr) {
        try {
            const parsed = JSON.parse(dataStr);
            return Array.isArray(parsed) ? parsed : [];
        } catch {}

        const text = String(dataStr || "");
        const out = [];
        const objectRe = /\{([^{}]+)\}/g;
        let match;
        while ((match = objectRe.exec(text))) {
            const body = match[1];
            const source = body.match(/source\s*:\s*([^,\]}]+)/i)?.[1]?.trim();
            const quality = body.match(/quality\s*:\s*([^,\]}]+)/i)?.[1]?.trim();
            if (source) out.push({ source, quality });
        }
        if (out.length > 0) return out;
        return /^https?:\/\//i.test(text.trim()) ? [{ source: text.trim(), quality: "Auto" }] : [];
    }

    function base64Decode(str) {
        try {
            return Buffer.from(str, 'base64').toString('utf8');
        } catch { return ""; }
    }

    function pen(v) {
        if (!v) return "";
        let out = "";
        for (let i = 0; i < v.length; i++) {
            const c = v[i];
            if (c >= 'A' && c <= 'Z') out += String.fromCharCode(((c.charCodeAt(0) - 65 + 13) % 26) + 65);
            else if (c >= 'a' && c <= 'z') out += String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97);
            else out += c;
        }
        return out;
    }



    async function extractHubCloud(url, qual) {
        try {
            const headers = { ...CommonHeaders, "Cookie": "xla=s4t" };

            const res = await http_get(url, headers);
            if (!res || !res.body) {
                if (url.includes("gdlink")) {
                    return [{ url: url, name: "GdLink", quality: qual }];
                }
                return [];
            }
            
            // Check if we're already on a page with download buttons (like gamerxyt)
            if (url.includes("gamerxyt.com") || res.body.includes("Download Link Generated")) {
                return extractFinalButtons(res.body, qual);
            }

            const doc = JsoupLite.parse(res.body);
            const nextUrl = fixUrl(doc.find("#download")?.attr("href") || "");
            if (nextUrl) {
                const res2 = await http_get(nextUrl, { ...headers, "Referer": url });
                if (res2 && res2.body) {
                    return extractFinalButtons(res2.body, qual);
                }
            }
            
            // gdlink fallback: if no hubcloud pattern matched, passthrough the URL
            if (url.includes("gdlink")) {
                return [{ url: url, name: "GdLink", quality: qual }];
            }
        } catch {
            if (url.includes("gdlink")) return [{ url: url, name: "GdLink", quality: qual }];
        }
        return [];
    }

    function extractFinalButtons(html, qual) {
        const doc = JsoupLite.parse(html);
        const results = [];
        const links = doc.select("a");
        links.forEach(link => {
            const href = fixUrl(link.attr("href"));
            const text = link.text().toLowerCase();
            const isBtn = (link.attr("class") || "").includes("btn");
            if (isBtn && (text.includes("fsl server") || text.includes("fslv2") || text.includes("download file") || text.includes("s3 server") || text.includes("mega server"))) {
                results.push({ url: href, name: "HubCloud", quality: qual, info: link.text().trim() });
            } else if (text.includes("pixeldrain") || text.includes("pixel server")) {
                const idMatch = /\/u\/([a-zA-Z0-9]+)/.exec(href);
                if (idMatch) results.push({ url: `https://pixeldrain.com/api/file/${idMatch[1]}?download`, name: "PixelDrain", quality: qual });
            }
        });
        return results;
    }

    async function getHome(cb) {
        const cats = [
            { title: "Home", url: "/page/" },
            { title: "Prime Video", url: "/category/amzn-prime-video/page/" },
            { title: "Netflix", url: "/category/netflix/page/" },
            { title: "Hotstar", url: "/category/hotstar/page/" },
            { title: "Anime", url: "/category/anime/page/" },
            { title: "K Drama", url: "/category/k-drama/page/" }
        ];
        
        try {
            const baseUrl = await getBaseUrl();
            const pages = await fetchMany(cats.map(cat => ({ url: `${baseUrl}${cat.url}1`, headers: CommonHeaders, meta: cat })));
            const results = {};
            pages.forEach(page => {
                const title = page.meta.title;
                const items = page.body ? parseCards(page.body, baseUrl) : [];
                if (items.length > 0) results[title] = items;
            });
            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "SITE_OFFLINE", message: e.message });
        }
    }

    async function search(query, cb) {
        try {
            const baseUrl = await getBaseUrl();
            const res = await http_get(`${baseUrl}/search.php?q=${encodeURIComponent(query)}&page=1`, CommonHeaders);
            if (res && res.body) {
                const data = JSON.parse(res.body);
                const items = [];
                if (data.hits && Array.isArray(data.hits)) {
                    data.hits.forEach(hit => {
                        const d = hit.document;
                        const title = cleanText(d.post_title).replace(/^Download\s+/i, "");
                        const href = fixUrl(d.permalink, baseUrl);
                        const poster = fixUrl(d.post_thumbnail, baseUrl);
                        
                        if (href && title) {
                            items.push(new MultimediaItem({
                                title,
                                url: href,
                                posterUrl: poster,
                                type: inferType(title)
                            }));
                        }
                    });
                }
                return cb({ success: true, data: items });
            }
            cb({ success: true, data: [] });
        } catch {
            cb({ success: true, data: [] });
        }
    }

    async function load(url, cb) {
        try {
            const baseUrl = await getBaseUrl();
            const res = await http_get(url, CommonHeaders);
            if (!res || !res.body) return cb({ success: false, errorCode: "SITE_OFFLINE", message: "Failed to load page" });
            
            const doc = JsoupLite.parse(res.body);
            let title = cleanText(doc.find("title")?.text()).replace(/\s*[-|]\s*MoviesDrive.*$/i, "").replace(/^Download\s+/i, "");
            let poster = fixUrl(doc.find("main > p > img")?.attr("src") || doc.find("img")?.attr("src"), baseUrl);
            const imdbMatch = res.body.match(/imdb\.com\/title\/(tt\d+)/);
            const imdbId = imdbMatch ? imdbMatch[1] : "";
            const isSeries = /episode|season\s*\d+|series/i.test(title);
            const meta = await fetchAioMeta(imdbId, isSeries ? "series" : "movie");
            const metaData = buildMetaData(meta, { title, poster, imdbId });

            const buttons = doc.select("h5 > a").filter(a => a !== null && !/zip/i.test(a.text()));
            const buttonRequests = buttons.map(btn => {
                const btnText = btn.text();
                const headingText = previousElementText(btn.parent) || btnText;
                const btnHref = fixUrl(btn.attr("href"), baseUrl);
                const qual = getQuality(btnText);
                return { url: btnHref, headers: CommonHeaders, meta: { btnText, headingText, qual } };
            });
            const buttonPages = (await fetchMany(buttonRequests)).map(page => ({
                ...page.meta,
                body: page.body || ""
            }));

            const episodeMap = new Map();
            const movieLinks = [];

            buttonPages.forEach(page => {
                if (!page.body) return;
                const sDoc = JsoupLite.parse(page.body);
                const anchors = sDoc.select("a").filter(l => {
                    const href = fixUrl(l.attr("href"), baseUrl);
                    const lText = l.text();
                    return /hubcloud|gdlink/i.test(`${href} ${lText}`);
                });

                let fallbackEpisode = 1;
                anchors.forEach(l => {
                    const href = fixUrl(l.attr("href"), baseUrl);
                    const lText = l.text();
                    const source = { source: href, quality: page.qual };
                    if (!isSeries) {
                        movieLinks.push(source);
                        return;
                    }

                    const idx = page.body.indexOf(l.outerHTML());
                    const context = idx >= 0 ? page.body.substring(Math.max(0, idx - 700), idx + l.outerHTML().length) : `${page.headingText} ${page.btnText} ${lText}`;
                    const season = findSeason(`${page.headingText} ${page.btnText}`);
                    const episode = findEpisode(`${lText} ${context}`, fallbackEpisode);
                    fallbackEpisode = Math.max(fallbackEpisode + 1, episode + 1);
                    const key = `${season}:${episode}`;
                    const list = episodeMap.get(key) || [];
                    if (!list.some(item => item.source === href)) list.push(source);
                    episodeMap.set(key, list);
                });
            });

            const episodes = [];
            if (isSeries) {
                Array.from(episodeMap.entries()).forEach(([key, links]) => {
                    const [season, episode] = key.split(":").map(n => parseInt(n, 10));
                    const epInfo = episodeMeta(meta, season, episode);
                    episodes.push(new Episode({
                        name: epInfo?.name || epInfo?.title || `Episode ${episode}`,
                        season,
                        episode,
                        posterUrl: epInfo?.thumbnail || metaData.posterUrl,
                        description: epInfo?.overview || undefined,
                        airDate: epInfo?.released || undefined,
                        url: JSON.stringify(links)
                    }));
                });
            } else if (movieLinks.length > 0) {
                episodes.push(new Episode({
                    name: "Full Movie",
                    season: 1,
                    episode: 1,
                    url: JSON.stringify(movieLinks),
                    posterUrl: metaData.posterUrl
                }));
            }

            if (episodes.length === 0) return cb({ success: false, errorCode: "PARSE_ERROR", message: "No download links found" });

            episodes.sort((a,b) => (a.season - b.season) || (a.episode - b.episode));
            
            cb({
                success: true,
                data: new MultimediaItem({
                    ...metaData,
                    url,
                    type: isSeries ? "series" : "movie",
                    episodes
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        }
    }

    
        try {
            const sources = parseSources(dataStr);
            if (!Array.isArray(sources)) return cb({ success: true, data: [] });
            
            const nested = await Promise.all(sources.map(async item => {
                const u = item.source;
                const q = item.quality || "HD";
                if (u.includes("hubcloud") || u.includes("gdlink")) {
                    const links = await extractHubCloud(u, q);
                    return links.map(l => {
                        let sourceName = `${l.name} [${l.quality || q}]`;
                        if (l.info) sourceName += ` - ${l.info}`;
                        return new StreamResult({
                            url: l.url,
                            source: sourceName,
                            quality: l.quality || q,
                            headers: CommonHeaders
                        });
                    });
                }
                return [
                    new StreamResult({
                        url: u,
                        source: q.includes("p") || q === "4K" ? q : `${q} Source`,
                        quality: q,
                        headers: CommonHeaders
                    })
                ];
            }));
            const results = nested.flat();
            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: "Failed to parse streams: " + e.message });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
