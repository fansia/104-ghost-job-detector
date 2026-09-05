/* 幽靈職缺評分。
 *
 * 原則:分數只是排序用的摘要,真正要給求職者看的是「事實」(HR 幾天沒處理履歷、
 * 近 30 天內有沒有站內回覆紀錄、掛了幾天)。誤判把真職缺標成假的,對雙方都是傷害,
 * 所以 UI 一律同時呈現原始數據,讓使用者自己判斷。
 */
var GJD = (function (ns) {
  const u = ns.util;

  /* 應徵人數區間。
   * 104 於 2026-09 把 applyCnt 歸零,但 analysisType 這個欄位仍帶著人數級距,
   * 而且與 104 自己頁面上顯示的「N~M 人應徵」實測 66 筆完全一致(1:1,零衝突)。
   * 精確人數後來從應徵分析端點救回來了(見 api.applyCount),級距退居備援:
   * 端點失敗、或精確值與級距對不上時仍然顯示級距。 */
  const APPLY_RANGE = { 1: '0~5 人', 2: '6~10 人', 3: '11~30 人', 4: '30 人以上' };
  const applyRangeText = (t) => APPLY_RANGE[t] || null;

  /**
   * @param {object} f 事實集合
   *   hrBehaviorPR   0~1,104 內部的 HR 活躍度百分位
   *   daysSinceProcessed  HR 上次處理履歷距今天數(null = 近 30 天內無紀錄)
   *   daysSinceReply      公司上次透過 104 回覆應徵者距今天數(null = 近 30 天內無紀錄)
   *
   * 這兩個欄位是滾動時間窗,不是全部歷史。2026-09 改版後兩者都是 30 天
   *(實測 1,056 筆,「N 天內」的最大值都正好是 30;改版前回覆窗是 90 天)。
   * 所以 null 代表「這段期間內沒有」,不是「從來沒有」。
   * 而且 104 只看得到站內訊息 —— HR 直接打電話或寄 email 不會被記錄。
   *   hasInteraction      是否有拿到 interactionRecord
   *   postedDays     刊登(最後更新)距今天數
   *   hrActive       104 的「積極徵才中」標準(近似 PR >= 0.7);false 不代表不活躍
   *   applyCnt       精確應徵人數(來自應徵分析端點),取不到時為 null
   *   applyType      應徵人數級距 1~4
   *   applyRangeText 級距的文字,例如「6~10 人」
   *   openJobs       公司目前總開缺數
   *   repostCount    我們觀察期間看到它重新刊登的次數
   *   salaryUndisclosed 是否待遇面議
   */
  function scoreJob(f) {
    let score = 0;
    const reasons = [];

    // 近期沒人應徵、而且站內也沒有任何互動紀錄時,這兩個 null 沒有指控任何事,
    // 不該拿來扣分。條件必須同時成立:實測 63 個 0 人應徵的職缺裡有 44 個帶著
    // 非 null 的互動紀錄,只看應徵人數就整組關掉會把真實的紀錄一起蓋掉。
    // 104 改版後拿不到精確人數,改用最低級距(0~5 人)當代理 —— 它只會「移除」扣分,
    // 寬鬆一點的方向比較安全,寧可少指控也不要誤指控。
    const fewApplicants = f.applyCnt === 0 || f.applyType === 1;
    const quietWithNoRecord =
      fewApplicants && f.daysSinceProcessed === null && f.daysSinceReply === null;

    function add(points, text, kind) {
      score += points;
      reasons.push({ points, text, kind: kind || 'warn' });
    }

    // 1. HR 活躍度(104 自己算的分數,最直接)
    if (typeof f.hrBehaviorPR === 'number') {
      if (f.hrBehaviorPR < 0.3) {
        add(30, `HR 活躍度僅贏過 ${Math.round(f.hrBehaviorPR * 100)}% 的公司`);
      } else if (f.hrBehaviorPR < 0.5) {
        add(15, `HR 活躍度偏低(PR ${Math.round(f.hrBehaviorPR * 100)})`);
      } else if (f.hrBehaviorPR >= 0.8) {
        reasons.push({
          points: 0,
          text: `HR 活躍度高(PR ${Math.round(f.hrBehaviorPR * 100)})`,
          kind: 'good',
        });
      }
    } else if (f.hrActive === true) {
      // 拿不到 PR 數值時的替代路徑。只給正向、不拿 false 扣分的理由見 buildFacts。
      reasons.push({ points: 0, text: 'HR 活躍度達 104 的「積極徵才中」標準', kind: 'good' });
    }

    // 2. 上次處理履歷的時間 —— 最能反映「這個缺還有沒有人在看」
    if (f.hasInteraction && quietWithNoRecord) {
      reasons.push({
        points: 0,
        text: '近期無人應徵,104 站內也沒有互動紀錄,無從判斷 HR 的行為',
        kind: 'info',
      });
    } else if (f.hasInteraction) {
      // 門檻依實測分布訂:91% 的職缺在 7 天內處理過履歷,超過 7 天已是最差的 9.4%,
      // 超過 14 天是最差的 3.4%,而 null 代表落在 30 天的窗外,是最差的一檔。
      const d = f.daysSinceProcessed;
      if (d === null) {
        add(30, '近 30 天內沒有處理過任何履歷');
      } else if (d > 14) {
        add(22, `已經 ${d} 天沒有處理履歷`);
      } else if (d > 7) {
        add(14, `${d} 天沒有處理履歷`);
      } else {
        reasons.push({
          points: 0,
          text: `${u.withinDaysText(d)}處理過履歷`,
          kind: 'good',
        });
      }

      // 3. 有沒有透過 104 回覆應徵者 —— 呈現,但不計分。
      //    104 只記錄得到站內訊息的往來,很多 HR 是直接打電話或寄 email 聯絡應徵者,
      //    那些完全不會出現在這裡。既然「無紀錄」有一個完全無辜的解釋,
      //    就不該拿它扣分,只把事實擺出來讓使用者自己判斷。
      if (f.daysSinceReply === null) {
        reasons.push({
          points: 0,
          text: '近 30 天內沒有透過 104 回覆應徵者(HR 也可能是用電話或 email 聯絡)',
          kind: 'info',
        });
      } else {
        reasons.push({
          points: 0,
          text: `${u.withinDaysText(f.daysSinceReply)}透過 104 回覆過應徵者`,
          kind: f.daysSinceReply > 30 ? 'info' : 'good',
        });
      }
    }

    // 4. 刊登時長(104 只顯示「更新日期」,長期掛著的缺很容易被忽略)
    if (typeof f.postedDays === 'number') {
      if (f.postedDays > 90) add(18, `已刊登 ${f.postedDays} 天`);
      else if (f.postedDays > 60) add(12, `已刊登 ${f.postedDays} 天`);
      else if (f.postedDays > 30) add(6, `已刊登 ${f.postedDays} 天`);
    }

    // 5. 收了一堆履歷卻沒在處理
    const manyApplicants = f.applyType === 4 || (typeof f.applyCnt === 'number' && f.applyCnt > 30);
    if (manyApplicants && f.daysSinceProcessed !== null && f.daysSinceProcessed > 7) {
      add(
        10,
        typeof f.applyCnt === 'number'
          ? `已有 ${f.applyCnt} 人應徵,但 HR 超過一週沒處理`
          : '已有 30 人以上應徵,但 HR 超過一週沒處理'
      );
    }

    // 6. 公司同時開的缺數(養人才庫的常見特徵)
    if (typeof f.openJobs === 'number') {
      if (f.openJobs > 30) add(10, `這家公司同時開 ${f.openJobs} 個缺`);
      else if (f.openJobs > 15) add(5, `這家公司同時開 ${f.openJobs} 個缺`);
    }

    // 7. 重新刊登 —— 由本外掛長期觀察得到,104 頁面上看不到
    if (f.repostCount >= 2) {
      add(15, `觀察期間重新刊登過 ${f.repostCount} 次`);
    }

    // 8. 待遇面議(弱訊號,只加一點點)
    if (f.salaryUndisclosed) add(4, '待遇面議');

    score = Math.max(0, Math.min(100, score));

    let level, label;
    if (score >= 65) {
      level = 'red';
      label = '高風險';
    } else if (score >= 40) {
      level = 'orange';
      label = '可疑';
    } else if (score >= 20) {
      level = 'yellow';
      label = '留意';
    } else {
      level = 'green';
      label = '正常';
    }

    return { score, level, label, reasons, opportunity: detectOpportunity(f, score) };
  }

  /* ---------- 正向訊號:值得優先投的缺 ----------
   *
   * 「應徵人數少」單獨看沒有意義 —— 實測 1,144 筆,3 人以下的職缺佔 54%,
   * 而且刊登天數中位數(4 天)並沒有比 11–30 人那組(3 天)新,
   * 也就是說少人應徵不代表新刊登,反而有 16.6% 是「掛了三週還沒人投」的滯銷缺。
   *
   * 真正有意義的是三個條件的交集:沒什麼人投、缺是新的、而且 HR 這幾天真的在看履歷。
   * 這時候搶先投才有意義。實測交集約佔 30%。
   */

  // 精確人數改由應徵分析端點取得,門檻回到原本的「3 人以下」;
  // 只拿得到級距時退回「0~5 人」這一檔,條件會鬆一點但仍是最低檔。
  const OPP_MAX_APPLY = 3;
  const OPP_APPLY_TYPE = 1;
  const OPP_MAX_POSTED_DAYS = 7;
  const OPP_MAX_PROCESSED_DAYS = 7;
  // 比「正常」(0–19)更嚴:公司同時開 30 個缺就 +10,那種養人才庫的缺不該掛正向徽章
  const OPP_MAX_SCORE = 9;

  function detectOpportunity(f, score) {
    // 只在幾乎沒有風險訊號時才敢講「機會」,否則等於自打嘴巴
    if (score > OPP_MAX_SCORE) return null;
    if (typeof f.applyCnt === 'number') {
      if (f.applyCnt > OPP_MAX_APPLY) return null;
    } else if (f.applyType !== OPP_APPLY_TYPE) return null;
    if (typeof f.postedDays !== 'number' || f.postedDays > OPP_MAX_POSTED_DAYS) return null;
    if (f.daysSinceProcessed === null || f.daysSinceProcessed > OPP_MAX_PROCESSED_DAYS) {
      return null;
    }
    return {
      reasons: [
        typeof f.applyCnt === 'number' ? `${f.applyCnt} 人應徵` : `應徵人數 ${f.applyRangeText}`,
        `${u.daysAgoText(f.postedDays)}刊登`,
        `HR ${u.withinDaysText(f.daysSinceProcessed)}處理過履歷`,
      ],
    };
  }

  /** 把各來源的原始資料整理成 scoreJob 需要的事實集合 */
  function buildFacts({
    searchRow,
    companyEntry,
    companyTotal,
    applyCnt,
    history,
    jobDetail,
    hrPRLookup,
  }) {
    const src = searchRow || {};
    const ce = companyEntry || {};
    // 互動紀錄三個來源都可能有:公司職缺 API、搜尋結果列、職缺內頁
    const ir =
      ce.interactionRecord ||
      (src && src.interactionRecord) ||
      (jobDetail && jobDetail.interactionRecord) ||
      null;

    /* 104 於 2026-09 改版:interactionRecord 的三個時間戳全部歸零,真正的資料改放進
     * lastProcessedResumeDesc / lastCustReplyDesc 兩個中文字串;同時 applyCnt 與
     * hrBehaviorPR 也一併變成 0(實測 792 筆無一例外)。
     *
     * 用「有沒有 Desc 這個 key」判斷格式,而不是看值是不是 0 ——
     * 真的沒有互動紀錄的職缺也會是 0,兩者必須分得開。
     * 這樣寫還有一個好處:104 若改回舊格式,會自動走回時間戳那條路,不必再改一次。
     */
    const descApi = !!ir && 'lastProcessedResumeDesc' in ir;

    const now = ir && ir.nowTimestamp ? ir.nowTimestamp : Date.now() / 1000;

    const appearRaw = src.appearDate || (jobDetail && jobDetail.appearDate) || ce.appearDate;
    const appearDate = u.parseAppearDate(appearRaw);

    // 搜尋列 / 公司職缺 API / 職缺內頁這三個來源的 PR
    const inlinePR =
      typeof src.hrBehaviorPR === 'number'
        ? src.hrBehaviorPR
        : typeof ce.hrBehaviorPR === 'number'
          ? ce.hrBehaviorPR
          : jobDetail && typeof jobDetail.hrBehaviorPR === 'number'
            ? jobDetail.hrBehaviorPR
            : null;

    /* PR 0 代表「贏過 0% 的公司」,是最重的一項扣分(+30)。上面那三個端點在 104
     * 2026-09 改版後恆為 0,把「沒給資料」當成「墊底」會冤枉每一個職缺 ——
     * 真的墊底的是極少數,誤判的代價卻是全部,所以那邊來的 0 一律視為無資料。
     *
     * hrPRLookup 則是從相似職缺清單反查回來的(見 api.js 的 lookupHrPR),那裡的值
     * 是 104 原樣下發的,0 就真的是墊底,不能跟著抹掉。所以它優先,而且不做 0 的轉換。
     */
    const hrPR = typeof hrPRLookup === 'number' ? hrPRLookup : inlinePR === 0 ? null : inlinePR;

    /* hasHrBehavior:PR 歸零後唯一還活著的活躍度訊號。
     *
     * 104 前端判斷要不要掛「積極徵才中」的條件是 hasHrBehavior || hrBehaviorPR >= 0.7,
     * 門檻 0.7 來自它自己的程式碼(isActive: e => e >= .7)。這個布林值高度近似
     * 「PR >= 0.7」但不是恆等:隨機抽 70 筆同時取兩者,一致率 97%,true 佔 27%、
     * PR>=0.7 佔 30%,比例吻合;但有 PR 0.83 卻回 false 的樣本,離門檻太遠,
     * 不能用快照時間差解釋。當成近似用可以,別當成純函數。
     *
     * 這條線切得有意義:相似職缺 API 仍下發真實 PR,拿 2,252 筆比對互動紀錄,
     * PR 高低與履歷處理時效嚴格單調 —— 兩側的處理履歷中位數是 0 天對 2 天,
     * 七天內處理 95% 對 72%,完全沒有處理紀錄 0% 對 14%。
     *
     * 但只拿 true 當正向訊號、false 不扣分,理由不是它沒有鑑別力,而是:
     * false 涵蓋 PR 0~0.7 一整段,內部差異太大(0.6~0.7 那檔中位 1 天、九成在
     * 七天內處理,和 true 組幾乎沒差),而真正該被指控的那批(PR<0.1,中位 17 天、
     * 半數完全沒有處理紀錄)早就被下面的時效規則扣滿了,再扣一次是重複計算。
     */
    const hrActive =
      typeof src.hasHrBehavior === 'boolean'
        ? src.hasHrBehavior
        : typeof ce.hasHrBehavior === 'boolean'
          ? ce.hasHrBehavior
          : jobDetail && typeof jobDetail.hasHrBehavior === 'boolean'
            ? jobDetail.hasHrBehavior
            : null;

    // 應徵人數級距:搜尋列 / 公司職缺 API / 職缺內頁都有
    const analysisType =
      typeof src.analysisType === 'number'
        ? src.analysisType
        : typeof ce.analysisType === 'number'
          ? ce.analysisType
          : jobDetail && typeof jobDetail.analysisType === 'number'
            ? jobDetail.analysisType
            : null;

    /* 應徵分析端點對「不存在的 job_no」「參數是 0 或非數字」全都回 200 + total 0,
     * 跟真的 0 人應徵長得一模一樣。所以拿 analysisType 交叉驗證:級距說有 6 人以上,
     * 精確值卻是 0,代表這次沒對上,寧可退回級距也不要報一個假的 0。 */
    const rawApply = typeof applyCnt === 'number' ? applyCnt : null;
    const applyTrusted =
      rawApply !== null && !(rawApply === 0 && typeof analysisType === 'number' && analysisType >= 2);
    const exactApply = applyTrusted
      ? rawApply
      : descApi
        ? null
        : typeof src.applyCnt === 'number'
          ? src.applyCnt
          : null;

    return {
      jobName: src.jobName || ce.jobName || (jobDetail && jobDetail.jobName),
      custName: src.custName || (jobDetail && jobDetail.custName),
      hrBehaviorPR: hrPR,
      hrActive,
      hasInteraction: !!ir,
      daysSinceProcessed: !ir
        ? null
        : descApi
          ? u.parseInteractionDesc(ir.lastProcessedResumeDesc)
          : u.daysSinceTs(ir.lastProcessedResumeAtTime, now),
      daysSinceReply: !ir
        ? null
        : descApi
          ? u.parseInteractionDesc(ir.lastCustReplyDesc)
          : u.daysSinceTs(ir.lastCustReplyTimestamp, now),
      postedDays: u.daysSince(appearDate),
      appearDateText: u.formatDate(appearDate) || appearRaw || null,
      // 搜尋 API 自己的 applyCnt 在新格式下恆為 0(實測 792/792),那是「不再提供」
      // 而不是「沒有人應徵」,不能照著顯示。精確人數改由應徵分析端點取得,
      // 只有舊格式才回頭信任 src.applyCnt。
      applyCnt: exactApply,
      applyType: analysisType,
      applyRangeText: applyRangeText(analysisType),
      openJobs: typeof companyTotal === 'number' ? companyTotal : null,
      repostCount: history ? history.repostCount || 0 : 0,
      firstSeen: history ? history.firstSeen : null,
      salaryUndisclosed: src.salaryLow === 0 && src.salaryHigh === 0,
    };
  }

  ns.score = { scoreJob, buildFacts };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
