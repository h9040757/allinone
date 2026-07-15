(function () {
    var BASE_URL = "https://api.kartoons.me/api/stremio";
    var token = "1KU9SIVqjWVcBW7YKcXj6jHYBAc7aCbD6ySMQSc0MHQ"; // Default fallback token

    // Initialize the plugin
    function init() {
        // Parse token from parameter if available
        var param = TVXServices.tools.getPluginParameter();
        if (param && param.indexOf("token=") !== -1) {
            token = param.split("token=")[1];
        }
        
        // Load the initial category menu
        loadManifest();
    }

    // Fetch Manifest to discover available catalogs/categories
    function loadManifest() {
        var url = BASE_URL + "/manifest.json?token=" + token;
        
        TVXServices.ajax.get({
            url: url,
            success: function (data) {
                try {
                    var manifest = JSON.parse(data);
                    buildMainMenu(manifest.catalogs || []);
                } catch (e) {
                    TVXServices.warn("Error parsing manifest: " + e.message);
                    fallbackMenu();
                }
            },
            error: function (err) {
                TVXServices.warn("Failed to load manifest. Access may be restricted.");
                fallbackMenu();
            }
        });
    }

    // Build the main menu using catalogs from the manifest
    function buildMainMenu(catalogs) {
        var menuItems = [];

        catalogs.forEach(function (catalog) {
            menuItems.push({
                label: catalog.name || catalog.id,
                icon: "folder",
                action: "link:javascript:loadCatalog('" + catalog.type + "', '" + catalog.id + "')"
            });
        });

        TVXServices.start({
            menu: menuItems,
            placeholder: "Select Category"
        });
    }

    // Load content items inside a specific category (Catalog)
    window.loadCatalog = function (type, id) {
        var url = BASE_URL + "/catalog/" + type + "/" + id + ".json?token=" + token;

        TVXServices.ajax.get({
            url: url,
            success: function (data) {
                try {
                    var response = JSON.parse(data);
                    var metas = response.metas || [];
                    buildContentGrid(metas);
                } catch (e) {
                    TVXServices.warn("Error parsing catalog items: " + e.message);
                }
            },
            error: function () {
                TVXServices.warn("Failed to retrieve content for category: " + id);
            }
        });
    };

    // Build grid layout for content items
    function buildContentGrid(metas) {
        var items = [];

        metas.forEach(function (meta) {
            items.push({
                label: meta.name,
                image: meta.poster,
                type: "button",
                action: "link:javascript:loadDetails('" + meta.type + "', '" + meta.id + "')"
            });
        });

        TVXServices.navigate({
            items: items,
            layout: "grid",
            title: "Content List"
        });
    }

    // Load details and streams for a specific item
    window.loadDetails = function (type, id) {
        var url = BASE_URL + "/stream/" + type + "/" + id + ".json?token=" + token;

        TVXServices.ajax.get({
            url: url,
            success: function (data) {
                try {
                    var response = JSON.parse(data);
                    var streams = response.streams || [];
                    
                    if (streams.length > 0) {
                        // Play the first available working stream quality/link
                        playVideo(streams[0]);
                    } else {
                        TVXServices.warn("No streams found for this content.");
                    }
                } catch (e) {
                    TVXServices.warn("Error parsing stream metadata: " + e.message);
                }
            },
            error: function () {
                TVXServices.warn("Failed to fetch streams.");
            }
        });
    };

    // Playback integration
    function playVideo(stream) {
        var playUrl = stream.url;
        if (!playUrl && stream.externalUrl) {
            playUrl = stream.externalUrl;
        }

        if (playUrl) {
            TVXServices.play({
                url: playUrl,
                title: stream.title || "Playing Video"
            });
        } else {
            TVXServices.warn("No valid media URL found in the stream response.");
        }
    }

    // Fallback menu in case of API failure or token mismatch
    function fallbackMenu() {
        TVXServices.start({
            menu: [
                {
                    label: "Check API / Token",
                    icon: "warning",
                    action: "info:Please verify your connection and token validity."
                }
            ]
        });
    }

    // Register initialization
    TVXServices.onReady(function () {
        init();
    });
})();
