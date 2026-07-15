async function getHome(cb) {
        try {
            const base = getBaseApiUrl();
            const token = getToken();
            const manifestUrl = `${base}/manifest.json?token=${token}`;
            const res = await http_get(manifestUrl, HEADERS);
            const manifestData = JSON.parse(res.body || "{}");
            const catalogs = manifestData.catalogs || [];

            const defaultCatalogs = catalogs.length > 0 ? catalogs : [
                { id: "kartoons-movies", type: "movie", name: "Kartoons Movies" },
                { id: "kartoons-shows", type: "series", name: "Kartoons Shows" }
            ];

            const results = await mapLimit(defaultCatalogs, 3, async (cat, index) => {
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

                    // Force custom group names based on type and position
                    let displayName = cat.name;
                    if (cat.type === "movie") {
                        // If there are multiple movie catalogs, we can split them
                        displayName = index === 0 ? "Trending Now" : "Popular Movies";
                    } else if (cat.type === "series") {
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