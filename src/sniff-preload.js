// Injected into the hidden scraper window before page scripts run.
// Wraps fetch/XHR so every JSON response the site loads is forwarded to the main process.
const { ipcRenderer } = require('electron');

function report(url, text) {
  try {
    const json = JSON.parse(text);
    ipcRenderer.send('sniffed-json', { url, json });
  } catch { /* not JSON */ }
}

const origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await origFetch(...args);
  try {
    const clone = res.clone();
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    clone.text().then(t => report(url, t)).catch(() => {});
  } catch {}
  return res;
};

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this.__sniffUrl = url;
  return origOpen.call(this, method, url, ...rest);
};
XMLHttpRequest.prototype.send = function (...args) {
  this.addEventListener('load', () => {
    try { report(this.__sniffUrl || '', this.responseText); } catch {}
  });
  return origSend.apply(this, args);
};
