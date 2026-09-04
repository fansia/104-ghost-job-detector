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
  const APPLY_TTL = 60 * 60 * 1000; // 應徵人數快取 1 小時

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
   * 搜尋 API — 一次拿 20 筆職缺的 appearDate / applyCnt / hrBehaviorPR。
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
      hrBehaviorPR: x.hrBehaviorPR,
      interactionRecord: x.interactionRecord || null,
      salaryLow: x.salaryLow,
      salaryHigh: x.salaryHigh,
    }));
    await u.cacheSet(key, rows);
    return rows;
  }

  const COMPANY_PAGE_SIZE = 100;

  /**
   * 公司職缺 API — 這裡才有 interactionRecord(HR 上次處理履歷/回覆應徵者的時間)。
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
        hrBehaviorPR: j.hrBehaviorPR,
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

  const APPLY_MAX_PAGES = 3;
  // 搜尋結果太發散,代表公司名稱被斷詞成通用詞(「第一金人壽保險股份有限公司」
  // 會命中兩萬多筆),再翻幾頁也撈不到這家的缺,不如省下請求。
  const APPLY_MAX_TOTAL = 400;

  /**
   * 用公司名稱查搜尋 API,補回應徵人數。
   *
   * 公司職缺 API 和職缺詳細頁 API 都沒有應徵人數(它們的 userApplyCount 是
   * 「你自己投過幾次」,不是應徵者總數),精確的 applyCnt 只有搜尋 API 有。
   * 而搜尋 API 沒有任何以公司過濾的參數(cust/custNo/kwop 全試過,都被忽略),
   * 只能拿公司名稱當關鍵字撈,再自行比對 custCode 濾掉名稱相近的其他公司。
   *
   * 因此這是盡力而為:公司名稱夠特殊時能完整對上,名稱通用時只會拿到一部分,
   * 對不到的職缺就不顯示應徵人數(badge 本來就會略過 null 欄位)。
   *
   * @returns {Promise<Object<string, number>>} jobCode(base36) -> 應徵人數
   */
  async function applyCountsByCompany(custName, custCode) {
    if (!custName || !custCode) return {};
    const key = 'apply:' + custCode;
    const cached = await u.cacheGet(key, APPLY_TTL);
    if (cached) return cached;

    const out = {};
    try {
      for (let page = 1; page <= APPLY_MAX_PAGES; page++) {
        const p = new URLSearchParams({
          keyword: custName,
          page: String(page),
          pagesize: '20',
        });
        const json = await queue(() =>
          getJson('https://www.104.com.tw/jobs/search/api/jobs?' + p.toString())
        );
        const rows = json.data || [];
        for (const x of rows) {
          if (u.custCodeFromUrl(x.link && x.link.cust) !== custCode) continue;
          const code = u.jobCodeFromUrl(x.link && x.link.job);
          if (code && typeof x.applyCnt === 'number') out[code] = x.applyCnt;
        }
        const total =
          json.metadata && json.metadata.pagination && json.metadata.pagination.total;
        if (!rows.length) break;
        if (typeof total === 'number' && (page * 20 >= total || total > APPLY_MAX_TOTAL)) break;
      }
    } catch (e) {
      return out; // 撈到一半失敗就用已有的,應徵人數不是關鍵訊號
    }

    await u.cacheSet(key, out);
    return out;
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
      hrBehaviorPR: h.hrBehaviorPR,
      // 職缺內頁自己就帶著互動紀錄,不必再靠公司職缺 API 繞一圈去找
      interactionRecord: d.interactionRecord || h.interactionRecord || null,
      closeDate: d.closeDate,
      employees: d.employees,
    };
    await u.cacheSet(key, out);
    return out;
  }

  ns.api = { searchJobs, companyJobs, applyCountsByCompany, jobContent };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
