import os
from pathlib import Path
from playwright.sync_api import sync_playwright

OUTPUT = Path(__file__).resolve().parent / "artifacts"
OUTPUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(os.environ.get("E2E_CDP_URL", "http://127.0.0.1:9334"))
    pages = [page for context in browser.contexts for page in context.pages]
    if not pages:
        raise AssertionError("未找到 Electron 页面")
    page = pages[0]
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(1000)

    title = page.title()
    if "悸风喵核 Studio" not in title:
        raise AssertionError(f"窗口标题异常：{title}")

    nav_panels = page.locator(".nav-item").evaluate_all("els => els.map(el => el.dataset.panel)")
    if nav_panels != ["uploadPage", "downloadPage", "historyPage"]:
        raise AssertionError(f"导航板块异常：{nav_panels}")

    required = [
        "#uploadPage", "#downloadPage", "#historyPage", "#accountPanel",
        "#sunoAccountSelect", "#sunoExtensionBtn", "#batchUploadDropArea",
        "#sunoDownloadForm", "#historyList",
    ]
    for selector in required:
        if page.locator(selector).count() != 1:
            raise AssertionError(f"缺少必要界面元素：{selector}")

    csp = page.locator('meta[http-equiv="Content-Security-Policy"]').get_attribute("content") or ""
    for directive in ["script-src 'self' blob:", "object-src 'none'", "frame-src 'none'"]:
        if directive not in csp:
            raise AssertionError(f"CSP 缺少：{directive}")

    # 未登录时点击受保护导航必须停留在三板块范围，不能跳到已隐藏的分离模块。
    page.locator("#activationRequiredModal").evaluate("el => el.classList.add('hidden')")
    page.locator('[data-panel="downloadPage"]').click(force=True)
    page.wait_for_timeout(200)
    visible_panels = page.locator(".module-page").evaluate_all("els => els.filter(el => getComputedStyle(el).display !== 'none').map(el => el.id)")
    if any(panel not in {"uploadPage", "downloadPage", "historyPage"} for panel in visible_panels):
        raise AssertionError(f"出现范围外板块：{visible_panels}")

    page.screenshot(path=str(OUTPUT / "packaged-three-panels.png"), full_page=True)
    print({"title": title, "navPanels": nav_panels, "visiblePanels": visible_panels, "url": page.url})
    browser.close()
