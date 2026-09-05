/* 徽章 UI:在職缺卡片上插入 104 沒有顯示的那幾項數據。
 *
 * 不分級、不算分、不上警示色,理由見 score.js 檔頭。
 *
 * 版面:數據一律收合時就全部呈現,不做「摘要三選一」——
 * 挑三個講就得決定哪一項最重要,那本身就是一種判斷,而且被擠掉的那幾項
 * 常常正是使用者想看的。展開的部分只放說明與使用注意。
 *
 * 但七項一項一列會讓徽章比職缺卡本身還高,所以改成橫向流動、兩行排完,
 * 標籤縮短、長字串(HR 活躍度的門檻說明)移進展開區。
 */
var GJD = (function (ns) {
  /** 要呈現的資料。標籤刻意縮短:一張職缺卡上,徽章不該比職缺本身還高。 */
  function buildItems(f) {
    const items = [];
    /* mod 是這一項的視覺修飾,只有兩種:
     *   'em'   永遠強調這個欄位(刊登日期是唯一「104 有、但要自己心算」的欄位),
     *          不隨數值改變外觀。
     *   'good' HR 這七天內動過。
     *   'bad'  刊登超過 60 天。
     *
     * 綠色與紅色都只是「值得多看一眼」的提示,不是分級 —— 徽章不會因此給出總評。
     * 特別是紅色:實測 39 個刊登超過 60 天的職缺,89.7% 的 HR 在七天內仍處理過履歷,
     * 零個是三十天完全沒動作的(見 score.js 檔頭)。掛得久多半是常年開缺,
     * 不是幽靈,所以紅色旁邊的「處理履歷」常常同時是綠的 —— 那兩個顏色不衝突,
     * 它們講的是兩件事。
     */
    const push = (label, value, mod) => items.push({ label, value, mod: mod || null });

    // 七天是 104 自己的節奏:實測 1,039 筆,86.5% 的職缺七天內處理過履歷。
    const recent = (d) => typeof d === 'number' && d <= 7;
    // 刊登超過 60 天的只佔 3.8%,標出來不會滿江紅
    const stale = typeof f.postedDays === 'number' && f.postedDays > 60;

    push(
      '處理履歷',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceProcessed !== null
          ? GJD.util.withinDaysText(f.daysSinceProcessed)
          : '近 30 天內無紀錄',
      recent(f.daysSinceProcessed) ? 'good' : null
    );
    push(
      '回覆應徵者',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceReply !== null
          ? GJD.util.withinDaysText(f.daysSinceReply)
          : '近 30 天內無紀錄',
      recent(f.daysSinceReply) ? 'good' : null
    );
    // 抓不到就明講。整項消失會讓使用者以為是 0 人應徵,或以為外掛壞了。
    // 104 於 2026-09 移除精確人數,只剩級距。有級距就顯示級距,兩者都沒有才說取不到。
    push(
      '應徵',
      typeof f.applyCnt === 'number'
        ? `${f.applyCnt} 人`
        : f.applyRangeText
          ? f.applyRangeText
          : '無法取得'
    );
    if (f.repostCount) push('重新刊登', `${f.repostCount} 次`);
    // 刊登日是日曆日期,要用 daysAgoText(0 = 今天),不能寫成「0 天前」
    push(
      '刊登',
      f.appearDateText
        ? typeof f.postedDays === 'number'
          ? `${f.appearDateText}(${GJD.util.daysAgoText(f.postedDays)})`
          : f.appearDateText
        : '無資料',
      stale ? 'bad' : 'em'
    );
    if (typeof f.openJobs === 'number') push('公司開缺', `${f.openJobs} 個`);
    return items;
  }

  const NOTES = [
    '資料來自 104 網頁自己使用的內部 API,僅供參考。',
    '「處理履歷」與「回覆應徵者」都是 30 天的滾動紀錄 ——「無紀錄」是指這段期間內沒有,不是從來沒有。',
    'HR 若直接打電話或寄 email 聯絡應徵者,104 不會記錄,這裡也就看不到。',
    '「處理履歷」不一定是真人動作,系統自動配對可能也算在內。',
    '「刊登」是 104 上的最後更新日期,不是最初刊登日。',
    '綠色代表 HR 在七天內處理過履歷或回覆過應徵者;沒有綠色不代表有問題。',
    '紅色代表這個缺掛了超過 60 天。但掛得久不等於是幽靈職缺 —— 實測這種缺有九成的 HR 七天內仍在處理履歷,多半是常年開缺(養人才庫、高流動率、條件開得硬)。',
    '這個外掛不評分、不分級,也不推論職缺真假 —— 顏色只是提示你多看一眼,請自行斟酌。',
  ];

  function buildDetail() {
    const el = document.createElement('div');
    el.className = 'gjd-detail';
    const ul = document.createElement('ul');
    ul.className = 'gjd-notes';
    for (const t of NOTES) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.append(li);
    }
    el.append(ul);
    return el;
  }

  /* ---------- 商店評價邀請 ----------
   * 只在使用者已經用順手、而且正在展開說明時出現一次(門檻見 util.js)。
   *
   * 兩件刻意不做的事:
   * 1. 不指定星數。Chrome 商店的政策禁止操縱評分,文案只能請人「留下評價」。
   * 2. 不做評價分流(先問喜不喜歡、喜歡才帶去商店)。挑「時機」可以,篩「對象」不行。
   */

  const REVIEW_URL =
    'https://chromewebstore.google.com/detail/ollabfbopbnckocijfnahjeaoalbnbej/reviews';

  let askShownThisPage = false;

  function buildReviewAsk() {
    const box = document.createElement('div');
    box.className = 'gjd-ask';

    const text = document.createElement('p');
    text.className = 'gjd-ask__text';
    text.textContent = '這個外掛有幫上忙嗎?到 Chrome 商店留幾句話,可以幫其他求職者找到它。';

    const actions = document.createElement('p');
    actions.className = 'gjd-ask__actions';

    // 104 的職缺卡片本身可能是連結,點任何地方都可能導航 —— 一律擋掉冒泡
    const go = document.createElement('a');
    go.className = 'gjd-ask__go';
    go.href = REVIEW_URL;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.textContent = '前往評價';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      GJD.util.markReview('clicked');
      box.remove();
    });

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'gjd-ask__no';
    no.textContent = '不用了';
    no.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      GJD.util.markReview('dismissed');
      box.remove();
    });

    actions.append(go, no);
    box.append(text, actions);
    return box;
  }

  /** 展開說明時呼叫:記一次展開,必要時附上評價邀請。 */
  async function maybeAskForReview(detail) {
    try {
      await GJD.util.noteExpand();
      if (askShownThisPage) return;
      if (!(await GJD.util.shouldAskReview())) return;
      if (detail.hidden) return; // 使用者已經收回去了,不要事後才冒出來
      askShownThisPage = true;
      detail.append(buildReviewAsk());
    } catch (e) {
      /* 邀請只是加分項,壞掉不能影響徽章本身 */
    }
  }

  /** 建立(或更新)一張卡片的徽章元素 */
  function render(facts) {
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge';

    // 數據與展開鈕同一列:七項資料排成兩行就夠,不值得再為一個「說明」另闢一列
    const top = document.createElement('div');
    top.className = 'gjd-top';

    const data = document.createElement('div');
    data.className = 'gjd-data';

    const list = document.createElement('div');
    list.className = 'gjd-items';
    for (const it of buildItems(facts)) {
      const item = document.createElement('span');
      item.className = it.mod ? 'gjd-item gjd-item--' + it.mod : 'gjd-item';
      const k = document.createElement('span');
      k.className = 'gjd-k';
      k.textContent = it.label;
      const v = document.createElement('span');
      v.className = 'gjd-v';
      // 綠色另外帶一個 ✓:紅配綠是最典型的色盲組合,不能只靠顏色傳遞訊息
      v.textContent = it.mod === 'good' ? '✓ ' + it.value : it.value;
      item.append(k, v);
      list.append(item);
    }
    data.append(list);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'gjd-toggle';
    toggle.title = '這些數字怎麼來的、怎麼看';

    const label = document.createElement('span');
    label.textContent = '說明';

    const caret = document.createElement('span');
    caret.className = 'gjd-caret';
    caret.textContent = '▾';

    toggle.append(label, caret);
    top.append(data, toggle);
    wrap.append(top);

    const detail = buildDetail();
    detail.hidden = true;
    wrap.append(detail);

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      detail.hidden = !detail.hidden;
      caret.textContent = detail.hidden ? '▾' : '▴';
      if (!detail.hidden) maybeAskForReview(detail);
    });

    return wrap;
  }

  function renderLoading() {
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge gjd-badge--loading';
    wrap.textContent = '分析中…';
    return wrap;
  }

  /**
   * 抓不到資料時顯示的徽章。
   * 這裡刻意不沉默:徽章直接消失的話,使用者無從分辨是「這個職缺沒有資料」、
   * 「外掛壞了」還是「104 改版了」,只會覺得工具時好時壞。
   */
  function renderError(text) {
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge gjd-badge--error';
    wrap.textContent = text || '無法取得這個職缺的資料';
    return wrap;
  }

  ns.badge = { render, renderLoading, renderError };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
