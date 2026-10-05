"""Evidence file storage: validation, hashing, and safe reads.

Files live on disk under EVIDENCE_DIR (a Docker volume), never in the database;
the database keeps the metadata. Downloads always go through an authorized
endpoint and are sent as attachments.

Not done yet: virus scanning. `scan_status` is "not_scanned" and `scan()` is the
one place to plug a scanner in; until then downloads carry that status.
"""
import hashlib
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from app.compliance.models import EvidenceFile
from app.config import settings

ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv",
    ".zip", ".mp4", ".mov",
}
_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".zip": "application/zip",
    ".mp4": "video/mp4", ".mov": "video/quicktime",
}
# Leading bytes a file of that type must have, so a renamed .exe is not accepted as a screenshot.
_SIGNATURES = {
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".pdf": [b"%PDF-"],
    ".zip": [b"PK\x03\x04"],
    ".docx": [b"PK\x03\x04"],
    ".xlsx": [b"PK\x03\x04"],
    ".pptx": [b"PK\x03\x04"],
}


class EvidenceError(ValueError):
    pass


def storage_root() -> Path:
    root = Path(settings.evidence_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def scan(_data: bytes) -> str:
    """Hook for a virus scanner. Returns "clean", "infected" or "not_scanned"."""
    return "not_scanned"


def save_upload(db: Session, uploader: str, filename: str, data: bytes) -> EvidenceFile:
    name = Path(filename or "").name
    ext = Path(name).suffix.lower()
    if not name or ext not in ALLOWED_EXTENSIONS:
        raise EvidenceError(f"This file type isn't accepted. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")
    if not data:
        raise EvidenceError("The file is empty")
    limit = settings.evidence_max_mb * 1024 * 1024
    if len(data) > limit:
        raise EvidenceError(f"The file is larger than the {settings.evidence_max_mb} MB limit")
    sigs = _SIGNATURES.get(ext)
    if sigs and not any(data.startswith(s) for s in sigs):
        raise EvidenceError("The file's contents don't match its extension")
    status = scan(data)
    if status == "infected":
        raise EvidenceError("The file was rejected by the virus scan")

    key = f"{uuid.uuid4().hex}{ext}"
    (storage_root() / key).write_bytes(data)
    f = EvidenceFile(
        original_name=name,
        storage_key=key,
        size=len(data),
        mime=_MIME.get(ext, "application/octet-stream"),
        sha256=hashlib.sha256(data).hexdigest(),
        uploaded_by=uploader,
        scan_status=status,
    )
    db.add(f)
    db.flush()
    return f


def read_path(f: EvidenceFile) -> Path:
    root = storage_root()
    path = (root / f.storage_key).resolve()
    if root not in path.parents or not path.is_file():
        raise FileNotFoundError(f.storage_key)
    return path
