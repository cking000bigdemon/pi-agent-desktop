#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Atomic file writes for wiki-compile scripts.

`_meta.json` and raw source frontmatter are both load-bearing — a crashed
write (power loss, Ctrl-C mid-flush, OSError on a full disk) would corrupt
the wiki's state machine. These helpers write to a sibling tempfile and
`os.replace` into place, which is atomic on POSIX and on NTFS/Win32 for
same-volume renames.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def atomic_write_bytes(path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def atomic_write_text(path, text: str, encoding: str = "utf-8") -> None:
    atomic_write_bytes(path, text.encode(encoding))
