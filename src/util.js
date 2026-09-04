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

  /**
   * 解析 104 的互動描述字串。
   *
   * 2026-09 改版後,interactionRecord 的時間戳全部歸零,真正的資料改放在
   * lastProcessedResumeDesc / lastCustReplyDesc 兩個中文字串裡。
   * 實測 1,056 筆只有五種格式:
   *   "3 分鐘前聯絡過求職者" / "5 小時前處理過履歷"  → 0(未滿一天)
   *   "7 天內處理過履歷"                            → 7
   * 認不得的字串一律回 null —— 寧可顯示「無資料」,也不要猜一個數字出來。
   */
  function parseInteractionDesc(text) {
    if (!text || typeof text !== 'string') return null;
    if (/分鐘前|小時前/.test(text)) return 0;
    const m = text.match(/(\d+)\s*天/);
    return m ? Number(m[1]) : null;
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

  /* ---------- 使用量統計 ----------
   * 唯一用途:判斷什麼時候適合開口請使用者去商店留評價。
   * 只有四個數字(看過幾個缺、展開幾次、哪幾天用過、有沒有回應過邀請),
   * 不含任何職缺內容,也不含任何可識別身分的資料,而且全部留在這台電腦上。
   */

  const STATS_KEY = 'gjd:stats';

  // 門檻:要等到「真的用順手」才開口。第一次看到徽章的人還在搞懂這是什麼,
  // 這時候問等於打斷。四個條件要同時成立。
  const ASK_MIN_JOBS = 80; // 累計看過的不重複職缺
  const ASK_MIN_EXPANDS = 5; // 展開徽章的次數 —— 真的在看數據,而不是把徽章當背景
  const ASK_MIN_DAYS = 3; // 不同的使用日數。一天狂刷 200 個缺不算用順手
  const ASK_MIN_AGE_DAYS = 3; // 距離第一次執行
  const ACTIVE_DAYS_CAP = 10; // 只留最近幾天,不需要完整的使用歷史

  let stats = null;
  let statsDirty = false;
  let statsTimer = null;

  function todayKey() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function blankStats() {
    return { installedAt: Date.now(), jobs: 0, expands: 0, days: [], review: null };
  }

  async function loadStats() {
    if (stats) return stats;
    try {
      const box = await chrome.storage.local.get(STATS_KEY);
      const v = box[STATS_KEY];
      stats = v && typeof v === 'object' ? Object.assign(blankStats(), v) : blankStats();
      if (!Array.isArray(stats.days)) stats.days = [];
    } catch (e) {
      stats = blankStats();
    }
    return stats;
  }

  // 一頁會渲染二十幾張徽章,每次都寫 storage 太浪費 —— 合併成兩秒一次。
  function saveStatsSoon() {
    statsDirty = true;
    if (statsTimer) return;
    statsTimer = setTimeout(async () => {
      statsTimer = null;
      if (!statsDirty || !stats) return;
      statsDirty = false;
      try {
        await chrome.storage.local.set({ [STATS_KEY]: stats });
      } catch (e) {
        /* 統計寫不進去不影響主要功能 */
      }
    }, 2000);
  }

  /** 第一次看到某個職缺時呼叫(由 touchHistory 判斷),所以這是不重複的計數。 */
  async function noteNewJob() {
    const s = await loadStats();
    s.jobs = (s.jobs || 0) + 1;
    saveStatsSoon();
  }

  async function noteExpand() {
    const s = await loadStats();
    s.expands = (s.expands || 0) + 1;
    saveStatsSoon();
  }

  async function noteActiveDay() {
    const s = await loadStats();
    const d = todayKey();
    if (s.days.includes(d)) return;
    s.days.push(d);
    if (s.days.length > ACTIVE_DAYS_CAP) s.days = s.days.slice(-ACTIVE_DAYS_CAP);
    saveStatsSoon();
  }

  /** 四個門檻同時成立,而且還沒回應過邀請時,才值得開口。 */
  async function shouldAskReview() {
    try {
      const s = await loadStats();
      if (s.review) return false;
      if ((s.jobs || 0) < ASK_MIN_JOBS) return false;
      if ((s.expands || 0) < ASK_MIN_EXPANDS) return false;
      if (s.days.length < ASK_MIN_DAYS) return false;
      if (Date.now() - (s.installedAt || 0) < ASK_MIN_AGE_DAYS * 86400000) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 記下使用者對邀請的回應。'dismissed' 與 'clicked' 都代表「不再問」——
   * 按過「不用了」還一直跳出來,比從來沒問過更糟。
   * 這裡不走延遲寫入:使用者可能馬上就離開頁面。
   */
  async function markReview(state) {
    try {
      const s = await loadStats();
      s.review = state;
      statsDirty = false;
      await chrome.storage.local.set({ [STATS_KEY]: s });
    } catch (e) {
      /* 寫不進去最多就是下次再問一次 */
    }
  }

  ns.util = {
    parseAppearDate,
    formatDate,
    daysSince,
    daysSinceTs,
    parseInteractionDesc,
    daysAgoText,
    withinDaysText,
    jobCodeFromUrl,
    custCodeFromUrl,
    cacheGet,
    cacheSet,
    noteNewJob,
    noteExpand,
    noteActiveDay,
    shouldAskReview,
    markReview,
    makeQueue,
    noteFetch,
    getHealth,
  };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
