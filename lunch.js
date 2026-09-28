(() => {
  'use strict';

  // 급식표(엑셀·CSV)를 읽어 매일 점심에 먹을 양을 목표에 맞춰 안내한다.
  // 앱 본체가 window.FitLogCore를 제공해야 동작하고, window.FitLogAI가 있으면 AI로 더 정확하게 계산한다.
  const core = window.FitLogCore;
  if (!core) return;
  const { readState, writeState, showToast, dateKey, esc } = core;
  const ai = window.FitLogAI || null;
  const $ = (selector, root = document) => root.querySelector(selector);
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  let aiBusyDate = null;

  // ---------------------------------------------------------------
  // 1. 파일 읽기: xlsx(zip) · csv · html 표. 외부 라이브러리 없이 브라우저에서만 처리한다.
  // ---------------------------------------------------------------
  async function unzip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let end = -1;
    for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65558); index--) {
      if (view.getUint32(index, true) === 0x06054b50) { end = index; break; }
    }
    if (end < 0) throw new Error('엑셀 파일 구조를 읽지 못했어요.');
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const entries = {};
    for (let index = 0; index < count && view.getUint32(offset, true) === 0x02014b50; index++) {
      const nameLength = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      entries[name] = { method: view.getUint16(offset + 10, true), size: view.getUint32(offset + 20, true), local: view.getUint32(offset + 42, true) };
      offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    return async name => {
      const entry = entries[name];
      if (!entry) return null;
      const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
      const data = bytes.subarray(start, start + entry.size);
      if (entry.method === 0) return new TextDecoder().decode(data);
      if (entry.method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('이 브라우저에서는 엑셀 압축을 풀 수 없어요. CSV로 저장해 올려주세요.');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    };
  }

  const xml = text => new DOMParser().parseFromString(text, 'application/xml');
  const columnIndex = ref => [...String(ref).replace(/\d+/g, '')].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;

  async function readXlsx(buffer) {
    const read = await unzip(buffer);
    const shared = [];
    const sharedXml = await read('xl/sharedStrings.xml');
    if (sharedXml) [...xml(sharedXml).getElementsByTagName('si')].forEach(item => shared.push([...item.getElementsByTagName('t')].map(node => node.textContent).join('')));
    const workbook = xml(await read('xl/workbook.xml') || '<workbook/>');
    const relsXml = await read('xl/_rels/workbook.xml.rels');
    const targets = {};
    if (relsXml) [...xml(relsXml).getElementsByTagName('Relationship')].forEach(rel => { targets[rel.getAttribute('Id')] = rel.getAttribute('Target'); });
    const sheets = [];
    for (const sheet of workbook.getElementsByTagName('sheet')) {
      const id = sheet.getAttribute('r:id') || [...sheet.attributes].find(attr => /:id$/.test(attr.name))?.value;
      const target = String(targets[id] || '').replace(/^\/?xl\//, '').replace(/^\//, '');
      const sheetXml = target && await read(`xl/${target}`);
      if (!sheetXml) continue;
      const rows = [];
      for (const cell of xml(sheetXml).getElementsByTagName('c')) {
        const ref = cell.getAttribute('r') || '';
        const row = +ref.replace(/[A-Z]+/g, '') - 1;
        const col = columnIndex(ref);
        if (row < 0 || col < 0) continue;
        const type = cell.getAttribute('t');
        const raw = cell.getElementsByTagName('v')[0]?.textContent ?? '';
        const value = type === 's' ? shared[+raw] ?? '' : type === 'inlineStr' ? [...cell.getElementsByTagName('t')].map(node => node.textContent).join('') : raw;
        (rows[row] ||= [])[col] = value;
      }
      sheets.push({ name: sheet.getAttribute('name') || '', rows });
    }
    return sheets;
  }

  function decodeText(buffer) {
    const utf8 = new TextDecoder('utf-8').decode(buffer);
    if ((utf8.match(/�/g) || []).length < 3) return utf8.replace(/^﻿/, '');
    try { return new TextDecoder('euc-kr').decode(buffer); } catch { return utf8; }
  }

  function readCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ',' || char === '\t') { row.push(cell); cell = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[index + 1] === '\n') index++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += char;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return [{ name: '', rows }];
  }

  function readHtmlTable(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return [...doc.querySelectorAll('table')].map(table => ({
      name: '',
      rows: [...table.rows].map(tr => [...tr.cells].map(td => td.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()))
    }));
  }

  async function readSheets(file) {
    const buffer = await file.arrayBuffer();
    const head = new Uint8Array(buffer.slice(0, 8));
    if (head[0] === 0x50 && head[1] === 0x4b) return readXlsx(buffer);
    if (head[0] === 0xd0 && head[1] === 0xcf) throw new Error('예전 엑셀 형식(.xls)이에요. 엑셀에서 "다른 이름으로 저장 → Excel 통합 문서(.xlsx)"로 저장해 올려주세요.');
    const text = decodeText(buffer);
    return /^\s*</.test(text) ? readHtmlTable(text) : readCsv(text);
  }

  // ---------------------------------------------------------------
  // 2. 급식표 해석: 나이스식 표(날짜·메뉴 열)와 달력식(칸마다 날짜+메뉴) 모두 지원
  // ---------------------------------------------------------------
  const MEAL_LABEL = /^\[?\s*(조식|중식|석식|아침|점심|저녁)\s*\]?$/;
  // 메뉴가 아닌 안내 문구. 영양소 이름은 NUTRIENT_LINE이 줄 시작에서 판별한다("영양밥", "저지방우유"는 메뉴로 남긴다).
  const SKIP_LINE = /원산지|알레르기|알러지|영양\s*(정보|성분|소|표|사)|식단표|급식표|학교|^메뉴$|^식단$|^요일$|^[월화수목금토일]$|^[월화수목금토일]요일$/;
  const HOLIDAY = /휴업|방학|재량|공휴|휴일|급식\s*없음|미실시|^없음$|추석|설날|연휴|개교기념/;
  // 급식표 아래에 붙는 영양 정보 줄(에너지 612kcal, 철 3.2mg 등)을 메뉴로 읽지 않는다.
  const NUTRIENT_LINE = /^(에너지|열량|탄수화물|단백질|지방|칼슘|철분?|비타민\s*[A-Za-z0-9]*|리보플라빈|티아민|나트륨|식이섬유|콜레스테롤|당류|포화지방|레티놀|아연|칼륨|엽산)(?=$|\s|[(:：\d])|\d\s*(mg|㎎|μg|ug|RE)(?![가-힣])/i;
  const NUTRIENT_EN = /^(energy|protein|fat|carbohydrates?|calcium|iron|sodium|vitamin\s*[a-z0-9]*|riboflavin|thiamin|fiber|ca|fe|na)(?=$|\s|[(:\d])/i;
  const isMenuItem = raw => {
    const line = normalizeText(raw).trim();
    const compact = line.replace(/\s+/g, '');
    return /[가-힣a-zA-Z]/.test(line) && line.length <= 30
      && !SKIP_LINE.test(line) && !SKIP_LINE.test(compact)
      && !NUTRIENT_LINE.test(line) && !NUTRIENT_LINE.test(compact) && !NUTRIENT_EN.test(line)
      && !/kcal|칼로리|열량|㎉/i.test(line) && !MEAL_LABEL.test(compact);
  };

  // 엑셀·HTML에서 넘어온 보이지 않는 문자와 전각 문자를 정리한다.
  const normalizeText = value => String(value ?? '').normalize('NFC')
    .replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '')
    .replace(/[\u00A0\u3000]/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));

  function cleanItem(raw) {
    let text = normalizeText(raw).replace(/<[^>]+>/g, ' ').replace(/[*#★☆◆◇●○■□▶▷※@♥♡]/g, '').replace(/\s+/g, ' ').trim();
    for (let pass = 0; pass < 3; pass++) {
      text = text.replace(/\s*\(\s*[\d.,\s]+\)\s*$/, '').replace(/(?<=[가-힣a-zA-Z)\]])\s*\d{1,2}(?:\s*[.,]\s*\d{1,2})*\s*\.\s*$/, '').trim();
    }
    return text.replace(/^[-·•\s]+/, '').trim();
  }

  const kcalOf = value => { const match = String(value || '').replace(/,/g, '').match(/(\d{3,4}(?:\.\d+)?)\s*(?:kcal|㎉|칼로리)?/i); return match ? Math.round(+match[1]) : null; };

  // "* 에너지/단백질/칼슘/철" 같은 안내 줄. 빗금으로 먼저 쪼개면 영양소 이름이 메뉴처럼 보이므로 줄째 버린다.
  const NOTE_LINE = /^\s*[*※☞▶►◎]|^\s*[[(]?\s*(에너지|열량|영양\s*(정보|성분|소|표)|원산지|알레르기|알러지)/;
  const nutrientList = line => line.split(/[,/·]/).filter(part => NUTRIENT_LINE.test(normalizeText(part).replace(/\s+/g, ''))).length >= 2;

  // 알레르기 번호 묶음 "(5.6.10.13)". 이 뒤는 다음 메뉴가 시작되는 자리로 본다.
  const ALLERGY_GROUP = /\(\s*\d{1,2}(?:\s*[.,]\s*\d{1,2})*\s*\.?\s*\)/g;

  // 괄호 밖의 쉼표·빗금에서만 나눈다. "모듬전(한돈육전,참나물전)"은 한 메뉴로 둔다.
  function splitOutsideParens(text) {
    const parts = [];
    let depth = 0;
    let buffer = '';
    for (const char of text) {
      if (char === '(') depth++;
      if (char === ')') depth = Math.max(0, depth - 1);
      if ((char === ',' || char === '/') && depth === 0) { parts.push(buffer); buffer = ''; } else buffer += char;
    }
    parts.push(buffer);
    return parts;
  }

  const balanceParens = text => (text.match(/\(/g) || []).length > (text.match(/\)/g) || []).length ? `${text})` : text;

  // 메뉴 칸 하나를 읽어 메뉴 목록과(있으면) 열량·단백질을 돌려준다.
  // 예) "부대찌개(2.5.6)     간장돈육불고기(5.6.10)" → 두 메뉴,  "* 에너지/단백질/칼슘/철" ↵ "549.92/32.20/…" → 549kcal·단백질 32g
  function readMenuCell(value) {
    const result = { items: [], kcal: null, protein: null };
    let headers = null;
    normalizeText(value).split(/<br\s*\/?>|\r?\n/i).forEach(line => {
      const segments = line.replace(ALLERGY_GROUP, '$&\n').split(/\n|\s{2,}/).map(segment => segment.trim()).filter(Boolean);
      segments.forEach(segment => {
        if (NOTE_LINE.test(segment) || nutrientList(segment)) {
          headers = segment.replace(/^[^가-힣A-Za-z]+/, '').split(/[/,·]/).map(part => part.trim()).filter(Boolean);
          return;
        }
        if (headers && NUTRIENT_LINE.test(segment.replace(/\s+/g, ''))) { headers.push(...segment.split(/[/,·]/).map(part => part.trim()).filter(Boolean)); return; }
        if (/^[\d.\s/,]+$/.test(segment)) {
          if (headers) {
            const numbers = segment.split(/[/,]/).map(part => +part.trim());
            const valueOf = pattern => { const index = headers.findIndex(name => pattern.test(name)); return index >= 0 ? numbers[index] : NaN; };
            const kcal = valueOf(/에너지|열량|kcal/i);
            const protein = valueOf(/단백질/);
            if (kcal >= 150 && kcal <= 2500) result.kcal = Math.round(kcal);
            if (protein > 0 && protein < 200) result.protein = Math.round(protein * 10) / 10;
            headers = null;
          }
          return;
        }
        const energy = segment.match(/^(?:에너지|열량)\s*[:：]?\s*(\d{3,4}(?:\.\d+)?)/);
        if (energy) { result.kcal = Math.round(+energy[1]); return; }
        if (/kcal|㎉/i.test(segment)) { const kcal = kcalOf(segment); if (kcal) result.kcal = kcal; return; }
        splitOutsideParens(segment).forEach(part => {
          const item = balanceParens(cleanItem(part));
          if (item && isMenuItem(item)) result.items.push(item);
        });
      });
    });
    return result;
  }

  const splitMenu = value => readMenuCell(value).items;

  function monthContext(sheets, fileName) {
    const haystack = [fileName, ...sheets.map(sheet => sheet.name), ...sheets.flatMap(sheet => sheet.rows.slice(0, 8).flat())].filter(Boolean).join(' ');
    const now = new Date();
    const full = haystack.match(/(20\d{2})\s*[년.\-/_]\s*(\d{1,2})\s*월?/);
    if (full && +full[2] >= 1 && +full[2] <= 12) return { year: +full[1], month: +full[2] };
    const monthOnly = haystack.match(/(\d{1,2})\s*월/);
    if (monthOnly && +monthOnly[1] >= 1 && +monthOnly[1] <= 12) {
      const month = +monthOnly[1];
      const year = now.getFullYear() + (month < now.getMonth() + 1 - 6 ? 1 : month > now.getMonth() + 1 + 6 ? -1 : 0);
      return { year, month };
    }
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }

  const toKey = (year, month, day) => {
    const date = new Date(year, month - 1, day);
    return date.getMonth() === month - 1 && date.getDate() === day ? dateKey(date) : null;
  };

  function parseDate(value, context) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (/^\d{5}(\.\d+)?$/.test(text) && +text > 40000 && +text < 60000) {
      const date = new Date(Math.round((+text - 25569) * 86400000));
      return toKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
    let match = text.match(/^(20\d{2})(\d{2})(\d{2})$/) || text.match(/(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    if (match) return toKey(+match[1], +match[2], +match[3]);
    match = text.match(/(\d{1,2})\s*[/.월]\s*(\d{1,2})\s*일?/);
    if (match) return toKey(context.year, +match[1], +match[2]);
    match = text.match(/^(\d{1,2})\s*일?\s*(?:\(?[월화수목금토일](?:요일)?\)?)?$/);
    return match ? toKey(context.year, context.month, +match[1]) : null;
  }

  // 달력 칸의 첫 줄처럼 "날짜만" 적힌 줄인지 확인한다. 엑셀 날짜 숫자(예: 46266)도 날짜로 본다.
  const DAY_ONLY = /^(?:(\d{1,2})\s*[/.월]\s*)?(\d{1,2})\s*일?\s*(?:\([^)]*\)?|[월화수목금토일](?:요일)?)?$/;
  const isDateLine = line => DAY_ONLY.test(line) || (/^\d{5}(\.\d+)?$/.test(line) && +line > 40000 && +line < 60000) || /^20\d{2}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?\s*(\(?[월화수목금토일]\)?)?$/.test(line);

  function sectionsOf(lines) {
    const sections = [];
    let current = { meal: '중식', lines: [], kcal: null };
    lines.forEach(line => {
      const label = line.match(MEAL_LABEL);
      if (label) {
        if (current.lines.length) sections.push(current);
        current = { meal: { 아침: '조식', 점심: '중식', 저녁: '석식' }[label[1]] || label[1], lines: [], kcal: null };
        return;
      }
      const kcal = /kcal|칼로리|㎉/i.test(line) && !NOTE_LINE.test(line) ? kcalOf(line) : null;
      if (kcal) current.kcal = kcal; else current.lines.push(line);
    });
    if (current.lines.length) sections.push(current);
    return sections.map(section => {
      const info = readMenuCell(section.lines.join('\n'));
      return { meal: section.meal, kcal: section.kcal || info.kcal, protein: info.protein, items: info.items };
    }).filter(section => section.items.length);
  }

  function fromTable(rows, context) {
    for (let headerRow = 0; headerRow < Math.min(rows.length, 15); headerRow++) {
      const header = (rows[headerRow] || []).map(cell => String(cell || ''));
      const find = pattern => header.findIndex(cell => pattern.test(cell));
      const dateCol = find(/일자|날짜|급식일|MLSV_YMD|^date$/i);
      const menuCol = find(/요리명|메뉴|식단|음식|DDISH/i);
      if (dateCol < 0 || menuCol < 0 || dateCol === menuCol) continue;
      const kcalCol = find(/칼로리|열량|kcal|CAL_INFO/i);
      const mealCol = find(/식사명|식사\s*구분|구분|끼니|MMEAL/i);
      const found = [];
      let lastDate = null;
      for (let row = headerRow + 1; row < rows.length; row++) {
        const cells = rows[row] || [];
        const parsedDate = parseDate(cells[dateCol], context);
        if (parsedDate) lastDate = parsedDate;
        const date = parsedDate || (String(cells[dateCol] ?? '').trim() ? null : lastDate);
        const info = readMenuCell(cells[menuCol]);
        if (!date || !info.items.length) continue;
        const mealText = String(cells[mealCol] || '');
        found.push({ date, meal: /조식|아침/.test(mealText) ? '조식' : /석식|저녁/.test(mealText) ? '석식' : '중식', items: info.items, kcal: (kcalCol >= 0 ? kcalOf(cells[kcalCol]) : null) || info.kcal, protein: info.protein });
      }
      if (found.length) return found;
    }
    return [];
  }

  function fromCalendar(rows, context) {
    const found = [];
    const lineList = value => String(value ?? '').split(/<br\s*\/?>|\r?\n/i).map(line => line.trim()).filter(Boolean);
    rows.forEach((row, rowIndex) => (row || []).forEach((value, colIndex) => {
      const lines = lineList(value);
      if (!lines.length || !isDateLine(lines[0])) return;
      const date = parseDate(lines[0].replace(/\(.*$/, ''), context);
      if (!date) return;
      let menuLines = lines.slice(1);
      if (!menuLines.length) {
        let gap = 0;
        for (let step = 1; step <= 25; step++) {
          const below = lineList(rows[rowIndex + step]?.[colIndex]);
          if (!below.length) { if (menuLines.length && ++gap >= 2) break; continue; }
          if (isDateLine(below[0])) break;
          gap = 0;
          menuLines.push(...below);
        }
      }
      if (menuLines.some(line => HOLIDAY.test(line)) && menuLines.length <= 2) return;
      sectionsOf(menuLines).filter(section => section.items.length >= 2).forEach(section => found.push({ date, ...section }));
    }));
    return found;
  }

  async function parseMenuFile(file) {
    const sheets = await readSheets(file);
    const context = monthContext(sheets, file.name);
    let entries = [];
    for (const sheet of sheets) entries = entries.concat(fromTable(sheet.rows, context));
    if (!entries.length) for (const sheet of sheets) entries = entries.concat(fromCalendar(sheet.rows, context));
    const days = {};
    entries.forEach(entry => {
      if (entry.items.every(item => HOLIDAY.test(item))) return;
      const list = days[entry.date] ||= [];
      const same = list.find(item => item.meal === entry.meal);
      if (same) same.items = [...new Set([...same.items, ...entry.items])];
      else list.push({ meal: entry.meal, items: entry.items, kcal: entry.kcal || null, protein: entry.protein || null });
    });
    return days;
  }

  // ---------------------------------------------------------------
  // 3. 먹을 양 계산 (AI 없이 음식 종류별 급식 1인분 추정)
  // ---------------------------------------------------------------
  // [패턴, 역할, kcal, 단백질, 탄수, 지방] — 위에서부터 먼저 맞는 규칙을 쓴다.
  const FOOD_RULES = [
    [/(수제비|어묵|유부|만두|떡)국$/, 'soup', 150, 6, 18, 5],
    [/떡국|만둣국|만두국|칼국수|수제비|라면|우동|짬뽕|짜장|국수|냉면|쫄면|파스타|스파게티|볶음면|비빔면|쌀국수|잔치국수/, 'staple', 480, 15, 78, 11],
    [/볶음밥|비빔밥|덮밥|주먹밥|김밥|오므라이스|라이스|필라프|리조또|유부초밥|초밥|컵밥|국밥|카레밥|치밥|곤드레|콩나물밥|무밥|버섯밥|굴밥|김치밥/, 'staple', 560, 16, 88, 14],
    [/밥($|&|\s|\()|쌀밥|잡곡밥|현미밥|흑미밥|보리밥|기장밥|찰밥|콩밥|영양밥|수수밥/, 'staple', 300, 6, 66, 1],
    [/죽$/, 'staple', 250, 7, 45, 4],
    [/떡볶이|떡꼬치|라볶이/, 'staple', 350, 7, 70, 5],
    [/빵|토스트|버거|샌드위치|피자|베이글|또띠아|팬케이크|핫케이크/, 'staple', 300, 9, 42, 10],
    [/부대찌개|감자탕|순대국|뼈해장국|해장국|육개장|닭개장|곰탕|갈비탕|설렁탕|짜글이|돼지국밥/, 'soup', 300, 16, 18, 17],
    [/국$|탕$|찌개|전골|스프$|수프$|냉국|개장/, 'soup', 120, 7, 8, 6],
    [/멸치|진미채|오징어채|김자반|김구이|^김$|파래/, 'side', 70, 5, 6, 3],
    [/튀김|까스|가스|커틀릿|강정|탕수|치킨|너겟|전$|전\(|부침|타코야끼|핫바|동그랑땡|핫도그|꿔바로우|깐풍|유린기|고로케|크로켓/, 'fried', 290, 12, 22, 17],
    [/불고기|제육|갈비|돼지|돈육|소고기|쇠고기|우육|닭|오리|햄|소시지|소세지|떡갈비|장조림|수육|보쌈|스테이크|미트볼|함박|주물럭|족발|삼겹|목살|베이컨|구이|바베큐|바비큐|편육|동파육/, 'protein', 230, 17, 8, 14],
    [/생선|고등어|삼치|꽁치|연어|갈치|명태|동태|코다리|오징어|낙지|새우|어묵|조기|가자미|참치|쭈꾸미|주꾸미|홍합|조개|굴|임연수|해물/, 'protein', 170, 15, 6, 9],
    [/계란|달걀|에그|두부|메추리알|콩자반|유부/, 'protein', 130, 9, 5, 8],
    [/맛살|게살|크래미|스팸|너비아니|닭가슴살|훈제오리/, 'protein', 110, 8, 8, 5],
    [/김치|깍두기|섞박지|석박지|겉절이|단무지|피클|장아찌|총각|열무|동치미|나박/, 'kimchi', 20, 1, 4, 0],
    [/케이크|케익|쿠키|머핀|와플|도넛|도너츠|아이스|젤리|푸딩|주스|쥬스|음료|에이드|스무디|초코|과자|약과|티라미수|마카롱|츄러스|꿀떡|파이|타르트|빙수|슈크림|카스텔라|브라우니|시리얼|식혜|수정과|유과|한과|라떼|요거트볼/, 'treat', 170, 3, 28, 6],
    [/우유|요구르트|요거트|요플레|치즈|두유/, 'dairy', 120, 6, 10, 6],
    [/과일|사과|배$|귤|오렌지|바나나|포도|수박|멜론|키위|파인애플|딸기|자두|복숭아|토마토|망고|참외|천혜향|한라봉|샤인|블루베리|체리|메론|머스캣|자몽|석류/, 'fruit', 60, 1, 15, 0],
    [/잡채|감자|고구마|옥수수|단호박|떡$|당면|묵$/, 'carbside', 150, 3, 26, 4],
    [/나물|무침|샐러드|쌈|숙주|시금치|브로콜리|양배추|오이|버섯|채소|야채|볶음|찜$|조림|콩나물|미역|다시마|가지|호박|생채|양상추|파프리카/, 'veg', 60, 2, 7, 3],
    [/소스|양념|쌈장|초장|고추장|케첩|드레싱|간장|와사비|머스타드|마요/, 'condiment', 25, 0, 4, 1]
  ];

  function estimateFood(name) {
    const rule = FOOD_RULES.find(([pattern]) => pattern.test(name));
    const [, role, kcal, protein, carbs, fat] = rule || [null, 'side', 120, 5, 12, 5];
    return { role, kcal, protein, carbs, fat };
  }

  function goalType(state) {
    const info = state.profile?.recommendationContext || {};
    if (info.goalType) return info.goalType;
    const text = `${info.goalStatement || ''} ${info.goal || ''}`;
    if (/감량|체지방|다이어트|빼|살/.test(text)) return '체지방 감량';
    if (/벌크|증량|근육\s*증가|근육량\s*(증가|늘)|근성장/.test(text)) return '근육 증가';
    return '체중 유지';
  }

  function lunchTarget(state) {
    const targets = state.profile?.targets || { kcal: 2200, protein: 150 };
    const share = +(state.lunch?.share || 0.35);
    return { kcal: Math.round((+targets.kcal || 2200) * share), protein: Math.round((+targets.protein || 150) * share), share };
  }

  const ROLE_NOTES = {
    staple: portion => portion < 1 ? '목표 칼로리에 맞춰 조금 덜' : portion > 1 ? '활동량을 채우려면 조금 더' : '평소 한 그릇',
    protein: portion => portion > 1 ? '단백질 채우기 · 더 받을 수 있으면' : '단백질 반찬은 꼭 챙기기',
    veg: portion => portion > 1 ? '배를 채우는 저칼로리 반찬 · 넉넉히' : '마음껏 먹어도 좋아요',
    kimchi: () => '나트륨이 많아 적당히',
    soup: portion => portion < 1 ? '국물은 빼고 건더기만 절반' : '건더기 위주, 국물은 반만',
    fried: portion => portion < 1 ? '기름져서 절반만' : '적당히',
    treat: portion => portion === 0 ? '오늘은 건너뛰기' : portion < 1 ? '절반만' : '가볍게',
    dairy: () => '단백질·칼슘 보충',
    fruit: () => '후식으로 좋아요',
    carbside: portion => portion < 1 ? '탄수화물이라 조금만' : '밥 양과 함께 조절',
    condiment: () => '조금만',
    side: () => ''
  };

  function localGuide(entry, state) {
    const target = lunchTarget(state);
    const goal = goalType(state);
    const cut = goal === '체지방 감량';
    let items = entry.items.map(name => ({ name, ...estimateFood(name) }));
    const baseSum = items.reduce((sum, item) => sum + item.kcal, 0);
    // 급식표에 열량이 적혀 있으면 음식별 추정치를 그 합계에 맞춘다.
    if (entry.kcal > 300 && baseSum > 0) {
      const scale = Math.min(1.6, Math.max(0.6, entry.kcal / baseSum));
      items = items.map(item => ({ ...item, kcal: Math.round(item.kcal * scale) }));
    }
    const proteinSum = items.reduce((sum, item) => sum + item.protein, 0);
    if (entry.protein > 5 && proteinSum > 0) {
      const scale = Math.min(2, Math.max(0.5, entry.protein / proteinSum));
      items = items.map(item => ({ ...item, protein: Math.round(item.protein * scale * 10) / 10 }));
    }
    items.forEach(item => { item.portion = { treat: cut ? 0.5 : 1, fried: cut ? 0.5 : 1, carbside: cut ? 0.5 : 1 }[item.role] ?? 1; });
    const staples = items.filter(item => item.role === 'staple');
    const total = key => items.reduce((sum, item) => sum + item[key] * item.portion, 0);
    const fitStaple = () => {
      const base = staples.reduce((sum, item) => sum + item.kcal, 0);
      if (!base) return;
      const others = items.filter(item => item.role !== 'staple').reduce((sum, item) => sum + item.kcal * item.portion, 0);
      const portion = Math.min(cut ? 1 : 1.5, Math.max(0.5, Math.round((target.kcal - others) / base * 4) / 4));
      staples.forEach(item => { item.portion = portion; });
    };
    fitStaple();
    if (total('protein') < target.protein * 0.8) {
      items.filter(item => item.role === 'protein').forEach(item => { item.portion = 1.5; });
      fitStaple();
    }
    if (cut && total('kcal') > target.kcal * 1.15) {
      items.filter(item => item.role === 'treat').forEach(item => { item.portion = 0; });
      fitStaple();
    }
    // 그래도 많으면 부대찌개·감자탕 같은 진한 찌개·탕을 건더기만 절반으로 줄인다.
    if (cut && total('kcal') > target.kcal * 1.1) {
      items.filter(item => item.role === 'soup' && item.kcal >= 250).forEach(item => { item.portion = 0.5; });
    }
    // 메뉴가 가벼우면 저칼로리 채소 반찬으로 포만감을 채운다(감량 중엔 밥은 그대로 둔다).
    if (total('kcal') < target.kcal * 0.85) {
      items.filter(item => item.role === 'veg').forEach(item => { item.portion = 1.5; });
      if (!cut) fitStaple();
    }
    const tips = [];
    const proteinGap = Math.round(target.protein - total('protein'));
    const kcalGap = Math.round(target.kcal - total('kcal'));
    if (proteinGap >= 10) tips.push(`단백질이 약 ${proteinGap}g 부족해요. 오후 간식으로 우유·계란·두부·닭가슴살을 더해 보세요.`);
    if (kcalGap > target.kcal * 0.15) tips.push(cut ? `메뉴가 가벼워 목표보다 약 ${kcalGap}kcal 적어요. 감량 중이라면 이대로 괜찮아요.` : `목표보다 약 ${kcalGap}kcal 적어요. 밥을 조금 더 받거나 간식으로 채워 보세요.`);
    else if (-kcalGap > target.kcal * 0.1) {
      // 실제 메뉴 중에서 줄일 만한 것을 골라 이름으로 안내한다.
      const reducible = items.filter(item => item.portion > 0 && (['fried', 'treat', 'carbside'].includes(item.role) || (item.role === 'soup' && item.kcal >= 250))).map(item => item.name);
      tips.push(`목표보다 약 ${-kcalGap}kcal 많아요. ${reducible.length ? `${reducible.slice(0, 2).join('·')} 양을 조금 더 줄여 보세요.` : '반찬을 조금씩 덜어 양을 맞춰 보세요.'}`);
    }
    return {
      source: 'local', goal, target, tips, meal: entry.meal, menuKcal: entry.kcal || null, createdAt: new Date().toISOString(),
      items: items.map(item => ({ name: item.name, role: item.role, portion: item.portion, kcal: item.kcal, protein: item.protein, carbs: item.carbs, fat: item.fat, note: ROLE_NOTES[item.role](item.portion) }))
    };
  }

  async function aiGuide(entry, state) {
    const target = lunchTarget(state);
    const goal = goalType(state);
    const prompt = `학교 급식 점심 메뉴를 보고 이 사용자가 먹을 양을 정한다. 메뉴: ${entry.items.join(', ')}.${entry.kcal ? ` 급식표 표기 열량 ${entry.kcal}kcal.` : ''} 점심 목표 약 ${target.kcal}kcal, 단백질 ${target.protein}g, 목표 ${goal}. 사용자 정보: ${ai.context(state)}. 메뉴마다 별도 항목으로 반환하고, 성인 급식 1인분 기준 영양값을 kcalPerServing·proteinPerServing·carbsPerServing·fatPerServing에 넣는다. servings에는 이 사용자의 권장 섭취량을 0.25 단위로(건너뛰면 0), referenceAmount에는 먹는 방법을 15자 이내로(예: 밥 2/3공기, 국물은 반만, 더 받기). 합계가 점심 목표에 가깝게 하되 단백질 반찬은 줄이지 않는다.`;
    const raw = await ai.analyze(prompt);
    const list = Array.isArray(raw?.items) ? raw.items : [];
    if (!list.length) throw new Error('AI 결과가 비어 있어요.');
    return {
      source: 'ai', goal, target, meal: entry.meal, menuKcal: entry.kcal || null, createdAt: new Date().toISOString(),
      items: list.filter(item => isMenuItem(String(item.name || ''))).map(item => ({
        name: String(item.name || '음식'), role: estimateFood(String(item.name || '')).role,
        portion: Math.min(2, Math.max(0, Math.round((+item.servings || 0) * 4) / 4)),
        kcal: Math.max(0, Math.round(+item.kcalPerServing || 0)), protein: Math.max(0, +item.proteinPerServing || 0),
        carbs: Math.max(0, +item.carbsPerServing || 0), fat: Math.max(0, +item.fatPerServing || 0), note: String(item.referenceAmount || '')
      }))
    };
  }

  // ---------------------------------------------------------------
  // 4. 오늘(또는 다음 급식일) 가이드 준비 · 저장
  // ---------------------------------------------------------------
  const lunchEntry = (state, date) => {
    const list = state.lunch?.days?.[date] || [];
    return list.find(item => item.meal === '중식') || list[0] || null;
  };
  const GUIDE_VERSION = 'v5';
  const signature = entry => entry ? `${GUIDE_VERSION}|${entry.items.join('|')}#${entry.kcal || ''}#${entry.protein || ''}` : '';

  function displayDate(state) {
    const now = new Date();
    const today = dateKey(now);
    if (now.getHours() < 15 && lunchEntry(state, today)) return today;
    // 점심이 지났거나 오늘 급식이 없으면(주말 등) 가장 가까운 다음 급식일을 미리 보여준다.
    for (let offset = 1; offset <= 4; offset++) {
      const date = new Date(now);
      date.setDate(now.getDate() + offset);
      if (lunchEntry(state, dateKey(date))) return dateKey(date);
    }
    return null;
  }

  function ensureGuide(date) {
    const state = readState();
    const entry = lunchEntry(state, date);
    if (!entry) return null;
    const saved = state.lunch?.guides?.[date];
    const target = lunchTarget(state);
    const targetChanged = saved && (saved.target?.kcal !== target.kcal || saved.target?.protein !== target.protein) && !saved.edited;
    if (saved && (saved.loggedAt || (saved.signature === signature(entry) && !targetChanged))) return saved;
    const guide = { ...localGuide(entry, state), signature: signature(entry) };
    state.lunch.guides ||= {};
    state.lunch.guides[date] = guide;
    // 2주 넘은 가이드는 정리한다.
    const cutoff = dateKey(new Date(Date.now() - 14 * 86400000));
    Object.keys(state.lunch.guides).forEach(key => { if (key < cutoff) delete state.lunch.guides[key]; });
    writeState(state);
    return guide;
  }

  async function upgradeWithAi(date, force = false) {
    if (!ai?.enabled() || aiBusyDate) return;
    const state = readState();
    const entry = lunchEntry(state, date);
    const saved = state.lunch?.guides?.[date];
    if (!entry || !saved) return;
    if (!force && (saved.source === 'ai' || saved.aiTriedAt || saved.edited || saved.loggedAt)) return;
    saved.aiTriedAt = new Date().toISOString();
    writeState(state);
    aiBusyDate = date;
    render();
    try {
      const guide = await aiGuide(entry, readState());
      const next = readState();
      next.lunch.guides[date] = { ...guide, signature: signature(entry), aiTriedAt: saved.aiTriedAt };
      writeState(next);
      if (force) showToast('AI가 급식 양을 다시 계산했어요.');
    } catch (error) {
      if (force) showToast(error.message || 'AI 계산에 실패해 기본 추정을 보여드려요.');
    } finally {
      aiBusyDate = null;
      render();
    }
  }

  // ---------------------------------------------------------------
  // 5. 화면: 홈 카드(오늘 점심 가이드) + 식단 탭 카드(급식표 관리)
  // ---------------------------------------------------------------
  const PORTION_LABELS = { 0: '건너뛰기', 0.25: '1/4', 0.5: '절반', 0.75: '3/4', 1: '1인분', 1.25: '1인분+', 1.5: '1.5인분', 1.75: '1.75인분', 2: '2인분' };
  const portionText = (portion, role, name) => {
    if (role === 'staple' && /밥$/.test(name) && portion > 0) return { 0.25: '1/4공기', 0.5: '반 공기', 0.75: '3/4공기', 1: '1공기', 1.25: '1공기+', 1.5: '1.5공기' }[portion] || `${portion}공기`;
    return PORTION_LABELS[portion] ?? `${portion}인분`;
  };
  const prettyDate = date => { const value = new Date(`${date}T12:00:00`); return `${value.getMonth() + 1}/${value.getDate()}(${WEEKDAYS[value.getDay()]})`; };
  const sumOf = (items, key) => Math.round(items.reduce((sum, item) => sum + item[key] * item.portion, 0));

  function headline(guide) {
    const staple = guide.items.find(item => item.role === 'staple');
    const protein = guide.items.find(item => item.role === 'protein' && item.portion >= 1);
    const parts = [];
    if (staple) parts.push(`${staple.name} ${portionText(staple.portion, staple.role, staple.name)}`);
    if (protein) parts.push(`${protein.name}${protein.portion > 1 ? ' 넉넉히' : ' 꼭 챙기기'}`);
    return parts.join(', ') || '골고루 적당히';
  }

  function renderHomeCard() {
    const home = $('[data-view="home"] .content');
    if (!home) return;
    let card = $('#lunchGuide');
    const state = readState();
    const hasMenu = Object.keys(state.lunch?.days || {}).length > 0;
    // 급식표를 아직 안 올렸으면 홈에서 바로 찾을 수 있게 안내 카드를 보여준다. "안 먹어요"로 닫으면 다시 안 뜬다.
    if (!hasMenu) {
      if (state.lunchPromptHidden) { card?.remove(); return; }
      if (!card) {
        card = document.createElement('section');
        card.id = 'lunchGuide';
        ($('#checkin') || $('.welcome'))?.insertAdjacentElement('afterend', card);
      }
      card.className = 'card lunch-card lunch-prompt';
      delete card.dataset.date;
      card.innerHTML = `<div class="lunch-head"><div><span class="lunch-eyebrow">🍱 급식 먹는다면</span><strong>급식표를 올리면 매일 점심 먹을 양을 알려드려요</strong><small>엑셀·CSV 급식표를 올리면 목표 칼로리에 맞춰 밥·반찬 양을 계산해요.</small></div></div>
        <div class="lunch-actions"><button type="button" class="primary mint" data-go="meals" data-open="lunchManager">급식표 올리기</button><button type="button" class="link" data-lunch-dismiss>급식 안 먹어요</button></div>`;
      return;
    }
    const date = displayDate(state);
    if (!date) { card?.remove(); return; }
    if (!card) {
      card = document.createElement('section');
      card.id = 'lunchGuide';
      card.className = 'card lunch-card';
      ($('#checkin') || $('.welcome'))?.insertAdjacentElement('afterend', card);
    }
    card.className = 'card lunch-card';
    const guide = ensureGuide(date);
    if (!guide) { card.remove(); return; }
    guide.items = guide.items.filter(item => isMenuItem(item.name));
    const today = dateKey(new Date());
    const label = date === today ? '오늘 점심 급식' : `${prettyDate(date)} 점심 급식`;
    const kcal = sumOf(guide.items, 'kcal');
    const protein = sumOf(guide.items, 'protein');
    const ratio = Math.min(130, Math.round(kcal / Math.max(1, guide.target.kcal) * 100));
    const busy = aiBusyDate === date;
    card.dataset.date = date;
    card.innerHTML = `
      <div class="lunch-head"><div><span class="lunch-eyebrow">🍱 ${label} · ${date === today ? prettyDate(date) : '미리 보기'}</span><strong>${esc(headline(guide))}</strong></div><i class="badge ${guide.source === 'ai' ? 'up' : ''}">${busy ? 'AI 계산 중…' : guide.source === 'ai' ? 'AI 추천' : guide.edited ? '직접 조절' : '기본 추정'}</i></div>
      <p class="lunch-target">점심 목표 약 ${guide.target.kcal.toLocaleString()}kcal · 단백질 ${guide.target.protein}g <em>${esc(guide.goal)}</em></p>
      <ul class="lunch-items">${guide.items.map((item, index) => `<li class="${item.portion === 0 ? 'skip' : ''}"><div><b>${esc(item.name)}</b>${item.note ? `<small>${esc(item.note)}</small>` : ''}</div><div class="lunch-portion"><button type="button" data-lunch-step="-1" data-index="${index}" aria-label="${esc(item.name)} 줄이기">−</button><span>${portionText(item.portion, item.role, item.name)}</span><button type="button" data-lunch-step="1" data-index="${index}" aria-label="${esc(item.name)} 늘리기">＋</button></div></li>`).join('')}</ul>
      ${(guide.tips || []).length ? `<ul class="lunch-tips">${guide.tips.map(tip => `<li>💡 ${esc(tip)}</li>`).join('')}</ul>` : ''}
      <div class="lunch-total"><div><span>이대로 먹으면</span><b>약 ${kcal.toLocaleString()}kcal · 단백질 ${protein}g</b></div><div class="lunch-bar"><i style="width:${Math.min(100, ratio)}%" class="${ratio > 110 ? 'over' : ''}"></i></div></div>
      <div class="lunch-actions">${date === today ? (guide.loggedAt ? '<button type="button" class="ghost" disabled>점심 기록됨 ✓</button>' : '<button type="button" class="primary mint" data-lunch-log>이대로 먹었어요</button>') : ''}${ai?.enabled() ? `<button type="button" class="ghost" data-lunch-ai ${busy ? 'disabled' : ''}>${guide.source === 'ai' ? 'AI로 다시 계산' : 'AI로 정확하게'}</button>` : ''}<button type="button" class="link" data-go="meals">급식표</button></div>
      <small class="lunch-note">${guide.menuKcal ? `급식표 표기 ${guide.menuKcal}kcal 기준 · ` : ''}급식 1인분 기준 추정치예요. 실제 배식량에 따라 달라요.</small>`;
    // AI가 연결돼 있으면 날짜마다 한 번만 자동으로 더 정확하게 계산한다(직접 조절했거나 이미 기록했으면 건드리지 않음).
    if (ai?.enabled() && guide.source !== 'ai' && !guide.aiTriedAt && !guide.edited && !guide.loggedAt && !busy) setTimeout(() => upgradeWithAi(date), 0);
  }

  function renderManager(message = '') {
    const photo = $('[data-view="meals"] .photo');
    if (!photo) return;
    let card = $('#lunchManager');
    if (!card) {
      card = document.createElement('section');
      card.id = 'lunchManager';
      card.className = 'card lunch-manager';
      photo.insertAdjacentElement('afterend', card);
    }
    const state = readState();
    const dates = Object.keys(state.lunch?.days || {}).sort();
    const today = dateKey(new Date());
    const upcoming = dates.filter(date => date >= today).slice(0, 3);
    const share = +(state.lunch?.share || 0.35);
    card.innerHTML = `
      <div class="lunch-head"><div><strong>🏫 급식표</strong><small>엑셀(.xlsx)이나 CSV를 올리면 매일 아침 홈 화면에 점심 가이드가 떠요. 파일은 이 기기 안에서만 읽어요.</small></div></div>
      ${dates.length ? `<p class="lunch-status">${dates.length}일치 등록 · ${prettyDate(dates[0])}~${prettyDate(dates.at(-1))}${state.lunch.fileName ? ` · ${esc(state.lunch.fileName)}` : ''}</p>
        ${upcoming.length ? `<ul class="lunch-preview">${upcoming.map(date => `<li><b>${prettyDate(date)}</b><span>${esc(lunchEntry(state, date).items.join(' · '))}</span></li>`).join('')}</ul>` : '<p class="lunch-status">앞으로 남은 급식 일정이 없어요. 다음 달 급식표를 올려주세요.</p>'}` : ''}
      ${message ? `<p class="lunch-message">${message}</p>` : ''}
      <label class="primary mint full lunch-upload">${dates.length ? '급식표 추가·교체' : '급식표 올리기'}<input type="file" id="lunchFile" accept=".xlsx,.csv,.xls,.htm,.html,text/csv"></label>
      <label class="field lunch-share"><span>하루 중 점심 비중</span><select class="select" id="lunchShare">${[[0.3, '30% (아침을 든든히 먹을 때)'], [0.35, '35% (보통)'], [0.4, '40% (점심을 가장 많이 먹을 때)']].map(([value, text]) => `<option value="${value}" ${Math.abs(share - value) < 0.001 ? 'selected' : ''}>${text}</option>`).join('')}</select></label>
      ${dates.length ? '<button type="button" class="link danger" data-lunch-clear>급식표 지우기</button>' : '<p class="lunch-help">나이스(NEIS)에서 받은 식단 파일이나, 날짜 칸마다 메뉴가 적힌 달력형 식단표 모두 읽을 수 있어요.</p>'}`;
  }

  function render() {
    renderHomeCard();
    renderManager();
  }

  async function handleFile(file) {
    if (!file) return;
    renderManager('급식표를 읽는 중…');
    try {
      const days = await parseMenuFile(file);
      const count = Object.keys(days).length;
      if (!count) throw new Error('메뉴를 찾지 못했어요. 날짜 칸과 메뉴 칸이 있는 표인지 확인해 주세요. 계속 안 되면 CSV로 저장해 올려보세요.');
      const state = readState();
      state.lunch ||= {};
      state.lunch.days = { ...(state.lunch.days || {}), ...days };
      state.lunch.fileName = file.name;
      state.lunch.uploadedAt = new Date().toISOString();
      writeState(state);
      const dates = Object.keys(days).sort();
      renderManager(`✓ ${count}일치 급식을 읽었어요 (${prettyDate(dates[0])}~${prettyDate(dates.at(-1))}).`);
      renderHomeCard();
      showToast(`급식 ${count}일치를 등록했어요.`);
    } catch (error) {
      renderManager(`⚠️ ${esc(error.message || '파일을 읽지 못했어요.')}`);
    }
  }

  function cleanSavedMenus() {
    const state = readState();
    let changed = false;
    Object.entries(state.lunch?.days || {}).forEach(([date, list]) => {
      const kept = list.map(entry => {
        const items = entry.items.filter(isMenuItem);
        if (items.length !== entry.items.length) changed = true;
        return { ...entry, items };
      }).filter(entry => entry.items.length);
      if (kept.length) state.lunch.days[date] = kept; else { delete state.lunch.days[date]; changed = true; }
    });
    Object.values(state.lunch?.guides || {}).forEach(guide => {
      const items = (guide.items || []).filter(item => isMenuItem(item.name));
      if (items.length !== (guide.items || []).length) { guide.items = items; changed = true; }
    });
    if (changed) writeState(state);
  }

  function install() {
    if (document.body.dataset.lunchInstalled) return;
    document.body.dataset.lunchInstalled = 'true';
    cleanSavedMenus();
    const style = document.createElement('style');
    style.textContent = `
      .lunch-card{margin-top:9px;padding:14px;background:linear-gradient(150deg,#fffaf0,#fff 60%)}.lunch-head{display:flex;justify-content:space-between;align-items:start;gap:8px}.lunch-head strong{display:block;margin-top:3px;font-size:16px;line-height:1.35}.lunch-head small{display:block;margin-top:4px;color:var(--sub);font-size:12px;line-height:1.5}.lunch-eyebrow{color:#b0701e;font-size:11px;font-weight:900}
      .lunch-target{margin:8px 0 4px;color:var(--sub);font-size:12px}.lunch-target em{margin-left:4px;padding:2px 7px;border-radius:99px;background:#f1f6f4;font-style:normal;font-weight:800}
      .lunch-items{margin:6px 0 0;padding:0;list-style:none}.lunch-items li{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px dashed #ece3d2}.lunch-items li.skip b{color:#a3b3ad;text-decoration:line-through}.lunch-items b{display:block;font-size:14px}.lunch-items small{display:block;margin-top:2px;color:#8b6a3e;font-size:11px}
      .lunch-portion{display:flex;align-items:center;gap:4px;flex:none}.lunch-portion span{min-width:58px;text-align:center;font-size:13px;font-weight:900}.lunch-portion button{width:30px;height:30px;border:1px solid var(--line);border-radius:10px;background:#fff;font-size:16px;font-weight:900}
      .lunch-tips{margin:8px 0 0;padding:9px 11px;border-radius:12px;background:#fff7e6;list-style:none;font-size:12px;line-height:1.55;color:#7a5a2a}.lunch-tips li+li{margin-top:4px}
      .lunch-total{margin-top:8px;padding:10px 12px;border-radius:13px;background:#f7faf8}.lunch-total span{display:block;color:var(--sub);font-size:11px}.lunch-total b{font-size:14px}.lunch-bar{height:7px;margin-top:6px;border-radius:99px;background:#e6efeb;overflow:hidden}.lunch-bar i{display:block;height:100%;border-radius:inherit;background:var(--mint)}.lunch-bar i.over{background:#ff9e82}
      .lunch-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.lunch-actions .primary{min-height:42px}.lunch-actions .ghost{min-height:42px}.lunch-note{display:block;margin-top:8px;color:var(--sub);font-size:11px}
      .lunch-manager{margin:10px 0;padding:14px}.lunch-status{margin:10px 0 6px;font-size:13px;font-weight:800}.lunch-preview{margin:0 0 10px;padding:0;list-style:none}.lunch-preview li{padding:7px 0;border-top:1px dashed var(--line);font-size:12px;line-height:1.5}.lunch-preview b{margin-right:6px}.lunch-preview span{color:var(--sub)}
      .lunch-message{margin:8px 0;padding:9px 11px;border-radius:12px;background:#fff7e6;font-size:13px;line-height:1.5}.lunch-upload{display:flex;align-items:center;justify-content:center;margin-top:8px;cursor:pointer}.lunch-upload input{display:none}.lunch-share{margin:12px 0 4px}.lunch-help{margin:8px 0 0;color:var(--sub);font-size:12px;line-height:1.5}
    `;
    document.head.appendChild(style);

    document.addEventListener('change', event => {
      if (event.target.id === 'lunchFile') { handleFile(event.target.files?.[0]); event.target.value = ''; }
      if (event.target.id === 'lunchShare') {
        const state = readState();
        state.lunch ||= {};
        state.lunch.share = +event.target.value;
        writeState(state);
        render();
      }
    });
    document.addEventListener('click', event => {
      const step = event.target.closest('[data-lunch-step]');
      if (step) {
        const date = $('#lunchGuide')?.dataset.date;
        const state = readState();
        const guide = state.lunch?.guides?.[date];
        const item = guide?.items[+step.dataset.index];
        if (!item) return;
        item.portion = Math.min(2, Math.max(0, item.portion + 0.25 * +step.dataset.lunchStep));
        guide.edited = true;
        writeState(state);
        renderHomeCard();
        return;
      }
      if (event.target.closest('[data-lunch-log]')) {
        const date = $('#lunchGuide')?.dataset.date;
        const state = readState();
        const guide = state.lunch?.guides?.[date];
        if (!guide || date !== dateKey(new Date())) return;
        state.logs ||= {};
        state.logs[date] ||= { meals: [], workouts: [] };
        state.logs[date].meals ||= [];
        guide.items.filter(item => item.portion > 0).forEach(item => state.logs[date].meals.push({
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, meal: '점심', name: item.name,
          amount: `급식 ${portionText(item.portion, item.role, item.name)}`, servings: item.portion,
          kcal: Math.round(item.kcal * item.portion), protein: Math.round(item.protein * item.portion * 10) / 10,
          carbs: Math.round(item.carbs * item.portion * 10) / 10, fat: Math.round(item.fat * item.portion * 10) / 10, src: 'lunch'
        }));
        guide.loggedAt = new Date().toISOString();
        writeState(state);
        window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
        renderHomeCard();
        showToast('급식 점심을 식단에 기록했어요.');
        return;
      }
      if (event.target.closest('[data-lunch-ai]')) {
        const date = $('#lunchGuide')?.dataset.date;
        if (date) upgradeWithAi(date, true);
        return;
      }
      if (event.target.closest('[data-lunch-dismiss]')) {
        const state = readState();
        state.lunchPromptHidden = true;
        writeState(state);
        renderHomeCard();
        showToast('안내를 닫았어요. 나중에 식단 화면에서 급식표를 올릴 수 있어요.');
        return;
      }
      if (event.target.closest('[data-lunch-clear]')) {
        if (!confirm('등록한 급식표를 모두 지울까요? 이미 기록한 식단은 그대로 남아요.')) return;
        const state = readState();
        delete state.lunch;
        writeState(state);
        render();
        showToast('급식표를 지웠어요.');
      }
    });

    // 매일 처음 열 때(또는 다시 볼 때) 오늘 가이드를 만들고, AI가 연결돼 있으면 한 번 더 정확하게 계산한다.
    const refresh = () => {
      render();
      const date = $('#lunchGuide')?.dataset.date;
      if (date) upgradeWithAi(date);
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('hashchange', () => { if (['#home', '#meals'].includes(location.hash)) render(); });
    window.addEventListener('fitlog:state-updated', () => { if (!$('#lunchGuide')?.contains(document.activeElement)) renderHomeCard(); });
    refresh();
  }

  install();
  window.FitLogLunch = { parseMenuFile, localGuide, estimateFood };
})();
