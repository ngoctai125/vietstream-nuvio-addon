# Ad scan — quét watermark/quảng cáo trong stream

Dùng `ffmpeg` trích 3 frame mỗi stream + `RapidOCR` đọc chữ, phân loại:

- **ban** — quảng cáo cá cược/bóng đá/nhà cái (brand: W88, FB88, 789bet, kubet… hoặc cú pháp `cá cược`, `kèo`, `tài xỉu` xuất hiện ≥2 frame) → addon loại stream.
- **warn** — watermark nguồn phim/domain/telegram/zalo (`bit.ly`, `HDVNN.NET`, `YanHH3D.cOm`…) → giữ stream, gắn `⚠️ nguồn có chữ: …` vào title và xếp sau stream sạch.
- **clean** — không thấy chữ đáng ngờ.

## Chạy

```bash
cd E:\AI\5_TAM\_scratch\vietstream
LIMIT=8 PROVIDERS=kkphim,hdvnn \
  "C:\Users\ngoct\.scrapers\.venv\Scripts\python.exe" -I tools/adscan/scan.py
node tools/adscan/inject_plugin.js
```

- `ADDON_BASE` mặc định `https://vietstream-addon-v9vo.onrender.com`.
- `FFMPEG`/`FFPROBE` mặc định bản WinGet Gyan 8.1.2.
- Kết quả: `tools/adscan/report.json` (chi tiết) và `data/adscan.json` (addon dùng).
- K20 chậm (proxy từng segment) — nên quét riêng với `PROVIDERS=k20 LIMIT=1`.

## Hạn chế

- Chỉ đọc chữ xuất hiện trong 3 frame mẫu; watermark hiện muộn hoặc chữ quá nhỏ có thể sót.
- Chữ trong phụ đề trùng từ khoá cá cược chỉ bị coi là ban khi xuất hiện ≥2 frame; brand/domain bị coi là ban ngay.
- Sau khi quét lại, chạy `inject_plugin.js` rồi commit + push để Render/CDN cập nhật.
