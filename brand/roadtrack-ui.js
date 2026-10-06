/* Road Track — UI layer over upstream LubeLogger.
 *
 * Appended to wwwroot/js/shared.js at image build time, the same trick the
 * theme uses with site.css: shared.js is loaded by _Layout.cshtml on every
 * page, so this needs no proxy rule and no Razor fork.
 *
 * Three jobs: add the "Access" tab, replace the vehicle Dashboard with our own
 * renderer, and rewrite the three "LubeLogger" strings that are compiled into
 * the Razor views.
 *
 * Those three strings used to be nginx `sub_filter` rules on the reverse
 * proxy. They moved here because a proxy's configuration is easily
 * regenerated from a template — adding a second hostname, or re-running
 * whatever writes it, silently drops hand-added rules and serves
 * "LubeLogger" again. In JS the branding follows the app to any hostname and
 * any proxy. Old sub_filter rules left in place are harmless: they run
 * first, and these replacements then find nothing.
 */
(function () {
    'use strict';

    /* Exactly the three surfaces no file swap or setting can reach. Targeted,
     * NOT a blanket replace — upstream's funding link is
     * https://www.patreon.com/LubeLogger and a global substitution
     * would corrupt it. */
    function rebrandHead() {
        // _Layout.cshtml:44 — "<title>@ViewData["Title"] - LubeLogger</title>"
        if (document.title.indexOf(' - LubeLogger') !== -1) {
            document.title = document.title.replace(' - LubeLogger', ' - Road Track');
        }
        // _Layout.cshtml:35 — the iOS home-screen app title.
        var meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
        if (meta && meta.content === 'LubeLogger') meta.content = 'Road Track';
    }

    /* _Settings.cshtml:374, inside the Settings tab. Text node only, so the
     * neighbouring Patreon link is never touched. Upstream fetches that partial
     * after the page has loaded (garage.js:22 `loadSettings`), so this also runs
     * whenever the Settings pane (Home/Index.cshtml:167) is filled; on page load
     * alone it never found the sentence. */
    function rebrandAbout(root) {
        var walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.indexOf('LubeLogger utilizes open-source') !== -1) {
                node.nodeValue = node.nodeValue.replace(
                    'LubeLogger utilizes open-source', 'Road Track utilizes open-source');
                return;
            }
        }
    }

    /* The landing page is the garage — a wall of vehicles and nothing else.
       (The Calendar tab is upstream's and is hidden in roadtrack.css.) */
    function isLandingPage() {
        /* `/Home/Index` is the conventional ASP.NET route for the same action
           and serves the identical page — verified, it returns the garage. A
           test that only knew `/` and `/Home` left the Metrics tab injected
           there. */
        return /^\/(?:Home(?:\/Index)?\/?)?$/i.test(location.pathname);
    }

    /* Upstream restores the active tab from `?tab=`, and writes that param into
       history itself every time you switch — so anyone who has ever opened the
       Calendar has `/Home?tab=calendar` in their history or bookmarks. With the
       tab button hidden, landing on that URL activates the Calendar pane with
       no visible control to get back out of it: a dead end built out of the
       app's own breadcrumbs.
    
       Rewritten here rather than hidden harder. Runs at shared.js parse time,
       before anything has read the parameter. */
    function redirectCalendarTab() {
        if (!isLandingPage()) return;
        var params = new URLSearchParams(location.search);
        if (params.get('tab') !== 'calendar') return;
        params.set('tab', 'garage');
        try {
            history.replaceState(history.state, '',
                location.pathname + '?' + params + location.hash);
        } catch (e) {
            /* replaceState can throw in exotic sandboxes; the tab being
               reachable is a far smaller problem than a broken page. */
        }
    }

    /* One tab, built the same way whichever page it lands on. `cls` is what
       keeps inject() idempotent — upstream re-renders this navbar on some tab
       switches and a second copy would otherwise accumulate. */
    function addTab(cls, href, icon, label) {
        var nav = document.querySelector('ul.nav-tabs.lubelogger-tab');
        if (!nav || nav.querySelector('.' + cls)) return;

        var li = document.createElement('li');
        li.className = 'nav-item ' + cls;
        li.setAttribute('role', 'presentation');

        var a = document.createElement('a');
        a.className = 'nav-link resizable-nav-link';
        a.href = href;
        a.innerHTML = '<i class="bi ' + icon + '"></i>' +
                      '<span class="ms-2">' + label + '</span>';

        li.appendChild(a);

        /* Sit immediately before whatever upstream has pushed to the right
           (the Settings tab carries ms-auto), so these read as the last of
           the content tabs rather than landing after the account menu. */
        var pushed = nav.querySelector('.ms-auto');
        if (pushed) nav.insertBefore(li, pushed);
        else nav.appendChild(li);
    }

    /* THE SAME TAB, IN THE PHONE MENU — and this is not optional.
     *
     * Upstream ships TWO navigations, not one responsive one:
     *   · `ul.nav-tabs.lubelogger-tab`, which is what addTab() fills, and
     *     which collapses to zero height on a narrow screen;
     *   · `.lubelogger-mobile-nav`, a separately rendered full-screen list
     *     opened by the hamburger (`showMobileNav()`).
     *
     * Nothing copies between them. So a tab added only to the first one is
     * simply ABSENT on a phone — no overflow, no error, nothing to notice.
     * An injected tab once sat in that state for many releases, on the
     * surface the garage is actually managed from.
     *
     * There is a `.nav-item-more` overflow dropdown in the tab list too, and
     * it is a red herring: it only runs while the tab bar still has height,
     * it matches entries by `find('button').attr('id')`, and on a phone it is
     * hidden along with its parent. The mobile list is the one that matters.
     *
     * `afterId` is the upstream tab this belongs beside — Metrics next to
     * Dashboard, Access next to Settings — so the item lands in a sensible
     * place rather than after Logout. Falls back to appending.
     */
    function addMobileItem(cls, href, icon, label, afterId) {
        var list = document.querySelector('.lubelogger-mobile-nav ul');
        if (!list || list.querySelector('.' + cls)) return;

        var li = document.createElement('li');
        li.className = 'nav-item d-flex ' + cls;
        li.setAttribute('role', 'presentation');

        /* A button with an onclick, because that is what upstream's own
           non-tab entries in this list are (returnToGarage, showGlobalSearch)
           — the tab-switching ones use data-bs-toggle and would do nothing
           for a link to another page. */
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'nav-link flex-grow-1 text-start';
        b.innerHTML = '<span class="ms-2 display-3">' +
                      '<i class="bi ' + icon + ' me-2"></i>' + label + '</span>';
        b.addEventListener('click', function () { location.href = href; });

        li.appendChild(b);

        var ref = afterId ? list.querySelector('#' + afterId) : null;
        var anchor = ref && ref.closest ? ref.closest('li') : null;
        if (anchor && anchor.parentNode === list) list.insertBefore(li, anchor.nextSibling);
        else list.appendChild(li);
    }

    /* Is the signed-in user an administrator?
     *
     * Asked of the DOM rather than of a config object, because the answer is
     * already there and it came from the server: Views/Home/Index.cshtml
     * renders the Admin Panel link inside `@if (User.IsInRole(IsAdmin))`, so
     * the link's presence IS the server's answer. getGlobalConfig() does not
     * carry the flag, and guessing from anything client-side would put the
     * tab in front of people who cannot use it.
     *
     * This only decides whether to DRAW a link. The page it points at is
     * gated on its own data being administrator-only — see brand/access. */
    function isAdmin() {
        return !!document.querySelector('a[href="/Admin"]');
    }

    /* THERE IS NO METRICS TAB ANY MORE, and that is a deletion rather than a
     * regression. It pointed at /brand/metrics/index.html, a standalone page
     * that was a strict SUBSET of the vehicle Dashboard — measured card by
     * card: every tile and every chart on it already existed on the dashboard,
     * which additionally has Distance driven, Spend by system and two more
     * tiles. Once the last thing it held alone, Biggest expenses, was ported
     * across, it was a worse copy of the page you land on when you click a
     * car.
     *
     * So the surface people were being sent to was the poorer of the two, and
     * keeping both meant maintaining the same aggregation against two shells.
     * Access is the only injected tab left; it belongs on the garage, because
     * it is about the whole garage and every account in it.
     */
    function inject() {
        if (isLandingPage()) {
            if (!isAdmin()) return;
            var access = '/brand/access/index.html' + themeQuery();
            addTab('roadtrack-access-tab', access, 'bi-people', 'Access');
            addMobileItem('roadtrack-access-mobile', access, 'bi-people', 'Access',
                          'settings-tab');
            return;
        }
        addVehicleTabs();
    }

    /* ── Collaborators, as a tab ─────────────────────────────────────────
     *
     * Sharing a car is the thing a garage of friends and family does most, and
     * it was the least reachable control in the app: upstream renders the
     * panel at the BOTTOM of the Dashboard partial, below five charts, and our
     * own dashboard faithfully reproduced that by lifting it into the last
     * card on the page. Nobody scrolls past their own spending charts to find
     * a permissions control.
     *
     * A REAL Bootstrap tab, not a link like Access — the panel is a fragment
     * of this page's own data, so it belongs in a pane beside Odometer and
     * Service rather than on a page of its own. Upstream's tabs are
     * `<button data-bs-toggle="tab" data-bs-target="#x-tab-pane">` against a
     * pane in `#vehicleTabContent`, and this builds exactly that shape so
     * Bootstrap drives it with no code of ours in the switching path.
     *
     * Both navbars again. Upstream ships two (see addMobileItem) and a tab
     * was once invisible on phones for many releases because only one was
     * written to. A sharing control that is missing on the device people
     * actually administer their garage from would repeat that exactly.
     *
     * NOT gated on isAdmin(). Measured against a running instance: a
     * non-admin gets this partial with a working "Add Collaborator" button on
     * their own vehicle — upstream already lets a collaborator share the car,
     * and this is the whole reason the Household page could be retired.
     */
    var COLLAB_PANE = 'rt-collab-tab-pane';
    var REPORTS_PANE = 'rt-reports-tab-pane';
    var FINANCE_PANE = 'rt-finance-tab-pane';

    /* Reports sits before Collaborators: it is the one people came for. */
    var VEHICLE_TABS = [
        {
            pane: FINANCE_PANE,
            slug: 'finance',
            icon: 'bi-cash-coin',
            label: 'Finance',
            open: loadFinance,
        },
        {
            pane: REPORTS_PANE,
            slug: 'reports',
            icon: 'bi-file-earmark-text',
            label: 'Reports',
            open: loadReports,
        },
        {
            pane: COLLAB_PANE,
            slug: 'collab',
            icon: 'bi-people',
            label: 'Collaborators',
            open: loadCollaborators,
        },
    ];

    function addVehicleTabs() {
        var content = document.getElementById('vehicleTabContent');
        var bar = document.querySelector('ul.nav-tabs.lubelogger-tab');
        if (!content || !bar) return;
        /* No vehicle in the URL means nothing to load, and a tab that opens on
           an empty pane is worse than no tab. Checked HERE rather than in each
           loader so the failure is "no tab" instead of "a dead one" — the same
           reading-off-the-URL approach the rest of this file uses, because
           upstream's GetVehicleId() is called from shared.js but defined
           somewhere shared.js does not own and may not exist yet. */
        if (!new URLSearchParams(location.search).get('vehicleId')) return;

        /* Upstream orders tabs with an inline `order:` rather than DOM
           position, so appending alone would land these in the middle. Sit past
           the highest, which keeps them last however many tabs a future
           upstream adds. */
        var order = 0;
        var items = document.querySelectorAll('#vehicleTab .nav-item, ul.nav-tabs.lubelogger-tab .nav-item');
        for (var i = 0; i < items.length; i++) {
            var n = parseInt(items[i].style.order, 10);
            if (!isNaN(n) && n > order) order = n;
        }

        var mobile = document.querySelector('.lubelogger-mobile-nav ul');
        for (var t = 0; t < VEHICLE_TABS.length; t++) {
            addVehicleTab(content, bar, mobile, VEHICLE_TABS[t], order + 1 + t);
        }
        dropUnresolvableTab();
    }

    /* A `?tab=` nobody can open is a blank page, so drop it before upstream
       reads it.

       Two ways to get one. Ours: an earlier release pushed every Road Track
       tab into history as `?tab=rt`, because upstream truncates a tab id at
       its first hyphen — so a bookmark or back-button entry from then
       resolves to `#rt-tab` and activates nothing. Upstream's own: a tab this
       user's config no longer shows.

       loadDefaultTab() falls back to the user's default tab when `tab` is
       absent, which is exactly the wanted behaviour; it has no branch for a
       tab that is merely unopenable, and instead parks waitForElement on a
       setInterval hunting an element that will never appear.

       Runs AFTER the tabs are injected so ours count as resolvable, and before
       jQuery ready, which is when upstream reads the parameter. Same shape and
       the same reason as redirectCalendarTab() on the garage page. */
    function dropUnresolvableTab() {
        var params = new URLSearchParams(location.search);
        var tab = params.get('tab');
        if (!tab || document.getElementById(tab + '-tab')) return;
        params.delete('tab');
        try {
            history.replaceState(history.state, '', location.pathname
                + (params.toString() ? '?' + params : '') + location.hash);
        } catch (e) {
            /* Exotic sandbox: a stale param is a worse page than a tidy URL,
               but neither is worth throwing over. */
        }
    }

    function addVehicleTab(content, bar, mobile, spec, order) {
        if (document.getElementById(spec.pane)) return;

        var pane = document.createElement('div');
        pane.className = 'tab-pane fade';
        pane.id = spec.pane;
        pane.setAttribute('role', 'tabpanel');
        pane.tabIndex = 0;
        content.appendChild(pane);

        addPaneTab(bar, 'nav-item roadtrack-' + spec.slug + '-tab', spec, order, 'desktop');
        if (mobile) {
            addPaneTab(mobile, 'nav-item d-flex roadtrack-' + spec.slug + '-mobile',
                       spec, order, 'mobile');
        }
        /* AND THE OVERFLOW MENU. checkNavBarOverflow() hides tab items from the
           HIGHEST css order down whenever the bar wraps past 48px, then reveals
           a counterpart in `.nav-item-more > ul` matched by `#${hiddenButtonId}`.
           Ours carry the highest order by design, so they are the FIRST to be
           hidden — and with no counterpart to reveal they simply vanished, at a
           width where the phone menu is still display:none. Measured at 820px:
           Collaborators hidden, absent from the dropdown, unreachable by any
           route. Narrow further and Reports and Finance follow it.

           An entry here is upstream's own answer to that, so use it rather than
           fighting the overflow: same id, same shape, hidden inline until
           upstream decides to show it. */
        var more = bar.querySelector('.nav-item-more > ul');
        if (more) {
            addPaneTab(more, 'nav-item text-truncate roadtrack-' + spec.slug + '-more',
                       spec, order, 'more');
        }

        /* Lazily, on first open — neither of these is cheap. Collaborators
           carves its panel out of a ~22KB dashboard partial, and Reports pulls
           every record for the vehicle. Not worth it for someone who never
           opens the tab. */
        var loaded = false;
        document.addEventListener('shown.bs.tab', function (e) {
            var target = e.target && e.target.getAttribute('data-bs-target');
            if (target !== '#' + spec.pane || loaded) return;
            loaded = true;
            spec.open(pane);
        });
    }

    /* EVERY TAB BUTTON NEEDS AN id, AND IT IS NOT COSMETIC.
     *
     * vehicle.js binds `$('button[data-bs-toggle="tab"]').on('show.bs.tab')` —
     * every tab button on the page, ours included, because they are injected on
     * DOMContentLoaded and that binding runs later on jQuery ready. Its handler
     * then does:
     *
     *     $(`.lubelogger-tab #${e.target.id}`).addClass('active');
     *
     * With no id that interpolates to the selector `.lubelogger-tab #`, which
     * is a SYNTAX ERROR. jQuery throws, the exception unwinds through
     * Bootstrap's dispatch of `show.bs.tab`, and Bootstrap never gets to
     * activate the pane or fire `shown.bs.tab` — which is the event our lazy
     * loader is waiting on. Net effect: clicking a Road Track tab does
     * absolutely nothing. No pane, no error the user can see, no clue.
     *
     * That is how Collaborators, Reports and Finance each once shipped dead,
     * and why tools/check_vehicle_tabs.py passed throughout: the fixture never
     * loaded upstream's vehicle.js, so the one line that breaks them was not
     * in the room.
     *
     * The SAME id on both navbars is deliberate and is upstream's own
     * convention — `report-tab` appears in the tab bar and in the phone menu,
     * and the two selectors above are exactly how upstream tells them apart.
     * Matching it also means the twin button now picks up `.active` like every
     * other tab, which it never did before.
     *
     * AND IT MUST CONTAIN NO HYPHEN BEFORE "-tab" — `rtfinance-tab`, not
     * `rt-finance-tab`. vehicle.js:94 writes the active tab into the URL through
     *
     *     getTabNameForURL = (name) => name.toLowerCase().split('-')[0]
     *
     * and reads it back as `${param}-tab`. So `rt-finance-tab` is pushed as
     * `?tab=rt` and comes back as `#rt-tab`, which does not exist: all three of
     * our tabs collapse to the same param, and RELOADING the URL upstream just
     * put in your history activates nothing at all — a blank vehicle page, with
     * `waitForElement` parked on a setInterval hunting `#rt-tab` forever (188
     * console lines in three seconds, measured). One hyphen fewer and the name
     * round-trips, so our tabs become bookmarkable like upstream's.
     */
    function addPaneTab(list, cls, spec, order, variant) {
        if (list.querySelector('.' + cls.split(' ').pop())) return;
        var li = document.createElement('li');
        li.className = cls;
        li.setAttribute('role', 'presentation');
        li.style.order = String(order);
        /* The overflow copy starts hidden, exactly as upstream's do —
           checkNavBarOverflow() is what reveals it, and only while the real
           tab is hidden. Without this it would show permanently and the menu
           would list three tabs that are already on screen. */
        if (variant === 'more') li.style.display = 'none';

        var isMobile = variant === 'mobile';
        var b = document.createElement('button');
        b.type = 'button';
        b.id = 'rt' + spec.slug + '-tab';
        b.setAttribute('role', 'tab');
        b.setAttribute('data-bs-toggle', 'tab');
        b.setAttribute('data-bs-target', '#' + spec.pane);
        b.setAttribute('aria-selected', 'false');
        b.className = isMobile
            ? 'nav-link flex-grow-1 text-start'
            : 'nav-link resizable-nav-link';
        b.innerHTML = isMobile
            ? '<span class="display-3 ms-2"><i class="bi ' + spec.icon + ' me-2"></i>'
              + spec.label + '</span>'
            : '<i class="bi ' + spec.icon + '"></i><span class="ms-2">'
              + spec.label + '</span>';

        li.appendChild(b);
        list.appendChild(li);
    }

    /* ── Reports ─────────────────────────────────────────────────────────
     *
     * Upstream has a report generator and it stays reachable from the
     * dashboard's tools row. It is a column picker: six checkboxes, a tag
     * filter and a date range, with no way to say "just the servicing". This
     * offers named reports instead — and a price toggle, which upstream can
     * only express as "untick the Cost column".
     *
     * Same lazy-module shape as the vehicle dashboard: the tab pane is the
     * mount point and brand/reports/reports.js is the renderer. */
    function loadReports(pane) {
        pane.textContent = 'Loading…';
        import('/brand/reports/reports.js?v=__RT_VERSION__')
            .then(function (m) {
                return m.default(pane, Number(
                    new URLSearchParams(location.search).get('vehicleId')));
            })
            .catch(function (err) {
                if (window.console) console.error('Road Track reports:', err);
                pane.textContent = 'Reports are unavailable — reload the page to try again.';
            });
    }

    /* ── Finance ─────────────────────────────────────────────────────────
     *
     * What the car itself cost — price, deposit, interest, when it is paid off,
     * and what it has been worth since. Upstream has the price fields and no
     * surface that does anything with them; the loan terms are extra fields
     * added to the same panel (see below).
     *
     * Waits on ensureMetricsCss() because it renders with the dashboard's
     * stylesheet rather than one of its own — on a LubeLogger page nothing has
     * asked for that sheet yet, and drawing before it lands bakes empty colours
     * into the canvas. Same reasoning, and the same helper, as the dashboard. */
    function loadFinance(pane) {
        pane.textContent = 'Loading…';
        Promise.all([
            ensureMetricsCss(),
            import(metricsAsset('finance.js')),
        ])
            .then(function (r) {
                return r[1].default(pane, Number(
                    new URLSearchParams(location.search).get('vehicleId')));
            })
            .catch(function (err) {
                if (window.console) console.error('Road Track finance:', err);
                pane.textContent = 'Finance is unavailable — reload the page to try again.';
            });
    }

    function loadCollaborators(pane) {
        var id = new URLSearchParams(location.search).get('vehicleId');
        if (!id || !window.jQuery) return;
        window.jQuery.get('/Vehicle/GetReportPartialView?vehicleId='
                          + encodeURIComponent(id), function (data) {
            /* Parsed inert first so only the one element named here is brought
               across — the rest of that response is upstream's dashboard, and
               letting its chart setup run would draw charts into hidden
               zero-height boxes. */
            var doc = new DOMParser().parseFromString(data, 'text/html');
            var collab = doc.querySelector('#collaboratorContent');
            if (!collab) {
                pane.textContent = 'Collaborators are unavailable for this vehicle.';
                return;
            }
            /* Upstream sizes it with Bootstrap grid classes that only mean
               anything inside a .row; left on, they pin it to a sixth of the
               width and truncate every name to "cla…". */
            collab.className = 'rt-collab-pane';
            /* jQuery, NOT adoptNode: the fragment carries an inline <script>
               defining addCollaborator() and deleteCollaborator(), which exist
               nowhere else in the app. An adopted <script> never executes, so
               the buttons would render perfectly and throw on click. The id
               survives because upstream's refreshCollaborators() repopulates
               $("#collaboratorContent") after every add and delete. */
            window.jQuery(pane).html(collab.outerHTML);
        });
    }

    /* Just the theme, for pages that have no vehicle and no distance in them.
       Dark mode is a server-side per-user setting a standalone page cannot
       read for itself — same reasoning as the dashboard's own asset URLs. */
    function themeQuery() {
        try {
            return '?theme=' + (getGlobalConfig().useDarkMode ? 'dark' : 'light');
        } catch (e) {
            return '';
        }
    }

    /* ── Single sign-on ──────────────────────────────────────────────
     *
     * There is deliberately NO login hand-off code here any more.
     *
     * Earlier releases carried an auto-press: it pressed upstream's "Login via …"
     * button, and later veiled the page so the form could not flash before the
     * redirect. All of that worked around a setting upstream already has.
     *
     * With `OpenIDConfig__DisableRegularLogin` set and `OpenIDConfig__LogOutURL`
     * non-empty, `LoginController.Index` builds the state/PKCE pair and returns
     * a **302 straight into the OIDC flow** — server-side, before any HTML is
     * generated. No form is rendered, so there is nothing to press, nothing to
     * veil, and no flash possible. Upstream does it properly; the JS did not
     * need to exist. (That flag hides the form; it does not make single
     * sign-on the only way in — see docs/operations.md.)
     *
     * An instance that keeps regular login gets the login form as upstream
     * intended — with its own "Login via …" button. Do not reintroduce an
     * auto-press to paper over that; set the flag instead.
     */

    /* The title and the meta tag are both parsed before shared.js loads
       (_Layout.cshtml lines 35 and 44 vs 61), so this lands before first
       paint rather than flashing the upstream name. */
    rebrandHead();
    redirectCalendarTab();

    /* ── Vehicle dashboard ───────────────────────────────────────────
     *
     * Upstream's Dashboard tab is the first thing you see after clicking a
     * vehicle, and for a garage that logs no fuel it reports "Distance
     * Traveled 0" and "0 mpg" beside a month-of-year bar chart that sums every
     * July on record into one bar. brand/metrics/vehicle-dash.js draws the
     * same figures the Metrics page does, scoped to the one vehicle.
     *
     * TIMING. vehicle.js declares `function getVehicleReport` at parse time and
     * only CALLS it from a jQuery ready handler, and a DOMContentLoaded
     * listener registered here — in shared.js, which _Layout loads in <head> —
     * runs before jQuery's ready callbacks do (verified in a browser, not
     * assumed: jQuery 3 resolves its ready list through a promise). So
     * replacing the global in onReady() lands before the first call, and no
     * request for upstream's partial is ever made on our behalf.
     */
    function metricsAsset(file) {
        return '/brand/metrics/' + file + '?v=__RT_VERSION__';
    }

    /* metrics.css is not part of site.css — the standalone page links it
       itself. On a LubeLogger page nothing has asked for it yet.
    
       Returns a promise that settles when the sheet is actually usable. The
       renderer reads every chart colour out of CSS custom properties with
       getComputedStyle at draw time, so rendering before the sheet lands bakes
       EMPTY colours into the canvases — and the later stylesheet fixes the
       layout while leaving the charts colourless, because nothing redraws them.
       Rare on a cold load (the module is a network fetch too), reachable when
       the module is cached and the sheet is not. */
    function ensureMetricsCss() {
        var link = document.getElementById('rt-metrics-css');
        if (link) return link.rtReady || Promise.resolve();

        link = document.createElement('link');
        link.id = 'rt-metrics-css';
        link.rel = 'stylesheet';
        link.href = metricsAsset('metrics.css');
        link.rtReady = new Promise(function (resolve) {
            link.addEventListener('load', function () {
                resolve();
                /* If the 3s giveaway below already fired, the dashboard drew
                   its charts with no theme tokens to read. Tell it to redraw
                   now that there are some. Harmless when nothing is listening. */
                document.dispatchEvent(new Event('rt-metrics-css-loaded'));
            });
            /* Settle on failure too, and on a stall. An unstyled dashboard is
               a bad outcome; a permanently blank tab is a worse one. */
            link.addEventListener('error', resolve);
            setTimeout(resolve, 3000);
        });
        document.head.appendChild(link);
        return link.rtReady;
    }

    function installVehicleDashboard() {
        if (typeof window.getVehicleReport !== 'function') return;
        window.getVehicleReport = function (vehicleId) {
            var pane = document.getElementById('report-tab-pane');
            if (!pane) return;
            pane.textContent = '';
            Promise.all([
                ensureMetricsCss(),
                import(metricsAsset('vehicle-dash.js')),
            ])
                .then(function (r) { return r[1].default(pane, Number(vehicleId)); })
                .catch(function (err) {
                    /* Never leave the tab blank. Anything that stops the module
                       loading — a stale cached asset, a syntax error, an
                       offline PWA start — falls back to upstream's own view,
                       which is poor but is not nothing. */
                    if (window.console) console.error('Road Track dashboard:', err);
                    if (window.jQuery) {
                        window.jQuery.get(
                            '/Vehicle/GetReportPartialView?vehicleId=' +
                                encodeURIComponent(vehicleId),
                            function (data) { window.jQuery(pane).html(data); });
                    }
                });
        };
    }

    /* ── "Odometer at purchase" on the vehicle form ──────────────────
     *
     * Upstream's vehicle modal already carries **Purchased Date**, tucked under
     * a collapsed "Purchase/Sold Information(optional)" panel, and Road Track's
     * metrics now measure ownership from it. What upstream has no field for is
     * the mileage the car showed that day — which is what every per-distance
     * figure has to count from on a vehicle bought second-hand. If the
     * previous owner put 60,000 miles on it, then without a starting reading
     * those miles are in the denominator of this owner's cost per mile.
     *
     * Added as a LubeLogger EXTRA FIELD rather than as a fork. saveVehicle()
     * harvests every `.extra-field` in the open modal by reading its <label> for
     * the name and its <input> for the value (getAndValidateExtraFields in
     * shared.js), so a div in that shape is validated and persisted by
     * upstream's own save path with nothing hooked and nothing patched. It
     * comes back out of /api/vehicles under `extraFields`, which is where
     * aggregate.js reads it.
     *
     * Once saved, upstream renders the field itself — at the TOP of the form,
     * where it reads as unrelated to the purchase date it belongs with. So the
     * existing node is MOVED into the panel rather than a second one added:
     * two inputs with the same label would both be harvested and whichever sat
     * later in the DOM would silently win the save.
     */
    /* THE SAME MECHANISM NOW CARRIES THE LOAN. Price, deposit, rate and term
     * are what the Finance tab is built out of, and upstream has a field for
     * exactly one of them (PurchasePrice, already in this panel). The other
     * three are extra fields, harvested and saved by upstream's own
     * getAndValidateExtraFields() with nothing hooked.
     *
     * Names are the storage keys — they must match LOAN_FIELDS and
     * VALUATION_FIELD in aggregate.js exactly, because the harvester reads the
     * <label> text as the field name.
     *
     * EVERY BOX IS type="text" WITH AN inputmode, INCLUDING THE MONEY ONES.
     * This is upstream's own convention for anything with a separator in it —
     * `inputPurchasePrice` is `type="text" inputmode="decimal"` — and the reason
     * is that `<input type="number">` SILENTLY DISCARDS a value it cannot parse.
     * A deposit stored as "2,000" put back into a number input comes out empty,
     * so reopening the form and saving wiped it: the exact data loss the refill
     * below exists to prevent, reintroduced by the input type. Measured, not
     * assumed — four of five fields came back and Down payment did not.
     * aggregate.js's typedNumber() strips separators anyway, so text costs
     * nothing and guarantees whatever was stored round-trips verbatim.
     *
     * They are <input> rather than <textarea> however much the valuations box
     * would like to be one — the harvester does `$(elem).find("input")`, so a
     * textarea is silently never saved. */
    var PURCHASE_ODOMETER_FIELD = 'Odometer at purchase';

    var PURCHASE_FIELDS = [
        { name: PURCHASE_ODOMETER_FIELD, mode: 'numeric',
          hint: 'What the odometer read the day you bought it.' },
        { name: 'Down payment', mode: 'decimal',
          hint: 'The deposit, if there was one.' },
        { name: 'Loan APR', mode: 'decimal', placeholder: 'e.g. 5.9',
          hint: 'The rate on the loan agreement, as a percentage.' },
        { name: 'Loan term (months)', mode: 'numeric', placeholder: 'e.g. 60',
          hint: 'How many payments. Leave blank if you bought it outright.' },
        { name: 'Estimated values',
          placeholder: 'e.g. 2024-06 = 12000, 2026-01 = 10000',
          hint: 'What it has been worth since, for the depreciation line.' },
    ];

    function findExtraField(modal, name) {
        var fields = modal.querySelectorAll('.extra-field');
        for (var i = 0; i < fields.length; i++) {
            var label = fields[i].querySelector('label');
            if (label && label.textContent.trim().toLowerCase() === name.toLowerCase()) {
                return fields[i];
            }
        }
        return null;
    }

    function buildField(spec) {
        var id = 'rt-input-' + spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        var div = document.createElement('div');
        div.className = 'extra-field';

        var label = document.createElement('label');
        label.setAttribute('for', id);
        /* The harvester reads this text as the field NAME, so it is the storage
           key as well as the caption. Keep these identical to
           PURCHASE_ODOMETER_FIELD / LOAN_FIELDS / VALUATION_FIELD in
           aggregate.js. */
        label.textContent = spec.name;

        var input = document.createElement('input');
        input.type = 'text';
        if (spec.mode) input.inputMode = spec.mode;
        input.id = id;
        input.className = 'form-control';
        input.placeholder = spec.placeholder || spec.name;

        div.appendChild(label);
        div.appendChild(input);
        return div;
    }

    /* PUT THE SAVED VALUES BACK IN THE BOXES, OR SAVING WIPES THEM.
     *
     * Upstream renders a record's extra fields through
     * StaticHelper.AddExtraFields(recordFields, templateFields), and that
     * function returns an EMPTY list when no vehicle extra-field template is
     * configured, and otherwise strips every field whose name is not in the
     * template. Our five are injected by this file, not declared as templates,
     * so the edit form draws them blank however much is stored — and
     * saveVehicle() then harvests the blanks over the real values.
     *
     * The whole failure is: open Edit Vehicle, change nothing, press Save, and
     * the purchase odometer, deposit, APR, term and valuations are gone.
     * Measured on the real image, not reasoned about. "Odometer at purchase"
     * was losable this way from the day it was added until this existed.
     *
     * The vehicle id comes from getVehicleModelData(), an inline script inside
     * upstream's own modal partial, so it is exactly the vehicle the form is
     * editing — id 0 on the Add form, where blank is correct and there is
     * nothing to fetch.
     *
     * Only ever fills a field the form left EMPTY, so a template-declared field
     * upstream did populate is never overwritten by a stale API read, and
     * neither is something the user has already typed.
     *
     * Deliberately: fill the boxes rather than declare the five as extra-field
     * templates. Templates would make upstream render them itself — the tidier
     * shape — but it means writing to the user's settings on their behalf, and
     * these fields would then appear on every vehicle form as first-class
     * upstream fields. Revisit if this ever needs to survive our JS not running,
     * which it cannot anyway: our JS is what draws the field.
     */
    function fillPurchaseFields(modal, panel) {
        var id = 0;
        try {
            id = Number(window.getVehicleModelData().id) || 0;
        } catch (e) {
            return;   // Add-vehicle form, or upstream moved the helper.
        }
        if (!id) return;
        fetch('/api/vehicles', {
            headers: { 'culture-invariant': 'true' },
            credentials: 'same-origin',
        })
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (list) {
                var vehicle = null;
                for (var i = 0; i < (list || []).length; i++) {
                    if (Number(list[i].id) === id) { vehicle = list[i]; break; }
                }
                if (!vehicle) return;
                var stored = {};
                var fields = vehicle.extraFields || [];
                for (var f = 0; f < fields.length; f++) {
                    stored[String(fields[f].name || '').trim().toLowerCase()] =
                        fields[f].value;
                }
                var boxes = panel.querySelectorAll('.rt-purchase-field');
                for (var b = 0; b < boxes.length; b++) {
                    var label = boxes[b].querySelector('label');
                    var input = boxes[b].querySelector('input');
                    if (!label || !input || input.value.trim() !== '') continue;
                    var value = stored[label.textContent.trim().toLowerCase()];
                    if (value !== undefined && value !== null) input.value = value;
                }
            })
            .catch(function () {
                /* A blank box is bad; a modal that throws is worse. The panel
                   is open either way, so the values can be retyped. */
            });
    }

    function fitPurchasePanel(modal) {
        var panel = modal.querySelector('#collapsePurchaseInfo');
        if (!panel || panel.querySelector('.rt-purchase-odometer')) return;

        for (var i = 0; i < PURCHASE_FIELDS.length; i++) {
            var spec = PURCHASE_FIELDS[i];
            /* MOVED, never duplicated. Once saved, upstream renders the field
               itself at the top of the form; two inputs with the same label
               would both be harvested and whichever sat later in the DOM would
               silently win the save. */
            var field = findExtraField(modal, spec.name) || buildField(spec);
            field.className += ' rt-purchase-field';
            if (spec.name === PURCHASE_ODOMETER_FIELD) {
                field.className += ' rt-purchase-odometer';
            }
            panel.appendChild(field);
            var note = document.createElement('div');
            note.className = 'form-text';
            note.textContent = spec.hint;
            panel.appendChild(note);
        }

        var hint = document.createElement('div');
        hint.className = 'form-text rt-purchase-lead';
        hint.textContent = 'Purchased Date and the reading above anchor the '
            + 'Dashboard: spend and mileage from before them belong to the '
            + 'previous owner and are left out. Price and the loan fields feed '
            + 'the Finance tab, and only reach the Dashboard when you press '
            + '“Include purchase & finance” there.';
        panel.appendChild(hint);

        fillPurchaseFields(modal, panel);

        var odoField = panel.querySelector('.rt-purchase-odometer');

        /* Open the panel when the vehicle has no purchase date yet. It is
           collapsed by default and three accordions down — which is why nobody
           has ever filled it in, and why every figure on the dashboard is
           measured from whatever the oldest receipt happens to be. Once it IS
           filled in there is nothing to prompt for, so it stays shut.

           Through Bootstrap's Collapse API, NOT by adding `.show` and stripping
           `.collapsed` by hand. Poking the classes appears to work and then
           silently loses: the Collapse instance is created lazily from the data
           attribute with `_isShown = false`, so the first thing that touches it
           re-syncs the DOM to what Bootstrap believes and the panel closes
           again. Measured on the real modal — open at 1.2s, shut by 3s, with no
           `hide.bs.collapse` event to show for it, which is exactly how the
           field came to look missing. */
        /* Open while EITHER half of the anchor is still missing — not just the
           date. Keying only on the date meant that the moment someone filled it
           in, the panel latched shut over an "Odometer at purchase" that was
           still empty, and the field became unreachable without knowing to
           expand a collapsed accordion to look for it. That is precisely how
           this fails: date filled in, reading still blank, field
           nowhere to be seen.

           Still keyed on those TWO only, now that four more fields live in the
           panel. The loan and valuation boxes are optional — most vehicles will
           never have them filled in — so including them would wedge the
           accordion permanently open on every car in the garage, which is how
           a helpful prompt turns into furniture nobody sees. */
        var dateInput = modal.querySelector('#inputPurchaseDate');
        var odoInput = odoField && odoField.querySelector('input');
        var incomplete = (dateInput && !dateInput.value.trim())
                      || (odoInput && !odoInput.value.trim());
        if (incomplete) {
            try {
                window.bootstrap.Collapse.getOrCreateInstance(panel, {
                    toggle: false,
                }).show();
            } catch (e) {
                /* No bootstrap global (or an API change): fall back to the
                   class poke. Worse, but a shut panel the user can still open
                   beats a thrown error that stops the field being added. */
                panel.classList.add('show');
                var button = modal.querySelector(
                    '[data-bs-target="#collapsePurchaseInfo"]');
                if (button) {
                    button.classList.remove('collapsed');
                    button.setAttribute('aria-expanded', 'true');
                }
            }
        }
    }

    /* Bootstrap 5.3 dispatches show.bs.modal on the modal element and it
       bubbles, so one listener covers both the add and the edit modal without
       wrapping either of upstream's globals. Captured, so a stopPropagation
       anywhere below cannot quietly remove the field. */
    function watchVehicleModal() {
        document.addEventListener('show.bs.modal', function (e) {
            var modal = e.target;
            if (modal && modal.querySelector
                && modal.querySelector('#inputPurchaseDate')) {
                fitPurchasePanel(modal);
            }
        }, true);
    }

    /* ── Add a receipt ──────────────────────────────────────────────────
     *
     * Hardly anybody types a receipt into a form. They photograph it, or
     * forward the email it arrived in — so if the instance's operator runs
     * something that files receipts from a Telegram bot or a mailbox, the
     * person standing in the garage with a receipt should not have to know
     * that it exists. Nothing in upstream's UI can say so; this button does.
     *
     * One button, fixed at the bottom-right of the garage and of every
     * vehicle page, opening whichever channels are configured. On a phone the
     * Telegram link opens the app straight into the bot; on a vehicle page it
     * carries `?start=v<id>`, so a bot that reads its /start payload can file
     * the next photo against that car without asking "Which vehicle?". The
     * mailto puts the car in the subject, the same hint for a mailbox.
     *
     * CONFIGURED AT RUN TIME, because the image is the same for everyone. The
     * entrypoint writes the ROADTRACK_RECEIPT_* environment variables to
     * /brand/config.json; with neither channel set there is no button at all,
     * since a menu with nothing in it is worse than no menu. `no-cache`
     * revalidates rather than refetches, so a restart with new values shows
     * up on the next page load without a version bump.
     *
     * Appended to <body>, not to either navbar — this is the one surface that
     * needs no counterpart in the phone menu (see addMobileItem), because it
     * is not a tab. z-index sits under Bootstrap's modal backdrop (1050) and
     * upstream's phone menu (2000), so it never floats over either. The menu
     * is Bootstrap's own dropup, driven by data-bs-toggle with no code here.
     *
     * Deliberately links and nothing more. A receipt-first upload in this app
     * would need a service next to it holding an extraction key; the bot and
     * the mailbox already are that service.
     */
    function addReceiptButton() {
        if (document.getElementById('rt-receipt')) return;
        var vehicleId = new URLSearchParams(location.search).get('vehicleId');
        var onVehicle = /^\/Vehicle\/Index/i.test(location.pathname) && vehicleId;
        if (!isLandingPage() && !onVehicle) return;

        fetch('/brand/config.json', { cache: 'no-cache', credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (config) {
                drawReceiptButton(config || {}, onVehicle ? vehicleId : null);
            });
    }

    function drawReceiptButton(config, vehicleId) {
        /* Strings only: the entrypoint validates what it writes, but this is
           a static file an operator can also edit by hand. */
        var text = function (v) { return typeof v === 'string' ? v.trim() : ''; };
        var bot = text(config.receiptTelegramBot);
        var name = text(config.receiptTelegramName);
        var mailbox = text(config.receiptEmail);
        if ((!bot && !mailbox) || document.getElementById('rt-receipt')) return;

        /* Views/Vehicle/Index.cshtml renders "<span class="lead">2021 Make
           Model<small>(#plate)</small></span>" — the label is the first text
           node. Best-effort: without it the links still work, the menu just
           has no heading and the subject line is blank. */
        var label = '';
        if (vehicleId) {
            var lead = document.querySelector('[onclick^="editVehicle"] span.lead');
            var first = lead && lead.firstChild && lead.firstChild.nodeValue;
            label = (first || '').trim();
        }

        var wrap = document.createElement('div');
        wrap.id = 'rt-receipt';
        wrap.className = 'dropup';
        wrap.innerHTML =
            '<button type="button" class="btn btn-primary rounded-pill shadow" ' +
                'data-bs-toggle="dropdown" data-bs-offset="0,8" aria-expanded="false">' +
                '<i class="bi bi-receipt"></i><span class="ms-2">Add a receipt</span>' +
            '</button>' +
            '<ul class="dropdown-menu dropdown-menu-end shadow"></ul>';
        var menu = wrap.querySelector('ul');
        /* Fixed markup only; everything configured or typed by a user goes in
           as text or as a property, never as HTML. */
        var add = function (html) {
            var li = document.createElement('li');
            li.innerHTML = html;
            menu.appendChild(li);
            return li.firstChild;
        };

        if (label) add('<h6 class="dropdown-header"></h6>').textContent = label;
        if (bot) {
            var tg = add('<a class="dropdown-item" target="_blank" rel="noopener">' +
                         '<i class="bi bi-telegram me-2"></i><span></span></a>');
            tg.href = 'https://t.me/' + encodeURIComponent(bot) +
                      (/^\d+$/.test(vehicleId || '') ? '?start=v' + vehicleId : '');
            tg.querySelector('span').textContent =
                name ? 'Send a photo to ' + name : 'Send a photo on Telegram';
        }
        if (mailbox) {
            var mail = add('<a class="dropdown-item"><i class="bi bi-envelope me-2"></i>' +
                           'Forward the email to <span class="rt-receipt-addr"></span></a>');
            mail.href = 'mailto:' + mailbox +
                        (label ? '?subject=' + encodeURIComponent(label) : '');
            mail.querySelector('.rt-receipt-addr').textContent = mailbox;
        }
        add('<hr class="dropdown-divider">');
        add('<span class="dropdown-item-text small text-body-secondary"></span>').textContent =
            (bot && mailbox ? 'Either one files' : 'That files') + ' the receipt here, scan attached.';
        document.body.appendChild(wrap);
    }

    function watchSettingsPane() {
        var pane = document.getElementById('settings-tab-pane');
        if (!pane || typeof MutationObserver !== 'function') return;
        /* childList only: the rewrite edits a text node's value, which is not
           a childList change, so it cannot retrigger this observer. */
        new MutationObserver(function () { rebrandAbout(pane); })
            .observe(pane, { childList: true, subtree: true });
    }

    /* ── Garage posters load as they scroll into view ───────────────────
     *
     * Every poster is the vehicle's photo as uploaded, often a full-size
     * camera image behind a tile a few hundred pixels wide. Nothing in the
     * layer can serve a smaller copy: photos sit behind the app's sign-in,
     * and a resized copy under /brand/ would be public. What it can do is
     * stop the posters below the fold downloading before anyone scrolls.
     *
     * THE ATTRIBUTE HAS TO BE IN THE MARKUP. garage.js:17 `loadGarage()`
     * inserts the /Home/Garage partial with `$("#garage-tab-pane").html(data)`,
     * and the browser decides to fetch an <img> as it is inserted. Setting
     * loading="lazy" afterwards, from a MutationObserver, changes the
     * attribute and nothing else: the fetch has already started (measured on
     * a 1.7.3 container — an offscreen poster patched that way was fetched,
     * the same poster with the attribute in its markup was not). So the
     * attribute goes into the HTML string, through jQuery's htmlPrefilter,
     * which both the innerHTML and the append path of `.html()` call.
     *
     * Scoped to strings that are a garage partial, so no other image in the
     * app changes how it loads. The partial is upstream's own Razor output,
     * where a `>` inside an attribute arrives encoded, so the lookahead stays
     * inside one tag. Lazy costs these posters nothing in first paint: they
     * arrive by AJAX, so the preload scanner never saw them anyway. */
    function lazyGaragePosters() {
        var $ = window.jQuery;
        if (!$ || typeof $.htmlPrefilter !== 'function' || $.htmlPrefilter.rtGarage) return;
        var upstream = $.htmlPrefilter;
        var prefilter = function (html) {
            html = upstream.call(this, html);
            if (typeof html === 'string' && html.indexOf('garage-item') !== -1) {
                html = html.replace(/<img\b(?![^>]*\sloading=)/gi,
                                    '<img loading="lazy" decoding="async"');
            }
            return html;
        };
        prefilter.rtGarage = true;
        $.htmlPrefilter = prefilter;
    }

    /* A photo whose file has gone (a restored backup without its images, say)
     * would draw the browser's broken-image glyph across the poster. Hide it
     * and let the card's dark background and the caption carry the tile.
     * `error` does not bubble, hence the capture listener; one listener for
     * every garage load rather than one per image. */
    function hideBrokenPosters() {
        document.addEventListener('error', function (e) {
            var img = e.target;
            if (img && img.tagName === 'IMG'
                && img.matches('#garageContainer .garage-item .card > img')) {
                img.style.opacity = '0';
            }
        }, true);
    }

    function onReady() {
        inject();
        rebrandAbout();
        watchSettingsPane();
        if (isLandingPage()) {
            lazyGaragePosters();
            hideBrokenPosters();
        }
        installVehicleDashboard();
        watchVehicleModal();
        addReceiptButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
