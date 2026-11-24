/* ============================================================
 * app.js — 交互逻辑：上传 / 菜单 / 图层控制 / 模式切换 / 示例图
 * ============================================================ */

const $ = (s) => document.querySelector(s);

const state = {
  artworks: [],        // {id, name, src, layers, thumb}
  currentId: null,
  mode: 'book',        // book | layers
  visibleLayer: 'all', // all | bg | role | prop
  autoRotate: false,
};

const LAYER_LABEL = { bg: '背景层', role: '角色层', prop: '小物件层' };
const LAYER_DESC = {
  all:  '展示完整立体书效果',
  bg:   '背景层 —— 远景纸艺，平贴于书页底部',
  role: '角色层 —— 画面主体，立起约 36° 形成景深',
  prop: '小物件层 —— 前景点缀，最靠近观众',
};

// ---------------- 初始化 ----------------
window.addEventListener('DOMContentLoaded', () => {
  Book3D.init($('#stage3d'));
  bindUpload();
  bindToolbar();
  bindElementTabs();
  bindModeSwitch();
  $('#demoBtn').addEventListener('click', loadDemo);
  $('#welcomeUpload').addEventListener('click', () => $('#fileInput').click());
});

// ---------------- 上传 ----------------
function bindUpload() {
  const zone = $('#uploadZone');
  const input = $('#fileInput');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
}

async function handleFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  for (const f of files) {
    const src = await fileToDataURL(f);
    await addArtwork(f.name.replace(/\.[^.]+$/, ''), src);
  }
}

function fileToDataURL(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

async function addArtwork(name, src) {
  showSeg(true, '正在拆分画面元素…', 5);
  try {
    const layers = await Segmenter.segment(src, (p, msg) => {
      showSeg(true, msg, p);
    });
    const art = {
      id: 'art_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name, src, layers,
      thumb: makeThumb(layers.full),
    };
    state.artworks.push(art);
    renderArtList();
    selectArtwork(art.id);
  } catch (err) {
    console.error(err);
    alert('拆分失败：' + (err?.message || '未知错误'));
  } finally {
    showSeg(false);
  }
}

function makeThumb(canvas) {
  const t = document.createElement('canvas');
  const s = 84 / Math.max(canvas.width, canvas.height);
  t.width = Math.round(canvas.width * s);
  t.height = Math.round(canvas.height * s);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.8);
}

// ---------------- 作品列表 ----------------
function renderArtList() {
  const list = $('#artList');
  $('#artCount').textContent = state.artworks.length;
  list.innerHTML = '';
  if (!state.artworks.length) {
    list.innerHTML = '<div class="empty-tip">暂无作品，先上传一张试试</div>';
    return;
  }
  for (const art of state.artworks) {
    const item = document.createElement('div');
    item.className = 'art-item' + (art.id === state.currentId ? ' active' : '');
    item.innerHTML = `
      <img class="art-thumb" src="${art.thumb}" alt="">
      <div class="art-info">
        <div class="art-name">${escapeHtml(art.name)}</div>
        <div class="art-meta">${art.layers.meta.width}×${art.layers.meta.height} · 已拆分</div>
      </div>
      <button class="art-del" title="删除">✕</button>`;
    item.addEventListener('click', () => selectArtwork(art.id));
    item.querySelector('.art-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeArtwork(art.id);
    });
    list.appendChild(item);
  }
}

function selectArtwork(id) {
  state.currentId = id;
  const art = state.artworks.find(a => a.id === id);
  if (!art) return;
  renderArtList();
  $('#welcome').classList.add('hidden');
  $('#layerSection').style.display = '';
  $('#stageTitle').textContent = art.name;
  const badge = $('#stageBadge');
  badge.style.display = '';
  badge.textContent = `角色 ${art.layers.meta.roleBox ? '✓' : '—'} · 小物件 ${art.layers.meta.propCount} 块`;

  Book3D.buildBook(art.layers, state.visibleLayer);
  Book3D.setMode(state.mode);
  renderLayerControls(art);
  updateElementDesc();
}

function removeArtwork(id) {
  state.artworks = state.artworks.filter(a => a.id !== id);
  if (state.currentId === id) {
    state.currentId = null;
    if (state.artworks.length) {
      selectArtwork(state.artworks[0].id);
    } else {
      $('#welcome').classList.remove('hidden');
      $('#layerSection').style.display = 'none';
      $('#stageTitle').textContent = '未选择作品';
      $('#stageBadge').style.display = 'none';
      Book3D.buildBook(null);
    }
  }
  renderArtList();
}

// ---------------- 图层控制 ----------------
function renderLayerControls(art) {
  const box = $('#layerControls');
  box.innerHTML = '';
  const depths = { bg: '远景 · 平贴', role: '中景 · 立起 36°', prop: '近景 · 立起 40°' };
  for (const key of ['bg', 'role', 'prop']) {
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.innerHTML = `
      <span class="layer-dot" style="background:${{bg:'#6ea8fe',role:'#ffa94d',prop:'#69db7c'}[key]}"></span>
      <label>${LAYER_LABEL[key]}</label>
      <span class="layer-depth">${depths[key]}</span>
      <input type="checkbox" checked data-layer="${key}">`;
    row.querySelector('input').addEventListener('change', (e) => {
      if (!e.target.checked && state.visibleLayer === key) {
        setElementTab('all');
      } else {
        refreshVisibility();
      }
    });
    box.appendChild(row);
  }
}

