"""HuggingFace embeddings for the attendance search index, plus a
Postgres-backed cache so a text is only ever sent to HuggingFace once.

Two modes (EMBEDDINGS_MODE):
- "api"   — HuggingFace Inference API (HuggingFaceEndpointEmbeddings), needs
            HUGGINGFACEHUB_API_TOKEN / HF_TOKEN.
- "local" — sentence-transformers on this machine (HuggingFaceEmbeddings),
            needs `pip install '.[local-embeddings]'`.
"""
import hashlib
import importlib.util
import logging
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager

import numpy as np
from langchain_core.embeddings import Embeddings
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.chat.models import AssistantEmbeddingCache
from app.config import settings

logger = logging.getLogger("app.chat")

TOKEN_MISSING = "HUGGINGFACEHUB_API_TOKEN is not set — add it to .env to enable semantic search"
LOCAL_MISSING = "EMBEDDINGS_MODE=local needs sentence-transformers: pip install '.[local-embeddings]'"

# Postgres caps bind parameters per statement; stay well under it.
_LOOKUP_CHUNK = 500
_INSERT_CHUNK = 200
# huggingface_hub's InferenceClient waits forever by default, and an index
# build holds the index lock while it embeds.
HF_TIMEOUT_SECONDS = 30


class EmbeddingsNotConfigured(RuntimeError):
    """Embeddings can't be used with the current settings — semantic search is
    unavailable, everything else in the assistant keeps working."""


def _mode() -> str:
    return (settings.embeddings_mode or "").strip().lower()


def embedding_namespace() -> str:
    """Cache namespace for the configured model. Vectors from different
    models (or modes) never mix, because they don't share a vector space."""
    return f"{_mode()}:{settings.hf_embedding_model.strip()}"


def redact_secrets(text: str) -> str:
    """Belt and braces for error messages that end up in API responses, tool
    results or logs: strip any configured key that somehow got into them."""
    for secret in (settings.huggingfacehub_api_token, settings.groq_api_key):
        secret = (secret or "").strip()
        if len(secret) >= 8:
            text = text.replace(secret, "***")
    return text


def build_base_embeddings() -> Embeddings:
    """The raw HuggingFace embeddings for the configured mode. Makes no
    network call and loads no model, so it doubles as the "is semantic
    search configured?" check (GET /chat/status)."""
    mode = _mode()
    model = settings.hf_embedding_model.strip()

    if mode == "api":
        token = settings.huggingfacehub_api_token.strip()
        if not token:
            raise EmbeddingsNotConfigured(TOKEN_MISSING)
        from langchain_huggingface import HuggingFaceEndpointEmbeddings  # heavy import; lazy

        emb = HuggingFaceEndpointEmbeddings(
            model=model,
            task="feature-extraction",
            huggingfacehub_api_token=token,
            provider=settings.hf_inference_provider.strip() or None,
        )
        # The wrapper has no timeout option; the clients read this per request.
        for client in (emb.client, emb.async_client):
            if client is not None:
                client.timeout = HF_TIMEOUT_SECONDS
        return emb

    if mode == "local":
        if importlib.util.find_spec("sentence_transformers") is None:
            raise EmbeddingsNotConfigured(LOCAL_MISSING)
        return _LazyLocalEmbeddings(model)

    raise EmbeddingsNotConfigured(f"EMBEDDINGS_MODE must be 'api' or 'local' (got {settings.embeddings_mode!r})")


_local_models: dict[str, Embeddings] = {}
_local_lock = threading.Lock()


def _local_model(model_name: str) -> Embeddings:
    """One loaded sentence-transformers model per process (loading it can
    mean a download and takes seconds, so it isn't redone per index build)."""
    with _local_lock:
        if model_name not in _local_models:
            try:
                from langchain_huggingface import HuggingFaceEmbeddings

                _local_models[model_name] = HuggingFaceEmbeddings(model_name=model_name)
            except ImportError as exc:
                raise EmbeddingsNotConfigured(LOCAL_MISSING) from exc
        return _local_models[model_name]


