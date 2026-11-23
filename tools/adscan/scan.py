#!/usr/bin/env python3
"""Quét watermark/quảng cáo trong stream phim bằng ffmpeg + RapidOCR.

- Lấy catalog + stream từ addon Render.
- Trích 3 frame mỗi stream, OCR.
- Phân loại:
    ban  : quảng cáo cá cược/bóng đá/nhà cái (loại bỏ hẳn)
    warn : watermark nguồn phim/domain/telegram (giữ, ghi chú, không ưu tiên)
    clean: không thấy chữ đáng ngờ
- Xuất tools/adscan/report.json và data/adscan.json cho addon.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request

from rapidocr_onnxruntime import RapidOCR

BASE = os.environ.get("ADDON_BASE", "https://vietstream-addon-v9vo.onrender.com")
FFMPEG = os.environ.get(
    "FFMPEG",
    r"C:\Users\ngoct\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe",
)
FFPROBE = os.environ.get("FFPROBE", FFMPEG.replace("ffmpeg.exe", "ffprobe.exe"))
LIMIT = int(os.environ.get("LIMIT", "8"))
PROVIDERS = [
    ("kkphim-phim-le", "movie"),
    ("hdvnn-moi", "movie"),
    ("k20-movie", "movie"),
]
WANTED = {x.strip() for x in os.environ.get("PROVIDERS", "kkphim,hdvnn,k20").split(",") if x.strip()}
PROVIDERS = [p for p in PROVIDERS if p[0].split("-")[0] in WANTED]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

BAN_BRAND = re.compile(
    r"\b(w88|fb88|m88|bk8|fun88|kubet|ku711|sunwin|go88|hitclub|rikvip|789club|789bet|f8bet|vn88|new88|shbet|188bet|12bet|letou|sbotop|v9bet|bet365|sbobet|dafabet|cmd368|jbo|bong88)\b"
)
BAN_GENERIC = re.compile(
    r"ca\s*cuoc|ca\s*do|keo\s*nha\s*cai|nha\s*cai|bong\s*da|tai\s*xiu|xoc\s*dia|lo\s*de|no\s*hu|game\s*bai|danh\s*bac|soi\s*keo"
)
WARN = re.compile(
    r"bit\.ly|t\.me|telegram|zalo|https?://|www\.|\.(com|net|org|xyz|top|vip|cc|tv|me|io)\b|fanpage|hdvnn|yanhh3d|kkphim|ophim|nguonc|vsmov|phim4k|motchill|subteam|sub\s*team|xem\s*phim|nguon|logo|watermark"
)


def norm(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("đ", "d").replace("Đ", "D").lower()
    return re.sub(r"\s+", " ", s).strip()


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def header_arg(headers):
    if not headers:
        return []
    lines = [f"{k}: {v}" for k, v in headers.items() if isinstance(v, str)]
    return ["-headers", "\r\n".join(lines) + "\r\n"] if lines else []


def duration(url, headers):
    cmd = [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", *header_arg(headers), url]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=40).stdout.strip()
        return float(out.splitlines()[0])
    except Exception:
        return None


def grab(url, headers, ts, out_path):
    cmd = [
        FFMPEG, "-v", "error", "-rw_timeout", "20000000", "-ss", str(ts), *header_arg(headers),
        "-i", url, "-frames:v", "1", "-vf", "scale=960:-1", "-y", out_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=70)
        return os.path.exists(out_path) and os.path.getsize(out_path) > 2000
    except Exception:
        return False


def main():
    ocr = RapidOCR()
    items = []
    for cat, typ in PROVIDERS:
        try:
            metas = (http_json(f"{BASE}/catalog/{typ}/{cat}.json").get("metas") or [])[:LIMIT]
        except Exception as e:
            print(f"[skip] {cat}: {e}", flush=True)
            continue
        print(f"== {cat}: {len(metas)} items", flush=True)
        for meta in metas:
            mid = meta.get("id")
            try:
                streams = (http_json(f"{BASE}/stream/{typ}/{mid}.json").get("streams") or [])
            except Exception as e:
                print(f"  [skip] {mid}: {e}", flush=True)
                continue
            # chọn 1 stream tốt nhất (1080p trước), bỏ external
            cand = [s for s in streams if s.get("url")]
            cand.sort(key=lambda s: 0 if "1080" in str(s.get("name", "")) else 1)
            for s in cand[:1]:
                url = s.get("url")
                headers = (((s.get("behaviorHints") or {}).get("proxyHeaders") or {}).get("request") or {})
                dur = duration(url, headers)
                if not dur or dur < 40:
                    times = [10, 30, 60]
                else:
                    times = sorted({20, max(30, int(dur * 0.45)), max(40, int(dur * 0.8))})
                    times = [t for t in times if t < dur - 5]
                texts = []
                with tempfile.TemporaryDirectory() as tmp:
                    for i, t in enumerate(times[:3]):
                        p = os.path.join(tmp, f"f{i}.jpg")
                        if not grab(url, headers, t, p):
                            continue
                        try:
                            res, _ = ocr(p)
                            texts.append(" | ".join(x[1] for x in (res or []) if len(x) > 2 and x[2] > 0.5))
                        except Exception:
                            texts.append("")
                joined = norm(" ".join(texts))
                ban_brand = bool(BAN_BRAND.search(joined))
                generic_frames = sum(1 for t in texts if BAN_GENERIC.search(norm(t)))
                warn_hit = bool(WARN.search(joined))
                if ban_brand or generic_frames >= 2:
                    level, note = "ban", "quảng cáo cá cược/bóng đá"
                elif warn_hit:
                    m = WARN.search(joined)
                    level, note = "warn", (m.group(0) if m else "watermark nguồn")
                else:
                    level, note = "clean", ""
                item = {
                    "provider": cat,
                    "id": mid,
                    "title": meta.get("name"),
                    "url": url,
                    "times": times[:3],
                    "texts": texts,
                    "level": level,
                    "note": note,
                }
                items.append(item)
                print(f"  {level:5s} | {meta.get('name')} | {note} | {' / '.join(t for t in texts if t)[:120]}", flush=True)
    # aggregate
    ban_urls = sorted({x["url"] for x in items if x["level"] == "ban"})
    warn_urls = {x["url"]: x["note"] for x in items if x["level"] == "warn"}
    warn_titles = {norm(x["title"]): x["note"] for x in items if x["level"] == "warn" and x.get("title")}
    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "base": BASE, "limit": LIMIT, "items": items,
              "banUrls": ban_urls, "warnUrls": warn_urls, "warnTitles": warn_titles}
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    data_dir = os.path.abspath(os.path.join(here, "..", "..", "data"))
    os.makedirs(data_dir, exist_ok=True)
    with open(os.path.join(data_dir, "adscan.json"), "w", encoding="utf-8") as f:
        json.dump({"generatedAt": report["generatedAt"], "banUrls": ban_urls,
                   "warnUrls": warn_urls, "warnTitles": warn_titles}, f, ensure_ascii=False, indent=2)
    print(f"\nDONE items={len(items)} ban={len(ban_urls)} warn={len(warn_urls)}", flush=True)


if __name__ == "__main__":
    main()
