"""mountains.png 외곽 정리 2단계: 산 실루엣에 끊김 없는 흰 윤곽선 1칸 + 안쪽 검은 여백 1칸.

python outline_mountains.py [--preview 경로]   (clean_mountains.py 다음에 실행, mountains.png 덮어씀)
- 실루엣(알파)을 3x3 열기로 다듬어 1~2칸 돌기 제거
- 하늘과 맞닿은 실루엣 테두리 = 흰 선, 그 안쪽 한 칸 = 검정 → 외곽 디더 점이 드러나지 않음
"""
import argparse
import pathlib

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ap = argparse.ArgumentParser()
ap.add_argument("--preview", default="")
a = ap.parse_args()

p = pathlib.Path(__file__).resolve().parent.parent / "mountains.png"
rgba = np.array(Image.open(p).convert("RGBA"))
body = rgba[..., 3] > 127
white = (rgba[..., 0] > 127) & body
H, W = body.shape

# 캔버스 바깥(좌우·아래)은 산으로 간주해 테두리 선이 생기지 않게
pad = np.pad(body, 2, mode="edge")
pad[:2, :] = False
pad = ndi.binary_opening(pad, structure=np.ones((3, 3)))
pad = ndi.binary_fill_holes(pad)
sky = ~pad
edge = pad & ndi.binary_dilation(sky, structure=np.ones((3, 3)))
gap = pad & ~edge & ndi.binary_dilation(edge, structure=np.ones((3, 3)))
body2, edge, gap = (m[2:-2, 2:-2] for m in (pad, edge, gap))

new_white = (white & body2 & ~gap) | edge
out = np.zeros_like(rgba)
out[..., :3] = (new_white * 255)[..., None]
out[..., 3] = body2 * 255
Image.fromarray(out, "RGBA").save(p, optimize=True)
print("edge px", int(edge.sum()), "gap cleared", int((white & gap).sum()), "body change", int((body ^ body2).sum()))

if a.preview:
    vis = np.zeros((H, W, 3), np.uint8)
    vis[new_white] = 255
    Image.fromarray(vis).resize((W * 3, H * 3), Image.NEAREST).save(a.preview)
