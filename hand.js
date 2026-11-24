// 웹캠 손 인식 → 손을 쥐었다 펴면(깜빡) 그 위치에서 폭죽
// 위쪽 #cam 영역에 거울 영상 + 손 뼈대를 그림(영상은 브라우저 밖으로 안 나감).
const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── 조절값 ───────────────────────────────────────────────
const OPEN_T = 1.45;     // 손가락끝-손목 거리 / 손바닥 길이 가 이보다 크면 '편 손' (쉽게: 1.55→1.45)
const CLOSE_T = 1.3;     // 이보다 작으면 '쥔 손' (쉽게: 1.15→1.3)
const BLINK_MS = 1000;   // 편 손 → 쥠 → 다시 펴기 를 이 시간 안에 하면 발사
const COOLDOWN_MS = 250; // 연속 발사 최소 간격(손마다)
const LOST_MS = 400;     // 손이 이 시간 넘게 안 보이면 상태 초기화
const CIRCLE_MS = 2000;  // 검지 끝 궤적을 이 시간만큼 보고 원인지 판단
const CIRCLE_TURN = 0.6; // 한 바퀴(360°)의 이 비율 이상 돌면 원 (대충 그려도 되게: 0.9→0.6)
const CIRCLE_COOL = 1500;// 원 축포 후 다음 원까지 최소 간격
// ────────────────────────────────────────────────────────

const W = 372, H = 465;
const hands = new Map(); // key: 'Left' | 'Right'

function openness(lm) {
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y, (lm[a].z - lm[b].z) * 0.5);
  const palm = d(0, 9) || 1e-6;
  return (d(8, 0) + d(12, 0) + d(16, 0) + d(20, 0)) / 4 / palm;
}

// 카메라 화면(위) 속 손 위치 → 폭죽 화면(아래)의 보이는 하늘 위치
// view: 영상이 카메라 칸에 '꽉 채우기'로 그려진 비율(가려진 위아래 여백 반영)
let view = { ox: 0, oy: 0, sx: 1, sy: 1 };
function palmXY(lm) {
  let x = 0, y = 0;
  for (const k of [0, 5, 9, 13, 17]) { x += lm[k].x; y += lm[k].y; }
  const vx = 1 - (view.ox + (x / 5) * view.sx);         // 거울
  const vy = view.oy + (y / 5) * view.sy;
  const s = (v) => Math.min(1, Math.max(0, (v - 0.5) * 1.25 + 0.5)); // 가장자리까지 닿기 쉽게
  const top = (window.__fw && window.__fw.visTop) || 0;
  return { x: s(vx) * W, y: top + s(vy) * (H - top) };
}

// 한 프레임의 손 결과 처리 (테스트에서 직접 넣을 수 있게 분리)
let nextId = 1;
const ASPECT = 4 / 3;   // 정규화 좌표 x 를 실제 비율로(카메라 4:3)

// 검지 끝이 최근 CIRCLE_MS 동안 한 바퀴 돌았나
function isCircle(trail, palm) {
  if (trail.length < 10) return false;
  let cx = 0, cy = 0;
  for (const p of trail) { cx += p.x; cy += p.y; }
  cx /= trail.length; cy /= trail.length;
  // 선 모양(왕복)은 원이 아님: 궤적이 퍼진 정도의 짧은 축/긴 축 비율
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of trail) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  if (l1 <= 0 || Math.sqrt(Math.max(0, l2) / l1) < 0.2) return false;

  const rs = trail.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const mr0 = rs.reduce((a, b) => a + b, 0) / rs.length;
  let sum = 0, prev = null;
  for (let i = 0; i < trail.length; i++) {
    if (rs[i] < 0.35 * mr0) continue;                  // 중심 근처 점은 각도가 튀니 제외
    const a = Math.atan2(trail[i].y - cy, trail[i].x - cx);
    if (prev != null) { let d = a - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; if (Math.abs(d) < 2.2) sum += d; }
    prev = a;
  }
  const mr = mr0;
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mr) ** 2, 0) / rs.length);
  return Math.abs(sum) >= CIRCLE_TURN * 2 * Math.PI && mr > 0.15 * palm && sd / mr < 0.8;
}

