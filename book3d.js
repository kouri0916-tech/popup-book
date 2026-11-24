/* ============================================================
 * book3d.js — Three.js 立体书渲染
 *
 * 场景构成：
 *  - 桌面 + 柔和光照 + 阴影
 *  - 打开的立体书（左右纸页 + 中缝书脊）
 *  - 三层纸艺切片（背景平贴页底 / 角色立起 45° / 小物件更靠前立起）
 *  - OrbitControls 旋转缩放
 * ============================================================ */

const Book3D = (() => {

  let renderer, scene, camera, controls;
  let bookGroup;          // 书本整体（含页与层）
  let layerMeshes = {};   // {bg, role, prop}
  let clock;
  let autoRotate = false;
  let openT = 1;          // 书本开合 0~1（当前实现为固定打开姿态）
  let animationId = null;

  const LAYER_COLORS = { bg: 0x6ea8fe, role: 0xffa94d, prop: 0x69db7c };

  // ---------- 初始化 ----------
  function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x14121c, 14, 34);

    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 4.2, 7.2);

    // 光照
    const hemi = new THREE.HemisphereLight(0xcdd6ff, 0x2a2340, 0.9);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff2dd, 1.6);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -8; key.shadow.camera.right = 8;
    key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x8ea2ff, 0.5);
    rim.position.set(-6, 4, -4);
    scene.add(rim);

    // 桌面
    const desk = new THREE.Mesh(
      new THREE.CircleGeometry(16, 48),
      new THREE.MeshStandardMaterial({ color: 0x1d1930, roughness: 0.95 })
    );
    desk.rotation.x = -Math.PI / 2;
    desk.position.y = -0.55;
    desk.receiveShadow = true;
    scene.add(desk);

    // 书本组
    bookGroup = new THREE.Group();
    scene.add(bookGroup);

    // 控制器
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 3.5;
    controls.maxDistance = 16;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.target.set(0, 0.4, 0);
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

  // ---------- 构建立体书 ----------
  /**
   * @param {{bg,role,prop,full,meta}} layers segmenter 输出
   * @param {string} visibleLayer 'all' | 'bg' | 'role' | 'prop'
   */
  function buildBook(layers, visibleLayer = 'all') {
    clearBook();
    if (!layers) return;

    const W = 4.6, D = 3.2;          // 单页宽 / 页深
    const pageThick = 0.045;

    // 封面底板（打开状态的两块硬壳）
    const coverMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2b, roughness: 0.7 });
    for (const side of [-1, 1]) {
      const cover = new THREE.Mesh(new THREE.BoxGeometry(W, 0.06, D + 0.12), coverMat);
      cover.position.set(side * (W / 2 + 0.02), -0.03, 0);
      cover.castShadow = cover.receiveShadow = true;
      bookGroup.add(cover);
    }

    // 纸页（微黄）
    const pageMat = new THREE.MeshStandardMaterial({ color: 0xf3ead7, roughness: 0.9 });
    for (const side of [-1, 1]) {
      const page = new THREE.Mesh(new THREE.BoxGeometry(W - 0.06, pageThick, D - 0.04), pageMat);
      page.position.set(side * (W / 2), 0.02, 0);
      page.receiveShadow = true;
      bookGroup.add(page);
    }

    // 三层纸艺切片
    const defs = [
      { key: 'bg',   z: -0.9, tilt: 0,        y: 0.06 },   // 背景：平贴
      { key: 'role', z: 0.15, tilt: -Math.PI / 5, y: 0.9 },// 角色：立起约36°
      { key: 'prop', z: 0.85, tilt: -Math.PI / 4.5, y: 0.75 },// 小物件：更靠前更立
    ];

    for (const d of defs) {
      const tex = canvasTexture(layers[d.key]);
      const mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, alphaTest: 0.08,
        side: THREE.DoubleSide, roughness: 0.85,
      });
      // 图片宽高比
      const aspect = layers.meta.width / layers.meta.height;
      const planeH = D * 0.92, planeW = planeH * aspect;
      const geo = new THREE.PlaneGeometry(planeW, planeH, 24, 24);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;

      // 纸片轻微弯曲（顶点 z 偏移，模拟纸张弧度）
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        pos.setZ(i, Math.pow(Math.abs(x) / (planeW / 2), 2) * 0.06);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      const pivot = new THREE.Group();
      pivot.position.set(0, d.y, d.z);
      pivot.rotation.x = d.tilt;
      pivot.add(mesh);
      mesh.name = 'layer_' + d.key;
      bookGroup.add(pivot);
      layerMeshes[d.key] = pivot;
    }

    applyVisibility(visibleLayer);
  }

  function canvasTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function clearBook() {
    while (bookGroup.children.length) {
      const c = bookGroup.children.pop();
      c.traverse?.(o => {
        o.geometry?.dispose?.();
        if (o.material) {
          o.material.map?.dispose?.();
          o.material.dispose?.();
        }
      });
    }
    layerMeshes = {};
  }

  // ---------- 可见性 / 模式 ----------
  function applyVisibility(mode) {
    for (const [key, pivot] of Object.entries(layerMeshes)) {
      pivot.visible = mode === 'all' || mode === key;
    }
  }

  function setMode(mode) {
    // layers 模式：三层错开展示（爆炸视图）
    const explode = mode === 'layers';
    const offsets = { bg: { y: 0.06, z: -0.9 }, role: { y: 0.9, z: 0.15 }, prop: { y: 0.75, z: 0.85 } };
    for (const [key, pivot] of Object.entries(layerMeshes)) {
      const o = offsets[key];
      const spread = explode ? 1.15 : 1;
      const lift = explode ? 0.55 : 0;
      pivot.position.y = o.y + (key === 'bg' ? 0 : key === 'role' ? lift : lift * 1.8);
      pivot.position.z = o.z * spread;
      pivot.rotation.x = explode ? -Math.PI / 7 : (key === 'bg' ? 0 : key === 'role' ? -Math.PI / 5 : -Math.PI / 4.5);
    }
  }

  function setAutoRotate(on) {
    autoRotate = on;
    controls.autoRotate = on;
  }

  function resetView() {
    camera.position.set(0, 4.2, 7.2);
    controls.target.set(0, 0.4, 0);
    controls.update();
  }

  // ---------- 动画循环 ----------
  function animate() {
    animationId = requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    // 书本轻微呼吸浮动
    if (bookGroup) {
      bookGroup.position.y = Math.sin(t * 0.8) * 0.03;
      bookGroup.rotation.y = Math.sin(t * 0.3) * 0.02;
    }
    controls.update();
    renderer.render(scene, camera);
  }

  return { init, buildBook, applyVisibility, setMode, setAutoRotate, resetView };
})();
