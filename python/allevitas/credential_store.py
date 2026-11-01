"""
allevitas-agent-kit - Local storage for credentials and recovery keys

Zero external dependencies: files use the standard library, and the OS keyring is
reached through the commands each OS ships (security, secret-tool, PowerShell).
Secrets are passed over stdin, never as command line arguments.
"""

from __future__ import annotations
import getpass
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Optional, Protocol, Tuple

KEYRING_SERVICE = "allevitas-agent-kit"
KEYRING_TIMEOUT_SEC = 5.0
LOCK_STALE_SEC = 60.0
LOCK_WAIT_SEC = 10.0
LOCK_POLL_SEC = 0.1
# Everything issued by the server is base62 with a prefix; anything else is not quoted safely
_KEYRING_SAFE_VALUE = re.compile(r"^[0-9A-Za-z_-]+$")


class KeyringBackend(Protocol):
    def get(self, account: str) -> Optional[str]:
        """Return the stored secret, or None when it does not exist or cannot be read."""

    def set(self, account: str, secret: str) -> bool:
        """Return False when the secret could not be stored."""

    def delete(self, account: str) -> None:
        ...


# (command args, stdin text, extra environment) -> (exit status or None, stdout)
CommandRunner = Callable[[List[str], Optional[str], Optional[Dict[str, str]]], Tuple[Optional[int], str]]


def _run_command(
    args: List[str],
    input_text: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
) -> Tuple[Optional[int], str]:
    try:
        res = subprocess.run(
            args,
            input=input_text if input_text is not None else "",
            env={**os.environ, **env} if env else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=KEYRING_TIMEOUT_SEC,
        )
    except (OSError, subprocess.SubprocessError):
        return None, ""
    return res.returncode, res.stdout or ""


