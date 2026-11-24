# Night Ridge Fireworks

1비트 픽셀 산 풍경 위로, 클릭할 때마다 불꽃놀이가 터지는 웹페이지.

- `index.html` / `fireworks.js` — 372×465 격자 캔버스, 흐려짐은 베이어 디더
- `mountains.png` → `tools/build_assets.py` → `mountains.js`
- `tools/clean_mountains.py` — 능선 위 부스러기 점 정리
- `hand.js` — 웹캠 손 인식(MediaPipe HandLandmarker). 손을 쥐었다 펴면 그 위치에서 폭죽. ES 모듈이라 로컬은 `python -m http.server 5361` 로 열기
