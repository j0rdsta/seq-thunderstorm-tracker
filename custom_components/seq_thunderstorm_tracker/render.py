"""Drawing the map picture used in notifications, widgets and picture cards.

It is the Bureau's own tracker image, cropped around one place, with that place and the alert
distance marked. Blocking (Pillow): call from an executor. No Home Assistant imports.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

from . import geo

OUTPUT_PX = 720
MARKER = (26, 115, 232)
RING = (26, 115, 232)
CAPTION = "Thunderstorm Tracker © Bureau of Meteorology"


class ImageError(ValueError):
    """The bytes are not a tracker image."""


def check_tracker_png(data: bytes) -> None:
    """Raise ImageError unless ``data`` is a PNG of the size the georeference was fitted to."""
    try:
        with Image.open(BytesIO(data)) as img:
            if img.format != "PNG":
                raise ImageError("the image is not a PNG")
            if img.size != (geo.IMAGE_W, geo.IMAGE_H):
                raise ImageError("the image is not the size the tracker is known to use")
            img.verify()
    except ImageError:
        raise
    except Exception as err:  # Pillow raises many types for broken files
        raise ImageError("the image could not be read") from err


def _font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    try:
        return ImageFont.load_default(size)
    except TypeError:  # Pillow before 10.1 has only the small bitmap font
        return ImageFont.load_default()


def render_map(
    image_png: bytes,
    *,
    lat: float | None,
    lon: float | None,
    radius_km: float,
    span_km: float,
    output_px: int = OUTPUT_PX,
) -> bytes:
    """Crop the tracker image to ``span_km`` around a place and mark it.

    Without a place inside the tracker's coverage, the whole image is returned unmarked.
    The crop is stretched to a square because the image's pixels are not square on the ground.
    """
    with Image.open(BytesIO(image_png)) as opened:
        src = opened.convert("RGB")

    marked = lat is not None and lon is not None and geo.in_coverage(lat, lon)
    if marked:
        px, py = geo.lonlat_to_pixel(lon, lat)
        km_x, km_y = geo.km_per_pixel(lat)
        crop_w = min(geo.IMAGE_W, span_km / km_x)
        crop_h = min(geo.IMAGE_H, span_km / km_y)
        # Keep the crop inside the image: near an edge the place moves off-centre instead.
        left = min(max(px - crop_w / 2, 0), geo.IMAGE_W - crop_w)
        top = min(max(py - crop_h / 2, 0), geo.IMAGE_H - crop_h)
        out_w = output_px
        out_h = round(output_px * (crop_h * km_y) / (crop_w * km_x))
    else:
        left, top, crop_w, crop_h = 0.0, 0.0, float(geo.IMAGE_W), float(geo.IMAGE_H)
        out_w, out_h = geo.IMAGE_W, geo.IMAGE_H

    out = src.resize(
        (out_w, out_h),
        Image.Resampling.BICUBIC,
        box=(left, top, left + crop_w, top + crop_h),
    )
    draw = ImageDraw.Draw(out, "RGBA")

    if marked:
        sx, sy = out_w / crop_w, out_h / crop_h
        cx, cy = (px - left) * sx, (py - top) * sy
        rx, ry = radius_km / km_x * sx, radius_km / km_y * sy
        box = (cx - rx, cy - ry, cx + rx, cy + ry)
        draw.ellipse(box, fill=(*RING, 22))
        draw.ellipse(box, outline=(255, 255, 255, 230), width=5)
        draw.ellipse(box, outline=(*RING, 255), width=3)
        dot = max(7, output_px // 80)
        draw.ellipse((cx - dot - 3, cy - dot - 3, cx + dot + 3, cy + dot + 3), fill=(255, 255, 255, 255))
        draw.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=(*MARKER, 255))

    font = _font(max(11, out_w // 48))
    text_box = draw.textbbox((0, 0), CAPTION, font=font)
    tw, th = text_box[2] - text_box[0], text_box[3] - text_box[1]
    pad = 5
    draw.rectangle((0, out_h - th - 2 * pad, tw + 2 * pad, out_h), fill=(255, 255, 255, 215))
    draw.text((pad, out_h - th - pad - text_box[1]), CAPTION, font=font, fill=(40, 40, 40, 255))

    buffer = BytesIO()
    out.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()
