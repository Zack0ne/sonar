import struct, zlib, math

S = 512
# RGBA canvas
buf = bytearray()
def px(r,g,b,a=255): return bytes((r,g,b,a))

# background gradient (orange -> dark) with a magnifier glass motif
cx, cy = 200, 200
ring_r = 150
ring_w = 34
handle = []

rows = []
for y in range(S):
    row = bytearray()
    row.append(0)  # filter type 0
    for x in range(S):
        # base gradient
        t = (x + y) / (2*S)
        r = int(232*(1-t) + 40*t)
        g = int(116*(1-t) + 44*t)
        b = int(59*(1-t) + 52*t)
        a = 255
        d = math.hypot(x-cx, y-cy)
        # glass lens (light fill)
        if d < ring_r - ring_w/2:
            r,g,b = 250, 250, 252
        # ring
        if abs(d - ring_r) < ring_w/2:
            r,g,b = 30, 30, 35
        # handle (diagonal thick line from lower-right of ring)
        hx0, hy0 = cx + ring_r*0.7, cy + ring_r*0.7
        # distance from point to the handle segment
        ex, ey = hx0 + 150, hy0 + 150
        dx, dy = ex-hx0, ey-hy0
        L2 = dx*dx+dy*dy
        tt = max(0, min(1, ((x-hx0)*dx+(y-hy0)*dy)/L2))
        px_, py_ = hx0+tt*dx, hy0+tt*dy
        if math.hypot(x-px_, y-py_) < 22 and tt > 0:
            r,g,b = 30,30,35
        row += bytes((r,g,b,a))
    rows.append(bytes(row))

raw = b"".join(rows)
def chunk(typ, data):
    c = typ + data
    return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(raw, 9))
png += chunk(b"IEND", b"")
with open("icon-source.png","wb") as f:
    f.write(png)
print("wrote icon-source.png", S, "x", S)
