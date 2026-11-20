/**
 * ⛺ 캠핑 장보기 체크리스트 · 전용 백엔드 (Google Apps Script)
 * ------------------------------------------------------------------
 * "캠핑 장보기 체크리스트" 스프레드시트에 묶여(bound) 동작하는 전용 백엔드입니다.
 * 기존 "우리 가족 기록장" 시트/스크립트와는 완전히 분리되어 있고,
 * 가족 캘린더·감사편지·아이들 일정 등 가족 데이터는 이 스크립트에서 전혀 읽지 않습니다.
 *
 * 시트 구조
 *   탭 items    A1:H1  id | category | name | qty | assignee | checked | order | updatedAt
 *   탭 receipts A1:M1  id | updatedAt | chunks | c1 ... c10
 *     - 영수증 사진(Data URL)을 청크로 쪼개 같은 스프레드시트 안에 저장합니다.
 *       (DriveApp 같은 새 OAuth 권한을 추가하지 않기 위한 설계)
 *     - 청크 하나 최대 45,000자(셀 한도 50,000자) → 10청크 = 450,000자(약 330KB JPEG)까지
 *
 * 동작
 *   doGet   : { ok:true, meta:{...}, items:[... hasReceipt:true/false ] } JSON 반환
 *             (시트가 비어 있으면 기본 품목을 1회만 시드)
 *             ?op=receipt&id={itemId}  → { ok:true, id, dataUrl, updatedAt } 영수증 원본
 *   doPost  : body(JSON, text/plain) { op, ... } 단건 패치
 *             - toggle : { op:'toggle', id, checked? }     체크/해제 (checked 생략 시 반전)
 *             - assign : { op:'assign', id, assignee }     담당자 변경 (병석/민규/영준/미정/캠핏 오더)
 *             - edit   : { op:'edit', id, name?, qty? }    이름·수량 수정
 *             - upsert : { op:'upsert', item:{ id?, category, name, qty?, assignee?, receipt? } }
 *                        id 가 있으면 그 행만 수정, 없으면 새 품목 추가.
 *                        item.receipt 에 'data:image/...' 가 오면 receipts 탭에도 저장
 *                        ('' 이면 삭제)
 *             - receipt: { op:'receipt', id, receipt }     기존 품목 영수증만 추가/교체/삭제
 *             - delete : { op:'delete', id }               품목 삭제 (+ receipts 탭 같은 id 삭제)
 *             - seed   : { op:'seed' }                     비어 있을 때만 기본 품목 시드
 *             LockService 로 한 번에 한 요청만 반영하므로, 3명이 서로 다른 품목을
 *             동시에 체크/배정해도 다른 사람의 변경을 덮어쓰지 않습니다(전체 덮어쓰기 없음).
 *
 * 웹 앱 배포 설정
 *   [배포] > [새 배포] > 유형 "웹 앱"
 *   - 다음 사용자로 실행: 나(소유자)          → 시트를 공유하지 않아도 됨
 *   - 액세스 권한: 모든 사용자(익명 포함)     → 친구 폰에서 링크만으로 접근
 *
 * 프런트엔드는 text/plain 본문으로 JSON 을 POST 하므로 CORS 사전요청(preflight)이
 * 발생하지 않습니다. 응답은 항상 JSON 이며 실패해도 { ok:false, error } 로 돌려줍니다.
 */

/* ---------------------------------------------------------------- 상수 */

var SHEET_NAME = 'items';
var HEADERS = ['id', 'category', 'name', 'qty', 'assignee', 'checked', 'order', 'updatedAt'];

