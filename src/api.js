/* 104 內部 API 封裝。
 *
 * 這些不是 104 官方對外開放、需申請金鑰的 Open API,而是 104 網頁前端自己在載入
 * 職缺時就會呼叫的內部 JSON 端點,未公開文件。content script 跑在 www.104.com.tw
 * 底下,全部是同源請求。
 */
var GJD = (function (ns) {
  const u = ns.util;
  const queue = u.makeQueue(2, 250); // 同時最多 2 個請求,每個間隔 250ms
  const COMPANY_TTL = 6 * 60 * 60 * 1000; // 公司資料快取 6 小時
  const SEARCH_TTL = 5 * 60 * 1000;
  const APPLY_TTL = 6 * 60 * 60 * 1000; // 應徵人數每日更新一次,快取 6 小時就夠

  async function getJson(url) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      const json = await res.json();
      u.noteFetch(true);
      return json;
    } catch (e) {
      u.noteFetch(false);
      throw e;
    }
  }

  /* ---------- 每一輪的用量統計 ----------
   * 這些端點沒有公開文件,請求量又是這個外掛最該節制的地方 —— HR 活躍度反查
   * 一個職缺最多要打六次。把每輪實際用量印出來,才看得出快取到底有沒有在擋。
   * 計數在 takeStats() 取走時歸零,所以印出來的是「這一輪」而不是累計。
   */
  const stats = {
    searchPages: 0, // 搜尋 API 實際打出去的頁數
    searchRows: 0, // 這輪拿到的職缺筆數
    companyReq: 0, // 公司相關請求(開缺總數 + 公司頁的職缺清單)
    applyReq: 0, // 應徵人數
    similarReq: 0, // 相似職缺清單:真的打出去的
    similarHit: 0, // 相似職缺清單:命中本輪快取,沒打
    storeHit: 0, // 命中 chrome.storage 快取,沒打
    prCacheHit: 0, // HR 活躍度直接從 sessionStorage 拿到
    prFound: 0, // 反查成功
    prMissed: 0, // 反查掃完仍找不到
  };

  /**
   * 搜尋 API — 一次拿 20 筆職缺的 appearDate / analysisType / hasHrBehavior。
   * applyCnt 與 hrBehaviorPR 兩個欄位仍在回傳裡,但 104 已把值歸零,只留著以防它改回來。
   * @param {URLSearchParams} params 直接沿用使用者當前搜尋頁的查詢條件
   */
  async function searchJobs(params, page) {
    const p = new URLSearchParams(params);
    p.set('page', String(page));
    p.set('pagesize', '20');
    const url = 'https://www.104.com.tw/jobs/search/api/jobs?' + p.toString();

    const key = 'search:' + url;
    const cached = await u.cacheGet(key, SEARCH_TTL);
    if (cached) {
      stats.storeHit++;
      stats.searchRows += cached.length;
      return cached;
    }

    const json = await queue(() => getJson(url));
    stats.searchPages++;
    const rows = (json.data || []).map((x) => ({
      jobNo: String(x.jobNo),
      jobCode: u.jobCodeFromUrl(x.link && x.link.job),
      // jobType 1 是置頂推薦(點進去的連結帶 jobsource=hotjob_chr_exp),每頁固定 2 筆,
      // 也就是 pagesize=20 卻回 22 筆的來源。它跟搜尋關鍵字沒什麼關係
      // (搜「數據工程師」會出「QC測試人員」),所以不為它做 HR 活躍度反查。
      jobType: x.jobType,
      jobName: x.jobName,
      custName: x.custName,
      custCode: u.custCodeFromUrl(x.link && x.link.cust),
      appearDate: x.appearDate,
      applyCnt: x.applyCnt,
      hrBehaviorPR: x.hrBehaviorPR,
      // 104 改版後 applyCnt 恆為 0:級距看 analysisType,精確人數見 applyCount()
      analysisType: x.analysisType,
      hasHrBehavior: x.hasHrBehavior,
      interactionRecord: x.interactionRecord || null,
      salaryLow: x.salaryLow,
      salaryHigh: x.salaryHigh,
    }));
    stats.searchRows += rows.length;
    await u.cacheSet(key, rows);
    return rows;
  }

  const COMPANY_PAGE_SIZE = 100;

  /**
   * 公司開缺總數 — 只為了 facts.openJobs 這一個數字。
   *
   * totalCount 與 pageSize 無關,第一頁就會回,所以拿 pageSize=1 就夠。
   * 實測同一家公司:pageSize=100 回傳 40,214 bytes、pageSize=1 只有 7,089 bytes,
   * 大公司差距更大(開 1,386 個缺的公司會被拉回整整 100 筆職缺,只為讀一個數字)。
   *
   * 職缺本身的欄位不從這裡拿 —— 搜尋 API 與職缺內頁 API 都自帶 interactionRecord,
   * 繞公司 API 找那一筆是白跑。只有公司頁的卡片沒有別的來源,才走 companyJobs()。
   */
  async function companyTotal(custCode) {
    if (!custCode) return null;
    const key = 'custTotal:' + custCode;
    const cached = await u.cacheGet(key, COMPANY_TTL);
    if (typeof cached === 'number') {
      stats.storeHit++;
      return cached;
    }

    const url =
      'https://www.104.com.tw/api/companies/' +
      encodeURIComponent(custCode) +
      '/jobs?page=1&pageSize=1';

    let json;
    try {
      json = await queue(() => getJson(url));
      stats.companyReq++;
    } catch (e) {
      return null;
    }
    const total = json && json.data && json.data.totalCount;
    if (typeof total !== 'number') return null;
    await u.cacheSet(key, total);
    return total;
  }

  /**
   * 公司職缺 API — 逐筆職缺的 interactionRecord 等欄位。
   * 只有公司頁在用:那裡的卡片除了這個 API 之外沒有別的資料來源。
   * 大公司可能有數百個職缺,所以要分頁取;呼叫端負責往後翻到找到目標職缺為止。
   * 回傳 { totalCount, totalPages, byJobCode: { [base36]: {...} } }
   */
  async function companyJobs(custCode, page) {
    if (!custCode) return null;
    const pageNo = page || 1;
    const key = 'cust:' + custCode + ':' + pageNo;
    const cached = await u.cacheGet(key, COMPANY_TTL);
    if (cached) {
      stats.storeHit++;
      return cached;
    }

    const url =
      'https://www.104.com.tw/api/companies/' +
      encodeURIComponent(custCode) +
      '/jobs?page=' +
      pageNo +
      '&pageSize=' +
      COMPANY_PAGE_SIZE;

    let json;
    try {
      json = await queue(() => getJson(url));
      stats.companyReq++;
    } catch (e) {
      return null;
    }

    const d = (json && json.data) || {};
    const list = d.list || {};
    const jobs = [].concat(list.topJobs || [], list.normalJobs || []);
    const byJobCode = {};
    for (const j of jobs) {
      const code = j.jobNo || u.jobCodeFromUrl(j.jobUrl);
      if (!code) continue;
      byJobCode[code] = {
        interactionRecord: j.interactionRecord || null,
        hrBehaviorPR: j.hrBehaviorPR,
        analysisType: j.analysisType,
        hasHrBehavior: j.hasHrBehavior,
        appearDate: j.appearDate,
        jobName: j.jobName,
      };
    }
    const out = {
      totalCount: typeof d.totalCount === 'number' ? d.totalCount : jobs.length,
      totalPages: typeof d.totalPages === 'number' ? d.totalPages : 1,
      byJobCode,
    };
    await u.cacheSet(key, out);
    return out;
  }

  /* 應徵人數。
   *
   * 104 於 2026-09 把搜尋 API 的 applyCnt 歸零,但應徵分析頁自己用的端點仍然給精確
   * 人數。job_no 是職缺代碼的 base36 數值(例:8y318 -> 15027164,與搜尋 API 回傳的
   * 數字 jobNo 一致)。不需要登入。
   *
   * 回傳的八個維度各自帶 total,但 skill/cert 只統計「有填這欄」的應徵者,會比實際
   * 人數少,所以只取人口統計維度。
   */
  const APPLY_TOTAL_KEYS = ['sex', 'edu', 'yearRange', 'exp'];

  async function applyCount(jobCode) {
    if (!jobCode) return null;
    const jobNo = parseInt(String(jobCode), 36);
    if (!Number.isFinite(jobNo) || jobNo <= 0) return null;

    const key = 'apply:' + jobCode;
    const cached = await u.cacheGet(key, APPLY_TTL);
    if (cached) {
      stats.storeHit++;
      return typeof cached.count === 'number' ? cached.count : null;
    }

    let json;
    try {
      json = await queue(() =>
        getJson('https://www.104.com.tw/jb/104i/applyAnalysisToJob/all?job_no=' + jobNo)
      );
      stats.applyReq++;
    } catch (e) {
      return null;
    }
    if (!json || typeof json !== 'object') return null;

    let count = null;
    for (const k of APPLY_TOTAL_KEYS) {
      const t = json[k] && json[k].total;
      if (typeof t === 'number') {
        count = t;
        break;
      }
    }
    if (count === null) return null;

    await u.cacheSet(key, { count });
    return count;
  }

  /* ---------- HR 活躍度(hrBehaviorPR)反查 ----------
   *
   * 104 於 2026-09 把「以該職缺為主體」的端點裡的 hrBehaviorPR 全部抹成 0 ——
   * 搜尋 API、職缺內頁、公司職缺 API 三邊皆然。但同一個職缺以「清單項目」的身分
   * 出現在別人的相似職缺清單裡時,值原樣保留。實測 8dclx:自己那三個端點都是 0,
   * 出現在 8jd0e 的相似清單裡是 0.7720。
   *
   * 所以要拿 X 的 PR,只能去翻某個 Y 的清單。麻煩的是相似關係高度不對稱:
   * Y 是 X 的第一名相似職缺,X 在 Y 的清單裡卻排到第 141~383 名(實測 32 筆,
   * 中位 294)。只看 Y 的第一頁完全撈不到 —— 三批獨立樣本共 52 次嘗試,零命中。
   *
   * 一頁 50 筆,那個名次區間正好落在第 3~8 頁,第 1、2 頁與第 9、10 頁兩頭全空。
   * 再按實測命中頻率(p6 x11、p7 x10、p4 x7、p3 x3、p8 x1)排成 6→7→4→3→8,
   * 單筆深挖的期望請求數從 4.50 次降到 3.18 次。
   */

  const SIMILAR_PAGE_SIZE = 50;
  const DEEP_PAGES = [6, 7, 4, 3, 8];

  /* PR 快取放 sessionStorage:關掉分頁就清空。
   * PR 是每日更新的慢變量,一個瀏覽階段內不會過期;而且每次請求都會順手灌進
   * 50 筆別的職缺,越滑命中率越高 —— 實測同一個搜尋的第 2 頁有 86% 直接命中,
   * 第 3 頁 77%。換關鍵字就只剩 9%,所以沒有跨階段保留的價值。
   */
  const PR_PREFIX = 'gjd:pr:';
  const MISS_PREFIX = 'gjd:prmiss:';

  function prGet(code) {
    try {
      const v = sessionStorage.getItem(PR_PREFIX + code);
      return v === null ? null : Number(v);
    } catch (e) {
      return null;
    }
  }

  function prSet(code, pr) {
    try {
      sessionStorage.setItem(PR_PREFIX + code, String(pr));
    } catch (e) {
      /* 配額滿了就算了,反查失敗只是少一項訊號 */
    }
  }

  // 找不到也要記下來。搜尋頁是虛擬捲動,同一張卡片會反覆進出 DOM,
  // 沒有這個標記的話每次重畫都要再燒 6 次請求去找一個本來就找不到的值。
  function prMissed(code) {
    try {
      return sessionStorage.getItem(MISS_PREFIX + code) !== null;
    } catch (e) {
      return false;
    }
  }

  function prMiss(code) {
    try {
      sessionStorage.setItem(MISS_PREFIX + code, '1');
    } catch (e) {
      /* 同上 */
    }
  }

  // 同一份清單會被多個職缺共用當跳板 —— 實測一個 Y 被 11 個不同的 X 指到,
  // 所以整份清單連同它的順序一起留著,同一個 url 在這個分頁裡只打一次。
  const similarCache = new Map();

  /** 抓一頁相似職缺,把裡面每一筆的 PR 都灌進快取,回傳這頁的職缺代碼順序 */
  function harvestSimilar(jobCode, page) {
    const url =
      'https://www.104.com.tw/job/ajax/similarJobs/' +
      encodeURIComponent(jobCode) +
      '?page=' +
      page +
      '&pageSize=' +
      SIMILAR_PAGE_SIZE;

    const cached = similarCache.get(url);
    if (cached) {
      stats.similarHit++;
      return cached;
    }

    stats.similarReq++;
    const p = queue(() => getJson(url))
      .then((json) => {
        const list = (json && json.data && json.data.list) || [];
        const codes = [];
        for (const j of list) {
          const code = u.jobCodeFromUrl(j.link && j.link.job);
          if (!code) continue;
          if (typeof j.hrBehaviorPR === 'number') prSet(code, j.hrBehaviorPR);
          codes.push(code);
        }
        return codes;
      })
      .catch(() => {
        similarCache.delete(url); // 失敗不留下來,下次還能重試
        return null;
      });

    similarCache.set(url, p);
    return p;
  }

  async function doLookupHrPR(jobCode) {
    // 先查自己的相似清單。自己不會出現在裡面,但要的是清單第一名 —— 那就是跳板 Y;
    // 順帶這 50 筆會把別的職缺的 PR 灌進快取,同一頁後面的卡片常常就不用再查了。
    const own = await harvestSimilar(jobCode, 1);
    // 請求失敗(回 null)跟「清單是空的」要分開:失敗只是這次沒拿到,不能寫進
    // 找不到標記,否則一次網路抖動就讓這個職缺在整個瀏覽階段裡永遠查不到。
    if (!own) return null;
    if (!own.length) {
      prMiss(jobCode);
      stats.prMissed++;
      return null;
    }

    // 實測跳板一律是別的職缺,但真的撞上自己就換下一個 —— 拿自己當跳板必然查不到,
    // 白燒五次請求。
    const y = own.find((c) => c !== jobCode);
    if (!y) {
      prMiss(jobCode);
      stats.prMissed++;
      return null;
    }

    let anyOk = false;
    for (const page of DEEP_PAGES) {
      const got = await harvestSimilar(y, page);
      if (got) anyOk = true;
      const v = prGet(jobCode);
      if (v !== null) {
        stats.prFound++;
        return v;
      }
    }

    // 掃完 p3~p8 還是沒有,就是相似簇之外的職缺(實測多為關鍵字勉強撈到的邊緣條目),
    // 再往下翻也找不到:兩批樣本裡沒有任何一筆命中 p9 或 p10。
    // 但整輪都失敗的話,那是抓不到而不是找不到,同樣不留標記。
    if (anyOk) {
      prMiss(jobCode);
      stats.prMissed++;
    }
    return null;
  }

  const prInFlight = new Map();

  /** 反查單一職缺的 HR 活躍度百分位,查不到回 null */
  function lookupHrPR(jobCode) {
    if (!jobCode) return Promise.resolve(null);
    const hit = prGet(jobCode);
    if (hit !== null) {
      stats.prCacheHit++;
      return Promise.resolve(hit);
    }
    if (prMissed(jobCode)) return Promise.resolve(null);

    const running = prInFlight.get(jobCode);
    if (running) return running;

    const p = doLookupHrPR(jobCode)
      .catch(() => null)
      .finally(() => prInFlight.delete(jobCode));
    prInFlight.set(jobCode, p);
    return p;
  }

  /** 職缺詳細頁 API */
  async function jobContent(jobCode) {
    const key = 'job:' + jobCode;
    const cached = await u.cacheGet(key, SEARCH_TTL);
    if (cached) {
      stats.storeHit++;
      return cached;
    }
    let json;
    try {
      json = await queue(() =>
        getJson('https://www.104.com.tw/job/ajax/content/' + encodeURIComponent(jobCode))
      );
    } catch (e) {
      return null;
    }
    const d = (json && json.data) || {};
    const h = d.header || {};
    const out = {
      jobName: h.jobName,
      custName: h.custName,
      custCode: u.custCodeFromUrl(h.custUrl),
      appearDate: h.appearDate,
      hrBehaviorPR: h.hrBehaviorPR,
      analysisType: h.analysisType,
      hasHrBehavior: h.hasHrBehavior,
      // 職缺內頁自己就帶著互動紀錄,不必再靠公司職缺 API 繞一圈去找
      interactionRecord: d.interactionRecord || h.interactionRecord || null,
      closeDate: d.closeDate,
      employees: d.employees,
    };
    await u.cacheSet(key, out);
    return out;
  }

  /** 取走這一輪的統計並歸零;順帶回報 PR 快取目前累積幾筆 */
  function takeStats() {
    const out = Object.assign({}, stats);
    for (const k of Object.keys(stats)) stats[k] = 0;
    out.prCacheSize = 0;
    try {
      for (const k of Object.keys(sessionStorage)) {
        if (k.startsWith(PR_PREFIX)) out.prCacheSize++;
      }
    } catch (e) {
      out.prCacheSize = null;
    }
    return out;
  }

  ns.api = {
    searchJobs,
    companyJobs,
    companyTotal,
    applyCount,
    jobContent,
    lookupHrPR,
    takeStats,
  };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
