# -*- coding: utf-8 -*-
"""Hot-update API."""

import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/update", tags=["update"])

_UPDATE_DIR = Path(__file__).resolve().parents[2] / "updatezip"
_VERSION_RE = re.compile(r"^\d{12}$")
_ZIP_NAME = "VideoVoice.zip"


def _is_valid_version(value: str) -> bool:
    return bool(_VERSION_RE.match(value))


def _scan_versions() -> list[str]:
    if not _UPDATE_DIR.exists():
        return []
    versions = []
    for entry in _UPDATE_DIR.iterdir():
        if entry.is_dir() and _is_valid_version(entry.name):
            versions.append(entry.name)
    return sorted(versions)


@router.get("/check")
def check_update(version: str = Query(..., description="Client version in YYYYMMDDHHMM")):
    logger.info("Received update check request, client version: %s", version)

    if not _is_valid_version(version):
        logger.warning("Invalid version format: %s", version)
        raise HTTPException(status_code=400, detail="Invalid version format, expected YYYYMMDDHHMM")

    versions = _scan_versions()
    if not versions:
        logger.info("No update packages found on server")
        return {"update_available": False, "latest_version": None}

    latest = versions[-1]
    if latest > version:
        logger.info("Update available: %s > %s", latest, version)
        return {
            "update_available": True,
            "latest_version": latest,
            "download_url": f"/api/update/download/{latest}",
        }

    logger.info("Client is up to date: %s", version)
    return {"update_available": False, "latest_version": latest}


@router.get("/download/{version}")
def download_update(version: str):
    logger.info("Download request for version: %s", version)

    if not _is_valid_version(version):
        logger.warning("Invalid download version format: %s", version)
        raise HTTPException(status_code=400, detail="Invalid version format")

    zip_path = _UPDATE_DIR / version / _ZIP_NAME
    if not zip_path.exists() or not zip_path.is_file():
        logger.warning("Update package not found: %s", zip_path)
        raise HTTPException(status_code=404, detail="Update package not found")

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=_ZIP_NAME,
    )
