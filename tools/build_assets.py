"""mountains.png → mountains.js (data URI). file:// 로 열어도 캔버스가 오염되지 않게 하려는 것.

python build_assets.py  (웹페이지 폴더 기준 상대경로)
mountains.png 자체는 ../벡터/tools/compose.py --land-png 로 생성.
"""
import base64
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
png = (root / "mountains.png").read_bytes()
uri = "data:image/png;base64," + base64.b64encode(png).decode()
(root / "mountains.js").write_text(f'window.MOUNTAINS_PNG="{uri}";\n', encoding="utf-8")
print("mountains.js", len(uri), "chars")
