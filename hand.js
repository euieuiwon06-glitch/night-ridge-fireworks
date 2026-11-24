// 웹캠 손 인식 → 손을 쥐었다 펴면(깜빡) 그 위치에서 폭죽
// 영상은 화면에 안 띄우고 브라우저 안에서만 손 위치를 읽음.
const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── 조절값 ───────────────────────────────────────────────
const OPEN_T = 1.55;     // 손가락끝-손목 거리 / 손바닥 길이 가 이보다 크면 '편 손'
const CLOSE_T = 1.15;    // 이보다 작으면 '쥔 손'
const BLINK_MS = 1000;   // 편 손 → 쥠 → 다시 펴기 를 이 시간 안에 하면 발사
const COOLDOWN_MS = 250; // 연속 발사 최소 간격(손마다)
const LOST_MS = 400;     // 손이 이 시간 넘게 안 보이면 상태 초기화
// ────────────────────────────────────────────────────────

const W = 372, H = 465;
const hands = new Map(); // key: 'Left' | 'Right'

function openness(lm) {
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y, (lm[a].z - lm[b].z) * 0.5);
  const palm = d(0, 9) || 1e-6;
  return (d(8, 0) + d(12, 0) + d(16, 0) + d(20, 0)) / 4 / palm;
}

function palmXY(lm) {
  let x = 0, y = 0;
  for (const k of [0, 5, 9, 13, 17]) { x += lm[k].x; y += lm[k].y; }
  // 거울처럼 좌우 반전, 화면 가장자리까지 닿기 쉽게 살짝 확대
  const nx = 1 - x / 5, ny = y / 5;
  const s = (v) => Math.min(1, Math.max(0, (v - 0.5) * 1.25 + 0.5));
  return { x: s(nx) * W, y: s(ny) * H };
}

// 한 프레임의 손 결과 처리 (테스트에서 직접 넣을 수 있게 분리)
function process(list, now) {
  const seen = new Set();
  const marks = [];
  for (const { key, lm } of list) {
    seen.add(key);
    const r = openness(lm);
    const pos = palmXY(lm);
    let h = hands.get(key);
    if (!h) { h = { state: "unknown", openAt: 0, closedAt: 0, lastFire: 0 }; hands.set(key, h); }
    h.seen = now;
    // 손 위치를 부드럽게 따라감
    h.x = h.x == null ? pos.x : h.x + (pos.x - h.x) * 0.5;
    h.y = h.y == null ? pos.y : h.y + (pos.y - h.y) * 0.5;

    h.ratio = r;
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
  if (window.__fw) window.__fw.hands = marks;
}
window.__hand = { process, openness, hands, draw: (...a) => drawPreview(...a) };

// ── 오른쪽 미리보기: 카메라에 내 모습이 어떻게 감지되는지 ──────────
const PV_W = 240, PV_H = 180;
let pv = null;
function makePreview() {
  const box = document.createElement("div");
  box.id = "hand-preview";
  box.innerHTML = `<canvas width="${PV_W * 2}" height="${PV_H * 2}"></canvas>
    <div class="cap">손을 편 채로 비춘 뒤, 주먹 쥐었다 펴면 폭죽</div>`;
  const st = document.createElement("style");
  st.textContent = `
    #hand-preview { position: fixed; right: 16px; top: 50%; transform: translateY(-50%);
      width: ${PV_W}px; pointer-events: none; font: 11px/1.5 "Pretendard", system-ui, sans-serif;
      color: #8a8a8a; letter-spacing: .02em; }
    #hand-preview canvas { display: block; width: ${PV_W}px; height: ${PV_H}px;
      border: 1px solid #333; background: #000; }
    #hand-preview .cap { margin-top: 6px; }
    @media (max-width: 720px) {
      #hand-preview { top: auto; bottom: 12px; right: 12px; width: 132px; transform: none; }
      #hand-preview canvas { width: 132px; height: 99px; }
      #hand-preview .cap { display: none; }
    }`;
  document.head.appendChild(st);
  document.body.appendChild(box);
  return box.querySelector("canvas").getContext("2d");
}

function drawPreview(video, res, connections, now) {
  if (!pv) pv = makePreview();
  const c = pv, w = PV_W * 2, h = PV_H * 2;
  // 거울 영상(흑백, 살짝 어둡게)
  c.save();
  c.filter = "grayscale(1) brightness(0.55) contrast(1.1)";
  c.translate(w, 0); c.scale(-1, 1);
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(w / vw, h / vh);                     // 꽉 채우기(가운데 기준 자름)
  const dw = vw * s, dh = vh * s, ox = (w - dw) / 2, oy = (h - dh) / 2;
  c.drawImage(video, ox, oy, dw, dh);
  c.restore();
  c.filter = "none";

  const P = (p) => [w - (ox + p.x * dw), oy + p.y * dh];   // 랜드마크 → 미리보기 좌표(거울)
  (res.landmarks || []).forEach((lm, i) => {
    const key = res.handedness?.[i]?.[0]?.categoryName || String(i);
    const hs = hands.get(key) || {};
    const fired = now - (hs.lastFire || -1e9) < 220;
    const closed = hs.state === "closed";
    const ink = fired ? "#ffffff" : closed ? "#9fd7ff" : "#e8e8e8";
    c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = fired ? 4 : 2;
    for (const { start, end } of connections) {
      const [x0, y0] = P(lm[start]), [x1, y1] = P(lm[end]);
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    }
    for (const p of lm) { const [x, y] = P(p); c.fillRect(x - 3, y - 3, 6, 6); }

    // 손목 옆: 상태 + 펼침 정도 막대(기준선 2개: 쥠 / 펴짐)
    const [wx, wy] = P(lm[0]);
    const bx = Math.min(w - 130, Math.max(8, wx - 60)), by = Math.min(h - 40, wy + 18);
    const r = hs.ratio || 0, max = 2.4, bw = 120;
    c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(bx - 6, by - 6, bw + 12, 40);
    c.fillStyle = ink; c.font = "bold 20px Pretendard, system-ui, sans-serif";
    c.fillText(fired ? "터짐!" : closed ? "쥠" : "펴짐", bx, by + 14);
    c.fillStyle = "#444"; c.fillRect(bx, by + 22, bw, 6);
    c.fillStyle = ink; c.fillRect(bx, by + 22, Math.min(1, r / max) * bw, 6);
    c.fillStyle = "#ff5a5a"; c.fillRect(bx + (CLOSE_T / max) * bw, by + 19, 2, 12);
    c.fillStyle = "#5aff8a"; c.fillRect(bx + (OPEN_T / max) * bw, by + 19, 2, 12);
  });
  if (!(res.landmarks || []).length) {
    c.fillStyle = "#8a8a8a"; c.font = "20px Pretendard, system-ui, sans-serif";
    c.fillText("손이 보이지 않아요", 16, h - 18);
  }
}

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
    if (!window.__hand.freeze && video.readyState >= 2 && video.currentTime !== lastT) {
      lastT = video.currentTime;
      const now = performance.now();
      const res = lm.detectForVideo(video, now);
      const list = (res.landmarks || []).map((l, i) => ({
        key: res.handedness?.[i]?.[0]?.categoryName || String(i), lm: l,
      }));
      process(list, now);
      drawPreview(video, res, HandLandmarker.HAND_CONNECTIONS, now);
      window.__hand.last = { video, conn: HandLandmarker.HAND_CONNECTIONS };
    }
    requestAnimationFrame(loop);
  };
  loop();
}
start();