var RECEIPT_SHEET = 'receipts';
var RECEIPT_CHUNK = 45000;          // 셀 한도 50,000자 미만
var RECEIPT_COLS = 10;              // c1 ~ c10
var RECEIPT_MAX = RECEIPT_CHUNK * RECEIPT_COLS;   // 450,000자
var RECEIPT_HEADERS = ['id', 'updatedAt', 'chunks',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'];

var DEFAULT_TITLE = '⛺ 캠핑 장보기 체크리스트';
var ASSIGNEES = ['병석', '민규', '영준', '미정', '캠핏 오더'];
var UNASSIGNED = '미정';

// 메뉴 흐름: 금저녁 부대찌개·불고기 / 토아침 고등어·계란국 / 토점심 고기 / 토저녁 쭈삼·어묵탕
// 밀키트 위주 장보기라 양념·자잘한 부재료는 넣지 않고 핵심 품목만 굵직하게 둡니다.
var CATEGORIES = [
  {
    key: '공통 준비물',
    items: [
      { name: '생수', qty: '2L x 6병' },
      { name: '숯 · 착화제' },
      { name: '그릴 · 석쇠 · 호일' },
      { name: '토치 · 부탄가스' },
      { name: '집게 · 가위 · 목장갑' },
      { name: '일회용 수저 · 접시 · 종이컵' },
      { name: '물티슈 · 키친타월 · 쓰레기봉투' },
      { name: '즉석밥 (햇반)' },
      { name: '김치' },
      { name: '주류 · 음료 · 얼음' },
      { name: '모닝커피 · 간식' }
    ]
  },
  {
    key: '금요일 저녁',
    items: [
      { name: '부대찌개 밀키트' },
      { name: '불고기 밀키트' },
      { name: '라면사리' }
    ]
  },
  {
    key: '토요일 아침',
    items: [
      { name: '고등어', qty: '순살/구이용' },
      { name: '계란국', qty: '밀키트 또는 계란·육수' },
      { name: '조미김 · 밑반찬' }
    ]
  },
  {
    key: '토요일 점심',
    items: [
      { name: '삼겹살 · 목살' },
      { name: '홍가리비' },
      { name: '상추 · 쌈채소' },
      { name: '쌈무' },
      { name: '쌈장 · 기름장' },
      { name: '마늘 · 고추 · 버섯' }
    ]
  },
  {
    key: '토요일 저녁',
    items: [
      { name: '쭈삼 밀키트' },
      { name: '꼬치어묵탕 밀키트' },
      { name: '우동사리' }
    ]
  }
];

var PROP_TITLE = 'camping_title';
var PROP_UPDATED = 'camping_updatedAt';
var LOCK_TIMEOUT_MS = 10000;

/* ---------------------------------------------------------------- doGet */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var op = String(p.op || '').toLowerCase();

    // 영수증 원본만 단건으로 돌려줍니다 (목록 조회에는 hasReceipt 만 실립니다).
    if (op === 'receipt') {
      var got = getReceipt_(p.id);
      if (!got) return jsonP_({ ok: false, error: 'no receipt' });
      return jsonP_({ ok: true, id: String(p.id || '').trim(), dataUrl: got.dataUrl, updatedAt: got.updatedAt });
    }

    var sh = ensureSheet_();
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      if (sh.getLastRow() < 2) {
        seed_(sh);
      }
    } finally {
      lock.releaseLock();
    }
    return jsonP_(state_(sh));
  } catch (err) {
    return jsonP_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ---------------------------------------------------------------- doPost */

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var op = String(body.op || '').toLowerCase();
    var sh = ensureSheet_();

    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      var rows = readRows_(sh);
      var changed = null;

      if (op === 'seed' || op === 'initifempty' || op === '') {
        if (rows.items.length === 0) {
          seed_(sh);
        }
      } else if (op === 'toggle') {
        changed = patchRow_(sh, rows, body.id, function (item) {
          var next = (typeof body.checked === 'boolean') ? body.checked : !item.checked;
          return { checked: !!next };
        });
      } else if (op === 'assign') {
        var who = normalizeAssignee_(body.assignee);
        changed = patchRow_(sh, rows, body.id, function () {
          return { assignee: who };
        });
      } else if (op === 'edit') {
        changed = patchRow_(sh, rows, body.id, function (item) {
          var patch = {};
          if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
          if (typeof body.qty === 'string') patch.qty = body.qty.trim().slice(0, 40);
          if (typeof body.category === 'string' && body.category.trim()) patch.category = body.category.trim().slice(0, 30);
          return patch;
        });
      } else if (op === 'upsert') {
        var item = body.item || {};
        if (item.id) {
          changed = patchRow_(sh, rows, item.id, function (old) {
            var patch = {};
            if (typeof item.name === 'string' && item.name.trim()) patch.name = item.name.trim().slice(0, 60);
            if (typeof item.qty === 'string') patch.qty = item.qty.trim().slice(0, 40);
            if (typeof item.category === 'string' && item.category.trim()) patch.category = item.category.trim().slice(0, 30);
            if (typeof item.assignee === 'string') patch.assignee = normalizeAssignee_(item.assignee);
            if (typeof item.checked === 'boolean') patch.checked = item.checked;
            return patch;
          });
        } else {
          changed = insertItem_(sh, item);
        }
        // 사진이 함께 왔으면 방금 만든/고친 행 id 로 receipts 탭에 저장합니다.
        if (changed && changed.id && typeof item.receipt === 'string') {
          applyReceipt_(changed.id, item.receipt);
        }
      } else if (op === 'receipt') {
        var rid = String(body.id || '').trim();
        if (indexOfId_(rows.items, rid) < 0) {
          return jsonP_({ ok: false, error: 'no such item: ' + rid });
        }
        applyReceipt_(rid, body.receipt);
        changed = { id: rid };
      } else if (op === 'delete') {
        var idx = indexOfId_(rows.items, body.id);
        if (idx >= 0) {
          sh.deleteRow(idx + 2); // 헤더 1행 + 0-based 보정
          changed = { id: body.id, deleted: true };
        }
        // 품목이 이미 없어도 영수증 행은 남기지 않습니다.
        applyReceipt_(String(body.id || '').trim(), '');
      } else {
        return jsonP_({ ok: false, error: 'unknown op: ' + op });
      }

      if (changed) {
        touchMeta_();
      }
      var out = state_(sh);
      if (!out.ok) return jsonP_(out);
      out.changed = changed;
      return jsonP_(out);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonP_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ---------------------------------------------------------------- 시트 준비 */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
  }
  var head = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  var same = true;
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(head[i]) !== HEADERS[i]) { same = false; break; }
  }
  if (!same) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureReceiptsSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(RECEIPT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECEIPT_SHEET);
  }
  var head = sh.getRange(1, 1, 1, RECEIPT_HEADERS.length).getValues()[0];
  var same = true;
  for (var i = 0; i < RECEIPT_HEADERS.length; i++) {
    if (String(head[i]) !== RECEIPT_HEADERS[i]) { same = false; break; }
  }
  if (!same) {
    sh.getRange(1, 1, 1, RECEIPT_HEADERS.length).setValues([RECEIPT_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function seed_(sh) {
  var order = 1;
  var now = new Date().toISOString();
  var data = [];
  for (var c = 0; c < CATEGORIES.length; c++) {
    var cat = CATEGORIES[c];
    for (var i = 0; i < cat.items.length; i++) {
      var it = cat.items[i];
      var nm = (typeof it === 'string') ? it : (it && it.name) || '';
      var qt = (typeof it === 'string') ? '' : ((it && it.qty) || '');
      if (!String(nm).trim()) continue;
      data.push([newId_(), cat.key, String(nm).trim(), String(qt).trim(), UNASSIGNED, false, order++, now]);
    }
  }
  if (data.length) {
    sh.getRange(2, 1, data.length, HEADERS.length).setValues(data);
  }
  touchMeta_();
}

/* ---------------------------------------------------------------- 영수증 저장 */

// receipts 탭에서 해당 id 행 번호(1부터). 없으면 -1.
function receiptRowIndex_(rsh, id) {
  var target = String(id || '').trim();
  if (!target) return -1;
  var last = rsh.getLastRow();
  if (last < 2) return -1;
  var ids = rsh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === target) return i + 2;
  }
  return -1;
}

/**
 * 영수증 사진(Data URL) 저장/교체/삭제.
 * dataUrl 이 비어 있으면 해당 행을 지웁니다.
 */
function applyReceipt_(id, dataUrl) {
  var sid = String(id || '').trim();
  if (!sid) return false;
  var rsh = ensureReceiptsSheet_();
  var url = String(dataUrl == null ? '' : dataUrl);
  var rowNo = receiptRowIndex_(rsh, sid);

  if (!url) {
    if (rowNo > 0) rsh.deleteRow(rowNo);
    return true;
  }
  if (url.indexOf('data:image/') !== 0) {
    throw new Error('invalid receipt: data:image/... 형식이 아닙니다');
  }
  if (url.length > RECEIPT_MAX) {
    throw new Error('receipt too large: ' + url.length + '자 (최대 ' + RECEIPT_MAX + '자)');
  }

  var chunks = Math.ceil(url.length / RECEIPT_CHUNK);
  if (chunks < 1) chunks = 1;
  var row = [sid, new Date().toISOString(), chunks];
  for (var i = 0; i < RECEIPT_COLS; i++) {
    row.push(i < chunks ? url.substr(i * RECEIPT_CHUNK, RECEIPT_CHUNK) : '');
  }
  if (rowNo > 0) rsh.getRange(rowNo, 1, 1, row.length).setValues([row]);
  else rsh.appendRow(row);
  return true;
}

function getReceipt_(id) {
  var sid = String(id || '').trim();
  if (!sid) return null;
  var rsh = ensureReceiptsSheet_();
  var rowNo = receiptRowIndex_(rsh, sid);
  if (rowNo < 0) return null;
  var vals = rsh.getRange(rowNo, 1, 1, RECEIPT_HEADERS.length).getValues()[0];
  var chunks = Number(vals[2]) || 0;
  var url = '';
  for (var i = 0; i < RECEIPT_COLS && i < chunks; i++) {
    url += String(vals[3 + i] == null ? '' : vals[3 + i]);
  }
  if (!url) return null;
  return { dataUrl: url, updatedAt: String(vals[1] || '') };
}

// 품목 id -> 영수증 있음 여부 (목록 조회에서 id 열만 읽습니다)
function receiptIdSet_() {
  var map = {};
  try {
    var rsh = ensureReceiptsSheet_();
    var last = rsh.getLastRow();
    if (last < 2) return map;
    var ids = rsh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var v = String(ids[i][0] || '').trim();
      if (v) map[v] = true;
    }
  } catch (e) { /* 영수증 탭을 못 읽어도 장보기는 그대로 동작 */ }
  return map;
}

