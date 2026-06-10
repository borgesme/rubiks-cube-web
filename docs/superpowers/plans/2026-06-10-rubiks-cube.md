# 3x3 魔方单文件 Web 应用 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-06-10-rubiks-cube-design.md` 实现单文件 `index.html` 的物理级高保真 3x3 魔方，支持投影向量手势识别、1:1 跟手与磁吸回弹。

**Architecture:** 单文件 ES Module，importmap 从 unpkg 引入 three@0.160 / OrbitControls / @tweenjs/tween.js@23。魔方状态完全由 27 个 mesh 的世界坐标隐式表达（无 3D 状态数组）；旋转用临时 Pivot + attach/detach + 坐标取整清洗；手势用「面法线 → 候选轴切线 → 屏幕投影 → 点积匹配」算法。

**Tech Stack:** Three.js 0.160（ES Modules）、@tweenjs/tween.js 23、Canvas 2D（程序化纹理）、Pointer Events。

**测试说明:** 本项目为零构建的单文件可视化应用，无自动化测试框架。每个任务以「浏览器手动验收」作为验证步骤：用 `python -m http.server 8000`（或 `npx -y serve .`）启动静态服务，访问 `http://localhost:8000`，按验收点逐项确认，并检查 DevTools Console 无报错。执行者无法亲自操作浏览器时，必须向用户展示验收点并等待确认后再提交。

**Files:**
- Create: `index.html`（唯一交付物，所有任务都修改此文件）
- Plan/Spec: 已存在于 `docs/superpowers/`

---

### Task 1: HTML 骨架 + importmap + 场景搭建（光影环境）

**Files:**
- Create: `index.html`

- [ ] **Step 1: 创建完整骨架文件**

写入以下完整内容到 `index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3x3 魔方</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #1a1d24; }
  #app { width: 100%; height: 100%; touch-action: none; }
  #toolbar {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 12px; padding: 10px 14px;
    background: rgba(20, 22, 30, 0.7); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px; backdrop-filter: blur(8px); z-index: 10;
  }
  #toolbar button {
    font: 600 14px/1 system-ui, sans-serif; color: #eee;
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px; padding: 10px 18px; cursor: pointer;
    transition: background .15s, opacity .15s;
  }
  #toolbar button:hover:not(:disabled) { background: rgba(255,255,255,0.18); }
  #toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
  #hint {
    position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
    color: rgba(255,255,255,0.45); font: 13px/1.4 system-ui, sans-serif; z-index: 10;
    user-select: none; pointer-events: none; white-space: nowrap;
  }
</style>
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/",
    "@tweenjs/tween.js": "https://unpkg.com/@tweenjs/tween.js@23.1.1/dist/tween.esm.js"
  }
}
</script>
</head>
<body>
<div id="app"></div>
<div id="toolbar">
  <button id="btn-scramble">打乱 Scramble</button>
  <button id="btn-reset">重置 Reset</button>
</div>
<div id="hint">左键拖拽：转动层 · 右键拖拽：旋转视角 · 滚轮：缩放</div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as TWEEN from '@tweenjs/tween.js';

/* ========== 1. 常量与配置 ========== */
const CUBIE_SIZE = 1;
const SPACING = 0.06;                    // 小方块物理间隙
const STEP = CUBIE_SIZE + SPACING;       // 网格步长
const EPSILON = 0.5;                     // 层筛选阈值
const HALF_PI = Math.PI / 2;
const DEAD_ZONE = 8;                     // 手势判定死区（像素）
const SNAP_DURATION = 200;               // 磁吸回弹时长 ms
const SCRAMBLE_STEPS = 20;
const SCRAMBLE_DURATION = 100;           // 打乱单步时长 ms

const FACE_COLORS = {
  px: '#ff8c00', nx: '#c41e3a',          // 右橙 / 左红
  py: '#f8f8f8', ny: '#ffd500',          // 上白 / 下黄
  pz: '#009b48', nz: '#0046ad',          // 前绿 / 后蓝
};
const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/* ========== 3. 场景搭建 ========== */
const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d24);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(5, 5.5, 7);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(6, 10, 7);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -10;
dirLight.shadow.camera.right = 10;
dirLight.shadow.camera.top = 10;
dirLight.shadow.camera.bottom = -10;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 40;
scene.add(dirLight);

// 地面只接收阴影
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.ShadowMaterial({ opacity: 0.25 })
);
ground.rotation.x = -HALF_PI;
ground.position.y = -3;
ground.receiveShadow = true;
scene.add(ground);

// 操作分离：左键留给层旋转手势，右键旋转视角
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 20;
controls.enablePan = false;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

/* ========== 8. 主循环 ========== */
const tweenGroup = new TWEEN.Group();

renderer.setAnimationLoop(() => {
  tweenGroup.update();
  controls.update();
  renderer.render(scene, camera);
});
</script>
</body>
</html>
```

