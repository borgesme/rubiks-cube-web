# 3x3 魔方 Web 应用 — 详细设计文档

日期：2026-06-10
需求来源：`docs/prompt.md`
交付物：单个 `index.html` 文件（HTML/CSS/JS 合一）

---

## 1. 总体架构

单文件、零构建、零外部素材。页面结构分三部分：

| 部分 | 内容 |
|---|---|
| HTML | 一个全屏 `<canvas>` 容器 + 顶部工具栏（Scramble / Reset 按钮、状态提示） |
| CSS | 全屏布局、按钮样式、禁用状态样式（动画进行中按钮置灰） |
| JS (ES Module) | 通过 `<script type="importmap">` 映射依赖，`<script type="module">` 实现全部逻辑 |

### 1.1 依赖（importmap，unpkg CDN）

```json
{
  "imports": {
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/",
    "@tweenjs/tween.js": "https://unpkg.com/@tweenjs/tween.js@23.1.1/dist/tween.esm.js"
  }
}
```

- `OrbitControls` 从 `three/addons/controls/OrbitControls.js` 引入。
- Tween.js 使用 `Group` 实例（v23 API）统一管理动画，主循环中 `tweenGroup.update()`。

### 1.2 JS 模块划分（单文件内按区块组织）

1. **常量与配置** — 尺寸、间距、颜色表、动画时长、Epsilon 等
2. **纹理工厂** — Canvas 程序化生成贴纸纹理
3. **场景搭建** — renderer / camera / lights / ground / OrbitControls
4. **魔方构建** — 27 个 Cubie 的创建与编排
5. **旋转引擎** — 层筛选、Pivot 变换、坐标清洗、动画队列
6. **手势系统** — 射线检测、投影向量意图判断、1:1 跟手、磁吸回弹
7. **UI 控制** — Scramble / Reset 按钮逻辑
8. **主循环** — requestAnimationFrame：tween 更新 + controls 更新 + 渲染

---

## 2. 视觉与物理标准

### 2.1 模型参数

| 参数 | 值 | 说明 |
|---|---|---|
| `CUBIE_SIZE` | 1.0 | 小方块边长 |
| `SPACING` | 0.06 | 物理间隙 |
| `STEP` | `CUBIE_SIZE + SPACING` = 1.06 | 网格步长，cubie 中心坐标为 `{-STEP, 0, +STEP}` 的组合 |
| `EPSILON` | 0.5 | 层筛选阈值（远小于 STEP，足够容错） |

27 个 Cubie 各自为独立 `THREE.Mesh`（`BoxGeometry` + 6 个材质的数组），加入一个 `cubeGroup`（仅作整体容器，旋转操作直接在 scene 空间进行）。

### 2.2 程序化纹理（Canvas）

`createStickerTexture(colorHex)` 工厂函数：

1. 创建 256×256 离屏 canvas。
2. 整底填充近黑色 `#0a0a0a`（模拟塑料黑边）。
3. 用 `roundRect`（圆角半径 ~32px，内边距 ~18px）绘制贴纸主体色。
4. 叠加高光：在贴纸区域上部绘制一层白色线性渐变（透明度 0.25 → 0），模拟塑料贴纸反光。
5. 贴纸边缘叠加一圈微暗描边，增强倒角立体感。
6. 返回 `THREE.CanvasTexture`（`colorSpace = SRGBColorSpace`，开启各向异性）。

六面标准配色：右橙 `#ff8c00`、左红 `#c41e3a`、上白 `#f8f8f8`、下黄 `#ffd500`、前绿 `#009b48`、后蓝 `#0046ad`。内侧面（非外露面）统一使用纯黑材质。

每个 cubie 根据其网格坐标判断哪些面外露：如 `x === 1` 则 +X 面贴橙色，否则贴黑色。材质使用 `MeshStandardMaterial`（roughness ≈ 0.35，metalness ≈ 0.05），配合光影呈现质感。纹理/材质按颜色缓存复用，总计 7 种材质（6 色 + 黑）。

### 2.3 光影环境

