// Cầu nối capture/restore: chạy TRONG ngữ cảnh extension (có chrome.storage). Main process mở trang này
// bằng session của profile rồi executeJavaScript gọi __cxDump()/__cxLoad() để chụp/phục hồi TRỌN chrome.storage.local.
window.__cxDump = function () {
  return new Promise(function (res) {
    try { chrome.storage.local.get(null, function (d) { res(d || {}); }); } catch (e) { res({}); }
  });
};
window.__cxLoad = function (obj) {
  return new Promise(function (res) {
    try {
      var payload = obj && typeof obj === "object" ? obj : {};
      chrome.storage.local.set(payload, function () { res({ ok: true, keys: Object.keys(payload).length }); });
    } catch (e) { res({ ok: false, error: String(e) }); }
  });
};
window.__cxReady = true;