- [ ] **Step 2: 浏览器验收**

启动：`python -m http.server 8000`（后台运行），访问 `http://localhost:8000`。

验收点：
1. 深色背景全屏画布，顶部两个按钮、底部提示文字。
2. 右键拖拽可旋转视角（目前场景为空，观察不到变化属正常，可暂用滚轮确认 controls 生效无报错）。
3. Console 无报错（importmap 三个依赖均加载成功）。

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: 搭建单文件骨架与 Three.js 场景（光影/地面/视角控制）"
```

---

### Task 2: Canvas 程序化纹理 + 27 个 Cubie 构建

**Files:**
- Modify: `index.html`（在「常量与配置」区块之后、「场景搭建」之前插入纹理工厂；在 controls 配置之后插入魔方构建）

- [ ] **Step 1: 插入纹理工厂区块**

在 `/* ========== 1. 常量与配置 ========== */` 区块结尾（`const AXES = {...};` 之后）插入：

```js
/* ========== 2. 纹理工厂（Canvas 程序化生成，零外部素材） ========== */
const materialCache = new Map();

// 绘制带圆角贴纸的纹理：黑边底色 + 圆角主体色 + 暗描边 + 顶部高光渐变
function createStickerTexture(colorHex) {
  const S = 256, PAD = 18, R = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  // 塑料黑边底色
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, S, S);
  // 圆角贴纸主体
  ctx.beginPath();
  ctx.roundRect(PAD, PAD, S - PAD * 2, S - PAD * 2, R);
  ctx.fillStyle = colorHex;
  ctx.fill();
  // 边缘微暗描边，增强倒角立体感
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4;
  ctx.stroke();
  // 顶部高光渐变，模拟贴纸塑料反光
  const grad = ctx.createLinearGradient(0, PAD, 0, S * 0.6);
  grad.addColorStop(0, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(PAD, PAD, S - PAD * 2, S - PAD * 2, R);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function getMaterial(colorHex) {
  if (!materialCache.has(colorHex)) {
    materialCache.set(colorHex, new THREE.MeshStandardMaterial({
      map: createStickerTexture(colorHex),
      roughness: 0.35,
      metalness: 0.05,
    }));
  }
  return materialCache.get(colorHex);
}

// 内侧不外露面的纯黑塑料材质
const blackMaterial = new THREE.MeshStandardMaterial({
  color: 0x0a0a0a, roughness: 0.6, metalness: 0.05,
});
```

- [ ] **Step 2: 插入魔方构建区块**

在 `window.addEventListener('contextmenu', ...)` 之后、`/* ========== 8. 主循环 ========== */` 之前插入：

```js
/* ========== 4. 魔方构建 ========== */
const cubies = [];
const cubieGeometry = new THREE.BoxGeometry(CUBIE_SIZE, CUBIE_SIZE, CUBIE_SIZE);

function buildCube() {
  for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++)
  for (let z = -1; z <= 1; z++) {
    // BoxGeometry 材质顺序：+x, -x, +y, -y, +z, -z；仅外露面贴彩色贴纸
    const mats = [
      x === 1  ? getMaterial(FACE_COLORS.px) : blackMaterial,
      x === -1 ? getMaterial(FACE_COLORS.nx) : blackMaterial,
      y === 1  ? getMaterial(FACE_COLORS.py) : blackMaterial,
      y === -1 ? getMaterial(FACE_COLORS.ny) : blackMaterial,
      z === 1  ? getMaterial(FACE_COLORS.pz) : blackMaterial,
      z === -1 ? getMaterial(FACE_COLORS.nz) : blackMaterial,
    ];
    const cubie = new THREE.Mesh(cubieGeometry, mats);
    cubie.position.set(x * STEP, y * STEP, z * STEP);
    cubie.castShadow = true;
    cubie.receiveShadow = true;
    scene.add(cubie);
    cubies.push(cubie);
  }
}

