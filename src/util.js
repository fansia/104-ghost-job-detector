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

  /** 104 的日期有三種格式(20260904 / 2026/09/04 / 9/04),統一成 YYYY/MM/DD 再顯示。 */
  function formatDate(date) {
    if (!date) return null;
    const p = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '/' + p(date.getMonth() + 1) + '/' + p(date.getDate());
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

  /**
   * 日曆日期用的措辭(appearDate 這種)。0 就真的是今天。
   */
  function daysAgoText(days) {
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    return days + ' 天前';
  }

  /**
   * 時間戳算出來的天數用的措辭(interactionRecord 這種)。
   * 這裡的 0 是「距今未滿 24 小時」,不等於「今天」—— 昨晚十一點也會算成 0,
   * 所以講「1 天內」才精確,「0 天前」則根本讀不通。
   */
  function withinDaysText(days) {
    if (days === 0) return '1 天內';
    return days + ' 天前';
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

  /* ---------- 資料來源健康狀態 ----------
   * 這些端點沒有公開文件,104 隨時可能改版。連續失敗時要讓使用者知道是「外掛抓不到了」,
   * 而不是「這個職缺剛好沒資料」—— 靜默消失是最糟的失敗方式。
   */

  const HEALTH_KEY = 'gjd:health';
  let health = null;

  async function loadHealth() {
    if (health) return health;
    const box = await chrome.storage.local.get(HEALTH_KEY);
    health = box[HEALTH_KEY] || { fails: 0, lastFailAt: null, lastOkAt: null };
    return health;
  }

  /** 記錄一次請求成敗。成功會把連續失敗計數歸零。 */
  async function noteFetch(ok) {
    try {
      const h = await loadHealth();
      if (ok) {
        h.lastOkAt = Date.now();
        if (!h.fails) return; // 一切正常時不必每次都寫入 storage
        h.fails = 0;
      } else {
        h.fails = (h.fails || 0) + 1;
        h.lastFailAt = Date.now();
      }
      await chrome.storage.local.set({ [HEALTH_KEY]: h });
    } catch (e) {
      /* 健康狀態只是輔助資訊,寫不進去不影響主要功能 */
    }
  }

  async function getHealth() {
    try {
      return await loadHealth();
    } catch (e) {
      return { fails: 0, lastFailAt: null, lastOkAt: null };
    }
  }

  ns.util = {
    parseAppearDate,
    formatDate,
    daysSince,
    daysSinceTs,
    daysAgoText,
    withinDaysText,
    jobCodeFromUrl,
    custCodeFromUrl,
    cacheGet,
    cacheSet,
    makeQueue,
    noteFetch,
    getHealth,
  };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
