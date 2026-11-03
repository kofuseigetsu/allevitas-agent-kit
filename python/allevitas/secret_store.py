"""
allevitas-agent-kit - Pluggable store for handing one-time secrets to the human operator

The SDK never ships a provider. Pass one as `secret_store=`, or name a module in
ALLEVITAS_SECRET_STORE_MODULE whose `create_provider(config)` returns one.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import importlib
import importlib.util
import os
from typing import Any, Dict, Literal, Optional, Protocol, Tuple, runtime_checkable

from .errors import AllevitasAuthError

SecretKind = Literal["recovery_key", "agent_key"]

DEFAULT_SECRET_STORE_TTL_SEC = 24 * 60 * 60
SECRET_STORE_MODULE_ENV = "ALLEVITAS_SECRET_STORE_MODULE"
SECRET_STORE_TTL_ENV = "ALLEVITAS_SECRET_STORE_TTL"
SECRET_STORE_OPT_PREFIX = "ALLEVITAS_SECRET_STORE_OPT_"


@runtime_checkable
class SecretStoreProvider(Protocol):
    """
    Keeps a secret where a human can collect it and returns a link to it.

    `store()` returns {"url": str, "expires_at": Optional[str]}. A provider may also define
    `check() -> bool` (or raise) to report whether it is reachable; registration calls it before
    the account is created and falls back to the recovery key file when it fails.
    """

    name: str

    def store(self, secret: str, ttl_sec: int, kind: SecretKind) -> Dict[str, Any]: ...


@dataclass
class SecretStoreConfig:
    ttl_sec: int = DEFAULT_SECRET_STORE_TTL_SEC
    options: Dict[str, str] = field(default_factory=dict, repr=False)


def secret_store_config_from_env() -> SecretStoreConfig:
    raw_ttl = os.environ.get(SECRET_STORE_TTL_ENV, "").strip()
    ttl_sec = DEFAULT_SECRET_STORE_TTL_SEC
    if raw_ttl:
        try:
            ttl_sec = int(raw_ttl)
        except ValueError:
            ttl_sec = 0
        if ttl_sec <= 0:
            raise AllevitasAuthError("CONFIG_ERROR", f"{SECRET_STORE_TTL_ENV} must be a positive number of seconds.")
    options = {
        name[len(SECRET_STORE_OPT_PREFIX):].lower(): value
        for name, value in os.environ.items()
        if name.startswith(SECRET_STORE_OPT_PREFIX) and len(name) > len(SECRET_STORE_OPT_PREFIX)
    }
    return SecretStoreConfig(ttl_sec=ttl_sec, options=options)


def _import_provider_module(spec: str) -> Any:
    if spec.endswith(".py") or os.sep in spec or (os.altsep and os.altsep in spec):
        path = os.path.abspath(spec)
        module_spec = importlib.util.spec_from_file_location("allevitas_secret_store_provider", path)
        if module_spec is None or module_spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module
    return importlib.import_module(spec)


def load_secret_store_module(spec: str, config: Optional[SecretStoreConfig] = None) -> SecretStoreProvider:
    """
    Import a module (dotted name or .py path) and return `create_provider(config)`.
    Raises AllevitasAuthError("CONFIG_ERROR") when anything goes wrong.
    """
    config = config or secret_store_config_from_env()
    try:
        module = _import_provider_module(spec)
    except Exception as e:
        raise AllevitasAuthError(
            "CONFIG_ERROR", f"Could not load the secret store module {spec!r}: {type(e).__name__}: {e}"
        ) from None
    factory = getattr(module, "create_provider", None)
    if not callable(factory):
        raise AllevitasAuthError("CONFIG_ERROR", f"The secret store module {spec!r} has no create_provider(config).")
    try:
        provider = factory(config)
    except Exception as e:
        raise AllevitasAuthError(
            "CONFIG_ERROR", f"create_provider() of {spec!r} failed: {type(e).__name__}: {e}"
        ) from None
    if not callable(getattr(provider, "store", None)):
        raise AllevitasAuthError("CONFIG_ERROR", f"create_provider() of {spec!r} did not return a provider with store().")
    return provider


def provider_name(provider: Any) -> str:
    return str(getattr(provider, "name", None) or type(provider).__name__)


def check_provider(provider: Any) -> Tuple[bool, str]:
    """
    Run the optional check(). Returns (reachable, reason).
    """
    check = getattr(provider, "check", None)
    if not callable(check):
        return True, ""
    try:
        result = check()
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
    if result is False:
        return False, "check() returned False"
    return True, ""


def store_secret(provider: Any, secret: str, ttl_sec: int, kind: SecretKind) -> Tuple[str, Optional[str]]:
    """
    Store a secret and return (url, expires_at). Raises when the provider gives no URL.
    """
    result = provider.store(secret, ttl_sec, kind)
    url = result.get("url") if isinstance(result, dict) else getattr(result, "url", None)
    expires_at = result.get("expires_at") if isinstance(result, dict) else getattr(result, "expires_at", None)
    if not isinstance(url, str) or not url:
        raise RuntimeError(f"{provider_name(provider)} returned no URL.")
    if secret in url:
        # A link that embeds the raw secret defeats the purpose
        raise RuntimeError(f"{provider_name(provider)} returned a URL that contains the secret itself.")
    return url, (str(expires_at) if expires_at is not None else None)