function process(list, now) {
  const seen = new Set();
  const marks = [];
  const ids = [];
  for (const { lm } of list) {
    const r = openness(lm);
    const pos = palmXY(lm);
    // 가장 가까운 기존 손과 이어 붙임(손 두 개가 같은 '오른손'으로 잡혀도 섞이지 않게)
    let h = null, best = 90;
    for (const [id, c] of hands) {
      if (seen.has(id) || c.x == null) continue;
      const d = Math.hypot(c.x - pos.x, c.y - pos.y);
      if (d < best) { best = d; h = c; }
    }
    if (!h) { h = { id: nextId++, state: "unknown", openAt: 0, closedAt: 0, lastFire: 0, lastCircle: 0, trail: [] }; hands.set(h.id, h); }
    seen.add(h.id); ids.push(h.id);
    h.seen = now;
    // 손 위치를 부드럽게 따라감
    h.x = h.x == null ? pos.x : h.x + (pos.x - h.x) * 0.5;
    h.y = h.y == null ? pos.y : h.y + (pos.y - h.y) * 0.5;

    h.ratio = r;

    // 검지 끝 궤적 → 원 그리기 감지
    const tip = { x: (1 - lm[8].x) * ASPECT, y: lm[8].y, t: now, raw: lm[8] };
    h.trail.push(tip);
    while (h.trail.length && now - h.trail[0].t > CIRCLE_MS) h.trail.shift();
    const palm = Math.hypot((lm[0].x - lm[9].x) * ASPECT, lm[0].y - lm[9].y);
    if (h.state !== "closed" && now - h.lastCircle > CIRCLE_COOL && isCircle(h.trail, palm)) {
      window.__fw && window.__fw.show && window.__fw.show();
      h.lastCircle = now; h.trail = [];
    }
    if (r > OPEN_T) {
      if (h.state === "closed" && now - h.openAt < BLINK_MS && now - h.lastFire > COOLDOWN_MS) {
        window.__fw && window.__fw.launch(h.x, h.y);
        h.lastFire = now;
      }
      if (h.state !== "open") h.openAt = now;
      h.state = "open";
    } else if (r < CLOSE_T) {
      if (h.state === "open") h.closedAt = now;
      else if (h.state === "unknown") h.openAt = -Infinity; // 쥔 채로 나타난 손은 발사 안 함
      h.state = "closed";
    }
    marks.push({ x: h.x, y: h.y, open: h.state !== "closed" });
  }
  for (const [k, h] of hands) if (!seen.has(k) && now - h.seen > LOST_MS) hands.delete(k);
  lastIds = ids;
  if (window.__fw) window.__fw.hands = marks;
}
let lastIds = [];
window.__hand = { process, openness, hands, isCircle };

