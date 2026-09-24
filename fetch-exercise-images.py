#!/usr/bin/env python3
"""
Download the exercise images for FitCircle.

The dataset is public domain (Unlicense), but GitHub asks people not to use
raw.githubusercontent.com as a CDN for production traffic. So pull the images
down once and serve them yourself — from Netlify, R2, or wherever you like.

    python3 fetch-exercise-images.py

Writes to ./images/exercises/<Exercise_Name>/0.jpg and 1.jpg
Roughly 1,700 files, about 85 MB. Safe to re-run: it skips what it already has.
"""

import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "images", "exercises")
LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "exercise-library.json")

done = skipped = failed = 0


def grab(rel):
    global done, skipped, failed
    dest = os.path.join(OUT, rel.replace("/", os.sep))
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        skipped += 1
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(3):
        try:
            req = Request(BASE + rel, headers={"User-Agent": "fitcircle-image-fetch"})
            with urlopen(req, timeout=30) as r:
                data = r.read()
            if not data:
                raise ValueError("empty response")
            with open(dest, "wb") as f:
                f.write(data)
            done += 1
            return
        except (URLError, HTTPError, ValueError, OSError):
            if attempt == 2:
                failed += 1
                print(f"\n  could not fetch {rel}", file=sys.stderr)
            else:
                time.sleep(1.5 * (attempt + 1))


def main():
    if not os.path.exists(LIB):
        sys.exit(f"exercise-library.json not found next to this script ({LIB})")

    lib = json.load(open(LIB))
    paths = sorted({p for ex in lib for p in ex.get("img", [])})
    print(f"{len(paths)} images to check, writing into {OUT}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, _ in enumerate(pool.map(grab, paths), 1):
            if i % 50 == 0:
                print(f"  {i}/{len(paths)}", end="\r", flush=True)

    total_mb = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fs in os.walk(OUT) for f in fs
    ) / 1048576

    print(f"\ndownloaded {done}, already had {skipped}, failed {failed}")
    print(f"{total_mb:.0f} MB on disk")
    if failed:
        print("Re-run to retry the failures — it only fetches what's missing.")


if __name__ == "__main__":
    main()
