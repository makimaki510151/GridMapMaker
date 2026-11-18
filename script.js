'use strict';

(() => {
  // ============================================================
  // 定数・状態
  // ============================================================
  const BLANK = '\u3000';          // 全角スペース = 空白マス（消しゴム）
  const MAX_SIZE = 100;
  const STORE_KEY = 'gridMapMaker.v2';
  const HISTORY_LIMIT = 100;
  const FONT = '"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Meiryo",sans-serif';
  const CANDIDATES = Array.from(
    'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ' +
    '●■▲◆★♪＃＄％＆' +
    'あいうえおかきくけこ'
  );

  const state = {
    w: 20,
    h: 12,
    grid: [],            // grid[y][x] = 全角1文字
    legend: [],          // {id, ch, name, color}
    blankName: '空白',   // 空白マス（全角スペース）の名前
    current: '',         // 選択中のタイル文字
    tool: 'pen',
    cell: 32,
    showGrid: true,
    outline: false,
    sel: null,           // 選択範囲 {x0, y0, x1, y1}（正規化済み）
    clip: null,          // コピー／切り取りした範囲（二次元配列）
    paste: false,        // 貼り付け先選択モード
    hover: null,         // マウス位置のマス
  };
  let nextId = 1;
  let stroke = null;     // 描画中の情報
  let selDrag = null;    // 範囲選択のドラッグ中情報
  let undoStack = [];
  let redoStack = [];
  let lastTextPush = 0;
  let saveTimer = null;
  let toastTimer = null;
  let composingMap = false;

  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#map');
  const ctx = canvas.getContext('2d');
  const cursorEl = $('#cursor');
  const legendList = $('#legendList');
  const paletteEl = $('#palette');
  const mapText = $('#mapText');
  const legendText = $('#legendText');
  const statusEl = $('#status');
  const unregEl = $('#unreg');

  // ============================================================
  // ユーティリティ
  // ============================================================

  /** 半角 → 全角（英数記号・スペース・半角カナ） */
  function toFullWidth(s) {
    return String(s)
      .replace(/[\uFF61-\uFF9F]+/g, (m) => m.normalize('NFKC'))
      .replace(/\t/g, BLANK)
      .replace(/ /g, BLANK)
      .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  }

  /** 全角化したうえで最初の1文字を返す（空白のみなら空文字） */
  function firstChar(s) {
    const t = Array.from(toFullWidth(s)).filter((c) => c !== BLANK && !/\s/.test(c));
    return t[0] || '';
  }

  const makeGrid = (w, h, fill = BLANK) =>
    Array.from({ length: h }, () => Array.from({ length: w }, () => fill));
  const cloneGrid = (g) => g.map((r) => r.slice());
  const snapshot = () => state.grid.map((r) => r.join(''));
  const gridFromLines = (lines) => lines.map((l) => Array.from(l));
  const gridToText = () => snapshot().join('\n');

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
  }
  const randomColor = () => hslToHex(Math.floor(Math.random() * 360), 55, 72);

  function contrast(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1c1c1c' : '#ffffff';
  }

  const legendMap = () => new Map(state.legend.map((e) => [e.ch, e]));
  const findLegend = (ch) => state.legend.find((e) => e.ch === ch);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function download(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}をコピーしました`);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(`${label}をコピーしました`);
    }
  }

  // ============================================================
  // 描画（canvas）
  // ============================================================
  function setCanvasSize() {
    const s = state.cell;
    const dpr = window.devicePixelRatio || 1;
    const cw = state.w * s, ch = state.h * s;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    cursorEl.style.width = s + 'px';
    cursorEl.style.height = s + 'px';
  }

  function drawCell(c, x, y, s, lmap, showGrid) {
    drawTile(c, x, y, s, state.grid[y][x], lmap, showGrid);
  }

  function drawTile(c, x, y, s, ch, lmap, showGrid) {
    const e = lmap.get(ch);
    const isBlank = ch === BLANK;
    const bg = isBlank ? '#ffffff' : e ? e.color : '#ffe3e3';
    c.fillStyle = bg;
    c.fillRect(x * s, y * s, s, s);

    if (!isBlank) {
      c.fillStyle = e ? contrast(e.color) : '#c00000';
      c.fillText(ch, x * s + s / 2, y * s + s / 2 + s * 0.04);
    }
    if (showGrid) {
      c.fillStyle = 'rgba(0,0,0,0.16)';
      c.fillRect(x * s + s - 1, y * s, 1, s);
      c.fillRect(x * s, y * s + s - 1, s, 1);
    }
  }

  function prepareCtx(c, s, dpr) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.font = `${Math.floor(s * 0.76)}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
  }

  function drawSelectionOverlay(c, s) {
    const { x0, y0, x1, y1 } = state.sel;
    const w = (x1 - x0 + 1) * s, h = (y1 - y0 + 1) * s;
    c.save();
    c.fillStyle = 'rgba(59,109,240,0.15)';
    c.fillRect(x0 * s, y0 * s, w, h);
    c.strokeStyle = '#3b6df0';
    c.lineWidth = 2;
    c.setLineDash([5, 3]);
    c.strokeRect(x0 * s + 1, y0 * s + 1, w - 2, h - 2);
    c.restore();
  }

  function drawPastePreview(c, s, lmap) {
    if (!state.paste || !state.clip || !state.hover) return;
    const clip = state.clip;
    const ox = state.hover.x, oy = state.hover.y;
    const cw = clip[0].length, ch = clip.length;
    c.save();
    c.globalAlpha = 0.6;
    for (let dy = 0; dy < ch; dy++) {
      for (let dx = 0; dx < cw; dx++) {
        const x = ox + dx, y = oy + dy;
        if (x >= state.w || y >= state.h) continue;
        drawTile(c, x, y, s, clip[dy][dx], lmap, state.showGrid);
      }
    }
    c.globalAlpha = 1;
    c.strokeStyle = '#3b6df0';
    c.lineWidth = 2;
    c.setLineDash([]);
    c.strokeRect(ox * s + 1, oy * s + 1, cw * s - 2, ch * s - 2);
    c.restore();
  }

  function updateEditButtons() {
    $('#btnCut').disabled = !state.sel;
    $('#btnCopy').disabled = !state.sel;
    $('#btnPaste').disabled = !state.clip;
  }

  function render() {
    setCanvasSize();
    const s = state.cell;
    const dpr = window.devicePixelRatio || 1;
    prepareCtx(ctx, s, dpr);
    if (state.sel && (state.sel.x1 >= state.w || state.sel.y1 >= state.h)) state.sel = null;
    const lmap = legendMap();
    for (let y = 0; y < state.h; y++) {
      for (let x = 0; x < state.w; x++) drawCell(ctx, x, y, s, lmap, state.showGrid);
    }
    if (state.sel) drawSelectionOverlay(ctx, s);
    drawPastePreview(ctx, s, lmap);
    updateEditButtons();
  }

  function renderOneCell(x, y) {
    const s = state.cell;
    prepareCtx(ctx, s, window.devicePixelRatio || 1);
    drawCell(ctx, x, y, s, legendMap(), state.showGrid);
  }

  // ============================================================
  // 履歴
  // ============================================================
  function updateHistoryButtons() {
    $('#btnUndo').disabled = undoStack.length === 0;
    $('#btnRedo').disabled = redoStack.length === 0;
  }

  function pushUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function restore(lines) {
    state.grid = gridFromLines(lines);
    state.h = state.grid.length;
    state.w = state.grid[0].length;
    refreshAll();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    updateHistoryButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    updateHistoryButtons();
  }

  // ============================================================
  // グリッド操作
  // ============================================================
  function setCell(x, y, ch) {
    if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;
    if (state.grid[y][x] === ch) return;
    state.grid[y][x] = ch;
    renderOneCell(x, y);
  }

  function bresenham(a, b, put) {
    let x0 = a.x, y0 = a.y;
    const x1 = b.x, y1 = b.y;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      put(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function floodFill(sx, sy, ch) {
    const target = state.grid[sy][sx];
    if (target === ch) return;
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
      if (state.grid[y][x] !== target) continue;
      state.grid[y][x] = ch;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  function previewShape(c) {
    state.grid = cloneGrid(stroke.base);
    const put = (x, y) => {
      if (x >= 0 && y >= 0 && x < state.w && y < state.h) state.grid[y][x] = stroke.ch;
    };
    const a = stroke.start;
    if (stroke.tool === 'line') {
      bresenham(a, c, put);
    } else if (stroke.tool === 'rect') {
      const x0 = Math.min(a.x, c.x), x1 = Math.max(a.x, c.x);
      const y0 = Math.min(a.y, c.y), y1 = Math.max(a.y, c.y);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!state.outline || x === x0 || x === x1 || y === y0 || y === y1) put(x, y);
        }
      }
    }
    render();
  }

  function resizeGrid(w, h) {
    w = Math.max(1, Math.min(MAX_SIZE, w | 0));
    h = Math.max(1, Math.min(MAX_SIZE, h | 0));
    const g = makeGrid(w, h);
    for (let y = 0; y < Math.min(h, state.h); y++) {
      for (let x = 0; x < Math.min(w, state.w); x++) g[y][x] = state.grid[y][x];
    }
    state.grid = g;
    state.w = w;
    state.h = h;
  }

  // ============================================================
  // 範囲選択・コピー・切り取り・貼り付け
  // ============================================================
  function setSelection(a, b) {
    state.sel = {
      x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
    };
    render();
  }

  function clearSelection() {
    if (!state.sel) return;
    state.sel = null;
    render();
  }

  function copySelection() {
    if (!state.sel) {
      toast('先に範囲を選択してください（選択ツールでドラッグ）');
      return false;
    }
    const { x0, y0, x1, y1 } = state.sel;
    state.clip = state.grid.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1));
    render();
    copyText(state.clip.map((r) => r.join('')).join('\n'), '選択範囲');
    return true;
  }

  function cutSelection() {
    if (!copySelection()) return;
    const { x0, y0, x1, y1 } = state.sel;
    pushUndo(snapshot());
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) state.grid[y][x] = BLANK;
    }
    render();
    syncMapText();
    updateCounts();
    scheduleSave();
  }

  function startPaste() {
    if (!state.clip) {
      toast('コピーまたは切り取りした範囲がありません');
      return;
    }
    if (state.tool !== 'select') setTool('select');
    state.sel = null;
    state.paste = true;
    render();
    toast('貼り付け先をクリック（Esc／右クリックでキャンセル）');
  }

  function cancelPaste() {
    if (!state.paste) return;
    state.paste = false;
    render();
  }

  function commitPaste(c) {
    const clip = state.clip;
    const before = snapshot();
    for (let dy = 0; dy < clip.length; dy++) {
      for (let dx = 0; dx < clip[0].length; dx++) {
        const x = c.x + dx, y = c.y + dy;
        if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
        state.grid[y][x] = clip[dy][dx];
      }
    }
    state.paste = false;
    if (before.join('\n') !== gridToText()) pushUndo(before);
    render();
    syncMapText();
    updateCounts();
    scheduleSave();
  }

  // ============================================================
  // ポインタ操作
  // ============================================================
  function cellFromEvent(e, clamp) {
    const rect = canvas.getBoundingClientRect();
    let x = Math.floor((e.clientX - rect.left) / state.cell);
    let y = Math.floor((e.clientY - rect.top) / state.cell);
    if (clamp) {
      x = Math.max(0, Math.min(state.w - 1, x));
      y = Math.max(0, Math.min(state.h - 1, y));
    } else if (x < 0 || y < 0 || x >= state.w || y >= state.h) {
      return null;
    }
    return { x, y };
  }

  function pickTile(c) {
    const ch = state.grid[c.y][c.x];
    if (ch === BLANK) {
      setTool('eraser');
    } else if (findLegend(ch)) {
      selectTile(ch);
    } else {
      toast(`「${ch}」は凡例に登録されていません`);
    }
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const c = cellFromEvent(e, false);
    if (!c) return;
    e.preventDefault();

    // 貼り付け先の確定（右クリックでキャンセル）
    if (state.paste) {
      if (e.button === 0) commitPaste(c);
      else cancelPaste();
      return;
    }

    // 範囲選択（ドラッグで範囲を指定）
    if (state.tool === 'select' && e.button === 0) {
      canvas.setPointerCapture(e.pointerId);
      selDrag = { start: c };
      setSelection(c, c);
      return;
    }

    let tool = state.tool;
    let ch = state.current;
    if (e.button === 2) {
      tool = 'pen';
      ch = BLANK;
    } else if (tool === 'picker') {
      pickTile(c);
      return;
    } else if (tool === 'eraser') {
      tool = 'pen';
      ch = BLANK;
    } else if (!ch) {
      toast('先に凡例へタイルを登録・選択してください');
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    stroke = { tool, ch, start: c, last: c, before: snapshot(), base: cloneGrid(state.grid) };

    if (tool === 'fill') {
      floodFill(c.x, c.y, ch);
      render();
    } else if (tool === 'pen') {
      setCell(c.x, c.y, ch);
    } else {
      previewShape(c);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const hover = cellFromEvent(e, false);
    updateHover(hover);
    if (selDrag) {
      setSelection(selDrag.start, cellFromEvent(e, true));
      return;
    }
    if (!stroke) return;
    const c = cellFromEvent(e, true);
    if (c.x === stroke.last.x && c.y === stroke.last.y) return;
    if (stroke.tool === 'pen') {
      bresenham(stroke.last, c, (x, y) => setCell(x, y, stroke.ch));
    } else if (stroke.tool === 'line' || stroke.tool === 'rect') {
      previewShape(c);
    }
    stroke.last = c;
  });

  function endStroke() {
    if (selDrag) {
      selDrag = null;
      return;
    }
    if (!stroke) return;
    const before = stroke.before;
    stroke = null;
    if (before.join('\n') !== gridToText()) pushUndo(before);
    syncMapText();
    updateCounts();
    scheduleSave();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => updateHover(null));

  function updateHover(c) {
    const prev = state.hover;
    state.hover = c;
    if (state.paste && (prev?.x !== c?.x || prev?.y !== c?.y)) render(); // 貼り付けプレビュー更新
    if (!c) {
      cursorEl.hidden = true;
      statusEl.textContent = `${state.w} × ${state.h} マス`;
      return;
    }
    cursorEl.hidden = false;
    cursorEl.style.left = c.x * state.cell + 'px';
    cursorEl.style.top = c.y * state.cell + 'px';
    const ch = state.grid[c.y][c.x];
    const e = findLegend(ch);
    const label = ch === BLANK ? state.blankName : e ? `${ch}　${e.name}` : `${ch}　（凡例になし）`;
    statusEl.textContent = `(${c.x + 1}, ${c.y + 1})　${label}　／　${state.w} × ${state.h} マス`;
  }

  // ============================================================
  // ツール・タイル選択
  // ============================================================
  function setTool(t) {
    if (t !== 'select') {
      state.paste = false;
      state.sel = null;
    }
    state.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    renderPalette();
    updateLegendActive();
    render();
    scheduleSave();
  }

  function selectTile(ch) {
    state.current = ch;
    if (['eraser', 'picker', 'select'].includes(state.tool)) state.tool = 'pen';
    state.paste = false;
    state.sel = null;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
    renderPalette();
    updateLegendActive();
    render();
    scheduleSave();
  }

  document.querySelectorAll('.tool').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool))
  );

  // ============================================================
  // パレット／凡例UI
  // ============================================================
  function renderPalette() {
    paletteEl.innerHTML = '';
    state.legend.forEach((e, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (e.ch === state.current && state.tool !== 'eraser' ? ' active' : '');
      b.textContent = e.ch;
      b.style.background = e.color;
      b.style.color = contrast(e.color);
      b.title = `${e.name}${i < 9 ? `（キー ${i + 1}）` : ''}`;
      if (i < 9) {
        const k = document.createElement('span');
        k.className = 'key';
        k.textContent = i + 1;
        b.appendChild(k);
      }
      b.addEventListener('click', () => selectTile(e.ch));
      paletteEl.appendChild(b);
    });

    // 空白（消しゴム）チップ
    const blank = document.createElement('button');
    blank.type = 'button';
    blank.className = 'chip blank' + (state.tool === 'eraser' ? ' active' : '');
    blank.textContent = '空';
    blank.title = `${state.blankName}（消しゴム・キーE）`;
    blank.addEventListener('click', () => setTool('eraser'));
    paletteEl.appendChild(blank);
  }

  function updateLegendActive() {
    legendList.querySelectorAll('.legend-row').forEach((row) => {
      if (row.dataset.id === 'blank') {
        row.classList.toggle('active', state.tool === 'eraser');
        return;
      }
      const e = state.legend.find((x) => x.id === Number(row.dataset.id));
      row.classList.toggle('active', !!e && e.ch === state.current && state.tool !== 'eraser');
    });
  }

  function styleChInput(input, color) {
    input.style.background = color;
    input.style.color = contrast(color);
  }

  function renderLegend() {
    legendList.innerHTML = '';
    state.legend.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.dataset.id = e.id;

      const main = document.createElement('div');
      main.className = 'legend-main';

      const chIn = document.createElement('input');
      chIn.type = 'text';
      chIn.className = 'ch-input';
      chIn.value = e.ch;
      chIn.title = '全角1文字（タイルとして使う文字）';
      styleChInput(chIn, e.color);

      const nameIn = document.createElement('input');
      nameIn.type = 'text';
      nameIn.className = 'name-input';
      nameIn.value = e.name;
      nameIn.placeholder = '意味（例：草原）';

      const colorIn = document.createElement('input');
      colorIn.type = 'color';
      colorIn.className = 'color-input';
      colorIn.value = e.color;
      colorIn.title = 'タイルの背景色';

      main.append(chIn, nameIn, colorIn);

      const sub = document.createElement('div');
      sub.className = 'legend-sub';
      const count = document.createElement('span');
      count.className = 'count';
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const up = document.createElement('button');
      up.type = 'button'; up.className = 'btn small'; up.textContent = '↑'; up.title = '上へ';
      const down = document.createElement('button');
      down.type = 'button'; down.className = 'btn small'; down.textContent = '↓'; down.title = '下へ';
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'btn small danger'; del.textContent = '削除';
      up.disabled = i === 0;
      down.disabled = i === state.legend.length - 1;
      actions.append(up, down, del);
      sub.append(count, actions);

      row.append(main, sub);
      legendList.appendChild(row);

      // --- イベント ---
      row.addEventListener('focusin', () => {
        if (state.current !== e.ch || state.tool === 'eraser' || state.tool === 'picker') selectTile(e.ch);
      });
      row.addEventListener('pointerdown', (ev) => {
        if (ev.target === row || ev.target === main || ev.target === sub) selectTile(e.ch);
      });

      chIn.addEventListener('input', (ev) => {
        if (ev.isComposing) return;
        const v = toFullWidth(chIn.value);
        if (v !== chIn.value) chIn.value = v;
      });
      chIn.addEventListener('focus', () => chIn.select());
      chIn.addEventListener('change', () => commitChar(e, chIn));

      nameIn.addEventListener('input', () => {
        e.name = nameIn.value;
        renderPalette();
        syncLegendText();
        scheduleSave();
      });

      colorIn.addEventListener('input', () => {
        e.color = colorIn.value;
        styleChInput(chIn, e.color);
        renderPalette();
        render();
        syncLegendText();
        scheduleSave();
      });

      up.addEventListener('click', () => moveLegend(i, -1));
      down.addEventListener('click', () => moveLegend(i, 1));
      del.addEventListener('click', () => deleteLegend(e));
    });

    // 固定の「空白」行（削除・文字変更不可。選ぶと消しゴムになる）
    const brow = document.createElement('div');
    brow.className = 'legend-row fixed';
    brow.dataset.id = 'blank';
    const bmain = document.createElement('div');
    bmain.className = 'legend-main';
    const bch = document.createElement('input');
    bch.type = 'text';
    bch.className = 'ch-input blank-ch';
    bch.value = '空';
    bch.disabled = true;
    bch.title = '空白マスは全角スペース（　）で表されます';
    const bname = document.createElement('input');
    bname.type = 'text';
    bname.className = 'name-input';
    bname.value = state.blankName;
    bname.placeholder = '空白の意味';
    const bnote = document.createElement('span');
    bnote.className = 'fixed-note';
    bnote.textContent = '固定';
    bmain.append(bch, bname, bnote);
    const bsub = document.createElement('div');
    bsub.className = 'legend-sub';
    const bcount = document.createElement('span');
    bcount.className = 'count';
    const bhelp = document.createElement('span');
    bhelp.className = 'count';
    bhelp.textContent = '全角スペース＝消しゴム';
    bsub.append(bcount, bhelp);
    brow.append(bmain, bsub);
    legendList.appendChild(brow);
    brow.addEventListener('focusin', () => { if (state.tool !== 'eraser') setTool('eraser'); });
    brow.addEventListener('pointerdown', (ev) => {
      if (ev.target !== bname) setTool('eraser');
    });
    bname.addEventListener('input', () => {
      state.blankName = bname.value;
      renderPalette();
      syncLegendText();
      scheduleSave();
    });

    updateLegendActive();
    updateCounts();
  }

  function commitChar(entry, input) {
    const ch = firstChar(input.value);
    if (!ch) {
      toast('空白は使えません（空白は消しゴム用に予約されています）');
      input.value = entry.ch;
      return;
    }
    if (ch !== entry.ch && findLegend(ch)) {
      toast(`「${ch}」はすでに登録されています`);
      input.value = entry.ch;
      return;
    }
    input.value = ch;
    if (ch === entry.ch) return;
    const old = entry.ch;
    // マップ上の旧文字も新しい文字へ置換
    for (const row of state.grid) {
      for (let x = 0; x < row.length; x++) if (row[x] === old) row[x] = ch;
    }
    if (state.current === old) state.current = ch;
    entry.ch = ch;
    refreshAll({ legend: false });
  }

  function moveLegend(i, d) {
    const j = i + d;
    if (j < 0 || j >= state.legend.length) return;
    [state.legend[i], state.legend[j]] = [state.legend[j], state.legend[i]];
    renderLegend();
    renderPalette();
    syncLegendText();
    scheduleSave();
  }

  function deleteLegend(entry) {
    const used = state.grid.flat().filter((c) => c === entry.ch).length;
    if (used > 0 && !confirm(`「${entry.ch}＝${entry.name}」はマップ上で ${used} マス使われています。\n凡例から削除しますか？（マップ上の文字は残り、「凡例にない文字」として表示されます）`)) return;
    state.legend = state.legend.filter((e) => e !== entry);
    if (state.current === entry.ch) state.current = state.legend[0] ? state.legend[0].ch : '';
    refreshAll();
  }

  function addLegend(ch, name, color) {
    if (!ch) ch = CANDIDATES.find((c) => !findLegend(c) && c !== BLANK) || '？';
    if (findLegend(ch)) return null;
    const entry = { id: nextId++, ch, name: name ?? '新しいタイル', color: color || randomColor() };
    state.legend.push(entry);
    return entry;
  }

  $('#btnAddLegend').addEventListener('click', () => {
    const entry = addLegend();
    state.current = entry.ch;
    refreshAll();
    const row = legendList.querySelector(`.legend-row[data-id="${entry.id}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      const nameIn = row.querySelector('.name-input');
      nameIn.focus();
      nameIn.select();
    }
  });

  // 使用数・未登録文字
  function updateCounts() {
    const counts = new Map();
    for (const row of state.grid) for (const c of row) counts.set(c, (counts.get(c) || 0) + 1);

    legendList.querySelectorAll('.legend-row').forEach((row) => {
      if (row.dataset.id === 'blank') {
        row.querySelector('.count').textContent = `使用：${counts.get(BLANK) || 0} マス`;
        return;
      }
      const e = state.legend.find((x) => x.id === Number(row.dataset.id));
      if (e) row.querySelector('.count').textContent = `使用：${counts.get(e.ch) || 0} マス`;
    });

    const unknown = [...counts.entries()].filter(([c]) => c !== BLANK && !findLegend(c));
    unregEl.innerHTML = '';
    if (!unknown.length) {
      unregEl.hidden = true;
      return;
    }
    unregEl.hidden = false;
    const strong = document.createElement('strong');
    strong.textContent = '凡例にない文字がマップにあります（赤で表示）';
    const items = document.createElement('div');
    items.className = 'unreg-items';
    unknown.forEach(([c, n]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${c} ×${n} ＋凡例に追加`;
      b.addEventListener('click', () => {
        addLegend(c);
        refreshAll();
      });
      items.appendChild(b);
    });
    unregEl.append(strong, items);
  }

  // ============================================================
  // テキストの同期
  // ============================================================
  function legendToText(withColor) {
    const lines = state.legend.map((e) => `${e.ch}＝${e.name}${withColor ? ' ' + e.color : ''}`);
    lines.push(`${BLANK}＝${state.blankName}`);
    return lines.join('\n');
  }

  function syncMapText() {
    mapText.value = gridToText();
  }

  function syncLegendText() {
    if (document.activeElement !== legendText) legendText.value = legendToText(true);
  }

  function onMapText() {
    const raw = mapText.value.replace(/\r/g, '');
    const pos = mapText.selectionStart;
    const conv = toFullWidth(raw);
    if (conv !== mapText.value) {
      mapText.value = conv;
      const p = toFullWidth(raw.slice(0, pos)).length;
      mapText.setSelectionRange(p, p);
    }

    const before = snapshot();
    const lines = conv.split('\n');
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    let rows = lines.map((l) => Array.from(l));
    let w = Math.max(1, ...rows.map((r) => r.length));
    if (w > MAX_SIZE || rows.length > MAX_SIZE) {
      toast(`最大サイズ ${MAX_SIZE}×${MAX_SIZE} を超えた部分は切り捨てます`);
      w = Math.min(w, MAX_SIZE);
      rows = rows.slice(0, MAX_SIZE);
    }
    state.grid = rows.map((r) => {
      const rr = r.slice(0, w);
      while (rr.length < w) rr.push(BLANK);
      return rr;
    });
    state.w = w;
    state.h = state.grid.length;

    const now = Date.now();
    if (now - lastTextPush > 1000 && before.join('\n') !== gridToText()) pushUndo(before);
    lastTextPush = now;

    $('#inW').value = state.w;
    $('#inH').value = state.h;
    render();
    updateCounts();
    scheduleSave();
  }

  mapText.addEventListener('compositionstart', () => { composingMap = true; });
  mapText.addEventListener('compositionend', () => { composingMap = false; onMapText(); });
  mapText.addEventListener('input', (e) => { if (!composingMap && !e.isComposing) onMapText(); });
  mapText.addEventListener('blur', syncMapText);

  function applyLegendText() {
    const old = new Map(state.legend.map((e) => [e.ch, e]));
    const next = [];
    const seen = new Set();
    for (const line of legendText.value.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // 全角スペース始まりの行は「空白」の定義
      if (line.startsWith(BLANK)) {
        const nm = line.slice(1).replace(/^[\s=＝:：]+/, '').trim();
        if (nm) state.blankName = nm;
        continue;
      }
      const chars = Array.from(line.trim());
      const ch = firstChar(chars[0]);
      if (!ch || seen.has(ch)) continue;
      let rest = chars.slice(1).join('').replace(/^[\s=＝:：]+/, '');
      let color = null;
      const m = rest.match(/(#[0-9a-fA-F]{6})\s*$/);
      if (m) {
        color = m[1].toLowerCase();
        rest = rest.slice(0, m.index);
      }
      const prev = old.get(ch);
      next.push({
        id: prev ? prev.id : nextId++,
        ch,
        name: rest.trim(),
        color: color || (prev ? prev.color : randomColor()),
      });
      seen.add(ch);
    }
    state.legend = next;
    if (!findLegend(state.current)) state.current = next[0] ? next[0].ch : '';
    legendText.blur();
    refreshAll();
    toast('凡例を反映しました');
  }

  $('#btnApplyLegend').addEventListener('click', applyLegendText);
  $('#btnCopyMap').addEventListener('click', () => copyText(gridToText(), 'マップ文字'));
  $('#btnCopyLegend').addEventListener('click', () => copyText(legendToText(false), '凡例'));

  // ============================================================
  // 全体更新・保存
  // ============================================================
  function refreshAll(opts = {}) {
    if (opts.legend !== false) renderLegend();
    else { updateLegendActive(); }
    renderPalette();
    render();
    updateCounts();
    syncMapText();
    syncLegendText();
    $('#inW').value = state.w;
    $('#inH').value = state.h;
    updateHistoryButtons();
    updateHover(null);
    scheduleSave();
  }

  function serialize() {
    return {
      app: 'grid-map-maker',
      version: 1,
      width: state.w,
      height: state.h,
      map: snapshot(),
      legend: state.legend.map((e) => ({ char: e.ch, name: e.name, color: e.color })),
      blankName: state.blankName,
      current: state.current,
    };
  }

  function loadData(data) {
    if (!data || !Array.isArray(data.map) || !Array.isArray(data.legend)) throw new Error('形式が正しくありません');
    const legend = [];
    const seen = new Set();
    for (const l of data.legend) {
      const ch = firstChar(l.char ?? l.ch ?? '');
      if (!ch || seen.has(ch)) continue;
      seen.add(ch);
      const color = /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color.toLowerCase() : randomColor();
      legend.push({ id: nextId++, ch, name: String(l.name ?? ''), color });
    }
    let rows = data.map.map((l) => Array.from(toFullWidth(String(l))));
    if (!rows.length) rows = [[BLANK]];
    rows = rows.slice(0, MAX_SIZE);
    const w = Math.max(1, Math.min(MAX_SIZE, Math.max(...rows.map((r) => r.length))));
    state.grid = rows.map((r) => {
      const rr = r.slice(0, w);
      while (rr.length < w) rr.push(BLANK);
      return rr;
    });
    state.w = w;
    state.h = state.grid.length;
    state.legend = legend;
    state.blankName = String(data.blankName || '空白');
    const cur = firstChar(data.current || '');
    state.current = legend.some((e) => e.ch === cur) ? cur : legend[0] ? legend[0].ch : '';
    undoStack = [];
    redoStack = [];
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          ...serialize(),
          cell: state.cell,
          showGrid: state.showGrid,
          outline: state.outline,
          tool: state.tool,
        }));
      } catch { /* 保存できない環境では無視 */ }
    }, 300);
  }

  // ============================================================
  // サンプル
  // ============================================================
  /** すごろく（いただきストリート系）用の初期凡例 */
  function defaultLegend() {
    const legend = [
      { char: '銀', name: '銀行', color: '#e9c85a' },
      { char: '♦', name: 'ダイヤ', color: '#ffe95c' },
      { char: '♥', name: 'ハート', color: '#ff7b8a' },
      { char: '♠', name: 'スペード', color: '#6d9bff' },
      { char: '♣', name: 'クローバー', color: '#6fd47a' },
    ];
    Array.from('ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ').forEach((c, i) => {
      legend.push({ char: c, name: `店${c}`, color: hslToHex(Math.round((i * 360) / 26), 50, 80) });
    });
    legend.push(
      { char: 'イ', name: 'イベント', color: '#ffa94d' },
      { char: '削', name: '削り', color: '#a9afb7' },
      { char: 'ス', name: 'スロット', color: '#c78bff' },
      { char: '株', name: '株', color: '#4fc3c7' }
    );
    return legend;
  }

  function loadSample() {
    const w = 19, h = 11;
    const g = makeGrid(w, h);

    // 外周のマス（左上から時計回り）
    const ring = [];
    const x0 = 3, x1 = 15, y0 = 1, y1 = 9;
    for (let x = x0; x <= x1; x++) ring.push([x, y0]);
    for (let y = y0 + 1; y <= y1; y++) ring.push([x1, y]);
    for (let x = x1 - 1; x >= x0; x--) ring.push([x, y1]);
    for (let y = y1 - 1; y > y0; y--) ring.push([x0, y]);

    const specials = Array.from('銀♦イ株♥削ス♠イ株♣削ス銀');
    const letters = Array.from('ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ');
    let si = 0, li = 0;
    ring.forEach(([x, y], i) => {
      if (i % 3 === 0 && si < specials.length) g[y][x] = specials[si++];
      else g[y][x] = letters[li++ % letters.length];
    });

    loadData({ map: g.map((r) => r.join('')), legend: defaultLegend(), current: '銀', blankName: '空白' });
    refreshAll();
  }

  // ============================================================
  // 入出力
  // ============================================================
  function fullText() {
    return `${gridToText()}\n\n【凡例】\n${legendToText(false)}\n`;
  }

  $('#btnSample').addEventListener('click', () => {
    if (confirm('サンプルを読み込みます。現在のマップと凡例は置き換わります。よろしいですか？')) loadSample();
  });
  $('#btnSaveJson').addEventListener('click', () => {
    download('gridmap.json', new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' }));
  });
  $('#btnSaveTxt').addEventListener('click', () => {
    download('gridmap.txt', new Blob([fullText()], { type: 'text/plain;charset=utf-8' }));
  });
  $('#btnSavePng').addEventListener('click', () => {
    const s = Math.max(32, state.cell);
    const c = document.createElement('canvas');
    c.width = state.w * s;
    c.height = state.h * s;
    const cx = c.getContext('2d');
    prepareCtx(cx, s, 1);
    const lmap = legendMap();
    for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) drawCell(cx, x, y, s, lmap, state.showGrid);
    c.toBlob((b) => download('gridmap.png', b), 'image/png');
  });
  $('#btnLoad').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      loadData(JSON.parse(await file.text()));
      refreshAll();
      toast('読み込みました');
    } catch (err) {
      toast('読み込みに失敗しました：' + err.message);
    }
  });

  // ============================================================
  // ツールバー
  // ============================================================
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnCopy').addEventListener('click', copySelection);
  $('#btnCut').addEventListener('click', cutSelection);
  $('#btnPaste').addEventListener('click', startPaste);
  $('#btnClear').addEventListener('click', () => {
    pushUndo(snapshot());
    state.grid = makeGrid(state.w, state.h);
    refreshAll();
  });
  $('#btnResize').addEventListener('click', () => {
    const w = parseInt($('#inW').value, 10);
    const h = parseInt($('#inH').value, 10);
    if (!(w >= 1) || !(h >= 1)) { toast('幅・高さは1以上の数字で指定してください'); return; }
    if (w > MAX_SIZE || h > MAX_SIZE) toast(`最大は ${MAX_SIZE}×${MAX_SIZE} です`);
    if (Math.min(w, MAX_SIZE) === state.w && Math.min(h, MAX_SIZE) === state.h) { refreshAll(); return; }
    pushUndo(snapshot());
    resizeGrid(w, h);
    refreshAll();
  });
  $('#zoom').addEventListener('input', (e) => {
    state.cell = Number(e.target.value);
    render();
    scheduleSave();
  });
  $('#chkGrid').addEventListener('change', (e) => {
    state.showGrid = e.target.checked;
    render();
    scheduleSave();
  });
  $('#chkOutline').addEventListener('change', (e) => {
    state.outline = e.target.checked;
    scheduleSave();
  });

  // ============================================================
  // キーボードショートカット
  // ============================================================
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && (k === 'c' || k === 'x') && state.sel) {
      e.preventDefault();
      k === 'c' ? copySelection() : cutSelection();
      return;
    }
    if (mod && k === 'v') { e.preventDefault(); startPaste(); return; }
    if (e.key === 'Escape') {
      cancelPaste();
      clearSelection();
      return;
    }
    if (mod || e.altKey) return;
    const tools = { b: 'pen', e: 'eraser', f: 'fill', l: 'line', r: 'rect', s: 'select', i: 'picker' };
    if (tools[k]) { setTool(tools[k]); return; }
    if (/^[1-9]$/.test(e.key)) {
      const entry = state.legend[Number(e.key) - 1];
      if (entry) selectTile(entry.ch);
    }
  });

  window.addEventListener('resize', render);

  // ============================================================
  // 初期化
  // ============================================================
  function init() {
    let restored = false;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        loadData(data);
        if (data.cell >= 16 && data.cell <= 56) state.cell = data.cell;
        state.showGrid = data.showGrid !== false;
        state.outline = !!data.outline;
        if (['pen', 'eraser', 'fill', 'line', 'rect', 'select', 'picker'].includes(data.tool)) state.tool = data.tool;
        restored = true;
      }
    } catch { restored = false; }

    $('#zoom').value = state.cell;
    $('#chkGrid').checked = state.showGrid;
    $('#chkOutline').checked = state.outline;

    if (!restored) loadSample();
    else refreshAll();
    setTool(state.tool);
  }

  init();
})();