/* ---------------------------------------------------------------- 읽기/쓰기 */

function readRows_(sh) {
  var last = sh.getLastRow();
  var items = [];
  if (last >= 2) {
    var values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      if (!String(r[0]).trim() && !String(r[2]).trim()) continue;
      items.push({
        id: String(r[0] || '').trim() || newId_(),
        category: String(r[1] || '').trim() || '기타',
        name: String(r[2] || '').trim(),
        qty: String(r[3] || '').trim(),
        assignee: normalizeAssignee_(r[4]),
        checked: toBool_(r[5]),
        order: Number(r[6]) || (i + 1),
        updatedAt: String(r[7] || '')
      });
    }
  }
  return { items: items, lastRow: last };
}

function indexOfId_(items, id) {
  var target = String(id || '').trim();
  if (!target) return -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === target) return i;
  }
  return -1;
}

/**
 * 시트의 해당 행만 부분 갱신합니다. (다른 행·다른 사람의 변경은 그대로 유지)
 */
function patchRow_(sh, rows, id, mutate) {
  var idx = indexOfId_(rows.items, id);
  if (idx < 0) return null;
  var item = rows.items[idx];
  var patch = mutate(item) || {};
  var rowNo = idx + 2;

  var nowIso = new Date().toISOString();
  var current = sh.getRange(rowNo, 1, 1, HEADERS.length).getValues()[0];

  var merged = {
    id: item.id,
    category: (patch.category !== undefined) ? patch.category : current[1],
    name: (patch.name !== undefined) ? patch.name : current[2],
    qty: (patch.qty !== undefined) ? patch.qty : current[3],
    assignee: (patch.assignee !== undefined) ? patch.assignee : normalizeAssignee_(current[4]),
    checked: (patch.checked !== undefined) ? !!patch.checked : toBool_(current[5]),
    order: Number(current[6]) || item.order || rowNo,
    updatedAt: nowIso
  };
  sh.getRange(rowNo, 1, 1, HEADERS.length).setValues([[
    merged.id, merged.category, merged.name, merged.qty, merged.assignee,
    merged.checked, merged.order, merged.updatedAt
  ]]);
  merged.updatedAt = nowIso;
  return merged;
}