- `renderer.shadowMap.enabled = true`，类型 `PCFSoftShadowMap`；色调映射 `ACESFilmicToneMapping`。
- `AmbientLight`（强度 ~0.55）保证暗面可见。
- `DirectionalLight`（强度 ~1.2，位置约 (6, 10, 7)），`castShadow = true`，配置阴影相机范围与 2048 贴图。
- 地面：大尺寸 `PlaneGeometry` + `ShadowMaterial`（opacity ~0.25），置于魔方下方 y ≈ -3，仅接收阴影。
- 所有 cubie `castShadow = receiveShadow = true`。
- 背景：深色渐变（CSS 或 scene.background 纯色 + 雾），突出魔方。

---

## 3. 核心逻辑：数据结构与变换

**不维护 3D 状态数组**。魔方的逻辑状态完全由 27 个 mesh 的世界坐标隐式表达。

### 3.1 动态层级筛选

```
selectLayer(axis, layerCoord):
  遍历 cubies，取 mesh.getWorldPosition()
  若 |worldPos[axis] - layerCoord * STEP| < EPSILON → 属于该层
```

不写死任何索引；打乱后依然正确，因为筛选始终基于当前世界位置。

### 3.2 Pivot 变换机制（关键考点）

```
rotateLayer(axis, layerCoord, angle):
  1. pivot = new THREE.Object3D()，置于原点，scene.add(pivot)
  2. 对选中 cubie 执行 pivot.attach(cubie)
     → attach 自动保持世界变换，免去手动四元数乘法
  3. 旋转 pivot[axis]（动画期间实时设置，或 Tween 补间）
  4. 动画结束：对每个 cubie 执行 scene.attach(cubie)（放回场景，保持世界变换）
  5. scene.remove(pivot)
  6. 坐标清洗（见 3.3）
```

### 3.3 坐标清洗

每次旋转结束后，对所有参与的 cubie：

- **位置**：`position.x/y/z = Math.round(p / STEP) * STEP`（对齐到网格）。
- **旋转**：将欧拉角各分量对齐到最近的 `π/2` 倍数：`rotation.x/y/z = Math.round(r / (π/2)) * (π/2)`。

消除浮点累积误差，防止多次旋转后"散架"。

### 3.4 动画与状态锁

- 全局 `isRotating` 标志：动画进行中禁止开始新的层旋转手势与按钮操作（Scramble 队列内部除外）。
- 程序化旋转（Scramble、磁吸回弹）用 Tween.js 补间 pivot 的旋转角，缓动 `Quadratic.Out`，时长 ~150ms（打乱时加速到 ~100ms）。

---

## 4. 交互系统：手势算法

### 4.1 操作分离

- **左键拖拽**：若按下时射线命中魔方 → 进入层旋转手势，`controls.enabled = false`；未命中魔方 → 不触发层旋转（也不旋转视角）。
- **右键拖拽**：OrbitControls 旋转视角。配置 `controls.mouseButtons = { LEFT: null, RIGHT: ROTATE }`，滚轮缩放保留。
- 触摸设备：单指等价左键（命中魔方时拖层，否则旋转视角），双指捏合缩放——作为增强项，鼠标交互为主。
- 屏蔽右键 `contextmenu` 默认菜单。

### 4.2 手势识别：基于投影向量（核心算法）

**第一步 — 射线检测（pointerdown）**：

- `Raycaster` 求交所有 cubie，取最近交点。
- 记录：命中的 cubie、交点 `point`、**面法线** `face.normal` 经 `normalMatrix`（或 mesh 世界四元数）变换到世界空间，再各分量 `Math.round()` 得到轴对齐法线 `N`（如 (0,0,1) 表示点在前面）。

**第二步 — 锁定候选轴（pointermove，超过死区 ~8px 后判定一次）**：

- 法线 `N` 排除一个轴，剩下两个世界轴为候选旋转轴。例：点击前面（N = Z 轴）→ 候选轴为 X、Y。
- 对每个候选轴 `A`，拖动该轴的层时贴纸表面的运动切线方向为 `T = A × N`（叉乘）。
- 将交点 `P` 与 `P + T` 分别用 `vector.project(camera)` 投影到 NDC，再换算为屏幕像素坐标，相减得到 **2D 屏幕方向向量** `S_A`。