function refreshVisibility() {
  const art = state.artworks.find(a => a.id === state.currentId);
  if (!art) return;
  const checks = [...document.querySelectorAll('#layerControls input')];
  for (const [key, pivot] of Object.entries(Book3D.layerMeshes || {})) {
    const cb = checks.find(c => c.dataset.layer === key);
    if (cb) pivot.visible = cb.checked && (state.visibleLayer === 'all' || state.visibleLayer === key);
  }
}

// ---------------- 元素单独显示 ----------------
function bindElementTabs() {
  document.querySelectorAll('.el-tab').forEach(btn => {
    btn.addEventListener('click', () => setElementTab(btn.dataset.layer));
  });
}

function setElementTab(layer) {
  state.visibleLayer = layer;
  document.querySelectorAll('.el-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.layer === layer));
  Book3D.applyVisibility(layer);
  updateElementDesc();
  // 同步侧栏复选框
  document.querySelectorAll('#layerControls input').forEach(cb => {
    cb.checked = layer === 'all' || cb.dataset.layer === layer;
  });
}

function updateElementDesc() {
  $('#elementDesc').textContent = LAYER_DESC[state.visibleLayer] || '';
}

// ---------------- 模式切换 ----------------
function bindModeSwitch() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      $('#modeTip').textContent = state.mode === 'book'
        ? '拖动旋转 · 滚轮缩放 · 观察纸艺景深'
        : '爆炸视图 · 三层错开便于检查拆分结果';
      Book3D.setMode(state.mode);
    });
  });
}

// ---------------- 工具条 ----------------
function bindToolbar() {
  $('#autoRotateBtn').addEventListener('click', (e) => {
    state.autoRotate = !state.autoRotate;
    Book3D.setAutoRotate(state.autoRotate);
    e.currentTarget.classList.toggle('active', state.autoRotate);
  });
  $('#resetViewBtn').addEventListener('click', () => Book3D.resetView());
  $('#openBookBtn').addEventListener('click', () => Book3D.resetView());
  $('#reSegBtn').addEventListener('click', async () => {
    const art = state.artworks.find(a => a.id === state.currentId);
    if (!art) return;
    await addArtwork(art.name, art.src);
  });
}

// ---------------- 拆分进度 ----------------
function showSeg(show, text = '', percent = 0) {
  $('#segOverlay').classList.toggle('hidden', !show);
  if (text) $('#segText').textContent = text;
  $('#segBar').style.width = percent + '%';
}

// ---------------- 示例画作（程序化生成，便于无图快速预览）----------------
async function loadDemo() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 768;
  const ctx = c.getContext('2d');

  // 背景：渐变天空 + 太阳
  const sky = ctx.createLinearGradient(0, 0, 0, 768);
  sky.addColorStop(0, '#8ec9ff'); sky.addColorStop(1, '#e8f4ff');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 1024, 768);
  ctx.fillStyle = '#ffd76e';
  ctx.beginPath(); ctx.arc(820, 140, 70, 0, Math.PI * 2); ctx.fill();

  // 远山
  ctx.fillStyle = '#a5c8e8';
  ctx.beginPath();
  ctx.moveTo(0, 480); ctx.quadraticCurveTo(250, 300, 520, 470);
  ctx.quadraticCurveTo(760, 330, 1024, 490);
  ctx.lineTo(1024, 768); ctx.lineTo(0, 768); ctx.fill();

  // 角色：小狐狸
  ctx.fillStyle = '#e8833a';
  ctx.beginPath(); ctx.ellipse(512, 560, 95, 120, 0, 0, Math.PI * 2); ctx.fill(); // 身体
  ctx.beginPath(); ctx.arc(512, 400, 68, 0, Math.PI * 2); ctx.fill();             // 头
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(455, 355); ctx.lineTo(475, 285); ctx.lineTo(500, 350); ctx.fill();
  ctx.beginPath(); ctx.moveTo(569, 355); ctx.lineTo(549, 285); ctx.lineTo(524, 350); ctx.fill();
  ctx.fillStyle = '#2b2b2b';
  ctx.beginPath(); ctx.arc(490, 395, 9, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(534, 395, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.ellipse(512, 440, 16, 11, 0, 0, Math.PI * 2); ctx.fill(); // 口鼻

  // 小物件：蘑菇与花
  ctx.fillStyle = '#d9534f';
  ctx.beginPath(); ctx.arc(220, 620, 45, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#f5e6d3'; ctx.fillRect(200, 620, 40, 60);
  ctx.fillStyle = '#ff8fb3';
  for (const [fx, fy] of [[760, 640], [830, 660], [700, 665]]) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(fx + Math.cos(a) * 14, fy + Math.sin(a) * 14, 11, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#ffd76e';
    ctx.beginPath(); ctx.arc(fx, fy, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff8fb3';
  }

  await addArtwork('示例 · 小狐狸森林', c.toDataURL('image/png'));
}

// ---------------- 工具 ----------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
