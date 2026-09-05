/* 把各來源的職缺資料整理成一組事實。
 *
 * 這裡刻意不算分、不分級、不下判斷。
 *
 * 104 手上有這些紀錄,但頁面上只顯示正面的那一半 —— 「1 天內聯絡過求職者」會出現,
 * 「近 30 天內一個應徵者都沒回覆過」則整列消失。這個外掛要做的就是把另一半補上,
 * 補完就閉嘴。
 *
 * 曾經有一套加權評分,後來拿掉了,因為實測 1,039 個職缺的結果撐不住那些扣分:
 * 「掛越久越沒人管」不成立 —— 刊登超過 180 天的職缺,HR 100% 在七天內處理過履歷;
 * 「30 天零動作」也不是幽靈 —— 那批缺的刊登天數中位數是 1 天、應徵人數全部落在
 * 0~5 人那一檔,是還沒有人投,不是沒人理。憑感覺挑出來的門檻只會製造誤判,
 * 而誤判把真職缺標成假的,對求職者和公司都是傷害。
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

  /* buildFacts 產出的事實集合(徽章直接照著顯示,不做任何加權或判斷):
   *
   *   daysSinceProcessed  HR 上次處理履歷距今天數(null = 近 30 天內無紀錄)
   *   daysSinceReply      公司上次透過 104 回覆應徵者距今天數(null = 同上)
   *   hasInteraction      是否有拿到 interactionRecord
   *   postedDays          刊登(最後更新)距今天數
   *   applyCnt            精確應徵人數(來自應徵分析端點),取不到時為 null
   *   applyType           應徵人數級距 1~4
   *   applyRangeText      級距的文字,例如「6~10 人」
   *   openJobs            公司目前總開缺數
   *   repostCount         我們觀察期間看到它重新刊登的次數
   *
   * 前三個是滾動時間窗,不是全部歷史。2026-09 改版後處理履歷與回覆都是 30 天
   *(實測 1,056 筆,「N 天內」的最大值都正好是 30;改版前回覆窗是 90 天)。
   * 所以 null 代表「這段期間內沒有」,不是「從來沒有」。
   * 而且 104 只看得到站內訊息 —— HR 直接打電話或寄 email 不會被記錄。
   */
  /** 把各來源的原始資料整理成徽章要呈現的事實集合 */
  function buildFacts({ searchRow, companyEntry, companyTotal, applyCnt, history, jobDetail }) {
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

    /* HR 活躍度這條線整條不用了,兩種來源都不取:
     *
     * hrBehaviorPR(0~1 的百分位)在 104 改版後恆為 0,要拿到真值只能去翻相似職缺
     * 清單反查,單一職缺得多打四到六次請求,還靠一組統計出來的頁碼 magic number 撐著,
     * 104 調一下演算法就靜默失效。
     *
     * hasHrBehavior(布林值,近似 PR >= 0.7)倒是三個回應本來就帶著、零成本,但
     * true 只佔 27%,false 涵蓋剩下的七成 —— 分不出「中段班」和「墊底」,印出來
     * 佔一個位置卻幾乎沒告訴使用者任何事,還容易被讀成指控。
     *
     * 真正有鑑別力的是下面的處理履歷 / 回覆時效,那兩項本來就在。
     */

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

    const daysSinceProcessed = !ir
      ? null
      : descApi
        ? u.parseInteractionDesc(ir.lastProcessedResumeDesc)
        : u.daysSinceTs(ir.lastProcessedResumeAtTime, now);
    const daysSinceReply = !ir
      ? null
      : descApi
        ? u.parseInteractionDesc(ir.lastCustReplyDesc)
        : u.daysSinceTs(ir.lastCustReplyTimestamp, now);

    return {
      jobName: src.jobName || ce.jobName || (jobDetail && jobDetail.jobName),
      custName: src.custName || (jobDetail && jobDetail.custName),
      hasInteraction: !!ir,
      daysSinceProcessed,
      daysSinceReply,
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
    };
  }

  ns.score = { buildFacts };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
