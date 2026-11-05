"""Real-Firefox end-to-end test for the XVault Firefox build (XVault 22).

Installs dist/XVault-*-firefox.zip as a temporary add-on through geckodriver, then checks the event page,
Library, search, every dashboard page, local OCR inside the event page, idle unload + wake-up, a real
download through the Firefox downloads API and the sidebar panel.
Usage: python3 scripts/e2e-firefox.py dist/XVault-<version>-firefox.zip
Needs: Firefox, geckodriver and `pip install selenium`. FIREFOX_BIN / GECKODRIVER override discovery.
FF_LIVE_X=1 also opens https://x.com and checks that the content scripts inject and answer.
"""
import json, os, shutil, sys, tempfile, time, urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
UUID = '11111111-2222-4333-8444-555555555555'
ADDON_ID = 'xvault@zeniyaxe.github.io'
ROOT = f'moz-extension://{UUID}/'
IMAGE = 'https://pbs.twimg.com/profile_images/1683899100922511378/5lY42eHs_400x400.jpg'
results = []
def check(name, ok, detail=''):
    results.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:300]})
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)
opts = Options()
def find(env, name):
    value = os.environ.get(env) or shutil.which(name)
    if not value:
        sys.exit(f'{name} not found: set {env}')
    return value
opts.binary_location = find('FIREFOX_BIN', 'firefox')
download_dir = tempfile.mkdtemp(prefix='xvault-ff-downloads-')
opts.add_argument('-headless')
opts.set_preference('extensions.webextensions.uuids', json.dumps({ADDON_ID: UUID}))
opts.set_preference('devtools.console.stdout.content', True)
opts.set_preference('browser.download.folderList', 2)
opts.set_preference('browser.download.dir', download_dir)
opts.set_preference('browser.download.useDownloadDir', True)
# Unload the event page quickly so the test exercises wake-ups (default 30 s).
opts.set_preference('extensions.background.idle.timeout', 6000)
gecko = os.environ.get('GECKODRIVER') or (os.path.join(os.environ['GECKOWEBDRIVER'], 'geckodriver') if os.environ.get('GECKOWEBDRIVER') else None) or find('GECKODRIVER', 'geckodriver')
svc = Service(gecko, log_output=os.environ.get('GECKO_LOG', os.path.join(tempfile.gettempdir(), 'xvault-gecko.log')),
              env={**os.environ, 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1'})
d = webdriver.Firefox(options=opts, service=svc)
d.set_script_timeout(120)
def open_ext(p):
    with d.context(d.CONTEXT_CHROME):
        d.execute_script('gBrowser.selectedTab = gBrowser.addTab(arguments[0], {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});', ROOT + p)
    time.sleep(1.5)
    d.switch_to.window(d.window_handles[-1])
def run_async(js, *args):
    return d.execute_async_script('const done = arguments[arguments.length - 1]; (async () => {' + js + '})().then(done, e => done({__error: String(e && (e.stack || e.message) || e)}));', *args)
try:
    d.install_addon(sys.argv[1], temporary=True)
    time.sleep(3)
    open_ext('dashboard.html')
    time.sleep(3)
    check('dashboard renders', 'XVault' in d.title, d.title)
    tweets = []
    authors = ['nasa', 'natgeo', 'artist_jo', 'dev_kim', 'photo_lee']
    words = ['Sunset over the bay', 'New telescope images', 'Sketch of the week', 'Shipping a release', 'Street photography', 'Cats being cats', 'Mountain trail at dawn']
    for i in range(60):
        h = authors[i % 5]; tid = str(1800000000000000000 + i)
        video = i % 4 == 0
        tweets.append({'id': tid, 'text': f'{words[i % 7]} #{i}', 'url': f'https://x.com/{h}/status/{tid}',
            'createdAt': f'2024-{(i % 12) + 1:02d}-{(i % 27) + 1:02d}T00:00:00.000Z', 'author': {'handle': h, 'name': h},
            'metrics': {'likes': i * 137, 'reposts': i * 3, 'replies': i, 'views': i * 1000},
            'media': [{'type': 'video', 'url': f'https://pbs.twimg.com/ext_tw_video_thumb/{i}/pu/img/t.jpg', 'playbackUrl': f'https://video.twimg.com/ext_tw_video/{i}/pu/vid/avc1/720x720/v.mp4'} if video else {'type': 'photo', 'url': f'https://pbs.twimg.com/media/SEED{i}.jpg'}],
            'sources': ['bookmarks' if i % 2 else 'likes']})
    stored = run_async("return await browser.runtime.sendMessage({ type: 'STORE_RECORDS', tweets: arguments[0], users: [] });", tweets)
    check('STORE_RECORDS through the event page', isinstance(stored, dict) and stored.get('ok'), json.dumps(stored)[:200])
    d.refresh(); time.sleep(3)
    for b in d.find_elements(By.XPATH, "//button[contains(., 'Start using XVault')]"):
        if b.is_displayed(): b.click(); time.sleep(0.5)
    def count(q):
        box = d.find_element(By.ID, 'search'); box.clear(); box.send_keys(q); box.send_keys(Keys.ENTER); time.sleep(1.5)
        return d.execute_script("return document.querySelectorAll('#list [data-id], #list article, #list .card').length")
    allc = count('')
    check('library renders seeded posts', allc > 0, allc)
    nasa = count('from:nasa'); check('from: filter', 0 < nasa < allc, nasa)
    vids = count('type:video'); check('type:video', 0 < vids < allc, vids)
    sem = count('is:edited'); check('v21 filter is:edited (none edited)', sem == 0, sem)
    count('')
    # Every top-level page renders without throwing.
    pages = run_async("""const out = {}; for (const b of document.querySelectorAll('[data-page]')) out[b.dataset.page] = 1; return Object.keys(out);""")
    check('navigation pages found', isinstance(pages, list) and len(pages) > 5, pages)
    errs = []
    d.execute_script("window.__xvErr = []; addEventListener('error', e => __xvErr.push(String(e.message))); addEventListener('unhandledrejection', e => __xvErr.push(String(e.reason && e.reason.message || e.reason)));")
    for p in pages if isinstance(pages, list) else []:
        d.execute_script("const b = document.querySelector(`[data-page='${arguments[0]}']`); b && b.click();", p)
        time.sleep(0.8)
    errs = d.execute_script('return window.__xvErr')
    check('every page opens without errors', not errs, errs)
    # Storage, settings and messages handled by the event page.
    stats = run_async("return await browser.runtime.sendMessage({ type: 'STATS' });")
    check('STATS from the event page', isinstance(stats, dict) and stats.get('ok') is not False and not stats.get('__error'), json.dumps(stats)[:200])
    # Local OCR inside the event page (no offscreen document in Firefox).
    ocr = run_async("""
      const bg = await browser.runtime.getBackgroundPage();
      if (!bg) return { error: 'no background page' };
      if (!bg.XVaultOcrEngine) await new Promise((resolve, reject) => { const s = bg.document.createElement('script'); s.src = browser.runtime.getURL('offscreen-ocr.js'); s.onload = resolve; s.onerror = () => reject(Error('script load failed')); bg.document.head.append(s); });
      const c = document.createElement('canvas'); c.width = 640; c.height = 160; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 160); g.fillStyle = '#000'; g.font = 'bold 64px sans-serif'; g.fillText('HELLO FIREFOX', 20, 105);
      const blob = await new Promise(r => c.toBlob(r, 'image/png')); const url = URL.createObjectURL(blob);
      // Serve the test image for an X media address (the engine only reads pbs.twimg.com URLs).
      const realFetch = bg.fetch; const fake = 'https://pbs.twimg.com/media/FIREFOXTEST.png?name=medium';
      bg.fetch = (u, o) => (String(u) === fake ? realFetch.call(bg, url) : realFetch.call(bg, u, o));
      const t0 = Date.now(); let res;
      try { res = await bg.XVaultOcrEngine.handle({ type: 'OCR_RECOGNIZE', url: fake }); } finally { bg.fetch = realFetch; }
      return { ...res, ms: Date.now() - t0 };""")
    check('local OCR runs in the Firefox event page', isinstance(ocr, dict) and ocr.get('ok') and 'HELLO' in str(ocr.get('text', '')).upper(), json.dumps(ocr)[:300])
    # Exports fall back to a download when there is no File System Access API.
    hasPicker = d.execute_script('return typeof window.showSaveFilePicker')
    check('no showSaveFilePicker in Firefox (fallback path)', hasPicker == 'undefined', hasPicker)
    # Event page unload + wake-up: state must survive and messages must still be answered.
    time.sleep(14)
    woke = run_async("return await browser.runtime.sendMessage({ type: 'STATS' });")
    check('event page wakes after idle unload', isinstance(woke, dict) and not woke.get('__error') and woke.get('actions') == 60, json.dumps(woke)[:160])
    # XVault 22 scheduled backups: Firefox has no offscreen document, so the event page builds the recovery
    # file itself (blob: URL) and saves it with browser.downloads into <media folder>/Backups.
    backup = run_async("return await browser.runtime.sendMessage({ type: 'AUTO_BACKUP_RUN' });")
    check('automatic backup built in the event page', isinstance(backup, dict) and backup.get('state') == 'saved', json.dumps(backup)[:300])
    saved = ''
    for _ in range(20):
        hits = [os.path.join(r, f) for r, _, fs in os.walk(download_dir) for f in fs if f.startswith('xvault-auto-') and f.endswith('.jsonl')]
        if hits:
            saved = hits[0]
            break
        time.sleep(0.5)
    lines = open(saved, encoding='utf-8').read().strip().split('\n') if saved else []
    posts = sum(1 for line in lines if '"store":"tweets"' in line.replace(' ', ''))
    check('backup file on disk in XVault/Backups with every post', saved.replace('\\', '/').endswith('.jsonl') and '/XVault/Backups/' in saved.replace('\\', '/') and posts == 60 and '"type":"end"' in lines[-1].replace(' ', ''), f'{saved} posts={posts}')
    # A real download through the Firefox downloads API (an X CDN image; skipped when offline).
    try:
        urllib.request.urlopen(urllib.request.Request(IMAGE, headers={'User-Agent': 'Mozilla/5.0 XVault-e2e'}), timeout=10)
        cdn = True
    except Exception as error:
        cdn = False
        print('SKIP real download (X CDN unreachable):', error)
    if cdn:
        run_async("return await browser.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { skipProfilePictures: false } });")
        queued = run_async("""return await browser.runtime.sendMessage({ type: 'QUEUE_DOWNLOADS', force: true, items: [{
          url: '""" + IMAGE + """', tweetId: '1800000000000000001',
          author: 'natgeo', index: 1, mediaType: 'photo', sourceMediaType: 'photo' }] });""")
        check('QUEUE_DOWNLOADS accepted', isinstance(queued, dict) and (queued.get('added') or 0) >= 1, json.dumps(queued)[:200])
        done = None
        for _ in range(30):
            time.sleep(1)
            rows = run_async("return (await browser.downloads.search({})).filter(x => !/[\\\\/]Backups[\\\\/]/.test(x.filename)).map(x => ({ state: x.state, file: x.filename, err: x.error || '' }));")
            if isinstance(rows, list) and any(r['state'] == 'complete' for r in rows):
                done = rows; break
        check('download completes in Firefox', bool(done), json.dumps(done or rows)[:300])
        if done:
            f = next(r['file'] for r in done if r['state'] == 'complete')
            check('downloaded file is on disk inside the XVault folder', os.path.exists(f) and os.path.getsize(f) > 1000 and '/XVault/' in f.replace('\\', '/'), f)
        time.sleep(4)
        q = run_async("return await browser.runtime.sendMessage({ type: 'DOWNLOAD_QUEUE_STATS' });")
        recorded = isinstance(q, dict) and (q.get('complete') or q.get('completed') or 0) >= 1
        if not recorded:
            # Diagnostics: the live CDN occasionally serves bytes that differ from the probed Content-Length.
            hist = run_async("return await browser.runtime.sendMessage({ type: 'GET_DOWNLOAD_HISTORY', limit: 5 });")
            print('history', json.dumps([{k: r.get(k) for k in ('state', 'attempts', 'bytesReceived', 'totalBytes', 'error')} for r in (hist or {}).get('rows', [])]))
        check('download recorded as complete', recorded, json.dumps(q)[:300])
    # Content scripts on x.com (needs network; skipped when x.com is unreachable).
    reachable = os.environ.get('FF_LIVE_X') == '1'
    if not reachable:
        print('SKIP live x.com content-script check (set FF_LIVE_X=1)')
    if reachable:
        dash = d.current_window_handle
        d.switch_to.new_window('tab'); d.get('https://x.com/NASA'); time.sleep(8)
        d.switch_to.window(dash)
        probe = run_async("""const [tab] = await browser.tabs.query({ url: 'https://x.com/*' });
          if (!tab) return { error: 'no x.com tab' };
          return await browser.tabs.sendMessage(tab.id, { type: 'XV_GET_TEMPLATES' });""")
        check('content scripts inject on x.com and answer the extension', isinstance(probe, dict) and probe.get('ok'), json.dumps(probe)[:200])
        perms = run_async("return await browser.permissions.getAll();")
        check('x.com host permission granted', 'https://x.com/*' in (perms or {}).get('origins', []), json.dumps(perms)[:300])
    open_ext('sidepanel.html'); time.sleep(2)
    check('sidebar panel renders', 'XVault' in d.execute_script('return document.body.innerText'), d.title)
finally:
    json.dump(results, open(os.environ.get('FF_RESULTS', os.path.join(tempfile.gettempdir(), 'xvault-firefox-results.json')), 'w'), indent=1)
    d.quit()
failed = [r for r in results if not r['ok']]
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
