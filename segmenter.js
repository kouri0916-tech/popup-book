/* ============================================================
 * segmenter.js — 浏览器端图像分层（背景 / 角色 / 小物件×N）
 *
 * 纯前端启发式算法，无需服务器：
 *  1. 背景层：四边种子 + BFS 区域生长抠出背景，并用"逐行扫描线
 *     插值"补全被前景遮挡的背景（inpaint），保证拆走前景后背景完整。
 *  2. 角色层：评分制选出显著主体（面积×居中×偏下×高宽比）。
 *  3. 小物件：其余每个大连通域单独输出一层（最多 6 个），带独立
 *     包围盒，供 3D 场景中逐个摆放/弹起。
 * 输出：{ bg, role, props:[{canvas,box}], full, meta }
 * ============================================================ */

const Segmenter = (() => {

  const MAX_DIM = 480;
  const BG_TOLERANCE = 34;
  const MIN_REGION = 24;        // 分析分辨率下最小连通域
  const MAX_PROPS = 6;          // 最多单独拆出的小物件数

  // ---------- 工具 ----------
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }

  function toCanvas(img, maxDim = 1600) {
    let { width: w, height: h } = img;
    if (Math.max(w, h) > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }

  // ---------- 主入口 ----------
  async function segment(imgOrSrc, onProgress = () => {}) {
    onProgress(10, '解码图片…');
    const img = imgOrSrc instanceof Image ? imgOrSrc : await loadImage(imgOrSrc);
    const full = toCanvas(img, 1600);

    onProgress(30, '分析色彩与连通域…');
    const aw = Math.min(MAX_DIM, full.width);
    const ah = Math.round(full.height * (aw / full.width));
    const ac = document.createElement('canvas');
    ac.width = aw; ac.height = ah;
    ac.getContext('2d').drawImage(full, 0, 0, aw, ah);
    const ad = ac.getContext('2d').getImageData(0, 0, aw, ah);
    const W = aw, H = ah, px = ad.data;

    // ---- 1. 背景检测：四边种子 + BFS 区域生长 ----
    const label = new Int32Array(W * H).fill(-1);
    const queue = [];
    const seedColor = sampleEdgeColor(px, W, H);
    const isBgLike = (i) => colorDist(px, i, seedColor) < BG_TOLERANCE;

    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    function push(x, y) {
      const i = y * W + x;
      if (label[i] === -1 && isBgLike(i)) { label[i] = 0; queue.push(i); }
    }
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const x = i % W, y = (i / W) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const n of nb) if (n >= 0 && label[n] === -1 && isBgLike(n)) { label[n] = 0; queue.push(n); }
    }
    onProgress(50, '标记前景元素…');

    // ---- 2. 前景连通域标记 ----
    const regions = [];
    let nextId = 1;
    for (let i = 0; i < W * H; i++) {
      if (label[i] !== -1) continue;
      const id = nextId++;
      const q = [i]; label[i] = id;
      const reg = { id, size: 0, minX: W, minY: H, maxX: 0, maxY: 0, sumX: 0, sumY: 0 };
      let h2 = 0;
      while (h2 < q.length) {
        const j = q[h2++];
        const x = j % W, y = (j / W) | 0;
        reg.size++; reg.sumX += x; reg.sumY += y;
        if (x < reg.minX) reg.minX = x;
        if (x > reg.maxX) reg.maxX = x;
        if (y < reg.minY) reg.minY = y;
        if (y > reg.maxY) reg.maxY = y;
        const nb = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
        for (const n of nb) if (n >= 0 && label[n] === -1) { label[n] = id; q.push(n); }
      }
      if (reg.size >= MIN_REGION) regions.push(reg);
    }
    regions.sort((a, b) => b.size - a.size);

    // ---- 3. 分类：角色 = 评分最高；其余为小物件（取前 N 个）----
    let roleReg = null;
    if (regions.length) {
      let best = null, bestScore = -1;
      for (const r of regions.slice(0, 8)) {
        const cx = r.sumX / r.size, cy = r.sumY / r.size;
        const w = r.maxX - r.minX + 1, h = r.maxY - r.minY + 1;
        const centerBias = 1 - Math.abs(cx / W - 0.5) * 1.6;
        const lowerBias = 0.6 + (cy / H) * 0.8;
        const tallBias = Math.min(1.4, (h / H) / Math.max(0.25, w / W) * 0.5);
        const score = Math.sqrt(r.size) * centerBias * lowerBias * tallBias;
        if (score > bestScore) { bestScore = score; best = r; }
      }
      roleReg = best;
    }
    const propRegions = regions.filter(r => r !== roleReg).slice(0, MAX_PROPS);

    onProgress(70, '生成纸艺切片…');
    const sx = full.width / W, sy = full.height / H;

    const bgC = buildLayer(full, (x, y) => label[((y / sy) | 0) * W + ((x / sx) | 0)] === 0);
    inpaintBackground(full, bgC, label, W, H, sx, sy);   // 背景补全

    const roleC = buildLayer(full, (x, y) => !!roleReg && label[((y / sy) | 0) * W + ((x / sx) | 0)] === roleReg.id);

    const props = propRegions.map(r => {
      const pad = 2;
      const bx = Math.max(0, (r.minX - pad) * sx | 0), by = Math.max(0, (r.minY - pad) * sy | 0);
      const bw = Math.min(full.width - bx, ((r.maxX - r.minX + 1) + pad * 2) * sx | 0);
      const bh = Math.min(full.height - by, ((r.maxY - r.minY + 1) + pad * 2) * sy | 0);
      const layer = buildLayer(full, (x, y) => {
        const l = label[((y / sy) | 0) * W + ((x / sx) | 0)];
        return l === r.id;
      }, bx, by, bw, bh);
      return { canvas: layer, box: { x: bx, y: by, w: bw, h: bh } };
    });

    feather(bgC); feather(roleC);
    props.forEach(p => feather(p.canvas));

    onProgress(95, '完成');
    const meta = {
      width: full.width, height: full.height,
      roleBox: roleReg ? {
        x: roleReg.minX * sx, y: roleReg.minY * sy,
        w: (roleReg.maxX - roleReg.minX + 1) * sx,
        h: (roleReg.maxY - roleReg.minY + 1) * sy,
      } : null,
      propCount: propRegions.length,
      seedColor: `rgb(${seedColor[0]},${seedColor[1]},${seedColor[2]})`,
    };
    return { bg: bgC, role: roleC, props, full, meta };
  }

  // ---------- 背景补全：对被前景遮挡的背景区域做扫描线插值 ----------
  function inpaintBackground(fullCanvas, bgCanvas, label, W, H, sx, sy) {
    const ctx = bgCanvas.getContext('2d');
    const w = bgCanvas.width, h = bgCanvas.height;
    const im = ctx.getImageData(0, 0, w, h);
    const d = im.data;
    const srcCtx = fullCanvas.getContext('2d');
    const src = srcCtx.getImageData(0, 0, w, h).data;

    // 逐行：对每行中"非背景"的空洞段，用两端背景色线性插值填充
    for (let y = 0; y < h; y++) {
      const ay = (y / sy) | 0;
      let x = 0;
      while (x < w) {
        const ax = (x / sx) | 0;
        if (label[ay * W + ax] === 0) { x++; continue; }
        // 找到一段连续空洞 [x0, x1)
        const x0 = x;
        while (x < w && label[ay * W + ((x / sx) | 0)] !== 0) x++;
        const x1 = x;
        if (x0 === 0 || x1 >= w) continue;   // 贴边空洞不填充（保持透明由上层覆盖）
        const li = (y * w + (x0 - 1)) * 4, ri = (y * w + x1) * 4;
        const span = x1 - x0 + 1;
        for (let xx = x0; xx < x1; xx++) {
          const t = (xx - x0 + 1) / span;
          const o = (y * w + xx) * 4;
          d[o]     = d[li]     * (1 - t) + d[ri]     * t;
          d[o + 1] = d[li + 1] * (1 - t) + d[ri + 1] * t;
          d[o + 2] = d[li + 2] * (1 - t) + d[ri + 2] * t;
          d[o + 3] = 255;
        }
      }
    }
    // 逐列再做一遍（十字插值，效果更好）
    for (let x = 0; x < w; x++) {
      const ax = (x / sx) | 0;
      let y = 0;
      while (y < h) {
        const ay = (y / sy) | 0;
        if (label[ay * W + ax] === 0) { y++; continue; }
        const y0 = y;
        while (y < h && label[((y / sy) | 0) * W + ax] !== 0) y++;
        const y1 = y;
        if (y0 === 0 || y1 >= h) continue;
        const ti = ((y0 - 1) * w + x) * 4, bi = (y1 * w + x) * 4;
        const span = y1 - y0 + 1;
        for (let yy = y0; yy < y1; yy++) {
          const t = (yy - y0 + 1) / span;
          const o = (yy * w + x) * 4;
          // 与行插值结果做平均（若该像素已被行插值填充）
          const r = src[ti]     * (1 - t) + src[bi]     * t;
          const g = src[ti + 1] * (1 - t) + src[bi + 1] * t;
          const b = src[ti + 2] * (1 - t) + src[bi + 2] * t;
          if (d[o + 3] === 255) {
            d[o] = (d[o] + r) / 2; d[o + 1] = (d[o + 1] + g) / 2; d[o + 2] = (d[o + 2] + b) / 2;
          } else {
            d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(im, 0, 0);
  }

  // ---------- 辅助 ----------
  function sampleEdgeColor(px, W, H) {
    const rs = [], gs = [], bs = [];
    const step = Math.max(1, (W + H) / 200 | 0);
    for (let x = 0; x < W; x += step) {
      for (const y of [0, H - 1]) {
        const i = (y * W + x) * 4;
        rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
      }
    }
    for (let y = 0; y < H; y += step) {
      for (const x of [0, W - 1]) {
        const i = (y * W + x) * 4;
        rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
      }
    }
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    return [med(rs), med(gs), med(bs)];
  }

  function colorDist(px, i, rgb) {
    const dr = px[i] - rgb[0], dg = px[i + 1] - rgb[1], db = px[i + 2] - rgb[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // 按蒙版从原图抠出一层；可裁剪到包围盒（crop 参数）
  function buildLayer(srcCanvas, keepFn, cx = 0, cy = 0, cw = srcCanvas.width, ch = srcCanvas.height) {
    const out = document.createElement('canvas');
    out.width = Math.max(1, cw | 0); out.height = Math.max(1, ch | 0);
    const octx = out.getContext('2d');
    octx.drawImage(srcCanvas, cx, cy, out.width, out.height, 0, 0, out.width, out.height);
    octx.globalCompositeOperation = 'destination-in';
    // 蒙版：keepFn 以全局坐标判断，裁剪时平移
    const maskC = document.createElement('canvas');
    maskC.width = out.width; maskC.height = out.height;
    const mctx = maskC.getContext('2d');
    const im = mctx.createImageData(out.width, out.height);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        if (keepFn(cx + x, cy + y)) {
          const o = (y * out.width + x) * 4;
          im.data[o] = 255; im.data[o + 1] = 255; im.data[o + 2] = 255; im.data[o + 3] = 255;
        }
      }
    }
    mctx.putImageData(im, 0, 0);
    octx.drawImage(maskC, 0, 0);
    return out;
  }

  function feather(canvas) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const im = ctx.getImageData(0, 0, w, h);
    const a = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) a[i] = im.data[i * 4 + 3];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            s += a[(y + dy) * w + (x + dx)];
        im.data[(y * w + x) * 4 + 3] = s / 9;
      }
    }
    ctx.putImageData(im, 0, 0);
  }

  return { segment, loadImage };
})();