function insertItem_(sh, item) {
  var name = String(item.name || '').trim();
  if (!name) return null;
  var rows = readRows_(sh);

  // 1) id 가 있는데 이미 그 행이 있으면 그 행만 갱신
  if (item.id) {
    var hit = indexOfId_(rows.items, item.id);
    if (hit >= 0) {
      return patchRow_(sh, rows, item.id, function () {
        var patch = {};
        if (typeof item.name === 'string' && item.name.trim()) patch.name = item.name.trim().slice(0, 60);
        if (typeof item.qty === 'string') patch.qty = item.qty.trim().slice(0, 40);
        if (typeof item.category === 'string' && item.category.trim()) patch.category = item.category.trim().slice(0, 30);
        if (typeof item.assignee === 'string') patch.assignee = normalizeAssignee_(item.assignee);
        if (typeof item.checked === 'boolean') patch.checked = item.checked;
        return patch;
      });
    }
  }

  // 2) 같은 카테고리에 같은 이름이 이미 있으면 새 행을 만들지 않고 그 행을 갱신합니다.
  //    (두 사람이 같은 품목을 동시에 추가해도 행이 중복되지 않게 하는 안전장치)
  var cat = String(item.category || '').trim() || '기타';
  for (var i = 0; i < rows.items.length; i++) {
    var it = rows.items[i];
    if (it.name === name && it.category === cat) {
      var targetId = it.id;
      return patchRow_(sh, rows, targetId, function () {
        var patch = {};
        if (typeof item.qty === 'string' && item.qty.trim()) patch.qty = item.qty.trim().slice(0, 40);
        if (typeof item.assignee === 'string') patch.assignee = normalizeAssignee_(item.assignee);
        return patch;
      });
    }
  }
  var maxOrder = 0;
  for (var j = 0; j < rows.items.length; j++) {
    if (rows.items[j].order > maxOrder) maxOrder = rows.items[j].order;
  }
  var nowIso = new Date().toISOString();
  var row = [
    newId_(),
    cat,
    name.slice(0, 60),
    String(item.qty || '').trim().slice(0, 40),
    normalizeAssignee_(item.assignee),
    !!item.checked,
    maxOrder + 1,
    nowIso
  ];
  sh.appendRow(row);
  return {
    id: row[0], category: row[1], name: row[2], qty: row[3],
    assignee: row[4], checked: row[5], order: row[6], updatedAt: nowIso
  };
}