// ── 위쪽 카메라 칸: 거울 컬러 영상 + 손 뼈대(흰 선·분홍 관절) + 상태 ─────────
const camCanvas = document.getElementById("camc");
const cc = camCanvas.getContext("2d");
let hintEl = document.querySelector("#cam .hint");
function drawCam(video, res, connections, now) {
  if (hintEl) { hintEl.remove(); hintEl = null; }
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(camCanvas.clientWidth * dpr), h = Math.round(camCanvas.clientHeight * dpr);
  if (camCanvas.width !== w || camCanvas.height !== h) { camCanvas.width = w; camCanvas.height = h; }
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(w / vw, h / vh);                      // 꽉 채우기(가운데 기준 자름)
  const dw = vw * s, dh = vh * s, ox = (w - dw) / 2, oy = (h - dh) / 2;
  view = { ox: ox / w, oy: oy / h, sx: dw / w, sy: dh / h };
  cc.save();
  cc.translate(w, 0); cc.scale(-1, 1);
  cc.drawImage(video, ox, oy, dw, dh);
  cc.restore();

  const P = (p) => [w - (ox + p.x * dw), oy + p.y * dh];    // 랜드마크 → 화면(거울)
  const u = w / 400;                                       // 선 굵기 기준
  (res.landmarks || []).forEach((lm, i) => {
    const hs = hands.get(lastIds[i]) || {};
    const fired = now - (hs.lastFire || -1e9) < 220;
    const circled = now - (hs.lastCircle || -1e9) < 700;
    // 검지 끝 궤적(노란 점, 오래된 것일수록 흐리게)
    const tr = hs.trail || [];
    tr.forEach((p, k) => {
      const [x, y] = P(p.raw);
      cc.globalAlpha = 0.15 + 0.85 * (k + 1) / tr.length;
      cc.fillStyle = "#ffe36b";
      cc.beginPath(); cc.arc(x, y, 2.2 * u, 0, Math.PI * 2); cc.fill();
    });
    cc.globalAlpha = 1;
    const closed = hs.state === "closed";
    cc.lineCap = "round";
    cc.strokeStyle = "rgba(255,255,255,.95)"; cc.lineWidth = (fired ? 3.2 : 1.6) * u;
    for (const { start, end } of connections) {
      const [x0, y0] = P(lm[start]), [x1, y1] = P(lm[end]);
      cc.beginPath(); cc.moveTo(x0, y0); cc.lineTo(x1, y1); cc.stroke();
    }
    for (const p of lm) {
      const [x, y] = P(p);
      cc.beginPath(); cc.arc(x, y, (fired ? 4 : 3) * u, 0, Math.PI * 2);
      cc.fillStyle = closed ? "#9fd7ff" : "#ffb3c1"; cc.fill();
      cc.lineWidth = 1 * u; cc.strokeStyle = "#fff"; cc.stroke();
    }
    // 손목 아래: 상태 + 펼침 막대(빨강 = 쥠 기준, 초록 = 펴짐 기준)
    const [wx, wy] = P(lm[0]);
    const bw = 70 * u, bx = Math.min(w - bw - 6 * u, Math.max(6 * u, wx - bw / 2));
    const by = Math.min(h - 22 * u, wy + 10 * u);
    const r = hs.ratio || 0, max = 2.4;
    cc.fillStyle = "rgba(0,0,0,.55)"; cc.fillRect(bx - 4 * u, by - 4 * u, bw + 8 * u, 22 * u);
    cc.fillStyle = "#fff"; cc.font = `600 ${9 * u}px system-ui, sans-serif`; cc.textBaseline = "top";
    cc.fillText(circled ? "원! 축포" : fired ? "터짐!" : closed ? "쥠" : "펴짐", bx, by);
    cc.fillStyle = "rgba(255,255,255,.25)"; cc.fillRect(bx, by + 12 * u, bw, 3 * u);
    cc.fillStyle = "#fff"; cc.fillRect(bx, by + 12 * u, Math.min(1, r / max) * bw, 3 * u);
    cc.fillStyle = "#ff5a5a"; cc.fillRect(bx + (CLOSE_T / max) * bw, by + 10 * u, 1.5 * u, 7 * u);
    cc.fillStyle = "#5aff8a"; cc.fillRect(bx + (OPEN_T / max) * bw, by + 10 * u, 1.5 * u, 7 * u);
  });
}
window.__hand.draw = (...a) => drawCam(...a);

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false,
    });
  } catch (e) {
    console.info("카메라를 쓸 수 없어 클릭으로만 동작합니다:", e.name);
    return;
  }
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  await video.play();
  if (hintEl) hintEl.textContent = "손 인식 준비 중…";

  const { FilesetResolver, HandLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO", numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let lm;
  try { lm = await make("GPU"); } catch { lm = await make("CPU"); }
  window.__hand.ready = true;

  let lastT = -1;
  const loop = () => {
    if (!window.__hand.freeze && !(window.__fw && window.__fw.full) && video.readyState >= 2 && video.currentTime !== lastT) {
      lastT = video.currentTime;
      const now = performance.now();
      const res = lm.detectForVideo(video, now);
      const list = (res.landmarks || []).map((l, i) => ({
        key: res.handedness?.[i]?.[0]?.categoryName || String(i), lm: l,
      }));
      process(list, now);
      drawCam(video, res, HandLandmarker.HAND_CONNECTIONS, now);
      window.__hand.last = { video, conn: HandLandmarker.HAND_CONNECTIONS };
    }
    requestAnimationFrame(loop);
  };
  loop();
}
start();
