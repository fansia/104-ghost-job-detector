const enabledEl = document.getElementById('enabled');
const healthEl = document.getElementById('health');
const trackedEl = document.getElementById('tracked');
const clearEl = document.getElementById('clear');
const hideAppliedEl = document.getElementById('hideApplied');
const companyListEl = document.getElementById('companyList');
const companyHeadEl = document.getElementById('companyHead');
const pageHiddenEl = document.getElementById('pageHidden');
const rulesCountEl = document.getElementById('rulesCount');

/* ---------- 隱藏規則 ----------
 * 讀寫共用 util.js 的實作(寫入有排隊與錯誤處理,見那裡的註解)。
 * 內容腳本監聽 storage 變動,所以這裡寫進去之後 104 的分頁會自己重畫。
 */

const HIDDEN_KEY = 'gjd:hidden';
const { getHidden, updateHidden } = GJD.util;

async function editRules(mutate) {
  await updateHidden(mutate);
  renderRules(await getHidden());
  renderPageHidden();
}

function renderList(el, items, emptyText, onRemove) {
  el.textContent = '';
  el.classList.toggle('empty', items.length === 0);
  if (!items.length) {
    el.textContent = emptyText;
    return;
  }
  items.forEach((it, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = it.label;
    span.title = it.title || it.label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '移除';
    btn.addEventListener('click', () => onRemove(i));
    li.append(span, btn);
    el.append(li);
  });
}

function renderRules(h) {
  hideAppliedEl.checked = h.hideApplied;
  companyHeadEl.textContent = h.companies.length
    ? `封鎖的公司(${h.companies.length})`
    : '封鎖的公司';

  /* 收起來時也要看得出裡面有沒有東西。沒有規則就講「點開設定」,
   * 那句話本身就是在告訴使用者這一列可以點。 */
  const on = [
    h.companies.length ? `${h.companies.length} 家公司` : null,
    h.hideApplied ? '隱藏已投過的' : null,
  ].filter(Boolean);
  rulesCountEl.textContent = on.length ? on.join(' · ') : '點開設定';
  renderList(
    companyListEl,
    h.companies.map((c) => ({
      label: c.name || c.code,
      title: `公司代碼:${c.code}`,
    })),
    '還沒封鎖任何公司。在職缺卡片的徽章上點「隱藏」就會加進來。',
    (i) => editRules((x) => x.companies.splice(i, 1))
  );
}

/* 這一頁隱藏了幾筆。由內容腳本寫進 storage(見 content.js 的說明),
 * 太舊就不顯示 —— 使用者可能是在別的分頁打開這個視窗的,拿上次的數字充數會誤導。 */
const PAGE_HIDDEN_KEY = 'gjd:pageHidden';
const PAGE_HIDDEN_TTL = 2 * 60 * 1000;

async function renderPageHidden() {
  const box = await chrome.storage.local.get(PAGE_HIDDEN_KEY);
  const v = box[PAGE_HIDDEN_KEY];
  const fresh = v && typeof v.count === 'number' && Date.now() - (v.at || 0) < PAGE_HIDDEN_TTL;
  pageHiddenEl.textContent = fresh ? v.count + ' 筆' : '—';
}

hideAppliedEl.addEventListener('change', () =>
  editRules((h) => (h.hideApplied = hideAppliedEl.checked))
);

async function refresh() {
  const box = await chrome.storage.local.get(null);
  enabledEl.checked = box['gjd:enabled'] !== false;
  const tracked = Object.keys(box).filter((k) => k.startsWith('hist:')).length;
  trackedEl.textContent = tracked + ' 筆';
  renderHealth(box['gjd:health']);
  renderRules(await getHidden());
  renderPageHidden();
}

// 104 的內部端點沒有公開文件,隨時可能改版。連續失敗代表的多半不是網路不穩,
// 而是資料來源變了 —— 與其讓徽章默默不出現,不如在這裡講清楚。
const FAIL_THRESHOLD = 5;

function renderHealth(h) {
  if (!h || (h.fails || 0) < FAIL_THRESHOLD) {
    healthEl.hidden = true;
    return;
  }
  healthEl.hidden = false;
  healthEl.textContent =
    `最近連續 ${h.fails} 次沒能取得資料。可能是 104 改版了,也可能只是網路不穩 —— ` +
    '重新整理 104 頁面後如果仍然如此,請到 GitHub 回報。';
  const a = document.createElement('a');
  a.href = 'https://github.com/fansia/104-ghost-job-detector/issues';
  a.target = '_blank';
  a.textContent = '回報問題';
  healthEl.append(' ', a);
}

enabledEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ 'gjd:enabled': enabledEl.checked });
});

clearEl.addEventListener('click', async () => {
  const box = await chrome.storage.local.get(null);
  // 隱藏規則是使用者一條一條加的,不是快取 —— 清除快取與紀錄不該把它一起掃掉
  const keep = ['gjd:enabled', HIDDEN_KEY];
  const keys = Object.keys(box).filter((k) => !keep.includes(k));
  await chrome.storage.local.remove(keys);
  refresh();
});

refresh();
