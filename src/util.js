/* 共用工具:快取、請求佇列、日期處理 */
var GJD = (function (ns) {
  const DAY = 86400;

  /** 把 104 的三種日期格式正規化成 Date。
   *  搜尋 API:"20260830" / 職缺頁:"2026/08/07" / 公司職缺列表:"8/07"(無年份) */
  function parseAppearDate(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    let m;
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
      return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    if ((m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/))) {
      return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})$/))) {
      // 只有月/日:假設是過去一年內,若換算後是未來則往前推一年
      const now = new Date();
      let d = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
      if (d > now) d = new Date(now.getFullYear() - 1, +m[1] - 1, +m[2]);
      return d;
    }
    return null;
  }

  function daysSince(date) {
    if (!date) return null;
    return Math.floor((Date.now() - date.getTime()) / 86400000);
  }

  function daysSinceTs(unixSeconds, nowSeconds) {
    if (!unixSeconds) return null;
    const now = nowSeconds || Date.now() / 1000;
    return Math.floor((now - unixSeconds) / DAY);
  }

  /** 從職缺網址取出 base36 代碼,例如 https://www.104.com.tw/job/8i1y2?x=1 -> 8i1y2 */
  function jobCodeFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/\/job\/([0-9a-z]+)/i);
    return m ? m[1] : null;
  }

  /** 從公司網址取出公司代碼 */
  function custCodeFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/\/company\/([0-9a-z]+)/i);
    return m ? m[1] : null;
  }

  /* ---------- chrome.storage.local 快取 ---------- */

  async function cacheGet(key, maxAgeMs) {
    try {
      const box = await chrome.storage.local.get(key);
      const hit = box[key];
      if (!hit) return null;
      if (maxAgeMs && Date.now() - hit.t > maxAgeMs) return null;
      return hit.v;
    } catch (e) {
      return null;
    }
  }

  async function cacheSet(key, value) {
    try {
      await chrome.storage.local.set({ [key]: { t: Date.now(), v: value } });
    } catch (e) {
      /* storage 滿了就算了,不影響主要功能 */
    }
  }

  /** 限制同時進行的請求數,避免對 104 造成不必要的負擔 */
  function makeQueue(concurrency, gapMs) {
    let active = 0;
    const waiting = [];
    function next() {
      if (active >= concurrency || waiting.length === 0) return;
      active++;
      const { fn, resolve, reject } = waiting.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          setTimeout(() => {
            active--;
            next();
          }, gapMs);
        });
    }
    return function enqueue(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        next();
      });
    };
  }

  ns.util = {
    parseAppearDate,
    daysSince,
    daysSinceTs,
    jobCodeFromUrl,
    custCodeFromUrl,
    cacheGet,
    cacheSet,
    makeQueue,
  };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
