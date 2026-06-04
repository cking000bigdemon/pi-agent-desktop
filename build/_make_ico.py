from PIL import Image
import os

b = r"D:\variFlight_work\pi-web-desktop\build"
im = Image.open(os.path.join(b, "icon.png")).convert("RGBA")
im.save(
    os.path.join(b, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("ICO_OK", im.size)
