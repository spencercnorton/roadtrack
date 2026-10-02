/* Road Track — who sees which vehicle.
 *
 * WHY THIS EXISTS. Upstream can already do all of this; it just cannot show
 * it. Assignment lives in a Collaborators panel at the bottom of each
 * vehicle's Dashboard tab, one vehicle at a time, and "add" is a free-text box
 * you type a username into from memory — there is no list of who exists. So
 * nobody ever audits it, and access drifts until people can open cars that
 * are not theirs.
 *
 * One grid answers "what does this person see", and a checkbox fixes it.
 *
 * THIS IS NOT A NEW PERMISSION MODEL. Every write goes through upstream's own
 * bulk endpoints, which enforce their own rules (StrictCollaboratorFilter:
 * root passes, anyone else must already be able to edit that vehicle). The
 * page is a view over what LubeLogger already stores.
 *
 * ADMINISTRATOR ONLY, and enforced by the SERVER rather than by this file:
 * /brand/ is static and ungated, so hiding a button here would hide nothing.
 * The user list comes from /Admin/GetUserPartialView, which carries
 * [Authorize(Roles = IsAdmin)] — a non-admin is redirected to the login view
 * and gets no user list, so there is no grid to draw. That redirect IS the
 * gate. Do not "improve" this by reading users from somewhere unauthenticated.
 *
 * TWO LIMITS THIS PAGE MUST KEEP STATING RATHER THAN HIDING.
 *
 * 1. Access is not only direct. UserLogic.FilterUserVehicles resolves a user's
 *    own collaborations PLUS every vehicle their household PARENTS collaborate
 *    on. A grid that showed direct collaborators alone would render an
 *    unticked box for a car the person can see perfectly well — the exact
 *    wrong answer for a page whose whole purpose is "what does this person
 *    see". So inherited access is resolved too, and shown read-only: unticking
 *    a box that is not yours to untick would be a lie about what the click
 *    does.
 *
 * 2. The vehicle list is scoped to the signed-in account. /api/vehicles runs
 *    through that same filter, and ONLY the root user (id -1) bypasses it — an
 *    administrator who is not root sees the accounts of everyone but only the
 *    vehicles shared with them. There is no admin endpoint that returns the
 *    whole garage, so this cannot be fixed here and must not be papered over:
 *    the page says what its inventory is scoped to instead of calling itself
 *    garage-wide.
 */

import {
    api, AuthError, vehicleLabel, loadFormatting,
} from '../metrics/chart-kit.js?v=__RT_VERSION__';

const $ = (id) => document.getElementById(id);

/* Every response here has to be checked for a REDIRECT as well as for status.
 *
 * An expired session does not produce a 401 on these routes — upstream 302s to
 * the login view, fetch follows it by default, and the result is a perfectly
 * good HTTP 200 full of login HTML. Parsed for collaborators that yields an
 * empty set, so a click after the session dropped would have redrawn the whole
 * row as unticked and looked exactly like a successful removal. */
async function request(path, init) {
    const res = await fetch(path, { credentials: 'same-origin', ...init });
    if (res.status === 401 || res.status === 403) throw new AuthError();
    if (res.redirected || new URL(res.url, location.origin).pathname.startsWith('/Login')) {
        throw new AuthError();
    }
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res;
}

const partial = async (path) => (await request(path)).text();

const postForm = (path, pairs) => request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: (() => {
        const p = new URLSearchParams();
        for (const [k, values] of pairs) for (const v of values) p.append(k, v);
        return p.toString();
    })(),
});

/* Parsed inert with DOMParser — nothing from these partials is ever inserted
 * into this document, only read out as text, so a username containing markup
 * is data here and can never become an element.
 *
 * `wrap` exists because the user partial is a run of bare <tr>. The HTML
 * parser only keeps a table row inside a table context and SILENTLY DROPS it
 * otherwise, so parsing that fragment as a document returned a page with no
 * rows in it and the grid reported "administrator access required" while
 * signed in as root. (The household partial carries its own <table>, so it
 * does not need this.) */
function parse(text, wrap) {
    return new DOMParser().parseFromString(
        wrap ? `<table>${text}</table>` : text, 'text/html');
}

/* [{id, name, email, isAdmin}] from the admin partial.
 *
 * Shape read off Views/Admin/_Users.cshtml: one <tr> per user whose row click
 * is `loadUserHousehold(<id>)`, four <td> — name, email, an admin checkbox,
 * a delete button. If upstream restructures that view this returns [] and the
 * page says so, rather than rendering a grid with nobody in it.
 */
function parseUsers(text) {
    const out = [];
    for (const tr of parse(text, true).querySelectorAll('tr')) {
        const id = /loadUserHousehold\((\d+)\)/.exec(tr.getAttribute('onclick') || '');
        const cells = tr.querySelectorAll('td');
        if (!id || cells.length < 3) continue;
        out.push({
            id: Number(id[1]),
            name: cells[0].textContent.trim(),
            email: cells[1].textContent.trim(),
            isAdmin: !!cells[2].querySelector('input[type="checkbox"]:checked'),
        });
    }
    return out;
}

