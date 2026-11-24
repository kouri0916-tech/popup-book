/* ============================================================
 * book3d.js — Three.js 真实纸艺立体书渲染（v2）
 *
 * 三种立体书结构（用户可选）：
 *  1. vfold   V型折页：书页打开时角色层沿中缝呈 V 字立起，
 *             背景平铺于左右页，小物件散立页面前缘。
 *  2. tunnel  隧道景片：多层平行排列向内延伸，层层递进如隧道。
 *  3. popup   弹起式：打开书页时元素从页缝"弹起"立起（带动画）。
 *
 * 通用特性：
 *  - 开书/合书动画（封面 0°~180° 翻转 + 元素随开度立起）
 *  - 各层投影到书页（假阴影平面，纸艺感）
 *  - 元素单独显示 / 分层爆炸视图
 * ============================================================ */

const Book3D = (() => {

  let renderer, scene, camera, controls, clock;
  let bookGroup = null;      // init() 时创建（需 THREE 就绪）
  let animatables = [];      // [{obj, type, base, dir}] 开书动画驱动
  let layerMeshes = {};      // {bg, role, prop_0, ...}
  let currentLayers = null;
  let currentStyle = 'vfold';
  let openAmount = 0;        // 0 合上 → 1 打开
  let openTarget = 1;
  let autoRotate = false;

  const PAGE_W = 4.2, PAGE_D = 3.0;

  // ---------- 初始化 ----------
  function init(canvas) {
    bookGroup = new THREE.Group();
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x14121c, 16, 40);

    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 5.2, 8.2);

    scene.add(new THREE.HemisphereLight(0xcdd6ff, 0x2a2340, 0.85));

    const key = new THREE.DirectionalLight(0xfff2dd, 1.7);
    key.position.set(4, 9, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9 });
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x8ea2ff, 0.45);
    rim.position.set(-6, 4, -5);
    scene.add(rim);

    const desk = new THREE.Mesh(
      new THREE.CircleGeometry(18, 48),
      new THREE.MeshStandardMaterial({ color: 0x1d1930, roughness: 0.95 })
    );
    desk.rotation.x = -Math.PI / 2;
    desk.position.y = -0.62;
    desk.receiveShadow = true;
    scene.add(desk);

    scene.add(bookGroup);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 3.5;
    controls.maxDistance = 18;
    controls.maxPolarAngle = Math.PI / 2.02;
    controls.target.set(0, 0.5, 0);
    controls.autoRotateSpeed = 1.2;

    clock = new THREE.Clock();
    resize();
    window.addEventListener('resize', resize);
    animate();
  }

  function resize() {
    const canvas = renderer.domElement;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ---------- 纸片网格（带折痕弯曲 + 厚度感）----------
  function paperMesh(canvas, opts = {}) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const aspect = canvas.width / canvas.height;
    const h = opts.height || 2.4;
    const geo = new THREE.PlaneGeometry(h * aspect, h, 20, 20);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.08,
      side: THREE.DoubleSide, roughness: 0.9,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    return mesh;
  }

  // 假阴影：半透明黑色椭圆贴片，放在元素脚下
  function blobShadow(w, h) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  function clearBook() {
    while (bookGroup.children.length) {
      const c = bookGroup.children.pop();
      c.traverse?.(o => {
        o.geometry?.dispose?.();
        if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); }
      });
    }
    animatables = [];
    layerMeshes = {};
  }

  // ---------- 构建立体书 ----------
  function buildBook(layers, style = 'vfold') {
    clearBook();
    currentLayers = layers;
    currentStyle = style;
    if (!layers) return;

    buildCovers();

    if (style === 'vfold') buildVFold(layers);
    else if (style === 'tunnel') buildTunnel(layers);
    else buildPopUp(layers);

    setOpen(openTarget, true);   // 立即应用当前开合状态
  }

  // 封面 + 内页（左右两块硬壳，可绕书脊旋转）
  function buildCovers() {
    const coverMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2b, roughness: 0.65 });
    const pageMat = new THREE.MeshStandardMaterial({ color: 0xf3ead7, roughness: 0.92 });

    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();          // 旋转轴在书脊
      pivot.position.set(0, 0, 0);

      const cover = new THREE.Mesh(new THREE.BoxGeometry(PAGE_W, 0.07, PAGE_D + 0.14), coverMat);
      cover.position.set(side * PAGE_W / 2, -0.035, 0);
      cover.castShadow = cover.receiveShadow = true;
      pivot.add(cover);

      const page = new THREE.Mesh(new THREE.BoxGeometry(PAGE_W - 0.05, 0.04, PAGE_D - 0.04), pageMat);
      page.position.set(side * PAGE_W / 2, 0.02, 0);
      page.receiveShadow = true;
      pivot.add(page);

      pivot.userData.side = side;
      bookGroup.add(pivot);
      animatables.push({ obj: pivot, type: 'cover', side });
    }
  }

  /* ===== 1. V 型折页 =====
   * 角色层：两半沿中缝立起成 V 字（左半随左页立、右半随右页立）
   * 实现：角色图切成左右两半，各自贴在随开度旋转的斜面上。
   * 背景：平铺在左右内页上。
   * 小物件：立在页面前缘，随开度从躺到立。
   */
  function buildVFold(layers) {
    const { bg, role, props, meta } = layers;
    const aspect = meta.width / meta.height;

    // --- 背景平铺左右页 ---
    if (bg) {
      const half = cropHalf(bg, 'left');
      const right = cropHalf(bg, 'right');
      for (const [halfC, side] of [[half, -1], [right, 1]]) {
        const m = paperMesh(halfC, { height: PAGE_D * 0.94 });
        m.rotation.x = -Math.PI / 2;
        m.position.set(side * PAGE_W / 2, 0.045, 0);
        m.rotation.z = side * Math.PI;   // 保持图方向正确
        m.visible = true;
        m.name = 'layer_bg';
        m.userData.isBg = true;
        bookGroup.add(m);
        layerMeshes['bg'] = layerMeshes['bg'] || [];
        layerMeshes['bg'].push(m);
      }
    }

    // --- 角色 V 字立起 ---
    if (role) {
      const lh = cropHalf(role, 'left');
      const rh = cropHalf(role, 'right');
      for (const [halfC, side] of [[lh, -1], [rh, 1]]) {
        if (!halfC.dataset?.empty) {
          const m = paperMesh(halfC, { height: 2.3 });
          const pivot = new THREE.Group();
          pivot.position.set(side * 0.02, 0.05, -0.1);
          m.position.set(side * 0.75, 0, 0);
          pivot.add(m);
          const sh = blobShadow(1.6, 1.0);
          sh.position.set(side * 0.75, 0.05, 0.35);
          pivot.add(sh);
          m.name = 'layer_role';
          bookGroup.add(pivot);
          animatables.push({ obj: pivot, type: 'vfold', side });
          layerMeshes['role'] = layerMeshes['role'] || [];
          layerMeshes['role'].push(pivot);
        }
      }
    }

    // --- 小物件立在页面前缘 ---
    props.forEach((p, i) => {
      const m = paperMesh(p.canvas, { height: 1.1 });
      const side = i % 2 === 0 ? -1 : 1;
      const px = side * (1.2 + (i / props.length) * 1.4);
      const pivot = new THREE.Group();
      pivot.position.set(px, 0.05, 0.85 - (i % 3) * 0.25);
      pivot.add(m);
      const sh = blobShadow(0.9, 0.55);
      sh.position.set(0, 0.03, 0.15);
      pivot.add(sh);
      m.name = 'layer_prop_' + i;
      bookGroup.add(pivot);
      animatables.push({ obj: pivot, type: 'stand', side });
      layerMeshes['prop_' + i] = [pivot];
    });
  }

  /* ===== 2. 隧道景片 =====
   * 背景在最里（贴后墙），角色居中，小物件按原位置前后分布，
   * 全部平行于封面、层层向内递进，像隧道书。
   */
  function buildTunnel(layers) {
    const { bg, role, props, meta } = layers;

    // 后墙：背景
    if (bg) {
      const m = paperMesh(bg, { height: PAGE_D * 1.05 });
      m.position.set(0, 1.1, -1.15);
      m.name = 'layer_bg';
      bookGroup.add(m);
      layerMeshes['bg'] = [m];
    }

    // 角色：中间景片
    if (role) {
      const m = paperMesh(role, { height: 2.1 });
      m.position.set(0, 0.95, -0.25);
      const sh = blobShadow(1.8, 1.1);
      sh.position.set(0, 0.04, -0.1);
      bookGroup.add(m); bookGroup.add(sh);
      m.name = 'layer_role';
      layerMeshes['role'] = [m];
    }

    // 小物件：按原图位置映射到 z 深度（越靠下越靠前）
    props.forEach((p, i) => {
      const m = paperMesh(p.canvas, { height: 1.15 });
      const ny = p.box.y / meta.height;              // 0 顶 → 1 底
      const nx = p.box.x / meta.width - 0.5;
      const z = 0.75 - ny * 1.6;                     // 底部元素更靠前
      m.position.set(nx * 4.5, 0.55 + (1 - ny) * 0.5, z);
      const sh = blobShadow(0.9, 0.5);
      sh.position.set(m.position.x, 0.04, z + 0.12);
      bookGroup.add(m); bookGroup.add(sh);
      m.name = 'layer_prop_' + i;
      layerMeshes['prop_' + i] = [m];
    });
  }

  /* ===== 3. 弹起式 =====
   * 打开书页时角色从小缝中"弹起"（旋转 + 上移动画），
   * 小物件从平贴状态立起。合书时全部压平。
   */
  function buildPopUp(layers) {
    const { bg, role, props } = layers;

    if (bg) {
      const half = cropHalf(bg, 'left');
      const right = cropHalf(bg, 'right');
      for (const [halfC, side] of [[half, -1], [right, 1]]) {
        const m = paperMesh(halfC, { height: PAGE_D * 0.94 });
        m.rotation.x = -Math.PI / 2;
        m.position.set(side * PAGE_W / 2, 0.045, 0);
        m.rotation.z = side * Math.PI;
        m.name = 'layer_bg';
        bookGroup.add(m);
        layerMeshes['bg'] = layerMeshes['bg'] || [];
        layerMeshes['bg'].push(m);
      }
    }

    if (role) {
      const m = paperMesh(role, { height: 2.4 });
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.06, -0.15);
      m.position.y = 1.15;           // 纸片中心抬到半高，绕底部翻起
      pivot.add(m);
      const sh = blobShadow(1.9, 1.1);
      sh.position.set(0, 0.05, 0.3);
      pivot.add(sh);
      m.name = 'layer_role';
      bookGroup.add(pivot);
      animatables.push({ obj: pivot, type: 'popup', side: 0 });
      layerMeshes['role'] = [pivot];
    }

    props.forEach((p, i) => {
      const m = paperMesh(p.canvas, { height: 1.0 });
      const side = i % 2 === 0 ? -1 : 1;
      const pivot = new THREE.Group();
      pivot.position.set(side * (1.0 + (i / Math.max(1, props.length)) * 1.3), 0.05, 0.7 - (i % 3) * 0.3);
      m.position.y = 0.45;
      pivot.add(m);
      const sh = blobShadow(0.85, 0.5);
      sh.position.set(0, 0.03, 0.12);
      pivot.add(sh);
      m.name = 'layer_prop_' + i;
      bookGroup.add(pivot);
      animatables.push({ obj: pivot, type: 'stand', side });
      layerMeshes['prop_' + i] = [pivot];
    });
  }

  // ---------- 把 canvas 切成左右两半 ----------
  function cropHalf(canvas, side) {
    const w = canvas.width, h = canvas.height;
    const out = document.createElement('canvas');
    out.width = Math.max(1, w >> 1); out.height = h;
    const ctx = out.getContext('2d');
    if (side === 'left') ctx.drawImage(canvas, 0, 0, w >> 1, h, 0, 0, w >> 1, h);
    else ctx.drawImage(canvas, w >> 1, 0, w - (w >> 1), h, 0, 0, w - (w >> 1), h);
    // 检查是否全透明
    const d = ctx.getImageData(0, 0, out.width, out.height).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 10) opaque++;
    out.dataset.empty = opaque < 4 ? '1' : '0';
    return out;
  }

  // ---------- 开合动画 ----------
  function setOpen(amount, instant = false) {
    openTarget = amount;
    if (instant) openAmount = amount;
  }

  function applyOpen(a) {
    const ang = a * Math.PI;   // 0 → 合上(180°)，1 → 打开(0°)
    for (const it of animatables) {
      if (it.type === 'cover') {
        // 封面绕书脊旋转：合上时两半竖直对合，打开时平摊
        it.obj.rotation.y = it.side * (Math.PI - ang) / 2 * -1 + (it.side < 0 ? 0 : 0);
        it.obj.rotation.y = it.side < 0 ? (Math.PI - ang) / 2 : -(Math.PI - ang) / 2;
      } else if (it.type === 'vfold') {
        // V 字：随开度从平贴(0)立到 55°
        it.obj.rotation.z = it.side * -a * 0.96;
        it.obj.rotation.x = 0;
        it.obj.position.y = 0.05 + a * 0.15;
      } else if (it.type === 'popup') {
        // 弹起：绕底边从平躺(0)翻到直立(80°)
        it.obj.rotation.x = -a * 1.4;
        it.obj.position.y = 0.06 + a * 0.1;
      } else if (it.type === 'stand') {
        // 小物件立起
        it.obj.rotation.x = -a * 1.2;
        it.obj.position.y = 0.05 + a * 0.12;
      }
    }
  }

  // ---------- 可见性 / 模式 ----------
  function applyVisibility(mode) {
    for (const [key, list] of Object.entries(layerMeshes)) {
      const kind = key.startsWith('prop') ? 'prop' : key;
      const visible = mode === 'all' || mode === kind;
      list.forEach(o => o.visible = visible);
    }
  }

  function setMode(mode) {
    const explode = mode === 'layers';
    for (const [key, list] of Object.entries(layerMeshes)) {
      list.forEach(o => {
        if (explode) {
          o.userData.basePos = o.userData.basePos || o.position.clone();
          const kind = key.startsWith('prop') ? 'prop' : key;
          const lift = kind === 'bg' ? 1.6 : kind === 'role' ? 0.9 : 0.3;
          o.position.y = o.userData.basePos.y + lift;
        } else if (o.userData.basePos) {
          o.position.copy(o.userData.basePos);
        }
      });
    }
  }

  function setStyle(style) {
    if (!currentLayers) return;
    buildBook(currentLayers, style);
  }

  function setAutoRotate(on) { autoRotate = on; controls.autoRotate = on; }

  function resetView() {
    camera.position.set(0, 5.2, 8.2);
    controls.target.set(0, 0.5, 0);
    controls.update();
  }

  function toggleBook() {
    setOpen(openTarget > 0.5 ? 0 : 1);
  }

  // ---------- 动画循环 ----------
  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    const t = clock.getElapsedTime();

    // 开合插值
    if (Math.abs(openAmount - openTarget) > 0.001) {
      openAmount += (openTarget - openAmount) * Math.min(1, dt * 3.2);
      applyOpen(openAmount);
    }
    // 呼吸浮动
    bookGroup.position.y = Math.sin(t * 0.8) * 0.03;
    bookGroup.rotation.y = Math.sin(t * 0.3) * 0.02;

    controls.update();
    renderer.render(scene, camera);
  }

  return { init, buildBook, applyVisibility, setMode, setStyle, setAutoRotate, resetView, toggleBook, setOpen, layerMeshes };
})();
