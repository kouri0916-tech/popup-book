/* ============================================================
 * segmenter.js — 浏览器端图像分层（背景 / 角色 / 小物件）
 *
 * 纯前端启发式算法，无需服务器：
 *  1. 背景层：对图像做多次下采样 + 区域生长，找出与画面四边
 *     颜色连通的大块区域 → 作为背景并抠出（边缘羽化）。
 *  2. 角色层：在剩余前景中，取"最大连通域 + 垂直居中偏下 +
 *     高宽比较大"的显著主体作为角色。
 *  3. 小物件层：其余前景连通域（较小、偏边缘）。
 * 输出三张带透明的 PNG canvas + 各层包围盒信息。
 * ============================================================ */

const Segmenter = (() => {

  const MAX_DIM = 480;          // 分析用最大边长（性能考虑）
  const BG_TOLERANCE = 34;      // 背景颜色容差
  const MIN_REGION = 24;        // 最小连通域像素数（分析分辨率下）

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
  /**
   * @param {HTMLImageElement|string} imgOrSrc
   * @returns {Promise<{bg, role, prop, full, meta}>} 各层 canvas 与元信息
   */
  async function segment(imgOrSrc, onProgress = () => {}) {
    onProgress(10, '解码图片…');
    const img = imgOrSrc instanceof Image ? imgOrSrc : await loadImage(imgOrSrc);
    const full = toCanvas(img, 1600);

    onProgress(30, '分析色彩与连通域…');
    // 分析用小图
    const aw = Math.min(MAX_DIM, full.width);
    const ah = Math.round(full.height * (aw / full.width));
    const ac = document.createElement('canvas');
    ac.width = aw; ac.height = ah;
    ac.getContext('2d').drawImage(full, 0, 0, aw, ah);
    const ad = ac.getContext('2d').getImageData(0, 0, aw, ah);
    const W = aw, H = ah, px = ad.data;

    // ---- 1. 背景检测：四边种子 + BFS 区域生长 ----
    const label = new Int32Array(W * H).fill(-1);   // -1 未访问
    const queue = [];
    const seedColor = sampleEdgeColor(px, W, H);

    const isBgLike = (i) => colorDist(px, i, seedColor) < BG_TOLERANCE;

    // 从四边所有"像背景"的像素开始生长
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
      const neighbors = [
        x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1,
        y > 0 ? i - W : -1, y < H - 1 ? i + W : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && label[n] === -1 && isBgLike(n)) { label[n] = 0; queue.push(n); }
      }
    }
    onProgress(55, '抠出背景层…');

    // ---- 2. 前景连通域标记 ----
    const regions = [];   // {id, size, minX, minY, maxX, maxY, sumX, sumY}
    let nextId = 1;
    for (let i = 0; i < W * H; i++) {
      if (label[i] !== -1) continue;
      // BFS 标记一个连通域
      const id = nextId++;
      const q = [i]; label[i] = id;
      const reg = { id, size: 0, minX: W, minY: H, maxX: 0, maxY: 0, sumX: 0, sumY: 0 };
      let head2 = 0;
      while (head2 < q.length) {
        const j = q[head2++];
        const x = j % W, y = (j / W) | 0;
        reg.size++;
        reg.sumX += x; reg.sumY += y;
        if (x < reg.minX) reg.minX = x;
        if (x > reg.maxX) reg.maxX = x;
        if (y < reg.minY) reg.minY = y;
        if (y > reg.maxY) reg.maxY = y;
        const nb = [
          x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1,
          y > 0 ? j - W : -1, y < H - 1 ? j + W : -1,
        ];
        for (const n of nb) if (n >= 0 && label[n] === -1) { label[n] = id; q.push(n); }
      }
      if (reg.size >= MIN_REGION) regions.push(reg);
    }
    regions.sort((a, b) => b.size - a.size);

    // ---- 3. 分类：最大且居中偏下、高宽比大 → 角色；其余 → 小物件 ----
    let roleReg = null;
    if (regions.length) {
      // 评分：面积 × 中心接近画面中轴 × 中心偏下 × 纵向占比
      let best = null, bestScore = -1;
      for (const r of regions.slice(0, 8)) {
        const cx = r.sumX / r.size, cy = r.sumY / r.size;
        const w = r.maxX - r.minX + 1, h = r.maxY - r.minY + 1;
        const centerBias = 1 - Math.abs(cx / W - 0.5) * 1.6;      // 越居中越高
        const lowerBias = 0.6 + (cy / H) * 0.8;                    // 偏下加分
        const tallBias = Math.min(1.4, (h / H) / Math.max(0.25, w / W) * 0.5);
        const score = Math.sqrt(r.size) * centerBias * lowerBias * tallBias;
        if (score > bestScore) { bestScore = score; best = r; }
      }
      roleReg = best;
    }

    onProgress(75, '生成三层纸艺切片…');

    // ---- 4. 生成三层带透明通道的 canvas（按分析比例映射回原尺寸）----
    const sx = full.width / W, sy = full.height / H;
    const srcCtx = full.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, full.width, full.height);

    const bgC   = buildLayer(full, (x, y) => label[((y / sy) | 0) * W + ((x / sx) | 0)] === 0);
    const roleC = buildLayer(full, (x, y) => !!roleReg && label[((y / sy) | 0) * W + ((x / sx) | 0)] === roleReg.id);
    const propC = buildLayer(full, (x, y) => {
      const l = label[((y / sy) | 0) * W + ((x / sx) | 0)];
      return l > 0 && (!roleReg || l !== roleReg.id);
    });

    // 边缘羽化 1px（对 alpha 通道做简单模糊，纸边更柔和）
    feather(roleC); feather(propC); feather(bgC);

    onProgress(95, '完成');
    const meta = {
      width: full.width, height: full.height,
      roleBox: roleReg ? {
        x: roleReg.minX * sx, y: roleReg.minY * sy,
        w: (roleReg.maxX - roleReg.minX + 1) * sx,
        h: (roleReg.maxY - roleReg.minY + 1) * sy,
      } : null,
      propCount: regions.filter(r => r !== roleReg).length,
      seedColor: `rgb(${seedColor[0]},${seedColor[1]},${seedColor[2]})`,
    };
    return { bg: bgC, role: roleC, prop: propC, full, meta };
  }

  // ---------- 辅助函数 ----------
  function sampleEdgeColor(px, W, H) {
    // 取四边像素的中位色调作为背景种子色
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

  // 按蒙版从原图抠出一层：白色蒙版区域保留原图像素，其余透明
  function buildLayer(srcCanvas, keepFn) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const maskC = document.createElement('canvas');
    maskC.width = w; maskC.height = h;
    const mctx = maskC.getContext('2d');
    const im = mctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (keepFn(x, y)) {
          const o = (y * w + x) * 4;
          im.data[o] = 255; im.data[o + 1] = 255; im.data[o + 2] = 255; im.data[o + 3] = 255;
        }
      }
    }
    mctx.putImageData(im, 0, 0);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.drawImage(srcCanvas, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(maskC, 0, 0);
    return out;
  }

  function feather(canvas) {
    // 对 alpha 做一次 3x3 均值模糊，柔化边缘
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
