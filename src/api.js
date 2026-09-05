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

  /**
   * 搜尋 API — 一次拿 20 筆職缺的 appearDate / analysisType / interactionRecord。
   * 回傳裡的 hrBehaviorPR / hasHrBehavior 兩個活躍度欄位刻意不取,理由見 score.js。
   * @param {URLSearchParams} params 直接沿用使用者當前搜尋頁的查詢條件
   */
  async function searchJobs(params, page) {
    const p = new URLSearchParams(params);
    p.set('page', String(page));
    p.set('pagesize', '20');
    const url = 'https://www.104.com.tw/jobs/search/api/jobs?' + p.toString();

    const key = 'search:' + url;
    const cached = await u.cacheGet(key, SEARCH_TTL);
    if (cached) return cached;

    const json = await queue(() => getJson(url));
    const rows = (json.data || []).map((x) => ({
      jobNo: String(x.jobNo),
      jobCode: u.jobCodeFromUrl(x.link && x.link.job),
      jobName: x.jobName,
      custName: x.custName,
      custCode: u.custCodeFromUrl(x.link && x.link.cust),
      appearDate: x.appearDate,
      applyCnt: x.applyCnt,
      // 104 改版後 applyCnt 恆為 0:級距看 analysisType,精確人數見 applyCount()
      analysisType: x.analysisType,
      interactionRecord: x.interactionRecord || null,
      salaryLow: x.salaryLow,
      salaryHigh: x.salaryHigh,
    }));
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
    if (typeof cached === 'number') return cached;

    const url =
      'https://www.104.com.tw/api/companies/' +
      encodeURIComponent(custCode) +
      '/jobs?page=1&pageSize=1';

    let json;
    try {
      json = await queue(() => getJson(url));
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
    if (cached) return cached;

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
        analysisType: j.analysisType,
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
    if (cached) return typeof cached.count === 'number' ? cached.count : null;

    let json;
    try {
      json = await queue(() =>
        getJson('https://www.104.com.tw/jb/104i/applyAnalysisToJob/all?job_no=' + jobNo)
      );
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

  /** 職缺詳細頁 API */
  async function jobContent(jobCode) {
    const key = 'job:' + jobCode;
    const cached = await u.cacheGet(key, SEARCH_TTL);
    if (cached) return cached;
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
      analysisType: h.analysisType,
      // 職缺內頁自己就帶著互動紀錄,不必再靠公司職缺 API 繞一圈去找
      interactionRecord: d.interactionRecord || h.interactionRecord || null,
      closeDate: d.closeDate,
      employees: d.employees,
    };
    await u.cacheSet(key, out);
    return out;
  }

  ns.api = { searchJobs, companyJobs, companyTotal, applyCount, jobContent };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
