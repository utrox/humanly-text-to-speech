"""Browser tests for the page reader and the PDF viewer.

They run the built extension (dist/) in Chromium with the Firefox APIs replaced by a small mock
(test/browser/mock.js), so they check segmentation, highlighting, click-to-jump, the player and
the PDF viewer, but not the voice itself.

    pip install playwright && python -m playwright install chromium
    npm run build
    python test/browser/run.py              # add --screenshots to refresh docs/screenshots

Set CHROMIUM_PATH to use a specific Chromium binary.
"""
import asyncio
import functools
import http.server
import os
import shutil
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHOTS = "--screenshots" in sys.argv
OPEN_SHADOW = ("const o=Element.prototype.attachShadow;"
               "Element.prototype.attachShadow=function(x){return o.call(this,{...x,mode:'open'})}")
failures = []


def check(cond, label):
    print(("PASS  " if cond else "FAIL  ") + label)
    if not cond:
        failures.append(label)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(folder):
    handler = functools.partial(QuietHandler, directory=folder)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


SENTENCES_JS = """(sel) => { const m = new Map();
  document.querySelectorAll(sel).forEach(e => { const i = +e.dataset.i; m.set(i, (m.get(i) || '') + e.textContent); });
  return [...m.values()]; }"""


async def page_tests(browser, base):
    pg = await browser.new_page(viewport={"width": 1200, "height": 800})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.add_init_script(path=os.path.join(ROOT, "test", "browser", "mock.js"))
    await pg.add_init_script(script=OPEN_SHADOW + ";window.__noAutoEnd=true")
    await pg.goto(base + "/article.html")
    original = await pg.evaluate("document.body.innerHTML")
    await pg.add_style_tag(path=os.path.join(ROOT, "dist", "page.css"))
    await pg.add_script_tag(path=os.path.join(ROOT, "dist", "content.js"))
    await pg.evaluate("window.__msgListeners.forEach(f => f({t: 'toggle'}))")
    await pg.wait_for_timeout(400)

    texts = await pg.evaluate(SENTENCES_JS, "nr-s")
    check("The Quiet Ocean Is Getting Louder" in texts, "page: headline is read")
    check("Dr. Smith studied humpback whales for twenty years off the coast of Hawaii." in texts, "page: 'Dr.' does not split a sentence")
    check(not any("Subscribe" in t or "Share this" in t or "Home" in t for t in texts), "page: menus, sidebar and share bar skipped")
    check(not any("[1]" in t for t in texts), "page: citation marks skipped")

    await pg.click("text=Shipping traffic has roughly doubled")
    await pg.wait_for_timeout(300)
    plays = [m for m in await pg.evaluate("window.__log") if m["t"] == "play"]
    check(plays and plays[-1]["text"] == "Shipping traffic has roughly doubled since then.", "page: clicking a sentence reads it")
    cur = await pg.evaluate("[...document.querySelectorAll('nr-s.__nr_cur')].map(e => e.textContent).join('')")
    check(cur == "Shipping traffic has roughly doubled since then.", "page: clicked sentence is highlighted")
    if SHOTS:
        await pg.hover("text=Researchers now argue")
        await pg.screenshot(path=os.path.join(ROOT, "docs", "screenshots", "page.png"))
        await pg.click("nr-ui >> [data-a=menu]")
        await pg.wait_for_timeout(300)
        box = await pg.evaluate("(() => { const r = document.querySelector('nr-ui').shadowRoot.querySelector('.dock').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
        await pg.screenshot(path=os.path.join(ROOT, "docs", "screenshots", "player.png"),
                            clip={"x": box[0] - 16, "y": box[1] - 16, "width": box[2] + 32, "height": box[3] + 32})
        await pg.click("nr-ui >> [data-a=menu]")

    n = len(plays)
    await pg.evaluate("document.querySelector('a[href=\"https://example.org\"]').addEventListener('click', e => e.preventDefault())")
    await pg.click("text=first long-term study")
    await pg.wait_for_timeout(200)
    check(len([m for m in await pg.evaluate("window.__log") if m["t"] == "play"]) == n, "page: clicking a link does not jump")

    await pg.click("nr-ui >> [data-a=close]")
    await pg.wait_for_timeout(200)
    check(await pg.evaluate("document.body.innerHTML") == original, "page: closing restores the page exactly")
    check(not errors, "page: no script errors " + "; ".join(errors))
    await pg.close()


async def autoplay_test(browser, base):
    pg = await browser.new_page(viewport={"width": 1200, "height": 800})
    await pg.add_init_script(path=os.path.join(ROOT, "test", "browser", "mock.js"))
    await pg.add_init_script(script=OPEN_SHADOW)
    await pg.goto(base + "/article.html")
    await pg.add_style_tag(path=os.path.join(ROOT, "dist", "page.css"))
    await pg.add_script_tag(path=os.path.join(ROOT, "dist", "content.js"))
    await pg.evaluate("window.__msgListeners.forEach(f => f({t: 'toggle'}))")
    await pg.wait_for_timeout(300)
    await pg.click("nr-ui >> .play")
    await pg.wait_for_timeout(1500)
    plays = [m["text"] for m in await pg.evaluate("window.__log") if m["t"] == "play"]
    check(len(plays) >= 3, "player: moves on to the next sentence by itself")
    await pg.click("nr-ui >> .play")
    await pg.wait_for_timeout(100)
    check((await pg.evaluate("window.__log"))[-1]["t"] == "pause", "player: pause button pauses")
    await pg.close()


async def pdf_test(browser, base):
    pg = await browser.new_page(viewport={"width": 1100, "height": 850})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.add_init_script(path=os.path.join(ROOT, "test", "browser", "mock.js"))
    await pg.add_init_script(script="window.__noAutoEnd=true")
    await pg.goto(base + "/viewer.html?file=" + base.replace(":", "%3A").replace("/", "%2F") + "%2Fsample.pdf")
    await pg.wait_for_function("document.querySelectorAll('.page[data-page=\"2\"] nr-s').length > 0", timeout=60000)
    texts = await pg.evaluate(SENTENCES_JS, '.page[data-page="1"] nr-s')
    check(not any("Journal of Testing" in t for t in texts), "pdf: running header skipped")
    await pg.click('.page[data-page="1"] nr-s[data-i="2"]')
    await pg.wait_for_timeout(300)
    plays = [m for m in await pg.evaluate("window.__log") if m["t"] == "play"]
    check(plays and plays[-1]["text"] == "The second paragraph continues the experiment across a line break.",
          "pdf: line-break hyphen joined and sentence read")
    if SHOTS:
        await pg.screenshot(path=os.path.join(ROOT, "docs", "screenshots", "pdf.png"))
    check(not errors, "pdf: no script errors " + "; ".join(errors))
    await pg.close()


async def main():
    if not os.path.exists(os.path.join(ROOT, "dist", "manifest.json")):
        sys.exit("Build first: npm run build")
    site = tempfile.mkdtemp()
    shutil.copytree(os.path.join(ROOT, "dist"), site, dirs_exist_ok=True)
    for f in ("article.html", "sample.pdf"):
        shutil.copy(os.path.join(ROOT, "test", "fixtures", f), site)
    if SHOTS:
        os.makedirs(os.path.join(ROOT, "docs", "screenshots"), exist_ok=True)
    httpd, base = serve(site)
    async with async_playwright() as p:
        kw = {"executable_path": os.environ["CHROMIUM_PATH"]} if os.environ.get("CHROMIUM_PATH") else {}
        browser = await p.chromium.launch(**kw)
        await page_tests(browser, base)
        await autoplay_test(browser, base)
        await pdf_test(browser, base)
        await browser.close()
    httpd.shutdown()
    shutil.rmtree(site, ignore_errors=True)
    print(f"\n{len(failures)} failed" if failures else "\nAll browser tests passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
