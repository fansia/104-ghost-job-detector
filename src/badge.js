/* 徽章 UI:在職缺卡片上插入一列風險摘要,點擊展開完整訊號。 */
var GJD = (function (ns) {
  const LEVEL_TEXT = { green: '正常', yellow: '留意', orange: '可疑', red: '高風險' };

  /** 摘要列上最值得一眼看到的兩三個事實 */
  function headlineFacts(f) {
    const out = [];
    // 沒人應徵時講「從未回覆應徵者」會誤導 —— 跟 score.js 用同一個條件
    if (f.hasInteraction && f.applyCnt !== 0) {
      if (f.daysSinceReply === null) out.push('從未回覆應徵者');
      else if (f.daysSinceReply > 30) out.push(`上次回覆 ${f.daysSinceReply} 天前`);

      if (f.daysSinceProcessed === null) out.push('無處理履歷紀錄');
      else if (f.daysSinceProcessed > 7) out.push(`${f.daysSinceProcessed} 天沒處理履歷`);
      else out.push(`${f.daysSinceProcessed} 天前處理過履歷`);
    }
    if (typeof f.postedDays === 'number' && f.postedDays > 30) {
      out.push(`刊登 ${f.postedDays} 天`);
    }
    if (typeof f.applyCnt === 'number') out.push(`${f.applyCnt} 人應徵`);
    return out.slice(0, 3);
  }

  function buildDetail(f, result) {
    const rows = [];
    const push = (label, value) => rows.push({ label, value });

    push('HR 活躍度', typeof f.hrBehaviorPR === 'number' ? `PR ${Math.round(f.hrBehaviorPR * 100)}(104 內部指標)` : '無資料');
    const noApplicants = f.applyCnt === 0;
    push(
      '上次處理履歷',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceProcessed !== null
          ? `${f.daysSinceProcessed} 天前`
          : noApplicants
            ? '尚無人應徵'
            : '沒有紀錄'
    );
    push(
      '上次回覆應徵者',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceReply !== null
          ? `${f.daysSinceReply} 天前`
          : noApplicants
            ? '尚無人應徵'
            : '從未回覆過'
    );
    push('刊登(更新)日期', f.appearDateText ? `${f.appearDateText}(${f.postedDays} 天前)` : '無資料');
    if (typeof f.applyCnt === 'number') push('應徵人數', `${f.applyCnt} 人`);
    if (typeof f.openJobs === 'number') push('公司目前開缺', `${f.openJobs} 個`);
    if (f.repostCount) push('觀察到重新刊登', `${f.repostCount} 次`);

    const el = document.createElement('div');
    el.className = 'gjd-detail';

    const table = document.createElement('div');
    table.className = 'gjd-detail__grid';
    for (const r of rows) {
      const k = document.createElement('div');
      k.className = 'gjd-detail__k';
      k.textContent = r.label;
      const v = document.createElement('div');
      v.className = 'gjd-detail__v';
      v.textContent = r.value;
      table.append(k, v);
    }
    el.append(table);

    if (result.reasons.length) {
      const ul = document.createElement('ul');
      ul.className = 'gjd-detail__reasons';
      for (const r of result.reasons) {
        const li = document.createElement('li');
        li.className = 'gjd-reason gjd-reason--' + r.kind;
        li.textContent = (r.kind === 'good' ? '✓ ' : '• ') + r.text;
        ul.append(li);
      }
      el.append(ul);
    }

    const note = document.createElement('p');
    note.className = 'gjd-detail__note';
    note.textContent =
      '資料來自 104 網頁自己使用的內部 API,僅供參考。分數高不代表這是假職缺,請搭配上面的原始數據自行判斷。';
    el.append(note);
    return el;
  }

  /** 建立(或更新)一張卡片的徽章元素 */
  function render(facts, result) {
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge gjd-badge--' + result.level;

    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'gjd-bar';

    const pill = document.createElement('span');
    pill.className = 'gjd-pill';
    pill.textContent = LEVEL_TEXT[result.level] + ' ' + result.score;

    const facesEl = document.createElement('span');
    facesEl.className = 'gjd-facts';
    facesEl.textContent = headlineFacts(facts).join(' ・ ');

    const caret = document.createElement('span');
    caret.className = 'gjd-caret';
    caret.textContent = '▾';

    bar.append(pill, facesEl, caret);
    wrap.append(bar);

    const detail = buildDetail(facts, result);
    detail.hidden = true;
    wrap.append(detail);

    bar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      detail.hidden = !detail.hidden;
      caret.textContent = detail.hidden ? '▾' : '▴';
    });

    return wrap;
  }

  function renderLoading() {
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge gjd-badge--loading';
    wrap.textContent = '分析中…';
    return wrap;
  }

  ns.badge = { render, renderLoading };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
