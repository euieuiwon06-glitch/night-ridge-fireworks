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
window.__hand = { process, openness };

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
    if (video.readyState >= 2 && video.currentTime !== lastT) {
      lastT = video.currentTime;
      const now = performance.now();
      const res = lm.detectForVideo(video, now);
      const list = (res.landmarks || []).map((l, i) => ({
        key: res.handedness?.[i]?.[0]?.categoryName || String(i), lm: l,
      }));
      process(list, now);
    }
    requestAnimationFrame(loop);
  };
  loop();
}
start();