function destroyCube() {
  for (const c of cubies) scene.remove(c);
  cubies.length = 0;
}

buildCube();
```

- [ ] **Step 3: 浏览器验收**

刷新 `http://localhost:8000`。

验收点：
1. 可见 3×3×3 魔方，六面配色正确（上白下黄、前绿后蓝、右橙左红）。
2. 贴纸为圆角矩形、四周有黑边、上部有高光；小方块之间有清晰间隙。
3. 地面有柔和阴影；右键拖拽旋转视角、滚轮缩放正常。
4. Console 无报错。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: Canvas 程序化圆角贴纸纹理与 27 个带间隙 Cubie"
```

---

### Task 3: 旋转引擎（动态层筛选 + Pivot 变换 + 坐标清洗）

**Files:**
- Modify: `index.html`（在「魔方构建」区块之后插入旋转引擎；`tweenGroup` 定义需从主循环区块上移）

- [ ] **Step 1: 移动 tweenGroup 定义**

将主循环区块中的 `const tweenGroup = new TWEEN.Group();` 删除，移至本任务新增的旋转引擎区块开头（见 Step 2），保证 `rotateLayer` 可引用。主循环区块变为：

```js
/* ========== 8. 主循环 ========== */
renderer.setAnimationLoop(() => {
  tweenGroup.update();
  controls.update();
  renderer.render(scene, camera);
});
```

- [ ] **Step 2: 插入旋转引擎区块**

在 `buildCube();` 之后插入：

```js
/* ========== 5. 旋转引擎 ========== */
const tweenGroup = new TWEEN.Group();
let isRotating = false; // 状态锁：动画期间禁止新的旋转与按钮操作

// 动态层级筛选：不写死索引，基于世界坐标 + 阈值判断方块归属
const _wp = new THREE.Vector3();
function selectLayer(axis, layerCoord) {
  return cubies.filter((c) => {
    c.getWorldPosition(_wp);
    return Math.abs(_wp[axis] - layerCoord * STEP) < EPSILON;
  });
}

/**
 * Pivot 挂载逻辑（关键考点）：
 * 1. 创建临时轴心 pivot 置于原点；
 * 2. pivot.attach(cubie)：attach 自动重算局部矩阵以保持世界变换不变，
 *    免去手动处理复杂的四元数乘法；
 * 3. 旋转 pivot 即可带动整层方块；
 * 4. 结束后 scene.attach(cubie) 将方块放回场景（同样保持世界变换），销毁 pivot。
 */
function createPivot(axis, layerCoord) {
  const pivot = new THREE.Object3D();
  scene.add(pivot);
  for (const c of selectLayer(axis, layerCoord)) pivot.attach(c);
  return pivot;
}

// 放回场景 + 坐标清洗：位置对齐网格、欧拉角对齐 π/2，
// 消除浮点累积误差，防止多次旋转后魔方“散架”
function releasePivot(pivot) {
  for (const c of [...pivot.children]) scene.attach(c);
  scene.remove(pivot);
  for (const c of cubies) {
    c.position.set(
      Math.round(c.position.x / STEP) * STEP,
      Math.round(c.position.y / STEP) * STEP,
      Math.round(c.position.z / STEP) * STEP,
    );
    c.rotation.set(
      Math.round(c.rotation.x / HALF_PI) * HALF_PI,
      Math.round(c.rotation.y / HALF_PI) * HALF_PI,
      Math.round(c.rotation.z / HALF_PI) * HALF_PI,
    );
  }
}

