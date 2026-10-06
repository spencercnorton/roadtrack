"""Drive headless Chrome and assert the Collaborators tab actually works.

    REALISTIC=1 ANCHORED=1 FINANCED=1 VALUED=1 python3 tools/preview.py 8909 &
    python3 tools/check_vehicle_tabs.py

ANCHORED, FINANCED and VALUED are ALL needed for a full run and they do not
collide — ANCHORED adds the post-purchase service behind the per-mile spike,
FINANCED puts a loan on vehicle 1, VALUED strips vehicle 2's price and gives it
a single typed valuation. Without them the spike, finance and depreciation
checks fail for want of a fixture rather than for want of working code, which
has already cost an afternoon of chasing the harness instead of the code.
preview.py also needs a running Road Track container for upstream's bundles —
see its header.

Run by hand, not in CI — it needs a Chrome on the box, and the CI images have
none. CHROME names the binary when `google-chrome` is not on the PATH, e.g.
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" on a Mac.

Why a browser at all, when the rest of this repo tests without one: the two
things most likely to break here cannot be seen from the DOM. Bootstrap has to
recognise our injected button as a tab and switch panes for it, and the panel
we inject carries an inline <script> defining addCollaborator() — adopted
nodes never execute their scripts, so the buttons would render perfectly and
throw ReferenceError on click. Both are silent failures that look like working
markup.

It also guards the mobile navigation, which upstream ships as a SEPARATE DOM
tree. The Metrics tab was once missing from every phone, release after
release, because nothing checked the second one.
"""
import asyncio, json, os, subprocess, tempfile, time, urllib.request
import websockets

PREVIEW = "http://127.0.0.1:8909/Vehicle/Index?vehicleId=1"


def find_chrome():
    if 'CHROME' in os.environ:
        return os.environ['CHROME']
    import shutil
    found = shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    if found:
        return found
    mac_chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    if os.path.exists(mac_chrome):
        return mac_chrome
    return 'google-chrome'


CHROME = find_chrome()