**第三步 — 意图判断（点积匹配）**：

- 取鼠标位移 2D 向量 `D = (dx, dy)`。
- 计算 `|dot(normalize(S_A), normalize(D))|`，对两个候选轴比较，**点积绝对值大者**即用户意图的旋转轴。
- 确定轴后，按交点世界坐标在该轴上的分量筛选层（3.1），创建 pivot 并 attach（3.2），进入拖拽跟随阶段。

### 4.3 方向修正与 1:1 实时跟手

- 旋转角公式：`angle = dot(D, normalize(S_A)) × sign × SENSITIVITY`
  - `D` 为自手势判定起点以来的累计鼠标位移；
  - `S_A` 是切线方向 `T = A × N` 的屏幕投影，**点积带符号**——天然编码了"鼠标顺着切线方向划 → 层往切线方向转"；
  - `sign` 由叉乘约定推导：绕轴 `A` 正向旋转时表面点速度为 `A × P_radial`，与 `T` 的关系确定符号，保证从正面、背面、顶面操作时鼠标向右划永远对应视觉上的"向右转"；
  - `SENSITIVITY` 标定为：拖动约一个魔方面在屏幕上的投影宽度 ≈ 转 90°。
- pointermove 中直接设置 `pivot.rotation[axis] = angle`，实现 1:1 跟手，不经过补间。

### 4.4 磁吸效果（pointerup）

1. 计算 `snapped = Math.round(angle / (π/2)) × (π/2)`。
2. Tween.js 从当前角度补间到 `snapped`（~200ms，`Quadratic.Out`）。
3. 完成回调中执行 scene.attach 放回 + 坐标清洗 + 解锁 `isRotating` + 恢复 controls。

---

## 5. UI 功能

- **Scramble**：随机生成 20 步（轴 × 层 × 方向随机，避免连续两步同轴同层互逆），逐步入队播放，每步 ~100ms。执行期间按钮禁用。
- **Reset**：销毁全部 cubie（释放 geometry，材质缓存保留），按初始排布重建。瞬时完成。
- 按钮置于页面顶部居中，半透明深色卡片风格；动画/打乱期间禁用并降低不透明度。

---

## 6. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| 拖拽中鼠标移出窗口 | `pointerup`/`pointercancel` 监听在 `window` 上 + `setPointerCapture`，确保总能触发磁吸收尾 |
| 动画中再次点击 | `isRotating` 锁直接忽略 |
| 点击命中但位移小于死区 | 不判定轴、不创建 pivot，pointerup 直接还原（视为点击而非拖拽） |
| 视角导致两候选轴投影几乎平行（极端机位） | 点积比较仍取较大者；若两投影向量长度过小（面近乎垂直屏幕）选择长度较大者 |
| CDN 加载失败 | 页面显示原生错误；不做降级（规范要求单一 CDN 方案） |

---

## 7. 测试方案

单文件无构建工具，采用手动验收清单（通过本地静态服务 + 浏览器验证）：

1. 加载后可见带阴影、圆角贴纸、有间隙的 3×3×3 魔方。
2. 右键拖拽旋转视角，左键空白处拖拽无反应。
3. 左键在任意面上沿水平/垂直拖动，对应层 1:1 跟手转动。
4. 从正面、背面、顶面、侧面分别操作，方向直觉一致（无反转 bug）。
5. 松手后磁吸对齐 90°，无错位、无方块漂移。
6. Scramble 播放 20 步打乱；之后继续手势操作依然正确（验证动态层筛选）。
7. 连续打乱+手动旋转 50+ 次后方块仍严格对齐网格（验证坐标清洗）。
8. Reset 后恢复六面同色初始状态。
9. 控制台无报错。

---

## 8. 代码质量要求

- 关键算法处保留中文注释，重点解释**手势投影算法**（4.2/4.3）与 **Pivot 挂载逻辑**（3.2），符合 prompt.md 第五节要求。
- 常量集中配置，无魔法数字散落。