// 程序化旋转某层（Scramble 等使用）
function rotateLayer(axis, layerCoord, direction, duration, onComplete) {
  isRotating = true;
  const pivot = createPivot(axis, layerCoord);
  const state = { angle: 0 };
  new TWEEN.Tween(state, tweenGroup)
    .to({ angle: direction * HALF_PI }, duration)
    .easing(TWEEN.Easing.Quadratic.Out)
    .onUpdate(() => { pivot.rotation[axis] = state.angle; })
    .onComplete(() => {
      releasePivot(pivot);
      isRotating = false;
      if (onComplete) onComplete();
    })
    .start();
}

// 临时调试出口（Task 5 移除）
window.__cube = { rotateLayer, selectLayer, cubies };
```

- [ ] **Step 3: 浏览器验收**

刷新页面，在 DevTools Console 执行：

```js
__cube.rotateLayer('y', 1, 1, 300)            // 顶层旋转 90°
__cube.selectLayer('y', 1).length             // 应输出 9
__cube.rotateLayer('x', -1, -1, 300)          // 左层反向旋转 90°
__cube.cubies.map(c => c.position.x / 1.06)   // 所有值应为精确的 -1/0/1（验证坐标清洗）
```

验收点：
1. 顶层/左层平滑转动 90°，无方块漂移或脱层。
2. `selectLayer` 返回 9 个方块。
3. 多次旋转后所有 `position` 分量除以 1.06 均为整数（允许 1e-10 级误差显示为整数）。
4. Console 无报错。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: 旋转引擎——世界坐标动态筛层、Pivot attach 变换与坐标清洗"
```

---

### Task 4: 手势系统（投影向量识别 + 1:1 跟手 + 磁吸）

**Files:**
- Modify: `index.html`（在「旋转引擎」区块之后插入手势系统）

- [ ] **Step 1: 插入手势系统区块**

在 `window.__cube = ...;` 之后插入：

