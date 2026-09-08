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

  /* ---------- 隱藏清單 ----------
   *
   * 這是整個外掛唯一「替使用者做決定」的地方,但決定是使用者自己下的 ——
   * 工具只負責記住並執行,不會自己判斷哪家公司該被隱藏。
   *
   * 形狀:{ companies: [{code, name}], hideApplied }
   *
   * 刻意沒有「隱藏置頂職缺」這個選項。置頂是 104 的付費商品,做一個開關專門
   * 把付費曝光濾掉,性質上接近廣告攔截 —— 那會給對方一個站得住腳的法律理由,
   * 而這個外掛的定位是補上它沒顯示的資訊,不是干預它怎麼賣廣告。
   * 公司一律用代碼當鍵,不用名稱:公司會改名,代碼不會;同名的不同公司也分得開。
   * name 只是拿來顯示的。
   */

  const HIDDEN_KEY = 'gjd:hidden';

  function blankHidden() {
    return { companies: [], hideApplied: false };
  }

  /* 一律回傳全新的物件與陣列。呼叫端拿到的若是快取本身那一份,
   * 任何人改它都會連帶改到快取,而快取代表的是「storage 裡現在的內容」。 */
  function normalizeHidden(v) {
    if (!v || typeof v !== 'object') return blankHidden();
    return {
      companies: Array.isArray(v.companies) ? v.companies.map((c) => ({ ...c })) : [],
      hideApplied: !!v.hideApplied,
    };
  }

  /* 最後一次成功讀到的規則。
   *
   * 讀失敗時退回這一份,而不是退回空清單 —— 空清單代表「沒有任何規則」,
   * 於是被隱藏的職缺會全部冒出來,看起來像設定被清掉了。最常見的觸發情境是
   * 開發時重新載入外掛:還開著的分頁裡,舊的內容腳本每次呼叫 chrome.storage
   * 都會拿到 Extension context invalidated。那是「問不到」,不是「沒有」。 */
  let lastGoodHidden = null;

  async function getHidden() {
    try {
      const box = await chrome.storage.local.get(HIDDEN_KEY);
      lastGoodHidden = normalizeHidden(box[HIDDEN_KEY]);
      return lastGoodHidden;
    } catch (e) {
      return normalizeHidden(lastGoodHidden);
    }
  }

  /* 讀-改-寫要排隊。同一個環境裡連按兩次隱藏時,兩次都會先各讀一份舊的、
   * 各改各的、再寫回去,後寫的把先寫的蓋掉,結果掉一筆。
   * (跨環境 —— 內容腳本 vs 彈出視窗 —— 沒辦法在這一層解決,chrome.storage
   *  沒有提供原子性的讀改寫;但那需要使用者兩隻手同時操作,罕見得多。) */
  let writeChain = Promise.resolve();

  /**
   * 改寫隱藏規則。mutate 直接改傳進去的物件。
   * @returns {Promise<boolean>} 是否真的寫進去了 —— 呼叫端要據此決定要不要重畫。
   */
  function updateHidden(mutate) {
    const run = writeChain.then(async () => {
      // getHidden 已經給的是副本,改它不會動到快取 —— 寫入失敗時快取要維持原狀,
      // 否則那筆沒存進去的變更會留在記憶體裡,之後每次讀取失敗都會把它當成真的。
      const h = await getHidden();
      mutate(h);
      try {
        await chrome.storage.local.set({ [HIDDEN_KEY]: h });
        lastGoodHidden = h;
        return true;
      } catch (e) {
        /* 寫不進去最常見的原因就是外掛剛被重新載入,這個分頁的腳本已經是孤兒。
         * 這裡不能讓例外往上飄:呼叫端是 click handler,沒有人會接。 */
        return false;
      }
    });
    // 這條鏈不能因為一次失敗就斷掉,後面的寫入還要用它排隊
    writeChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  function setHidden(next) {
    return updateHidden((h) => Object.assign(h, normalizeHidden(next)));
  }

  function hideCompany(code, name) {
    if (!code) return Promise.resolve(false);
    return updateHidden((h) => {
      if (!h.companies.some((c) => c.code === code)) {
        h.companies.push({ code, name: name || code });
      }
    });
  }

  /**
   * 這張卡片該不該被隱藏?回傳一個「原因」物件,或 null 代表不隱藏。
   *
   * 回傳結構而不是布林值,是為了讓摺疊後那一行講得出為什麼不見了,
   * 也讓「解除隱藏」知道該解除哪一條規則。
   * 使用者忘記自己封鎖過某家公司時,不該以為是外掛壞了。
   */
  function hiddenReason(facts, hidden) {
    if (!facts || !hidden) return null;

    const company =
      facts.custCode && hidden.companies.find((c) => c.code === facts.custCode);
    if (company) {
      return { kind: 'company', value: company.code, text: '你封鎖了這家公司' };
    }

    // isApplied 未登入時是 null —— 只在明確為 true 時才隱藏
    if (hidden.hideApplied && facts.isApplied === true) {
      return { kind: 'hideApplied', text: '你已經投過這個職缺' };
    }
    return null;
  }

  /**
   * 解除造成隱藏的那條規則。
   *
   * 摺疊列上只給這一種按鈕,不給「這次先顯示出來」的暫時放行 ——
   * 剛按完隱藏、下一秒按的那顆鈕,意思就是「我反悔了」。做成暫時放行的話,
   * 規則還留著,使用者得自己找到彈出視窗才解得掉,而且會以為按鈕沒作用。
   */
  function undoHidden(reason) {
    if (!reason) return Promise.resolve(false);
    return updateHidden((h) => {
      if (reason.kind === 'company') {
        h.companies = h.companies.filter((c) => c.code !== reason.value);
      } else if (reason.kind === 'hideApplied') {
        h.hideApplied = false;
      }
    });
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
    parseInteractionDesc,
    daysAgoText,
    withinDaysText,
    jobCodeFromUrl,
    custCodeFromUrl,
    cacheGet,
    cacheSet,
    getHidden,
    setHidden,
    updateHidden,
    hideCompany,
    hiddenReason,
    undoHidden,
    makeQueue,
    noteFetch,
    getHealth,
  };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