/* Current collaborators on ONE vehicle, from the per-vehicle partial. Asked
 * one vehicle at a time on purpose: GetVehiclesCollaborators takes a list but
 * answers with the INTERSECTION across it (common vs partial), which cannot be
 * inverted back into per-vehicle rows. */
function parseCollaborators(text) {
    return [...parse(text).querySelectorAll('.report-collaborator span')]
        .map((s) => s.textContent.trim())
        .filter(Boolean);
}

/* The CHILDREN of one parent, from /Admin/GetUserHouseholdModal.
 *
 * Direction matters and is easy to get backwards: the endpoint takes a parent
 * and lists who is under them (GetHouseholdForParentUserId), while the access
 * that gets inherited flows the other way — a child sees what its PARENTS
 * collaborate on. Read as children here, inverted into parents by load(). */
function parseHouseholdChildren(text) {
    const out = [];
    for (const tr of parse(text).querySelectorAll('tbody tr')) {
        const m = /adminUpdateUserHousehold\(\s*(\d+)\s*,\s*(\d+)/.exec(tr.innerHTML || '');
        const cell = tr.querySelector('td');
        if (!m || !cell) continue;
        out.push({ childId: Number(m[2]), name: cell.textContent.trim() });
    }
    return out;
}

const state = {
    users: [],
    vehicles: [],
    access: new Map(),      // vehicleId -> Set(username)  — DIRECT collaborators
    parents: new Map(),     // userId    -> Set(userId)    — whose access they inherit
    busy: false,
};

const userById = (id) => state.users.find((u) => u.id === id) || null;

/* Direct, inherited, or neither — the whole point of the grid. Returns the
 * PARENT the access came from when it is inherited, because "they can see it"
 * and "they can see it because they are in another user's household" are
 * different facts and only the second one tells you where to go and change
 * it. */
function accessFor(user, vehicleId) {
    const seen = state.access.get(vehicleId) || new Set();
    if (seen.has(user.name)) return { kind: 'direct', via: null };
    for (const parentId of state.parents.get(user.id) || []) {
        const parent = userById(parentId);
        if (parent && seen.has(parent.name)) return { kind: 'inherited', via: parent.name };
    }
    return { kind: 'none', via: null };
}

async function load() {
    await loadFormatting();
    /* The admin call FIRST and on its own. It is the gate, and a non-admin
     * must not get as far as learning which vehicles exist. */
    const users = parseUsers(await partial('/Admin/GetUserPartialView'));
    if (!users.length) throw new AuthError();
    state.users = users;

    state.parents = new Map();
    for (const u of users) {
        const children = parseHouseholdChildren(
            await partial(`/Admin/GetUserHouseholdModal?userId=${encodeURIComponent(u.id)}`));
        for (const c of children) {
            if (!state.parents.has(c.childId)) state.parents.set(c.childId, new Set());
            state.parents.get(c.childId).add(u.id);
        }
    }

    state.vehicles = (await api('/api/vehicles')) || [];
    state.access = new Map();
    for (const v of state.vehicles) {
        state.access.set(Number(v.id), new Set(parseCollaborators(await partial(
            `/Vehicle/GetCollaboratorsForVehicle?vehicleId=${encodeURIComponent(v.id)}`))));
    }
}

function cell(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined && text !== null) el.textContent = text;
    if (className) el.className = className;
    return el;
}

function renderAll() {
    renderGrid();
    renderUsers();
}