```js
/* ========== 6. 手势系统 ========== */
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

// 世界坐标 → 屏幕像素坐标
function worldToScreen(v) {
  const p = v.clone().project(camera);
  return new THREE.Vector2((p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight);
}

let drag = null; // 当前手势状态

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || isRotating || drag) return;
  pointerNDC.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(cubies);
  if (!hits.length) return;

  const hit = hits[0];
  // 表面法线：face.normal 为局部坐标，变换到世界空间后取整对齐坐标轴
  const normal = hit.face.normal.clone()
    .applyQuaternion(hit.object.getWorldQuaternion(new THREE.Quaternion()))
    .round();

  drag = {
    point: hit.point.clone(),  // 点击处世界坐标
    normal,                    // 世界空间表面法线（轴对齐）
    start: new THREE.Vector2(e.clientX, e.clientY),
    determined: false,         // 是否已判定旋转轴
    pivot: null, axis: null, angle: 0,
    screenDir: null, pixelsPerUnit: 0, radius: 0,
  };
  renderer.domElement.setPointerCapture(e.pointerId);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const D = new THREE.Vector2(e.clientX, e.clientY).sub(drag.start);

  if (!drag.determined) {
    if (D.length() < DEAD_ZONE) return;

    /**
     * 手势投影算法（核心考点）：
     * 1. 法线 N 排除自身所在轴，剩下两个世界轴为候选旋转轴 A；
     * 2. 绕轴 A 转动时，点击点沿切线 T = A × N 移动（叉乘）；
     * 3. 将 T 投影到屏幕得 2D 向量 S，与鼠标位移 D 做点积；
     * 4. |dot| 最大者 = 与滑动方向最匹配的轴，即为用户意图。
     *
     * 方向修正：旋转角直接取带符号的 dot(D, S)。点击点沿法线方向的
     * 分量恒为正（永远点在外表面），绕 A 正向旋转必使该点沿 +T 移动，
     * 因此 dot > 0 ⇔ 鼠标顺切线滑 ⇔ 层顺切线转——无论从正面、背面
     * 还是顶面操作，跟手方向天然一致，无需按面分类取反。
     */
    const candidates = [];
    for (const name of ['x', 'y', 'z']) {
      if (Math.abs(drag.normal[name]) > 0.5) continue; // 排除法线所在轴
      const tangent = new THREE.Vector3().crossVectors(AXES[name], drag.normal);
      const s0 = worldToScreen(drag.point);
      const s1 = worldToScreen(drag.point.clone().add(tangent));
      candidates.push({ name, screenVec: s1.sub(s0) });
    }

    const dNorm = D.clone().normalize();
    candidates.sort((a, b) =>
      Math.abs(b.screenVec.clone().normalize().dot(dNorm)) -
      Math.abs(a.screenVec.clone().normalize().dot(dNorm)));
    // 退化保护：最佳轴切线近乎垂直屏幕（投影过短）时换另一轴
    let best = candidates[0];
    if (best.screenVec.length() < 2 && candidates[1].screenVec.length() >= 2) {
      best = candidates[1];
    }

    const axis = best.name;
    const layerCoord = THREE.MathUtils.clamp(Math.round(drag.point[axis] / STEP), -1, 1);

    drag.axis = axis;
    drag.pivot = createPivot(axis, layerCoord);
    drag.screenDir = best.screenVec.clone().normalize();
    drag.pixelsPerUnit = best.screenVec.length();        // 屏幕像素 / 世界单位
    drag.radius = Math.abs(drag.point.dot(drag.normal)); // 点击点沿法线方向的分量
    drag.start.set(e.clientX, e.clientY);                // 从判定点重新累计，避免跳变
    drag.determined = true;
    isRotating = true;
    return;
  }

  // 1:1 实时跟手：鼠标沿切线投影方向移动 d 像素
  // → 世界距离 d / pixelsPerUnit → 旋转角 = 世界距离 / radius
  const pixels = D.dot(drag.screenDir);
  drag.angle = pixels / drag.pixelsPerUnit / drag.radius;
  drag.pivot.rotation[drag.axis] = drag.angle;
});

// 磁吸效果：松手后对齐到最近的 90° 倍数
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.determined) return; // 仅点击未拖动

  const snapped = Math.round(d.angle / HALF_PI) * HALF_PI;
  const state = { angle: d.angle };
  new TWEEN.Tween(state, tweenGroup)
    .to({ angle: snapped }, SNAP_DURATION)
    .easing(TWEEN.Easing.Quadratic.Out)
    .onUpdate(() => { d.pivot.rotation[d.axis] = state.angle; })
    .onComplete(() => {
      releasePivot(d.pivot);
      isRotating = false;
    })
    .start();
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
```

- [ ] **Step 2: 浏览器验收**

刷新页面。

验收点：
1. 左键在任意面水平/垂直拖动：对应层 1:1 跟手转动，慢动慢转、快动快转。
2. 松手后磁吸回弹至最近 90°，无错位。
3. 旋转视角到背面、顶面、底面分别操作：滑动方向与层转动方向始终视觉一致（无反转）。
4. 左键点击空白处拖动：无层旋转、视角也不转；右键拖拽视角正常。
5. 拖动小于 8px 即松手：无任何旋转发生。
6. 拖动中鼠标移出窗口再松开：层仍正确磁吸归位。
7. Console 无报错。

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: 投影向量手势识别、1:1 实时跟手与磁吸回弹"
```

---

### Task 5: Scramble / Reset 按钮 + 移除调试出口

**Files:**
- Modify: `index.html`（在「手势系统」区块之后插入 UI 控制；删除调试出口）

- [ ] **Step 1: 删除调试出口**

删除 Task 3 添加的这一行及其注释：

```js
// 临时调试出口（Task 5 移除）
window.__cube = { rotateLayer, selectLayer, cubies };
```

- [ ] **Step 2: 插入 UI 控制区块**

在手势系统区块之后（`addEventListener('pointercancel', endDrag);` 之后）、主循环之前插入：

```js
/* ========== 7. UI 控制 ========== */
const btnScramble = document.getElementById('btn-scramble');
const btnReset = document.getElementById('btn-reset');

