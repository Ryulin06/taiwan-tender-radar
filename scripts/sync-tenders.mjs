import * as cheerio from 'cheerio';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const TENDERS_FILE = path.join(DATA_DIR, 'tenders.json');
const STATUS_FILE = path.join(DATA_DIR, 'sync-status.json');
const BACKFILL_FILE = path.join(DATA_DIR, 'backfill-state.json');

const KEYWORDS = ['數位','媒體','社群','影片','拍攝','FB','推廣','宣傳','活動案','行銷','計畫'];
const RELATED = ['活動','廣告','影音','影像','紀錄','製作','傳播','公關','整合行銷','政策宣導','網路行銷','短影音','臉書','Facebook','環保','永續','淨零','教育政策'];
const CITIES = ['基隆市','臺北市','新北市','桃園市','新竹市','新竹縣','苗栗縣','臺中市','彰化縣','南投縣','雲林縣','嘉義市','嘉義縣','臺南市','高雄市','屏東縣','宜蘭縣','花蓮縣','臺東縣','澎湖縣','金門縣','連江縣'];

const OFFICIAL_BASE = 'https://web.pcc.gov.tw';
const TAIWANBUYING_BASE = 'https://www.taiwanbuying.com.tw';
const TENDER_SEARCH = `${OFFICIAL_BASE}/prkms/tender/common/basic/readTenderBasic`;
const AWARD_SEARCH = `${OFFICIAL_BASE}/prkms/tender/common/agent/readTenderAgent`;
const LOOKBACK = clampNumber(process.env.SYNC_LOOKBACK_DAYS, 1, 14, 3);
const MAX_KEYWORDS = clampNumber(process.env.SYNC_MAX_KEYWORDS, 1, KEYWORDS.length, KEYWORDS.length);
const REQUEST_DELAY_MS = clampNumber(process.env.SOURCE_REQUEST_DELAY_MS, 200, 5000, 500);
const REQUEST_TIMEOUT_MS = clampNumber(process.env.SOURCE_TIMEOUT_MS, 5000, 60000, 20000);
const CONCURRENCY = clampNumber(process.env.SOURCE_CONCURRENCY, 1, 4, 2);
const BACKFILL_MONTHS_PER_RUN = clampNumber(process.env.BACKFILL_MONTHS_PER_RUN, 0, 3, 1);
const HISTORY_START_YEAR = clampNumber(process.env.HISTORY_START_YEAR, 2020, new Date().getUTCFullYear(), 2024);
const TAIWANBUYING_ENABLED = String(process.env.TAIWANBUYING_ENABLED ?? 'true').toLowerCase() !== 'false';

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const canonical = value => clean(value).replace(/[「」『』“”"'\s()（）\-—_]/g, '').toLowerCase();
const textIncludes = (text, words) => words.some(word => text.toLowerCase().includes(word.toLowerCase()));

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return structuredClone(fallback); }
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function taiwanTodayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function normalizeDate(value) {
  if (!value) return null;
  const s = clean(value).replace(/[年月]/g, '/').replace(/日/g, '').replace(/[.\-]/g, '/');
  const m = s.match(/(\d{3,4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  let year = Number(m[1]);
  if (year < 1911) year += 1911;
  const iso = `${year}-${String(Number(m[2])).padStart(2,'0')}-${String(Number(m[3])).padStart(2,'0')}`;
  if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return null;
  return iso <= taiwanTodayIso() ? iso : null;
}
function normalizeMoney(value) {
  const cleaned = String(value ?? '').replace(/,/g, '').replace(/[^0-9.]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
function inferCity(agency, title) {
  const text = `${agency} ${title}`;
  return CITIES.find(city => text.includes(city)) || '中央／其他';
}
function isRelevant(title, agency = '') { return textIncludes(`${title} ${agency}`, [...KEYWORDS, ...RELATED]); }
function formatPccDate(date) { return `${date.getUTCFullYear()}/${String(date.getUTCMonth()+1).padStart(2,'0')}/${String(date.getUTCDate()).padStart(2,'0')}`; }
function defaultHeaders(referer = OFFICIAL_BASE) {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-TW,zh;q=0.9,en;q=0.6',
    'cache-control': 'no-cache', pragma: 'no-cache', referer,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
  };
}
async function fetchHtml(url, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, { headers: defaultHeaders(), redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const html = await response.text();
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`來源暫時忙碌（HTTP ${response.status}）`);
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`來源回應 HTTP ${response.status}`);
      if (!/<html|<table|<body/i.test(html)) throw new Error('來源回傳內容格式異常');
      return html;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}
function decodeNameFromCell($, cell) {
  const html = $(cell).html() || '';
  const jsName = html.match(/pageCode2Img\(["']([^"']+)["']\)/)?.[1];
  const anchor = $(cell).find('a').first();
  const name = clean(jsName || anchor.text() || $(cell).text()).replace(/\(?(更正公告|招標公告|決標公告)\)?/g, '').trim();
  const href = anchor.attr('href') || '';
  return { name, href: href ? new URL(href, OFFICIAL_BASE).href : '' };
}
function extractCaseNo(text) {
  const candidates = clean(text).match(/[A-Za-z0-9][A-Za-z0-9_.\-/]{2,40}/g) || [];
  return candidates.find(x => /\d/.test(x) && !/^https?$/i.test(x)) || '';
}
function headerIndexes($, table) {
  const headers = table.find('tr').first().find('th,td').map((_, el) => clean($(el).text())).get();
  const find = words => headers.findIndex(h => words.some(w => h.includes(w)));
  return {
    agency: find(['機關名稱','招標機關']), title: find(['標案名稱','標案案號及標案名稱']),
    publish: find(['公告日期','刊登公報日期','上網公告日期']), deadline: find(['截止投標','截止收件']), budget: find(['預算金額','採購金額'])
  };
}
function parseTenderRows(html) {
  const $ = cheerio.load(html); const rows = [];
  const table = $('#tpam').length ? $('#tpam') : $('table').filter((_, el) => $(el).text().includes('截止投標')).first();
  if (!table.length) return rows;
  const idx = headerIndexes($, table);
  table.find('tbody tr, tr').each((_, tr) => {
    const cells = $(tr).find('td'); if (cells.length < 5) return;
    const agencyCell = idx.agency >= 0 ? idx.agency : 1;
    const titleCell = idx.title >= 0 ? idx.title : 2;
    const agency = clean($(cells[agencyCell]).text());
    const identity = decodeNameFromCell($, cells[titleCell]);
    const caseNo = extractCaseNo($(cells[titleCell]).text());
    if (!identity.name || !caseNo || !isRelevant(identity.name, agency)) return;
    const publishDate = normalizeDate(idx.publish >= 0 ? $(cells[idx.publish]).text() : '');
    if (!publishDate) return;
    rows.push({
      uid: `${agency}|${caseNo}`, case_no: caseNo, title: identity.name, publish_date: publishDate,
      deadline: normalizeDate(idx.deadline >= 0 ? $(cells[idx.deadline]).text() : ''),
      budget: normalizeMoney(idx.budget >= 0 ? $(cells[idx.budget]).text() : ''), agency: agency || '未提供',
      city: inferCity(agency, identity.name), winner: '未公告', award_date: null, status: '招標公告',
      source_url: identity.href, source_name: '政府電子採購網', updated_at: new Date().toISOString()
    });
  });
  return rows;
}
function findValueByLabel($, labels) {
  let found = '';
  $('th,td').each((_, el) => {
    if (found) return;
    const label = clean($(el).text());
    if (!labels.some(x => label.includes(x))) return;
    const next = $(el).next('td'); if (next.length) found = clean(next.text());
  });
  return found;
}
async function fetchAwardDetail(url) {
  if (!url) return { winner: '未公告', budget: null, awardDate: null };
  try {
    const html = await fetchHtml(url, 1); const $ = cheerio.load(html);
    return {
      winner: findValueByLabel($, ['得標廠商','決標廠商','廠商名稱']) || '未公告',
      budget: normalizeMoney(findValueByLabel($, ['總決標金額','決標金額'])),
      awardDate: normalizeDate(findValueByLabel($, ['決標公告日期','決標日期','決標日']))
    };
  } catch { return { winner: '未公告', budget: null, awardDate: null }; }
}
function parseAwardRows(html) {
  const $ = cheerio.load(html); const rows = [];
  const table = $('#atm').length ? $('#atm') : $('table').filter((_, el) => $(el).text().includes('決標')).first();
  table.find('tbody tr, tr').each((_, tr) => {
    const cells = $(tr).find('td'); if (cells.length < 5) return;
    const agency = clean($(cells[1]).text()); const identity = decodeNameFromCell($, cells[2]);
    const caseNo = extractCaseNo($(cells[2]).text()); if (!identity.name || !caseNo || !isRelevant(identity.name, agency)) return;
    const publishDate = cells.map((_, c) => normalizeDate($(c).text())).get().find(Boolean) || null;
    rows.push({ agency, title: identity.name, caseNo, publishDate, detailUrl: identity.href });
  });
  return rows;
}
function buildTenderUrl(keyword, start, end) {
  const p = new URLSearchParams({ pageSize:'100', firstSearch:'true', searchType:'basic', isBinding:'N', isLogIn:'N', level_1:'on', orgName:'', orgId:'', tenderName:keyword, tenderType:'TENDER_DECLARATION', tenderWay:'TENDER_WAY_ALL_DECLARATION', dateType:'isSpdt', tenderStartDate:formatPccDate(start), tenderEndDate:formatPccDate(end), radProctrgCate:'', policyAdvocacy:'' });
  return `${TENDER_SEARCH}?${p}`;
}
function buildAwardUrl(keyword, start, end) {
  const p = new URLSearchParams({ pageSize:'100', firstSearch:'false', isBinding:'N', isLogIn:'N', orgName:'', orgId:'', tenderName:keyword, tenderId:'', tenderStatus:'TENDER_STATUS_1', tenderWay:'TENDER_WAY_ALL_DECLARATION', awardAnnounceStartDate:formatPccDate(start), awardAnnounceEndDate:formatPccDate(end), tenderRange:'TENDER_RANGE_ALL', minBudget:'', maxBudget:'', gottenVendorName:'', gottenVendorId:'', submitVendorName:'', submitVendorId:'' });
  return `${AWARD_SEARCH}?${p}`;
}
async function fetchKeyword(keyword, start, end) { return parseTenderRows(await fetchHtml(buildTenderUrl(keyword, start, end))); }
async function fetchAwardKeyword(keyword, start, end) { return parseAwardRows(await fetchHtml(buildAwardUrl(keyword, start, end))); }
function parseTaiwanBuyingDateRows(html, date) {
  const $ = cheerio.load(html); const publishDate = date.toISOString().slice(0,10); const rows = [];
  if (publishDate > taiwanTodayIso()) return rows;
  $('a').each((_, anchor) => {
    const href = $(anchor).attr('href') || ''; const text = clean($(anchor).text());
    if (!href || !text || !/ReadBidDetail|ShowBidDetail|BidDetail|Query_.*action/i.test(href)) return;
    const match = text.match(/^(.+?)[:：](.+?)(?:\s*\(\d{4}\/\d{1,2}\/\d{1,2}\))?$/); if (!match) return;
    const agency = clean(match[1]); const title = clean(match[2]); if (!title || !isRelevant(title, agency)) return;
    rows.push({ uid:`tbn|${agency}|${title}|${publishDate}`, case_no:'', title, publish_date:publishDate, deadline:null, budget:null, agency:agency||'未提供', city:inferCity(agency,title), winner:'未公告', award_date:null, status:'招標公告（補漏）', source_url:new URL(href,TAIWANBUYING_BASE).href, source_name:'台灣採購公報網', updated_at:new Date().toISOString() });
  }); return rows;
}
async function fetchTaiwanBuyingDate(date) {
  const yy=date.getUTCFullYear()-1911, mm=date.getUTCMonth()+1, dd=date.getUTCDate();
  const html=await fetchHtml(`${TAIWANBUYING_BASE}/Query_Dateaction.ASP?dd=${dd}&mm=${mm}&yy=${yy}`,2);
  return parseTaiwanBuyingDateRows(html,date);
}
async function mapPool(items, worker, concurrency=CONCURRENCY) {
  const results=new Array(items.length); let cursor=0;
  async function run(){ while(true){ const i=cursor++; if(i>=items.length)return; try{results[i]=await worker(items[i],i);}catch(e){results[i]=[];} } }
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},run)); return results;
}
function monthStart(d){const x=new Date(d);x.setUTCDate(1);x.setUTCHours(0,0,0,0);return x;}
function monthEnd(d){const x=monthStart(d);x.setUTCMonth(x.getUTCMonth()+1);x.setUTCDate(0);return x;}
function addMonths(d,n){const x=monthStart(d);x.setUTCMonth(x.getUTCMonth()+n);return x;}
function monthKey(d){return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function dateRange(){const end=new Date();end.setUTCHours(0,0,0,0);const start=new Date(end);start.setUTCDate(start.getUTCDate()-(LOOKBACK-1));return{start,end};}
function datesBetween(start,end){const a=[];for(const d=new Date(start);d<=end;d.setUTCDate(d.getUTCDate()+1))a.push(new Date(d));return a;}
function dedupe(items){
  const map=new Map();
  for(const item of items){const caseNo=item.caseNo||item.case_no||'';const key=caseNo?`${canonical(item.agency)}|${caseNo}`:`${canonical(item.agency)}|${canonical(item.title)}|${item.publish_date||item.publishDate||''}`;const old=map.get(key);if(!old){map.set(key,item);continue;}const incomingOfficial=item.source_name==='政府電子採購網', oldOfficial=old.source_name==='政府電子採購網';map.set(key,incomingOfficial&&!oldOfficial?{...old,...item}:{...item,...old});}
  return [...map.values()];
}
function mergeRows(existing,incoming){
  const today=taiwanTodayIso();const map=new Map(existing.filter(x=>!x.publish_date||x.publish_date<=today).map(x=>[x.uid,x]));
  for(const row of incoming){if(!row.publish_date||row.publish_date>today)continue;const old=map.get(row.uid)||{};map.set(row.uid,{...old,...row,publish_date:row.publish_date||old.publish_date||null,deadline:row.deadline||old.deadline||null,budget:row.budget??old.budget??null,winner:row.winner&&row.winner!=='未公告'?row.winner:(old.winner||'未公告'),award_date:row.award_date||old.award_date||null,source_url:row.source_url||old.source_url||''});}
  return [...map.values()].sort((a,b)=>(a.publish_date||'').localeCompare(b.publish_date||'')||String(a.title).localeCompare(String(b.title),'zh-Hant'));
}
async function updateStatus(partial){
  const old=await readJson(STATUS_FILE,{}); await writeJson(STATUS_FILE,{...old,...partial});
}
async function run(){
  const startedAt=new Date().toISOString();let existing=await readJson(TENDERS_FILE,[]);const errors=[];const words=KEYWORDS.slice(0,MAX_KEYWORDS);let added=0;
  await updateStatus({status:'running',started_at:startedAt,finished_at:null,count:existing.length,message:'同步執行中',source:'政府電子採購網 + 台灣採購公報網'});
  const {start,end}=dateRange();
  const tenderBatches=await mapPool(words,async k=>{try{const r=await fetchKeyword(k,start,end);await sleep(REQUEST_DELAY_MS);return r;}catch(e){errors.push(`最新招標 ${k}: ${e.message}`);return[];}});
  let merged=mergeRows(existing,dedupe(tenderBatches.flat()));added+=Math.max(0,merged.length-existing.length);existing=merged;await writeJson(TENDERS_FILE,existing);
  const awardBatches=await mapPool(words,async k=>{try{const r=await fetchAwardKeyword(k,start,end);await sleep(REQUEST_DELAY_MS);return r;}catch(e){errors.push(`最新決標 ${k}: ${e.message}`);return[];}});
  const awards=dedupe(awardBatches.flat()).slice(0,18);
  for(const c of awards){const d=await fetchAwardDetail(c.detailUrl);existing=mergeRows(existing,[{uid:`${c.agency}|${c.caseNo}`,case_no:c.caseNo,title:c.title,publish_date:c.publishDate,deadline:null,budget:d.budget,agency:c.agency||'未提供',city:inferCity(c.agency,c.title),winner:d.winner||'未公告',award_date:d.awardDate,status:'決標公告',source_url:c.detailUrl,source_name:'政府電子採購網',updated_at:new Date().toISOString()}]);await sleep(REQUEST_DELAY_MS);}
  await writeJson(TENDERS_FILE,existing);
  if(TAIWANBUYING_ENABLED){const b=await mapPool(datesBetween(start,end),async d=>{try{const r=await fetchTaiwanBuyingDate(d);await sleep(REQUEST_DELAY_MS);return r;}catch(e){errors.push(`採購公報 ${d.toISOString().slice(0,10)}: ${e.message}`);return[];}},Math.min(2,CONCURRENCY));const before=existing.length;existing=mergeRows(existing,dedupe(b.flat()));added+=Math.max(0,existing.length-before);await writeJson(TENDERS_FILE,existing);}

  let state=await readJson(BACKFILL_FILE,{version:1,cursor_month:null,completed_months:0,target_start_year:HISTORY_START_YEAR,done:false,updated_at:null});
  if(!state.cursor_month){state.cursor_month=monthKey(monthStart(new Date()));state.target_start_year=HISTORY_START_YEAR;}
  for (let n = 0; n < BACKFILL_MONTHS_PER_RUN && !state.done; n++) {
  const cursor = new Date(`${state.cursor_month}-01T00:00:00Z`);

  if (cursor.getUTCFullYear() < HISTORY_START_YEAR) {
    state.done = true;
    break;
  }

  const ms = monthStart(cursor);
  const me = monthEnd(cursor) > new Date() ? new Date() : monthEnd(cursor);
  const currentMonth = monthKey(ms);

  let successfulQueries = 0;

  const tb = await mapPool(words, async keyword => {
    try {
      const rows = await fetchKeyword(keyword, ms, me);
      successfulQueries += 1;
      await sleep(REQUEST_DELAY_MS);
      return rows;
    } catch (error) {
      const cause =
        error?.cause?.code ||
        error?.cause?.message ||
        error?.message ||
        String(error);

      errors.push(`歷史 ${currentMonth} ${keyword}: ${cause}`);
      return [];
    }
  });

  // 整個月份所有查詢都失敗：保留在目前月份，下次重試
  if (successfulQueries === 0) {
    state.last_failed_month = currentMonth;
    state.last_error = `該月份 ${words.length} 個關鍵字全部查詢失敗`;
    state.updated_at = new Date().toISOString();

    await writeJson(BACKFILL_FILE, state);
    break;
  }

  const before = existing.length;
  existing = mergeRows(existing, dedupe(tb.flat()));
  added += Math.max(0, existing.length - before);

  await writeJson(TENDERS_FILE, existing);

  // 至少有一個查詢成功，才推進到上一個月份
  state.completed_months = (state.completed_months || 0) + 1;

  const next = addMonths(cursor, -1);
  state.cursor_month = monthKey(next);
  state.done = next.getUTCFullYear() < HISTORY_START_YEAR;
  state.last_failed_month = null;
  state.last_error = null;
  state.updated_at = new Date().toISOString();

  await writeJson(BACKFILL_FILE, state);
}
  const result={status:errors.length?(existing.length?'partial':'error'):'ok',started_at:startedAt,finished_at:new Date().toISOString(),count:existing.length,added,message:errors.length?errors.slice(-10).join('\n'):'同步完成',source:'政府電子採購網 + 台灣採購公報網',backfill:state};
  await writeJson(STATUS_FILE,result);console.log(JSON.stringify(result,null,2));
}

run().catch(async error=>{const existing=await readJson(TENDERS_FILE,[]);await updateStatus({status:'error',finished_at:new Date().toISOString(),count:existing.length,message:error?.stack||String(error)});console.error(error);process.exitCode=1;});