function renderGrid() {
    const table = $('rt-grid');
    table.replaceChildren();

    const head = document.createElement('tr');
    const corner = cell('th', 'Vehicle');
    corner.setAttribute('scope', 'col');
    head.append(corner);
    for (const u of state.users) {
        const th = cell('th', '');
        th.setAttribute('scope', 'col');
        th.append(cell('span', u.name, 'rt-access-user'));
        if (u.isAdmin) th.append(cell('span', 'admin', 'rt-access-badge'));
        head.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(head);

    const tbody = document.createElement('tbody');
    let inherited = 0;
    for (const v of state.vehicles) {
        const id = Number(v.id);
        const tr = document.createElement('tr');
        const name = cell('th', vehicleLabel(v));
        name.setAttribute('scope', 'row');
        tr.append(name);
        for (const u of state.users) {
            const td = cell('td', '');
            const acc = accessFor(u, id);
            if (acc.kind === 'inherited') {
                /* Read-only, and named. A checkbox here would be a lie about
                 * what the click does: this access comes from a household, so
                 * unticking it would remove a collaboration that is not there
                 * and leave the person still seeing the car. */
                inherited += 1;
                const mark = cell('span', '↳', 'rt-access-inherited');
                mark.title = `via ${acc.via}’s household`;
                td.append(mark);
                td.setAttribute('aria-label',
                    `${u.name} sees ${vehicleLabel(v)} through ${acc.via}’s household`);
            } else {
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.className = 'form-check-input';
                box.checked = acc.kind === 'direct';
                box.setAttribute('aria-label', `${u.name} can see ${vehicleLabel(v)}`);
                box.addEventListener('change', () => toggle(box, id, u.name));
                td.append(box);
            }
            tr.append(td);
        }
        tbody.append(tr);
    }

    table.append(thead, tbody);

    /* The count that makes the drift obvious without reading the grid. */
    const everyone = state.vehicles.filter((v) => {
        const seen = state.access.get(Number(v.id)) || new Set();
        return state.users.length > 1 && state.users.every((u) => seen.has(u.name));
    }).length;
    $('rt-grid-note').textContent = everyone
        ? `${everyone} of ${state.vehicles.length} shared with everyone`
        : `${state.vehicles.length} vehicle${state.vehicles.length === 1 ? '' : 's'}`;

    $('rt-grid-foot').textContent = inherited
        ? '↳ is access inherited from a household parent — it has no checkbox '
          + 'because unticking one here would not remove it. Change those in '
          + '/Admin by clicking the parent’s row. Everything else saves as you click.'
        : 'Changes save as you click.';
}

/* Optimistic, then reconciled against the server's own answer.
 *
 * The box is left showing what was clicked while the POST is in flight and
 * corrected from a re-read afterwards, so a refused write (upstream's filter
 * says no, or the username has since been deleted) cannot leave the grid
 * claiming an assignment that does not exist. A failure is SAID, not just
 * silently reverted: a checkbox that springs back with no explanation reads as
 * a broken page rather than as a refusal. */
async function toggle(box, vehicleId, username) {
    if (state.busy) { box.checked = !box.checked; return; }
    state.busy = true;
    const adding = box.checked;
    box.disabled = true;
    const path = adding
        ? '/Vehicle/AddCollaboratorsToVehicles'
        : '/Vehicle/RemoveCollaboratorsFromVehicles';
    try {
        await postForm(path, [['usernames', [username]], ['vehicleIds', [String(vehicleId)]]]);
        state.access.set(vehicleId, new Set(parseCollaborators(await partial(
            `/Vehicle/GetCollaboratorsForVehicle?vehicleId=${encodeURIComponent(vehicleId)}`))));
        $('rt-error').hidden = true;
        renderAll();
    } catch (e) {
        box.checked = !adding;
        const box2 = $('rt-error');
        box2.hidden = false;
        box2.textContent = e instanceof AuthError
            ? 'Your session has expired — reload the page and sign in again. '
              + 'Nothing was changed.'
            : `Could not ${adding ? 'add' : 'remove'} ${username}: ${e.message}`;
    } finally {
        box.disabled = false;
        state.busy = false;
    }
}

function renderUsers() {
    const table = $('rt-users');
    table.replaceChildren();

    const head = document.createElement('tr');
    for (const h of ['User', 'Email', 'Vehicles']) {
        const th = cell('th', h);
        th.setAttribute('scope', 'col');
        head.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(head);

    const tbody = document.createElement('tbody');
    for (const u of state.users) {
        /* Effective, not direct — this column answers "what does this person
         * open the app to", and an inherited car is one of them. */
        const mine = state.vehicles
            .map((v) => ({ v, acc: accessFor(u, Number(v.id)) }))
            .filter((x) => x.acc.kind !== 'none')
            .map((x) => vehicleLabel(x.v)
                + (x.acc.kind === 'inherited' ? ` (via ${x.acc.via})` : ''));
        const tr = document.createElement('tr');
        const name = cell('th', u.name);
        name.setAttribute('scope', 'row');
        tr.append(name);
        tr.append(cell('td', u.email || '—', 'rt-access-email'));
        tr.append(cell('td', mine.length ? mine.join(', ') : 'none', 'rt-access-vehicles'));
        tbody.append(tr);
    }

    table.append(thead, tbody);
}

(async function boot() {
    try {
        await load();
    } catch (e) {
        $('rt-state').textContent = e instanceof AuthError
            ? 'Administrator access required. Sign in as an administrator to '
              + 'manage who sees which vehicle.'
            : 'Could not load accounts and vehicles.';
        return;
    }
    $('rt-lede').textContent =
        `${state.users.length} account${state.users.length === 1 ? '' : 's'}, `
        + `${state.vehicles.length} vehicle${state.vehicles.length === 1 ? '' : 's'} `
        + 'visible to this account. Getting in at all is decided by however this '
        + 'instance signs people in — LubeLogger’s own accounts or an OpenID '
        + 'Connect provider; this page only decides what someone sees once they '
        + 'are in.';
    /* Said every time rather than only when it bites, because the page cannot
     * tell when it bites: an administrator who is not the root user is served
     * a filtered /api/vehicles and there is nothing in the response to say so.
     * A garage-wide claim would be wrong for them and there is no endpoint
     * that would make it right. */
    $('rt-scope').textContent =
        'Vehicles are listed as this account sees them. The root user sees the '
        + 'whole garage; any other administrator sees only vehicles shared with '
        + 'them, so a car missing from this table may still exist.';
    renderAll();
    $('rt-state').hidden = true;
    $('rt-body').hidden = false;
})();