/* ---------------------------------------------------------------- 상태/메타 */

function state_(sh) {
  var rows = readRows_(sh);
  var items = rows.items;
  items.sort(function (a, b) { return (a.order - b.order) || a.name.localeCompare(b.name); });
  var withReceipt = receiptIdSet_();
  var done = 0;
  for (var i = 0; i < items.length; i++) {
    if (items[i].checked) done++;
    items[i].hasReceipt = !!withReceipt[items[i].id];
  }
  var props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    meta: {
      title: props.getProperty(PROP_TITLE) || DEFAULT_TITLE,
      updatedAt: props.getProperty(PROP_UPDATED) || '',
      count: items.length,
      done: done
    },
    categories: CATEGORIES.map(function (c) { return c.key; }),
    assignees: ASSIGNEES,
    items: items
  };
}

function touchMeta_() {
  PropertiesService.getScriptProperties().setProperty(PROP_UPDATED, new Date().toISOString());
}

/* ---------------------------------------------------------------- 유틸 */

function normalizeAssignee_(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return UNASSIGNED;
  for (var i = 0; i < ASSIGNEES.length; i++) {
    if (s === ASSIGNEES[i]) return s;
  }
  return UNASSIGNED;
}

function toBool_(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  var s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'y' || s === 'yes' || s === '✔' || s === 'o';
}

function newId_() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function jsonP_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