async def main():
    prof = tempfile.mkdtemp()
    proc = subprocess.Popen(
        [CHROME, '--headless=new', '--remote-debugging-port=9334',
         f'--user-data-dir={prof}', '--no-first-run', '--no-sandbox', 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                urllib.request.urlopen('http://127.0.0.1:9334/json/version', timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        tabs = json.load(urllib.request.urlopen('http://127.0.0.1:9334/json/list'))
        ws_url = [t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl']

        async with websockets.connect(ws_url, max_size=20_000_000) as ws:
            counter = 0
            errors = []

            async def cmd(method, params=None):
                nonlocal counter
                counter += 1
                mine = counter
                await ws.send(json.dumps({'id': mine, 'method': method, 'params': params or {}}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get('method') == 'Runtime.exceptionThrown':
                        errors.append(str(msg['params']['exceptionDetails'].get('text')))
                    if msg.get('id') == mine:
                        return msg.get('result', {})

            async def js(expr):
                r = await cmd('Runtime.evaluate',
                              {'expression': expr, 'awaitPromise': True, 'returnByValue': True})
                return r.get('result', {}).get('value')

            await cmd('Page.enable')
            await cmd('Runtime.enable')
            await cmd('Page.navigate', {'url': PREVIEW})
            await asyncio.sleep(3)

            checks = {}

            # ── Dashboard: the purchase toggle and the ownership chart ──
            #
            # Checked FIRST, before anything clicks away from the Dashboard.
            checks['ownership chart draws three lines'] = await js(
                "(()=>{const c=document.getElementById('rtv-chart-main');"
                "const ch = c && window.Chart && Chart.getChart(c);"
                "return !!ch && ch.data.datasets.map(d=>d.label).join('|') ==="
                " 'Running spend|Paid for the car|What it\\u2019s worth';})()")
            # Three lines, one money axis. A second y-scale would let whoever
            # picked the scales decide where paid crosses value, and that
            # crossing is the question the chart exists to answer.
            checks['ownership chart has exactly one y axis'] = await js(
                "(()=>{const ch=Chart.getChart(document.getElementById('rtv-chart-main'));"
                "return Object.keys(ch.scales).filter(k=>ch.scales[k].axis==='y')"
                ".length === 1;})()")
            checks['legend names all three lines'] = await js(
                "document.querySelectorAll('#rtv-legend button').length === 3")
            # The fixture buys the car on 30 Jan 2020 and files its first
            # receipt on 1 Feb, so January is only reachable from the purchase.
            checks['ownership chart starts at the purchase, not the first receipt'] = await js(
                "(()=>{const ch=Chart.getChart(document.getElementById('rtv-chart-main'));"
                "return ch.data.labels[0] === 'Jan 2020';})()")
            checks['purchase toggle is OFF by default'] = await js(
                "document.getElementById('rtv-buy').getAttribute('aria-pressed') === 'false'")

            total_before = await js("document.getElementById('rtv-total').textContent")
            permile_before = await js("document.getElementById('rtv-permile').textContent")
            await js("document.getElementById('rtv-buy').click()")
            await asyncio.sleep(1.5)
            total_after = await js("document.getElementById('rtv-total').textContent")
            permile_after = await js("document.getElementById('rtv-permile').textContent")
            # ONE switch, EVERY figure — it must change every metric, not just
            # the headline.
            checks['toggle repriced total spend'] = total_before != total_after
            checks['toggle repriced cost per mile'] = permile_before != permile_after
            checks['toggle repriced cost per month'] = await js(
                "document.getElementById('rtv-monthly-sub').textContent.length > 0")
            checks['toggle says what it folded in'] = await js(
                "document.getElementById('rtv-total-sub').textContent"
                ".includes('car and finance')")
            # A RANGE MUST NOT DROP ITS OWN FIRST MONTH. paidAt() answers "by
            # the END of this month", so basing the range on its own first
            # month subtracted that month's instalment out of the window meant
            # to contain it — a 12-month view reported eleven payments. Counted
            # here from the loan's terms rather than from the implementation.
            await js("document.querySelector('#rtv-range button:nth-child(3)').click()")
            await asyncio.sleep(1.5)
            checks['a 5Y range counts every instalment inside it'] = await js("""
              (()=>{const sub=document.getElementById('rtv-total-sub').textContent;
               const now=new Date(), start=new Date(2020,0,1);
               const k=(d)=>(d.getFullYear()-start.getFullYear())*12+(d.getMonth()-start.getMonth());
               const from=new Date(now.getFullYear(), now.getMonth()-59, 1);
               const n=Math.max(0, Math.min(60, k(now)) - k(from) + 1);
               const want=(n*347.15/1000).toFixed(1)+'K';
               return sub.includes('$'+want);})()""")
            await js("document.querySelector('#rtv-range button:nth-child(4)').click()")
            await asyncio.sleep(1.2)

            await js("document.getElementById('rtv-buy').click()")
            await asyncio.sleep(1.5)
            checks['toggling back restores the running-cost figure'] = (
                await js("document.getElementById('rtv-total').textContent") == total_before)

            # The spike. The fixture's first service is 12 miles after the
            # purchase, so the raw opening point is $166.67/mile against a
            # settled $0.36 — assert what is PLOTTED never gets near it.
            checks['running cost per mile has no opening spike'] = await js(
                "(()=>{const ch=Chart.getChart(document.getElementById('rtv-chart-permile'));"
                "const v=ch.data.datasets[0].data.filter(x=>x!==null);"
                "return v.length > 1 && Math.max(...v) < v[v.length-1] * 3;})()")
            checks['and says how many months it left off'] = await js(
                "document.getElementById('rtv-permile-note').textContent"
                ".includes('left off')")

            # ── Every injected tab button must carry an id ─────────────
            #
            # NOT cosmetic. vehicle.js binds every button[data-bs-toggle="tab"]
            # and interpolates e.target.id into `.lubelogger-tab #${id}`. With
            # no id that is the selector `.lubelogger-tab #`, jQuery throws
            # "unrecognized expression", the exception unwinds through
            # Bootstrap's dispatch of show.bs.tab, and the pane is never
            # activated — clicking the tab does nothing at all. Collaborators,
            # Reports and Finance all shipped dead this way.
            #
            # The pane-activation checks below are the real guard now that the
            # fixture carries that binding; this one names the cause, so a
            # failure points at the id rather than at six unrelated tabs.
            checks['every injected tab button has an id'] = await js(
                "['finance','reports','collab'].every(s =>"
                " [...document.querySelectorAll('.roadtrack-'+s+'-tab button,"
                " .roadtrack-'+s+'-mobile button')].every(b => b.id === 'rt'+s+'-tab'))")
            checks['the id makes a VALID selector for upstream to build'] = await js(
                "(()=>{try{ ['finance','reports','collab'].forEach(s=>{"
                " const id=document.querySelector('.roadtrack-'+s+'-tab button').id;"
                " window.jQuery('.lubelogger-tab #'+id); }); return true;"
                "}catch(e){ return false; }})()")

            # The id must ROUND-TRIP through upstream's URL sync, or every one
            # of our tabs collapses to the same param and reloading it lands on
            # a blank page. vehicle.js:94 pushes tabName.split('-')[0] and reads
            # it back as `${param}-tab`, so the id may carry no other hyphen.
            checks['tab ids round-trip through upstream\'s ?tab= param'] = await js(
                "['finance','reports','collab'].every(s => {"
                " const id = document.querySelector('.roadtrack-'+s+'-tab button').id;"
                " return id.toLowerCase().split('-')[0] + '-tab' === id; })")

            # Every tab needs a counterpart in the overflow dropdown, or it
            # simply vanishes when the navbar wraps — at widths where the phone
            # menu is still display:none, leaving no route to it at all.
            checks['every tab has an overflow-menu counterpart'] = await js(
                "['finance','reports','collab'].every(s =>"
                " !!document.querySelector('.nav-item-more > ul > li > #rt'+s+'-tab'))")
            checks['the overflow copies start hidden'] = await js(
                "['finance','reports','collab'].every(s => {"
                " const li = document.querySelector('.nav-item-more > ul > li > #rt'+s+'-tab')"
                " .closest('li'); return li.style.display === 'none'; })")

            checks['desktop tab present'] = await js(
                "!!document.querySelector('ul.nav-tabs.lubelogger-tab .roadtrack-collab-tab')")
            checks['mobile tab present'] = await js(
                "!!document.querySelector('.lubelogger-mobile-nav .roadtrack-collab-mobile')")
            checks['pane created'] = await js("!!document.getElementById('rt-collab-tab-pane')")
            checks['tab ordered after upstream tabs'] = await js(
                "Number(document.querySelector('.roadtrack-collab-tab').style.order) > 2")
            checks['nothing fetched before first open'] = await js(
                "document.getElementById('rt-collab-tab-pane').textContent.trim() === ''")

            await js("document.querySelector('.roadtrack-collab-tab button').click()")
            await asyncio.sleep(2.5)

            checks['pane active after click'] = await js(
                "document.getElementById('rt-collab-tab-pane').classList.contains('active')")
            checks['panel loaded into pane'] = await js(
                "!!document.querySelector('#rt-collab-tab-pane #collaboratorContent')")
            checks['collaborator name rendered'] = await js(
                "!!document.querySelector('#rt-collab-tab-pane .report-collaborator')")
            checks['inline script ran (addCollaborator defined)'] = await js(
                "typeof window.addCollaborator === 'function'")
            checks['bootstrap grid classes stripped'] = await js(
                "document.querySelector('#rt-collab-tab-pane #collaboratorContent')"
                ".className === 'rt-collab-pane'")
            checks['Household hidden in phone menu'] = await js(
                '(()=>{const b=document.querySelector('
                '\'.lubelogger-mobile-nav button[onclick="showHouseholdModal()"]\');'
                "return !!b && getComputedStyle(b).display === 'none';})()")
            checks['Household row hidden in dropdown'] = await js(
                '(()=>{const b=document.querySelector('
                '\'.dropdown-menu button[onclick="showHouseholdModal()"]\');'
                "return !!b && getComputedStyle(b.closest('li')).display === 'none';})()")

            # Clicking twice must not fetch and inject a second copy.
            await js("document.querySelector('#report-tab').click()")
            await asyncio.sleep(0.5)
            await js("document.querySelector('.roadtrack-collab-tab button').click()")
            await asyncio.sleep(1.5)
            checks['reopening does not duplicate the panel'] = await js(
                "document.querySelectorAll('#rt-collab-tab-pane .report-collaborator').length === 1")

            # ── Reports tab ────────────────────────────────────────────
            checks['reports tab present (desktop)'] = await js(
                "!!document.querySelector('ul.nav-tabs.lubelogger-tab .roadtrack-reports-tab')")
            checks['reports tab present (mobile)'] = await js(
                "!!document.querySelector('.lubelogger-mobile-nav .roadtrack-reports-mobile')")

            await js("document.querySelector('.roadtrack-reports-tab button').click()")
            await asyncio.sleep(3)

            checks['report sheet rendered'] = await js(
                "!!document.querySelector('#rt-reports-tab-pane .rt-rep-sheet .rt-rep-table')")
            # naturalWidth, NOT the src attribute. The first version of this
            # check read the attribute, passed, and the header was rendering a
            # broken-image box the whole time — the harness was serving .svg as
            # text/plain. Assert the pixels arrived.
            checks['branded header logo actually renders'] = await js(
                "(()=>{const l=document.querySelector('#rt-reports-tab-pane .rt-rep-logo');"
                "const w=document.querySelector('#rt-reports-tab-pane .rt-rep-wordmark');"
                "return !!l && l.complete && l.naturalWidth > 0"
                " && !!w && w.textContent==='Road Track';})()")

            # The header must not claim a wider span than the table beneath it.
            checks['header range matches the rows on the page'] = await js(
                "(()=>{const range=document.querySelector("
                "'#rt-reports-tab-pane .rt-rep-range').textContent;"
                "const cells=[...document.querySelectorAll("
                "'#rt-reports-tab-pane .rt-rep-table tbody tr td:first-child')]"
                ".map(td=>td.textContent);"
                "return cells.length ? range.startsWith(cells[0]) : true;})()")

            checks['figures are right-aligned'] = await js(
                "(()=>{const c=document.querySelector("
                "'#rt-reports-tab-pane .rt-rep-table td.rt-rep-num');"
                "return !!c && getComputedStyle(c).textAlign === 'right';})()")
            checks['routine report shows only servicing'] = await js(
                "(()=>{const h=[...document.querySelectorAll("
                "'#rt-reports-tab-pane .rt-rep-table th')].map(t=>t.textContent);"
                "return h.includes('Work done') && !h.includes('Type');})()")
            checks['stylesheet actually loaded'] = await js(
                "getComputedStyle(document.querySelector("
                "'#rt-reports-tab-pane .rt-rep-figure-value')).fontWeight === '700'")

            # The price toggle must take the prices off the sheet; prove the
            # Cost column LEAVES, not merely that the checkbox flips.
            before = await js(
                "[...document.querySelectorAll('#rt-reports-tab-pane .rt-rep-table th')]"
                ".map(t=>t.textContent).join('|')")
            await js("document.querySelector('#rt-reports-tab-pane .rt-rep-toggle input').click()")
            await asyncio.sleep(1)
            after = await js(
                "[...document.querySelectorAll('#rt-reports-tab-pane .rt-rep-table th')]"
                ".map(t=>t.textContent).join('|')")
            checks['prices on by default'] = 'Cost' in (before or '')
            checks['price toggle removes the Cost column'] = 'Cost' not in (after or '')
            checks['no money left in the body when off'] = await js(
                "!/[$£€]/.test(document.querySelector('#rt-reports-tab-pane .rt-rep-sheet').textContent)")

            # Switching to the money report must re-enable prices rather than
            # printing an empty page.
            await js("document.querySelectorAll('#rt-reports-tab-pane .rt-rep-type')[2].click()")
            await asyncio.sleep(1)
            checks['cost summary re-enables prices'] = await js(
                "document.querySelector('#rt-reports-tab-pane .rt-rep-toggle input').checked === true")
            checks['cost summary has category + system tables'] = await js(
                "[...document.querySelectorAll('#rt-reports-tab-pane .rt-rep-h3')]"
                ".map(h=>h.textContent).join('|').includes('By category')")

            await js("document.querySelectorAll('#rt-reports-tab-pane .rt-rep-type')[1].click()")
            await asyncio.sleep(1)
            checks['full records includes odometer rows'] = await js(
                "document.querySelector('#rt-reports-tab-pane .rt-rep-sheet')"
                ".textContent.includes('Odometer')")

            # ── Sorting the record reports ─────────────────────────────
            #
            # Reads the rendered TABLE rather than the state, because the sort
            # exists to change what is printed. Dates come back as "Sep 5,
            # 2025" so they are compared through Date.parse, not as strings.
            sort_js = ("(v=>{const s=document.querySelector"
                       "('#rt-reports-tab-pane .rt-rep-sort select');"
                       "s.value=v;s.dispatchEvent(new Event('change'));})")
            rows_js = ("[...document.querySelectorAll("
                       "'#rt-reports-tab-pane .rt-rep-table tbody tr')]")

            # ALL FOUR ORDERS ARE SAMPLED IN ONE PASS, then asserted. Two
            # earlier versions of this were vacuous and both looked fine:
            #
            #  · comparing row COUNTS after sorting proves nothing, because
            #    sortRows() runs for every order, so a dropped row is dropped
            #    from all four equally and the counts still agree;
            #  · asserting the row SET once at the end only ever tested
            #    whichever order happened to be selected last, so a cost-desc
            #    that silently dropped rows sailed through.
            #
            # Both were caught only by breaking the code on purpose. draw() is
            # synchronous, so one expression can visit every order and bring
            # back the evidence for all of them at once.
            snap = await js(
                "(()=>{const s=document.querySelector"
                "('#rt-reports-tab-pane .rt-rep-sort select');"
                "const out={};"
                "for (const v of ['date-asc','date-desc','cost-desc','cost-asc']) {"
                "  s.value=v; s.dispatchEvent(new Event('change'));"
                f"  const rows={rows_js};"
                "  out[v]={"
                "    dates: rows.map(r=>Date.parse(r.children[0].textContent)),"
                # The cost column is LAST, and only present while prices are on.
                "    costs: rows.map(r=>parseFloat((r.children[r.children.length-1]"
                "      .textContent||'').replace(/[^0-9.]/g,''))||0),"
                # The WHOLE row, not just its date. Fingerprinting the date
                # column alone let a same-day drop-and-duplicate through, and
                # a garage can have several invoices on one date.
                "    sig: JSON.stringify(rows.map(r=>[...r.children]"
                "      .map(c=>c.textContent).join('\\u001f')).sort()),"
                "  };"
                "}"
                "return JSON.stringify(out);})()")
            snap = json.loads(snap) if snap else {}

            def ordered(seq, ascending):
                return len(seq) > 1 and all(
                    (a <= b if ascending else a >= b)
                    for a, b in zip(seq, seq[1:]))

            checks['date sort ascending runs oldest to newest'] = ordered(
                snap.get('date-asc', {}).get('dates', []), True)
            checks['date sort descending runs newest to oldest'] = ordered(
                snap.get('date-desc', {}).get('dates', []), False)
            checks['cost sort descending runs dearest to cheapest'] = ordered(
                snap.get('cost-desc', {}).get('costs', []), False)
            checks['cost sort ascending runs cheapest to dearest'] = ordered(
                snap.get('cost-asc', {}).get('costs', []), True)

            # Reordering must not lose or invent rows in ONE order but not the
            # others — the failure that would matter most on a printed
            # maintenance history, and the one a reader could never spot.
            sigs = {k: v.get('sig') for k, v in snap.items()}
            checks['no order loses or doubles rows the others keep'] = (
                len(sigs) == 4 and len(set(sigs.values())) == 1
                and all(sigs.values()))

            await js(f"{sort_js}('cost-desc')")

            # On paper the control is gone, so the sheet has to say its order.
            checks['a non-default order is stated on the sheet itself'] = await js(
                "document.querySelector('#rt-reports-tab-pane .rt-rep-foot')"
                ".textContent.includes('Ordered by cost')")
            await js(f"{sort_js}('date-asc')")
            checks['and the default order is left unsaid'] = await js(
                "!document.querySelector('#rt-reports-tab-pane .rt-rep-foot')"
                ".textContent.includes('Ordered by')")

            # The cost summary is three aggregate tables, each already ranked
            # by the thing it is about; offering to re-sort them would be a
            # control that does nothing.
            await js("document.querySelectorAll('#rt-reports-tab-pane .rt-rep-type')[2].click()")
            await asyncio.sleep(1)
            checks['the sort control hides on the cost summary'] = await js(
                "document.querySelector('#rt-reports-tab-pane .rt-rep-sort').hidden === true")
            await js("document.querySelectorAll('#rt-reports-tab-pane .rt-rep-type')[1].click()")
            await asyncio.sleep(1)

            # Printing goes through upstream's printContainer(); the harness
            # stubs it to capture the HTML. Checks the sheet actually reaches
            # the printer, which is the whole feature.
            await js("window.__rtPrinted = null;"
                     "document.querySelector('#rt-reports-tab-pane .rt-rep-print').click()")
            await asyncio.sleep(1)
            checks['print hands the sheet to printContainer'] = await js(
                "typeof window.__rtPrinted === 'string'"
                " && window.__rtPrinted.includes('rt-rep-table')"
                " && window.__rtPrinted.includes('Road Track')")

            # ── Finance tab ────────────────────────────────────────────
            checks['finance tab present (desktop)'] = await js(
                "!!document.querySelector('ul.nav-tabs.lubelogger-tab .roadtrack-finance-tab')")
            checks['finance tab present (mobile)'] = await js(
                "!!document.querySelector('.lubelogger-mobile-nav .roadtrack-finance-mobile')")

            await js("document.querySelector('.roadtrack-finance-tab button').click()")
            await asyncio.sleep(3)

            checks['finance tiles rendered'] = await js(
                "!!document.querySelector('#rt-finance-tab-pane #rtf-total')"
                " && document.querySelector('#rt-finance-tab-pane #rtf-total')"
                ".textContent.trim() !== '—'")
            # The whole point of the tab: interest is DERIVED, not typed. The
            # fixture is $18,000 at 5.9% over 60 months, which is $2,829.32 —
            # a figure a spreadsheet agrees with.
            checks['interest is the real amortised total'] = await js(
                "document.querySelector('#rt-finance-tab-pane #rtf-interest')"
                ".textContent.includes('2,829.32')")
            checks['payoff month derived from the term'] = await js(
                "document.querySelector('#rt-finance-tab-pane #rtf-payoff')"
                ".textContent.includes('2025')")
            checks['paid-against-value chart drawn'] = await js(
                "(()=>{const c=document.querySelector('#rtf-chart');"
                "return !!c && c.width > 0 && !!window.Chart"
                " && !!Chart.getChart(c) && Chart.getChart(c).data.datasets.length === 2;})()")
            # A negative delta must not render as "$-10.8K" — money() puts the
            # symbol in front of whatever it is handed.
            checks['no $- in the finance figures'] = await js(
                "!document.querySelector('#rt-finance-tab-pane').textContent.includes('$-')")

            # ── The depreciation curve ─────────────────────────────────
            #
            # The fixture's last stated valuation is 2026-01, so TODAY'S figure
            # is modelled and must say so. The first version marked the tile
            # estimated only when NO figure had ever been stated, which left a
            # car valued two years ago presenting a modelled number as one
            # somebody had looked up — the exact claim the mark exists to stop.
            checks['a modelled worth is marked estimated'] = await js(
                "document.querySelector('#rt-finance-tab-pane #rtf-worth')"
                ".classList.contains('rt-est')")
            checks['and says which curve it came from, in plain words'] = await js(
                "(t=>t.includes('Subaru') && t.includes('five years')"
                " && !t.includes('undefined'))"
                "(document.querySelector('#rtf-chart-caveat').textContent)")
            # Measured is solid, modelled is dashed. Without the segment the
            # two halves of one line make the same claim.
            checks['the modelled tail of the value line is dashed'] = await js(
                "(()=>{const ds=Chart.getChart(document.querySelector('#rtf-chart'))"
                ".data.datasets.find(d=>d.label.includes('worth'));"
                "return !!ds && !!ds.segment && !!ds.segment.borderDash;})()")

            # ── The purchase / loan fields in the vehicle modal ─────────
            #
            # This is where every figure above is TYPED, and it had never been
            # under test. What matters is not that the inputs exist but what
            # upstream's harvester would SAVE — the label text is the storage
            # key, and a duplicated field means the empty copy wins.
            await js("document.getElementById('rt-open-vehicle-modal').click()")
            # Long enough for the /api/vehicles refill to land, not just for the
            # modal to animate — the values arrive asynchronously.
            await asyncio.sleep(3)
            harvested = await js("JSON.stringify(window.__rtHarvest().map(f=>f.name))")
            want = ['Odometer at purchase', 'Down payment', 'Loan APR',
                    'Loan term (months)', 'Estimated values']
            checks['modal saves exactly the five purchase fields'] = (
                json.loads(harvested or '[]') == want)
            checks['every purchase field is inside the purchase panel'] = await js(
                "(()=>{const p=document.getElementById('collapsePurchaseInfo');"
                "return [...document.querySelectorAll('#vehicleModal .extra-field')]"
                ".every(f=>p.contains(f));})()")
            # An already-saved field is MOVED, not copied: upstream renders it
            # at the top of the form, and two inputs with one label would both
            # be harvested with the later one silently winning.
            checks['an existing field keeps its value through the move'] = await js(
                "window.__rtHarvest().find(f=>f.name==='Odometer at purchase')"
                ".value === '38400'")
            checks['one input per field (a textarea would never save)'] = await js(
                "[...document.querySelectorAll('#vehicleModal .extra-field')]"
                ".every(f=>f.querySelectorAll('input').length === 1)")
            # Complete anchor → the accordion stays shut. The four optional
            # loan boxes must not wedge it open on every vehicle in the garage.
            # THE DATA-LOSS GUARD. Upstream draws these boxes EMPTY whenever no
            # vehicle extra-field template is configured (AddExtraFields returns
            # nothing), so saveVehicle() harvests blanks over whatever is stored
            # — open Edit, change nothing, press Save, and the purchase odometer,
            # deposit, APR, term and valuations are gone. Losable that way until
            # this was fixed. The fields are refilled from /api/vehicles on
            # open; if that ever stops, this check fails before a user loses
            # anything.
            checks['saved purchase values are put back in the boxes'] = await js(
                "(()=>{const h=window.__rtHarvest();const by={};"
                "h.forEach(f=>by[f.name]=f.value);"
                "return by['Odometer at purchase'] === '38400';})()")
            checks['all five loan values come back, not just the odometer'] = await js(
                "(()=>{const by={};window.__rtHarvest().forEach(f=>by[f.name]=f.value);"
                "return by['Down payment'] && by['Loan APR'] && by['Loan term (months)']"
                " && by['Estimated values'];})()")

            # ── A car with NO purchase price (VALUED=1, vehicle 2) ─────
            #
            # A common shape for a car owned a while, and the only one where
            # the curve runs BACKWARDS off a single typed figure.
            # Skipped rather than failed when the fixture is not loaded, so
            # the default run stays one command.
            await cmd('Page.navigate',
                      {'url': 'http://127.0.0.1:8909/Vehicle/Index?vehicleId=2'})
            await asyncio.sleep(4)
            valued = await js(
                "(()=>{const ch=Chart.getChart(document.getElementById('rtv-chart-main'));"
                "return !!(ch && ch.data.datasets.some(d=>d.label.includes('worth')));})()")
            if valued:
                checks['a car with no purchase price still charts a value line'] = await js(
                    "(()=>{const ds=Chart.getChart(document.getElementById('rtv-chart-main'))"
                    ".data.datasets.find(d=>d.label.includes('worth'));"
                    "return ds.data.filter(v=>v!==null).length > 10;})()")
                # The bug this exists for: findIndex returns -1 when every
                # label predates the only figure on file — which read as
                # "nothing is modelled" and drew a wholly modelled line SOLID.
                # EVERY segment, not a sample of three. The fixture's only
                # stated figure sits INSIDE the label range, so the line is
                # modelled on both sides of it — and the segment ending at that
                # real point is the one an off-by-one leaves solid. Sampling
                # index 0, the middle and the end walks straight past it.
                checks['and draws it dashed all the way, because it is all modelled'] = await js(
                    "(()=>{const ds=Chart.getChart(document.getElementById('rtv-chart-main'))"
                    ".data.datasets.find(d=>d.label.includes('worth'));"
                    "if(!ds.segment||!ds.segment.borderDash) return false;"
                    "const n=ds.data.filter(v=>v!==null).length;"
                    "for(let i=0;i<n-1;i++)"
                    "  if(!Array.isArray(ds.segment.borderDash({p0DataIndex:i}))) return false;"
                    "return n>2;})()")
                checks['and leaves the measured spend line solid'] = await js(
                    "(()=>{const ds=Chart.getChart(document.getElementById('rtv-chart-main'))"
                    ".data.datasets.find(d=>d.label.includes('Running'));"
                    "return !ds.segment;})()")

            checks['no uncaught page errors'] = not errors

            ok = True
            for name, value in checks.items():
                print(f"  {'ok  ' if value else 'FAIL'}  {name}")
                ok = ok and bool(value)
            if errors:
                print("\npage errors:")
                for e in errors:
                    print("   ", e)
            print("\nALL PASS" if ok else "\nFAILURES ABOVE")
            return 0 if ok else 1
    finally:
        proc.terminate()


raise SystemExit(asyncio.run(main()))
