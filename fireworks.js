// 1비트 픽셀 불꽃놀이 — 격자 372×465, 흰 픽셀만, 흐려짐은 베이어 4×4 디더로 표현
(() => {
  "use strict";

  // ── 조절값 ───────────────────────────────────────────────
  const W = 372, H = 465;
  const STEP = 1000 / 60;        // 물리 고정 스텝(ms)
  const GLOW_DECAY = 0.7;        // 남은 잔광 감쇠(프레임당 곱)
  const MAX_PARTICLES = 9000;
  const MIN_ABOVE_RIDGE = 22;    // 터지는 높이: 능선보다 최소 이만큼 위
  const SIZE = 1.75;             // 불꽃 전체 크기 배율
  const LIFE = 1.6;              // 불꽃 지속 시간 배율
  const HOLD = 0.45;             // 수명 중 이 비율까지는 최대 밝기 유지
  const TAIL_CURVE = 0.4;        // 꼬리 밝기 곡선(<1 이면 꼬리가 오래 밝음)
  const COLOR_RADIUS = 40;       // 이 거리(×SIZE)에서 거의 흰색이 됨
  const SNOW = 80;               // 눈송이 수
  const SNOW_SPEED = 1;          // 눈 내리는 속도 배율
  const GLOW_LIFE = 130;         // 산에 비친 불빛 지속 프레임
  const GLOW_RX = 120;           // 불빛이 비치는 좌우 범위(칸)
  const GLOW_DEPTH = 42;         // 능선에서 아래로 비치는 깊이(칸)
  const GLOW_MAX = 1.0;          // 가장 강할 때 색이 섞이는 정도(1 = 완전히 그 색)
  const FLASH = 34;            // 중심 빛무리 지속 프레임
  // ────────────────────────────────────────────────────────

  const cv = document.getElementById("c");
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H);
  const px = new Uint32Array(img.data.buffer);
  const glow = new Float32Array(W * H);     // 이번 프레임 밝기(0..1)
  const BLACK = 0xff000000, WHITE = 0xffffffff;

  // 무지개 7색 — 터질 때마다 하나를 무작위로
  const RAINBOW = [
    [255, 40, 40],   // 빨강
    [255, 140, 0],   // 주황
    [255, 220, 0],   // 노랑
    [40, 210, 70],   // 초록
    [30, 120, 255],  // 파랑
    [80, 70, 255],   // 남색
    [190, 70, 255],  // 보라
  ];
  const LUT = 32;
  const COLOR_EDGE = 0.82;  // 바깥 끝에서 흰색이 섞이는 정도(1 = 완전 흰색)
  // 중심(0) = 가장 진한 색, 바깥(1) = 흰색에 가깝게. COLOR_CURVE <1 이면 진한 영역이 좁음
  const COLOR_CURVE = 1.1;
  function makeLut([r, g, b]) {
    const lut = new Uint32Array(LUT);
    for (let k = 0; k < LUT; k++) {
      const t = COLOR_EDGE * Math.pow(k / (LUT - 1), COLOR_CURVE);
      const m = (c) => Math.round(c + (255 - c) * t);
      lut[k] = (0xff000000 | (m(b) << 16) | (m(g) << 8) | m(r)) >>> 0;
    }
    return lut;
  }
  const LUTS = RAINBOW.map(makeLut);

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const thr = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) thr[y * W + x] = (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

  // 산 레이어: 불투명 = 산(앞), 투명 = 하늘
  const landA = new Uint8Array(W * H), landW = new Uint8Array(W * H);
  const ridge = new Int16Array(W).fill(H);
  let ready = false;

  const mimg = new Image();
  mimg.onload = () => {
    const o = document.createElement("canvas");
    o.width = W; o.height = H;
    const oc = o.getContext("2d");
    oc.drawImage(mimg, 0, 0);
    const d = oc.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) {
      landA[i] = d[i * 4 + 3] > 127 ? 1 : 0;
      landW[i] = d[i * 4] > 127 ? 1 : 0;
    }
    // 열마다 능선 높이(작은 부스러기 무시: 아래로 6칸 이상 이어진 첫 지점)
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H - 6; y++) {
        let run = 0;
        while (run < 6 && landA[(y + run) * W + x]) run++;
        if (run === 6) { ridge[x] = y; break; }
      }
    }
    // 산에 불빛이 비칠 후보: 능선 아래 GLOW_DEPTH 안의 흰 픽셀
    const ids = [], ds = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x, d = y - ridge[x];
        if (landA[i] && landW[i] && d >= -2 && d < GLOW_DEPTH) { ids.push(i); ds.push(Math.max(0, d)); }
      }
    litIdx = Int32Array.from(ids);
    litDepth = Float32Array.from(ds);
    ready = true;
  };
  mimg.src = window.MOUNTAINS_PNG;

  // ── 화면 맞춤: 기기 픽셀 기준 정수배 확대 ────────────────
  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(innerWidth * dpr / W, innerHeight * dpr / H);
    const s = (k >= 1 ? Math.floor(k) : k) / dpr;
    cv.style.width = W * s + "px";
    cv.style.height = H * s + "px";
  }
  addEventListener("resize", fit);
  fit();

  // ── 그리기 도구 ─────────────────────────────────────────
  // 색: 지금 그리는 불꽃(cur)의 중심에서 멀수록 진한 색 → 흰색 쪽으로 옅어짐
  const col = new Uint32Array(W * H).fill(WHITE);
  let cur = null;
  function plot(x, y, b) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (b > glow[i]) {
      glow[i] = b;
      if (cur) {
        const d = Math.hypot(x - cur.x, y - cur.y) / cur.R;
        col[i] = cur.lut[Math.min(LUT - 1, (d * (LUT - 1)) | 0)];
      } else col[i] = WHITE;
    }
  }
  function line(x0, y0, x1, y1, b0, b1) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      plot(x0 + (x1 - x0) * t + 0.5, y0 + (y1 - y0) * t + 0.5, b0 + (b1 - b0) * t);
    }
  }
  function disc(cx, cy, r, b) {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const d = Math.hypot(x, y) / r;
        if (d <= 1) plot(cx + x, cy + y, b * (1 - d * d));
      }
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  // ── 입자 ───────────────────────────────────────────────
  const parts = [];   // 불꽃 입자
  const rockets = []; // 올라가는 불줄기
  const flashes = []; // 터질 때 중심 빛

  function Particle(x, y, vx, vy, o) {
    return {
      x, y, vx: vx * SIZE, vy: vy * SIZE,
      age: 0,
      life: o.life * LIFE,
      drag: o.drag,
      grav: o.grav,
      tail: o.tail,          // 꼬리 길이(지난 위치 수)
      hist: [],
      burst: spawning,       // 어느 불꽃 소속인지(색 계산용), 불줄기 불씨는 null=흰색
      width: o.width || 1,
      twinkle: o.twinkle || 0,
      fade: o.fade || 1.6,   // 밝기 곡선 지수
    };
  }

  // 종류별 터짐 — 원본 그림 속 불꽃처럼 촘촘하게: 겉 줄기 + 속 불꽃 + 중심 가루
  const shoot = (x, y, a, v, o) =>
    parts.push(Particle(x, y, Math.cos(a) * v, Math.sin(a) * v, o));

  // 공통: 중심의 촘촘한 반짝이 가루(디더 빛무리 느낌)
  function core(x, y, n, spread) {
    for (let i = 0; i < n; i++)
      shoot(x, y, rand(0, 6.283), spread * Math.pow(Math.random(), 1.5),
        { life: rand(30, 60), drag: 0.93, grav: 0.008, tail: 2, twinkle: 0.55, fade: 1 });
  }
  // 공통: 안쪽 작은 직선 불꽃
  function inner(x, y, n, sp) {
    for (let i = 0; i < n; i++)
      shoot(x, y, (i / n) * 6.283 + rand(-0.1, 0.1), sp * rand(0.6, 1),
        { life: rand(30, 42), drag: 0.92, grav: 0.01, tail: 12, fade: 1.4 });
  }

  const KINDS = {
    // 직선 줄기가 중심부터 사방으로 빽빽하게 (왼쪽 불꽃)
    rays(x, y) {
      const n = rand(80, 100) | 0, sp = rand(2.6, 3.2);
      for (let i = 0; i < n; i++)
        shoot(x, y, (i / n) * 6.283 + rand(-0.05, 0.05), sp * rand(0.45, 1.05),
          { life: rand(55, 72), drag: 0.93, grav: 0.012, tail: 36, fade: 1.2 });
      inner(x, y, 36, 1.3);
      core(x, y, 90, 1.6);
    },
    // 국화: 줄기 끝이 둥글게 처짐 (가운데 큰 불꽃)
    peony(x, y) {
      const n = rand(150, 190) | 0, sp = rand(2.4, 2.9);
      for (let i = 0; i < n; i++)
        shoot(x, y, rand(0, 6.283), sp * Math.sqrt(rand(0.3, 1)),
          { life: rand(60, 80), drag: 0.955, grav: 0.032, tail: 22, fade: 1.6 });
      inner(x, y, 30, 1.1);
      core(x, y, 80, 1.4);
    },
    // 버들: 길게 늘어지며 떨어짐
    willow(x, y) {
      const n = rand(100, 120) | 0, sp = rand(1.9, 2.4);
      for (let i = 0; i < n; i++)
        shoot(x, y, rand(0, 6.283), sp * rand(0.55, 1),
          { life: rand(100, 135), drag: 0.95, grav: 0.036, tail: 40, fade: 1.1, twinkle: 0.12 });
      core(x, y, 70, 1.2);
    },
    // 아치 분수: 굵은 팔이 솟았다 휘어 내려옴 + 사이사이 가는 팔 (오른쪽 불꽃)
    palm(x, y) {
      const n = rand(12, 16) | 0;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + ((i / (n - 1)) - 0.5) * rand(2.6, 3.1);
        shoot(x, y, a, rand(2.2, 2.8),
          { life: rand(75, 95), drag: 0.965, grav: 0.055, tail: 38, width: 2, fade: 1.1 });
        shoot(x, y, a + rand(-0.12, 0.12), rand(1.4, 2.0),
          { life: rand(60, 80), drag: 0.96, grav: 0.05, tail: 28, fade: 1.2 });
      }
      core(x, y, 80, 1.3);
    },
    // 반짝이: 촘촘한 점 덩어리가 퍼지며 깜빡임 + 가는 줄기 몇 개
    glitter(x, y) {
      const n = rand(260, 320) | 0;
      for (let i = 0; i < n; i++)
        shoot(x, y, rand(0, 6.283), rand(0.2, 2.3),
          { life: rand(50, 85), drag: 0.95, grav: 0.025, tail: 3, twinkle: 0.6, fade: 1.1 });
      inner(x, y, 24, 2.0);
    },
  };
  const KIND_POOL = ["rays", "rays", "peony", "peony", "willow", "palm", "glitter"];

  // ── 발사 ───────────────────────────────────────────────
  function launch(tx, ty, kind) {
    tx = Math.max(8, Math.min(W - 9, tx));
    const top = ridge[tx | 0] < H ? ridge[tx | 0] : H;
    ty = Math.max(14, Math.min(ty, top - MIN_ABOVE_RIDGE));
    const sx = tx + rand(-6, 6);
    const sy = Math.min(H + 2, top + 30);               // 산 뒤에서 출발
    const T = Math.max(26, Math.min(58, (sy - ty) / 4.2)) | 0; // 올라가는 프레임 수
    rockets.push({ sx, sy, tx, ty, T, t: 0, x: sx, y: sy, px: sx, py: sy,
                   wob: rand(0, 6.28), kind: KINDS[kind] ? kind : pick(KIND_POOL) });
  }

  let spawning = null;
  function burst(r) {
    const ci = (Math.random() * RAINBOW.length) | 0;
    const B = { x: r.tx, y: r.ty, R: COLOR_RADIUS * SIZE, lut: LUTS[ci] };
    lights.push({ x: r.tx, y: r.ty, rgb: RAINBOW[ci], t: 0 });
    flashes.push({ x: r.tx, y: r.ty, t: 0, burst: B });
    spawning = B;
    KINDS[r.kind](r.tx, r.ty);
    spawning = null;
    if (parts.length > MAX_PARTICLES) parts.splice(0, parts.length - MAX_PARTICLES);
  }

  // ── 눈: 클릭과 상관없이 늘 내림. 멀리(작고 느림)·가까이(크고 빠름) 세 겹 ──
  const flakes = [];
  function newFlake(y) {
    const z = Math.random();                       // 0 = 멀리, 1 = 가까이
    const size = z < 0.85 ? 1 : 2;                // 대부분 1칸 점, 가까운 것만 2칸 가로점
    return {
      x: rand(0, W), y: y ?? rand(-20, -2),
      vy: (0.12 + z * 0.35) * SNOW_SPEED,
      sway: rand(0.15, 0.5) * (0.5 + z), ph: rand(0, 6.28), fr: rand(0.01, 0.03),
      size,
    };
  }
  for (let i = 0; i < SNOW; i++) flakes.push(newFlake(rand(0, H)));

  // ── 산에 비치는 불빛 ─────────────────────────────────────
  const lights = [];
  let litIdx = new Int32Array(0), litDepth = new Float32Array(0);
  function drawMountainGlow() {
    if (!lights.length) return;
    for (let n = 0; n < litIdx.length; n++) {
      const i = litIdx[n], x = i % W;
      let best = 0, rgb = null;
      for (const L of lights) {
        // 시간: 터질 때 빠르게 밝아졌다 천천히 사라짐
        // 끝(GLOW_LIFE)에서 정확히 0이 되고 기울기도 0 → 뚝 끊기지 않음
        const env = L.t < 4 ? L.t / 4 : Math.pow(1 - (L.t - 4) / (GLOW_LIFE - 4), 2.6);
        const fx = 1 - Math.abs(x - L.x) / GLOW_RX;
        if (fx <= 0) continue;
        const h = Math.max(0, ridge[Math.max(0, Math.min(W - 1, L.x | 0))] - L.y);
        const fv = Math.max(0.75, 1 - h / 400);           // 높이 터질수록 조금 약하게
        const s = env * fv * Math.pow(fx, 1.4) * Math.pow(1 - litDepth[n] / GLOW_DEPTH, 1.3);
        if (s > best) { best = s; rgb = L.rgb; }
      }
      if (!rgb || best <= 0.002) continue;
      const k = Math.min(1, best * 1.7) * GLOW_MAX;
      const m = (c) => Math.round(255 + (c - 255) * k);
      px[i] = (0xff000000 | (m(rgb[2]) << 16) | (m(rgb[1]) << 8) | m(rgb[0])) >>> 0;
    }
  }

  function updateSnow() {
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i];
      f.ph += f.fr;
      f.y += f.vy;
      f.x += Math.sin(f.ph) * f.sway * 0.25;
      if (f.y > H + 3 || (ready && f.y > ridge[Math.max(0, Math.min(W - 1, f.x | 0))] + 4)) flakes[i] = newFlake();
      else if (f.x < -3) f.x += W + 6;
      else if (f.x > W + 3) f.x -= W + 6;
    }
  }
  function drawSnow() {
    // 산 레이어(불투명) 위에는 안 그림 → 눈이 산 뒤로 사라짐
    const put = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H && !landA[y * W + x]) px[y * W + x] = WHITE; };
    for (const f of flakes) {
      const x = f.x | 0, y = f.y | 0;
      put(x, y);
      if (f.size === 2) put(x + 1, y);
    }
  }

  // ── 갱신 ───────────────────────────────────────────────
  function update() {
    updateSnow();
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.t++;
      const u = r.t / r.T;
      const e = 1 - Math.pow(1 - u, 2.2);               // 올라갈수록 느려짐
      r.px = r.x; r.py = r.y;
      r.x = r.sx + (r.tx - r.sx) * e + Math.sin(r.wob + r.t * 0.35) * 0.6 * (1 - u);
      r.y = r.sy + (r.ty - r.sy) * e;
      // 떨어지는 불씨
      if (Math.random() < 0.6)
        parts.push(Particle(r.x, r.y, rand(-0.15, 0.15), rand(0.1, 0.5),
          { life: rand(10, 22), drag: 0.92, grav: 0.03, tail: 1, twinkle: 0.5 }));
      if (r.t >= r.T) { burst(r); rockets.splice(i, 1); }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.hist.push(p.x, p.y);
      if (p.hist.length > p.tail * 2) p.hist.splice(0, 2);
      p.vx *= p.drag; p.vy = p.vy * p.drag + p.grav;
      p.x += p.vx; p.y += p.vy;
      if (++p.age > p.life) parts.splice(i, 1);
    }
    for (let i = flashes.length - 1; i >= 0; i--) if (++flashes[i].t > FLASH) flashes.splice(i, 1);
    for (let i = lights.length - 1; i >= 0; i--) if (++lights[i].t > GLOW_LIFE) lights.splice(i, 1);
  }

  // ── 렌더 ───────────────────────────────────────────────
  function render() {
    for (let i = 0; i < glow.length; i++) glow[i] *= GLOW_DECAY;

    for (const f of flashes) {
      // 중심 빛무리: 커지며 디더 점으로 흩어짐
      const k = 1 - f.t / FLASH;
      cur = f.burst;
      disc(f.x, f.y, (4 + f.t * 0.45) | 0, 1.5 * Math.pow(k, 1.4));
    }
    cur = null;
    for (const r of rockets) {
      line(r.px, r.py + 5, r.x, r.y, 0.55, 1);
      line(r.x, r.y + 5, r.x, r.y + 14, 0.5, 0.1);       // 짧은 불꼬리
    }
    for (const p of parts) {
      // 수명 앞 절반은 온전히 밝고, 뒤 절반에 사라짐
      cur = p.burst;
      const u = p.age / p.life;
      let b = u < HOLD ? 1 : Math.pow(1 - (u - HOLD) / (1 - HOLD), p.fade);
      if (p.twinkle && Math.random() < p.twinkle * u) b *= 0.1;
      const h = p.hist, n = h.length / 2;
      let ox = p.x, oy = p.y, ob = b;
      for (let k = n - 1; k >= 0; k--) {
        const hx = h[k * 2], hy = h[k * 2 + 1];
        const tb = b * Math.pow(k / n, TAIL_CURVE);   // 머리 1 → 꼬리 끝 0
        line(ox, oy, hx, hy, ob, tb);
        if (p.width > 1) line(ox + 1, oy, hx + 1, hy, ob, tb);
        ox = hx; oy = hy; ob = tb;
      }
      plot(p.x + 0.5, p.y + 0.5, b * 1.3);
      if (p.width > 1) plot(p.x + 1.5, p.y + 0.5, b * 1.3);
    }

    for (let i = 0; i < px.length; i++) {
      if (landA[i]) px[i] = landW[i] ? WHITE : BLACK;
      else px[i] = glow[i] > thr[i] ? col[i] : BLACK;
    }
    cur = null;
    drawMountainGlow();
    drawSnow();
    ctx.putImageData(img, 0, 0);
  }

  // ── 루프 ───────────────────────────────────────────────
  let last = performance.now(), acc = 0;
  function frame(now) {
    acc += Math.min(100, now - last);
    last = now;
    if (ready) {
      while (acc >= STEP) { update(); acc -= STEP; }
      render();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── 입력: 좌클릭/터치할 때마다 발사 ─────────────────────
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !ready) return;
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W;
    const y = (e.clientY - r.top) / r.height * H;
    launch(x, y);
  });
  addEventListener("contextmenu", (e) => e.preventDefault());

  // 확인용: window.__fw.launch(x, y)
  window.__fw = { launch, get count() { return parts.length + rockets.length; } };
})();