class _LazyLocalEmbeddings(Embeddings):
    """Defers loading the local model to the first embed call, so building
    the embeddings object stays cheap (see build_base_embeddings)."""

    def __init__(self, model_name: str):
        self.model_name = model_name

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return _local_model(self.model_name).embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        return _local_model(self.model_name).embed_query(text)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _flat_vector(raw) -> list[float]:
    """One text's embedding as a flat list of floats. Some models return
    token-level output (a list of per-token vectors); mean-pool that."""
    try:
        arr = np.asarray(raw, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Embedding is not a numeric vector: {exc}") from exc
    if arr.ndim == 0 or arr.size == 0:
        raise ValueError("Embedding is empty or a scalar, not a vector")
    if arr.ndim > 1:
        arr = arr.reshape(-1, arr.shape[-1]).mean(axis=0)
    return [float(x) for x in arr]


def normalize_vectors(raw_vectors, expected: int | None = None) -> list[list[float]]:
    vectors = [_flat_vector(v) for v in raw_vectors]
    if expected is not None and len(vectors) != expected:
        raise ValueError(f"Embedding model returned {len(vectors)} vectors for {expected} texts")
    _check_dimensions(vectors)
    return vectors


def _check_dimensions(vectors: Sequence[Sequence[float]]) -> None:
    dims = {len(v) for v in vectors}
    if len(dims) > 1:
        raise ValueError(f"Inconsistent embedding dimensions: {sorted(dims)}")


class CachedEmbeddings(Embeddings):
    """Wraps a base Embeddings with the assistant_embedding_cache table.

    embed_documents() only hits the cache while a Session is bound
    (`with cached.bound(db): ...`); unbound, it embeds directly. Either way
    texts go to the base model in chunks of `batch_size` (the HF endpoint
    otherwise sends everything in a single request). embed_query() never
    touches the database — queries are one-offs, not worth caching.
    """

    def __init__(self, base: Embeddings, namespace: str, batch_size: int = 32):
        self.base = base
        self.namespace = namespace
        self.batch_size = max(1, int(batch_size))
        self._local = threading.local()
        # Counters from the most recent embed_documents() call, for logging.
        self.last_embedded_count = 0
        self.last_cache_hit_count = 0
        self.total_embedded_count = 0

    @contextmanager
    def bound(self, db: Session) -> Iterator["CachedEmbeddings"]:
        previous = getattr(self._local, "db", None)
        self._local.db = db
        try:
            yield self
        finally:
            self._local.db = previous

    def _bound_db(self) -> Session | None:
        return getattr(self._local, "db", None)

    def _embed_in_batches(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.batch_size):
            chunk = texts[start : start + self.batch_size]
            vectors.extend(normalize_vectors(self.base.embed_documents(chunk), expected=len(chunk)))
        _check_dimensions(vectors)
        return vectors

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        texts = list(texts)
        self.last_embedded_count = 0
        self.last_cache_hit_count = 0
        if not texts:
            return []

        db = self._bound_db()
        if db is None:
            vectors = self._embed_in_batches(texts)
            self.last_embedded_count = len(texts)
            self.total_embedded_count += len(texts)
            return vectors

        hashes = [content_hash(t) for t in texts]
        text_for_hash: dict[str, str] = {}
        for h, t in zip(hashes, texts):
            text_for_hash.setdefault(h, t)  # duplicate texts are embedded once

        found, cache_ok = self._lookup(db, list(text_for_hash))
        missing = [h for h in text_for_hash if h not in found]
        self.last_cache_hit_count = len(text_for_hash) - len(missing)
        dim = len(next(iter(found.values()))) if found else None
        # Each batch is cached as soon as it is embedded, so a build that
        # fails part-way (HF rate limit, timeout, 503) resumes from there
        # on the next attempt instead of re-sending everything.
        for start in range(0, len(missing), self.batch_size):
            chunk = missing[start : start + self.batch_size]
            vectors = normalize_vectors(
                self.base.embed_documents([text_for_hash[h] for h in chunk]), expected=len(chunk)
            )
            if dim is None:
                dim = len(vectors[0])
            elif len(vectors[0]) != dim:
                raise ValueError(f"Inconsistent embedding dimensions: {sorted({dim, len(vectors[0])})}")
            new = dict(zip(chunk, vectors))
            if cache_ok:
                cache_ok = self._store(db, new)
            found.update(new)
            self.last_embedded_count += len(chunk)
            self.total_embedded_count += len(chunk)

        result = [found[h] for h in hashes]
        _check_dimensions(result)
        return result

    def embed_query(self, text: str) -> list[float]:
        return _flat_vector(self.base.embed_query(text))

    def _lookup(self, db: Session, hashes: list[str]) -> tuple[dict[str, list[float]], bool]:
        found: dict[str, list[float]] = {}
        try:
            for start in range(0, len(hashes), _LOOKUP_CHUNK):
                chunk = hashes[start : start + _LOOKUP_CHUNK]
                rows = db.execute(
                    select(AssistantEmbeddingCache.content_hash, AssistantEmbeddingCache.embedding).where(
                        AssistantEmbeddingCache.namespace == self.namespace,
                        AssistantEmbeddingCache.content_hash.in_(chunk),
                    )
                ).all()
                for row in rows:
                    found[row.content_hash] = [float(x) for x in row.embedding]
        except SQLAlchemyError as exc:
            # e.g. the migration hasn't been run yet — still answer, just uncached.
            db.rollback()
            logger.warning("Embedding cache unavailable, embedding without it: %s", exc.__class__.__name__)
            return {}, False
        return found, True

    def _store(self, db: Session, new: dict[str, list[float]]) -> bool:
        """Writes and commits `new`; False (after a rollback) if the cache
        couldn't be written, so the caller stops trying for this call."""
        items = list(new.items())
        try:
            for start in range(0, len(items), _INSERT_CHUNK):
                chunk = items[start : start + _INSERT_CHUNK]
                stmt = pg_insert(AssistantEmbeddingCache).values(
                    [{"namespace": self.namespace, "content_hash": h, "embedding": v} for h, v in chunk]
                )
                # Another worker may have cached the same text meanwhile — fine.
                db.execute(stmt.on_conflict_do_nothing(index_elements=["namespace", "content_hash"]))
            db.commit()
        except SQLAlchemyError as exc:
            db.rollback()
            logger.warning("Couldn't write the embedding cache (vectors still used): %s", exc.__class__.__name__)
            return False
        return True
