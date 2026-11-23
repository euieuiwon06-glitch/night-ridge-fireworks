"""mountains.png 정리: 산 윤곽선 위로 떠 있는 부스러기 점을 지우고, 가림 영역(알파)을 윤곽선에 맞춤.

python clean_mountains.py  (웹페이지 폴더의 mountains.png 를 덮어씀, 확인용은 --preview 경로)
- 흰 픽셀 8방향 덩어리 중 MAIN 이상 크기 = 산 본체
- 열마다 본체 흰 픽셀이 처음 나오는 행 = 윤곽선 → 그 위는 전부 하늘(투명, 점 없음)
"""
import argparse
import pathlib

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

MAIN = 60

ap = argparse.ArgumentParser()
ap.add_argument("--preview", default="")
a = ap.parse_args()

p = pathlib.Path(__file__).resolve().parent.parent / "mountains.png"
rgba = np.array(Image.open(p).convert("RGBA"))
alpha = rgba[..., 3] > 127
white = (rgba[..., 0] > 127) & alpha
H, W = white.shape

lab, _ = ndi.label(white, structure=np.ones((3, 3)))
sz = np.bincount(lab.ravel())
sz[0] = 0
main = sz[lab] >= MAIN

top = np.array([np.argmax(main[:, x]) if main[:, x].any() else H for x in range(W)])
# 윤곽선에 1칸짜리 틈이 있어도 움푹 꺼지지 않게 이웃 열과 맞춤
top = np.minimum(top, ndi.minimum_filter1d(top, 3))

rows = np.arange(H)[:, None]
body = rows >= top[None, :]
removed = int((white & ~body).sum())
new_white = white & body
new_alpha = body & (alpha | (rows >= top[None, :]))

out = np.zeros_like(rgba)
out[..., :3] = (new_white * 255)[..., None]
out[..., 3] = new_alpha * 255
Image.fromarray(out, "RGBA").save(p, optimize=True)
print(f"removed specks: {removed} px, ridge rows {top.min()}..{top.max()}")

if a.preview:
    vis = np.zeros((H, W, 3), np.uint8)
    vis[new_alpha] = (40, 0, 0)
    vis[new_white] = 255
    vis[white & ~body] = (255, 0, 0)  # 지운 점 = 빨강
    Image.fromarray(vis).resize((W * 2, H * 2), Image.NEAREST).save(a.preview)