WINDOWS_CREDENTIAL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AllevitasCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public uint LastWrittenLow; public uint LastWrittenHigh; public uint CredentialBlobSize;
    public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref Credential credential, uint flags);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32")]
  public static extern void CredFree(IntPtr buffer);
}
'@
$target = $env:ALLEVITAS_KEYRING_TARGET
$marshal = [System.Runtime.InteropServices.Marshal]
switch ($env:ALLEVITAS_KEYRING_ACTION) {
  'set' {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
    $blob = $marshal::AllocHGlobal($bytes.Length)
    $marshal::Copy($bytes, 0, $blob, $bytes.Length)
    $credential = New-Object AllevitasCredential+Credential
    $credential.Type = 1; $credential.TargetName = $target; $credential.Persist = 2
    $credential.CredentialBlobSize = $bytes.Length; $credential.CredentialBlob = $blob
    $written = [AllevitasCredential]::CredWriteW([ref]$credential, 0)
    $marshal::FreeHGlobal($blob)
    if (-not $written) { exit 1 }
  }
  'get' {
    $pointer = [IntPtr]::Zero
    if (-not [AllevitasCredential]::CredReadW($target, 1, 0, [ref]$pointer)) { exit 1 }
    $credential = $marshal::PtrToStructure($pointer, [type][AllevitasCredential+Credential])
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    $marshal::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    [AllevitasCredential]::CredFree($pointer)
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
  }
  'delete' {
    if (-not [AllevitasCredential]::CredDeleteW($target, 1, 0)) { exit 1 }
  }
}
"""


class _MacKeyring:
    def __init__(self, run: CommandRunner):
        self._run = run

    @staticmethod
    def _args(account: str) -> List[str]:
        return ["-s", KEYRING_SERVICE, "-a", account]

    def get(self, account: str) -> Optional[str]:
        status, stdout = self._run(["security", "find-generic-password", *self._args(account), "-w"], None, None)
        return (stdout.strip() or None) if status == 0 else None

    def set(self, account: str, secret: str) -> bool:
        # `security -i` reads the command from stdin, keeping the secret out of `ps`
        quoted = " ".join(f'"{arg}"' for arg in self._args(account))
        status, _ = self._run(["security", "-i"], f'add-generic-password -U {quoted} -w "{secret}"\n', None)
        return status == 0

    def delete(self, account: str) -> None:
        self._run(["security", "delete-generic-password", *self._args(account)], None, None)


class _SecretServiceKeyring:
    def __init__(self, run: CommandRunner):
        self._run = run

    @staticmethod
    def _attrs(account: str) -> List[str]:
        return ["service", KEYRING_SERVICE, "account", account]

    def get(self, account: str) -> Optional[str]:
        status, stdout = self._run(["secret-tool", "lookup", *self._attrs(account)], None, None)
        return (stdout.strip() or None) if status == 0 else None

    def set(self, account: str, secret: str) -> bool:
        label = f"--label={KEYRING_SERVICE} {account}"
        status, _ = self._run(["secret-tool", "store", label, *self._attrs(account)], secret, None)
        return status == 0

    def delete(self, account: str) -> None:
        self._run(["secret-tool", "clear", *self._attrs(account)], None, None)


class _WindowsKeyring:
    def __init__(self, run: CommandRunner):
        self._run = run

    def _invoke(self, action: str, account: str, secret: Optional[str] = None) -> Tuple[Optional[int], str]:
        return self._run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
            secret,
            {
                "ALLEVITAS_KEYRING_ACTION": action,
                "ALLEVITAS_KEYRING_TARGET": f"{KEYRING_SERVICE}/{account}",
            },
        )

    def get(self, account: str) -> Optional[str]:
        status, stdout = self._invoke("get", account)
        return (stdout.strip() or None) if status == 0 else None

    def set(self, account: str, secret: str) -> bool:
        status, _ = self._invoke("set", account, secret)
        return status == 0

    def delete(self, account: str) -> None:
        self._invoke("delete", account)


def create_keyring_backend(
    platform: Optional[str] = None,
    run: CommandRunner = _run_command,
) -> Optional[KeyringBackend]:
    """
    Keyring backend for the current OS (None when the OS has none).
    Availability is decided by store_in_keyring, which falls back to the file on any failure.
    """
    target = platform or sys.platform
    if target == "darwin":
        return _MacKeyring(run)
    if target == "linux":
        return _SecretServiceKeyring(run)
    if target == "win32":
        return _WindowsKeyring(run)
    return None


def store_in_keyring(keyring: KeyringBackend, account: str, secret: str) -> bool:
    """
    Store a secret and read it back, so a file copy is only dropped once the keyring really holds it.
    """
    if not _KEYRING_SAFE_VALUE.match(secret):
        return False
    try:
        return keyring.set(account, secret) and keyring.get(account) == secret
    except Exception:
        return False


def restrict_permissions(file_path: str) -> None:
    """
    Restrict a file to its owner (best effort on Windows, where ACLs replace mode bits).
    """
    if sys.platform == "win32":
        user = os.environ.get("USERNAME") or getpass.getuser()
        subprocess.run(
            ["icacls", file_path, "/inheritance:r", "/grant:r", f"{user}:F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    os.chmod(file_path, 0o600)


def enforce_private_file(file_path: str) -> bool:
    """
    Tighten a secret file readable by others. Returns True when the mode had to be changed.
    """
    if sys.platform == "win32":
        return False
    mode = stat.S_IMODE(os.stat(file_path).st_mode)
    if mode & 0o077:
        os.chmod(file_path, 0o600)
        return True
    return False


def write_file_atomic(file_path: str, content: str) -> None:
    """
    Write through a temporary file so a crash never leaves a partial file behind.
    """
    directory = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(directory, exist_ok=True)

    tmp_path = os.path.join(directory, f".{os.path.basename(file_path)}.{uuid.uuid4().hex[:12]}.tmp")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        restrict_permissions(tmp_path)
        os.replace(tmp_path, file_path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    # Make the rename itself durable (directories cannot be opened on Windows)
    if sys.platform != "win32":
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def assert_writable_directory(file_path: str) -> None:
    """
    Fail before a one-time secret is requested from the server, not after it is lost.
    """
    directory = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(directory, exist_ok=True)
    probe_path = os.path.join(directory, f".allevitas-write-test.{uuid.uuid4().hex[:12]}.tmp")
    os.close(os.open(probe_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    os.remove(probe_path)


@contextmanager
def file_lock(file_path: str, wait_sec: float = LOCK_WAIT_SEC) -> Iterator[bool]:
    """
    Serialize key changes between processes sharing a credentials file.
    Yields False when another process holds the lock past the wait.
    """
    lock_path = f"{file_path}.lock"
    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)

    deadline = time.time() + wait_sec
    while True:
        try:
            os.close(os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            break
        except FileExistsError:
            try:
                if time.time() - os.stat(lock_path).st_mtime > LOCK_STALE_SEC:
                    os.remove(lock_path)
                    continue
            except FileNotFoundError:
                continue  # Released between the two calls
            if time.time() >= deadline:
                yield False
                return
            time.sleep(LOCK_POLL_SEC)

    try:
        yield True
    finally:
        try:
            os.remove(lock_path)
        except FileNotFoundError:
            pass


def read_json_file(file_path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def read_recovery_key_file(file_path: str) -> Optional[Dict[str, Any]]:
    data = read_json_file(file_path)
    return data if data and isinstance(data.get("recoveryKey"), str) else None


def write_recovery_key_file(file_path: str, data: Dict[str, Any]) -> None:
    write_file_atomic(file_path, json.dumps(data, indent=2, ensure_ascii=False))


def delete_recovery_key_file(file_path: str) -> bool:
    """
    Return False when there was no file to delete.
    """
    try:
        os.remove(file_path)
        return True
    except FileNotFoundError:
        return False


def detect_recovery_key_format(recovery_key: str) -> str:
    return "alv_rk" if recovery_key.startswith("alv_rk_") else "legacy_rc"