function setButtonsEnabled(on) {
  btnScramble.disabled = !on;
  btnReset.disabled = !on;
}

btnScramble.addEventListener('click', () => {
  if (isRotating || drag) return;
  setButtonsEnabled(false);

  const axes = ['x', 'y', 'z'];
  const moves = [];
  let last = null;
  while (moves.length < SCRAMBLE_STEPS) {
    const move = {
      axis: axes[Math.floor(Math.random() * 3)],
      layer: Math.floor(Math.random() * 3) - 1,
      dir: Math.random() < 0.5 ? 1 : -1,
    };
    // 避免与上一步同轴同层（防止互逆抵消）
    if (last && move.axis === last.axis && move.layer === last.layer) continue;
    moves.push(move);
    last = move;
  }

  let i = 0;
  (function next() {
    if (i >= moves.length) { setButtonsEnabled(true); return; }
    const m = moves[i++];
    rotateLayer(m.axis, m.layer, m.dir, SCRAMBLE_DURATION, next);
  })();
});

btnReset.addEventListener('click', () => {
  if (isRotating || drag) return;
  destroyCube();
  buildCube();
});
```

- [ ] **Step 3: 浏览器验收**

刷新页面。

验收点：
1. 点击「打乱」：连续播放 20 步随机旋转，期间两按钮禁用，结束后恢复。
2. 打乱后继续左键手势操作，层筛选与方向依然正确（验证动态筛层不依赖索引）。
3. 点击「重置」：魔方瞬间恢复六面同色初始状态。
4. 打乱动画进行中左键拖拽无效（状态锁生效）。
5. `window.__cube` 在 Console 中为 undefined。
6. Console 无报错。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: Scramble 随机打乱与 Reset 重置功能"
```

---

### Task 6: 最终验收（设计文档第 7 节完整清单）

**Files:** 无修改（纯验证；如发现缺陷，修复后补充提交）

- [ ] **Step 1: 完整手动验收**

按设计文档第 7 节逐项执行：

1. 加载后可见带阴影、圆角贴纸、有间隙的 3×3×3 魔方。
2. 右键拖拽旋转视角；左键空白处拖拽无反应。
3. 左键在任意面上沿水平/垂直拖动，对应层 1:1 跟手转动。
4. 从正面、背面、顶面、侧面分别操作，方向直觉一致。
5. 松手后磁吸对齐 90°，无错位、无方块漂移。
6. Scramble 播放 20 步打乱；之后手势操作依然正确。
7. 连续打乱 + 手动旋转 50+ 次后方块仍严格对齐网格。
8. Reset 后恢复初始状态。
9. 全程 Console 无报错。

- [ ] **Step 2: 如有缺陷**

使用 superpowers:systematic-debugging 技能定位修复，修复后重跑相关验收点并提交：

```bash
git add index.html
git commit -m "fix: <具体缺陷描述>"
```

---

## 自审记录

- **规格覆盖**：交付规范（Task 1 importmap/单文件）、视觉物理（Task 1 光影 + Task 2 纹理/间隙）、核心逻辑（Task 3 筛层/Pivot/清洗）、交互系统（Task 4 全部手势考点）、代码质量（各任务注释 + Task 5 按钮）——全部覆盖。
- **占位符**：无 TBD/TODO，所有步骤含完整代码。
- **类型一致性**：`selectLayer/createPivot/releasePivot/rotateLayer/buildCube/destroyCube/worldToScreen/endDrag` 与各任务引用处签名一致；`tweenGroup` 在 Task 3 上移后先于使用定义。
