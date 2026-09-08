"use strict";

// The merchant creates signed checkout URLs on this gateway. Do not use suffix
// matching: payment query strings and the account session must stay on trusted sites.
const PAYMENT_ORIGIN = "https://pay.gggua.com";

function installAccountPortalNavigation(win, { portalOrigin, apiOrigin, preferences, log }) {
  const parse = (value) => {
    try {
      const url = new URL(value);
      return url.username || url.password ? null : url;
    } catch (_) {
      return null;
    }
  };
  const isPortal = (value) => parse(value)?.origin === portalOrigin;
  const isPayment = (value) => parse(value)?.origin === PAYMENT_ORIGIN;
  const isReturn = (value) => {
    const url = parse(value);
    return url?.origin === apiOrigin && url.pathname === "/api/pay/gggua/return";
  };
  const isCheckout = (value) => {
    const url = parse(value);
    return url?.origin === portalOrigin && /^\/checkout(?:\/|$)/.test(url.pathname);
  };
  const attach = (target, paymentWindow = false) => {
    target.webContents.setWindowOpenHandler(({ url }) => {
      if (isPortal(url)) {
        target.loadURL(url).catch(() => log("官网账号窗口跳转失败，请稍后重试。", "warn"));
        return { action: "deny" };
      }
      const current = target.webContents.getURL();
      const checkoutPlaceholder = url === "about:blank" && isCheckout(current);
      if (checkoutPlaceholder || (isPayment(url) && (isPortal(current) || isPayment(current)))) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            parent: target,
            title: "商城扫码支付",
            width: 960,
            height: 800,
            minWidth: 640,
            minHeight: 600,
            autoHideMenuBar: true,
            show: target.isVisible(),
            webPreferences: { ...preferences, nodeIntegration: false, contextIsolation: true, sandbox: true },
          },
        };
      }
      return { action: "deny" };
    });
    target.webContents.on("did-create-window", child => attach(child, true));
    const guardNavigation = (event, url) => {
      if (isPortal(url) || isPayment(url) || isReturn(url)) return;
      if (paymentWindow && url === "about:blank") return;
      event.preventDefault();
      // Never log signed checkout query strings or payment tokens.
      const destination = parse(url);
      log(`已拦截官网账号窗口的非信任跳转: ${destination ? destination.origin : "无效网址"}`, "warn");
    };
    target.webContents.on("will-navigate", guardNavigation);
    target.webContents.on("will-redirect", guardNavigation);
  };
  attach(win);
}

module.exports = { installAccountPortalNavigation };
