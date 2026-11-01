/**
 * @allevitas/agent-kit - Local storage for credentials and recovery keys
 *
 * Zero external dependencies: files use Node.js fs, and the OS keyring is reached
 * through the commands each OS ships (security, secret-tool, PowerShell).
 * Secrets are passed over stdin, never as command line arguments.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

const KEYRING_SERVICE = "allevitas-agent-kit";
const KEYRING_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 60 * 1000;
const LOCK_WAIT_MS = 10 * 1000;
const LOCK_POLL_MS = 100;
// Everything issued by the server is base62 with a prefix; anything else is not quoted safely
const KEYRING_SAFE_VALUE = /^[0-9A-Za-z_-]+$/;

export type RecoveryKeyFormat = "alv_rk" | "legacy_rc";

export interface RecoveryKeyFile {
  accountId: string;
  recoveryKey: string;
  recoveryKeyId: string;
  format: RecoveryKeyFormat;
  createdAt: string;
}

export interface KeyringBackend {
  /** Returns the stored secret, or null when the entry does not exist or cannot be read. */
  get(account: string): string | null;
  /** Returns false when the secret could not be stored. */
  set(account: string, secret: string): boolean;
  delete(account: string): void;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string; env?: Record<string, string> }
) => { status: number | null; stdout: string };

const runCommand: CommandRunner = (command, args, options = {}) => {
  const res = spawnSync(command, args, {
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf-8",
    timeout: KEYRING_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  return { status: res.error ? null : res.status, stdout: res.stdout || "" };
};

const WINDOWS_CREDENTIAL_SCRIPT = `
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
`;

function macKeyring(run: CommandRunner): KeyringBackend {
  const args = (account: string) => ["-s", KEYRING_SERVICE, "-a", account];
  return {
    get(account) {
      const res = run("security", ["find-generic-password", ...args(account), "-w"]);
      return res.status === 0 ? res.stdout.trim() || null : null;
    },
    set(account, secret) {
      // `security -i` reads the command from stdin, keeping the secret out of `ps`
      const input = `add-generic-password -U ${args(account).map((a) => `"${a}"`).join(" ")} -w "${secret}"\n`;
      return run("security", ["-i"], { input }).status === 0;
    },
    delete(account) {
      run("security", ["delete-generic-password", ...args(account)]);
    },
  };
}

function secretServiceKeyring(run: CommandRunner): KeyringBackend {
  const attrs = (account: string) => ["service", KEYRING_SERVICE, "account", account];
  return {
    get(account) {
      const res = run("secret-tool", ["lookup", ...attrs(account)]);
      return res.status === 0 ? res.stdout.trim() || null : null;
    },
    set(account, secret) {
      const label = `--label=${KEYRING_SERVICE} ${account}`;
      return run("secret-tool", ["store", label, ...attrs(account)], { input: secret }).status === 0;
    },
    delete(account) {
      run("secret-tool", ["clear", ...attrs(account)]);
    },
  };
}

function windowsKeyring(run: CommandRunner): KeyringBackend {
  const invoke = (action: string, account: string, input?: string) =>
    run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CREDENTIAL_SCRIPT], {
      input,
      env: {
        ALLEVITAS_KEYRING_ACTION: action,
        ALLEVITAS_KEYRING_TARGET: `${KEYRING_SERVICE}/${account}`,
      },
    });
  return {
    get(account) {
      const res = invoke("get", account);
      return res.status === 0 ? res.stdout.trim() || null : null;
    },
    set(account, secret) {
      return invoke("set", account, secret).status === 0;
    },
    delete(account) {
      invoke("delete", account);
    },
  };
}

/**
 * Keyring backend for the current OS (null when the OS has none).
 * Availability is decided by `storeInKeyring`, which falls back to the file on any failure.
 */
export function createKeyringBackend(
  platform: string = process.platform,
  run: CommandRunner = runCommand
): KeyringBackend | null {
  switch (platform) {
    case "darwin":
      return macKeyring(run);
    case "linux":
      return secretServiceKeyring(run);
    case "win32":
      return windowsKeyring(run);
    default:
      return null;
  }
}

/**
 * Store a secret and read it back, so a file copy is only dropped once the keyring really holds it.
 */
export function storeInKeyring(keyring: KeyringBackend, account: string, secret: string): boolean {
  if (!KEYRING_SAFE_VALUE.test(secret)) {
    return false;
  }
  try {
    return keyring.set(account, secret) && keyring.get(account) === secret;
  } catch {
    return false;
  }
}

/**
 * Restrict a file to its owner (best effort on Windows, where ACLs replace mode bits).
 */
export function restrictPermissions(filePath: string): void {
  if (process.platform === "win32") {
    const user = process.env.USERNAME || os.userInfo().username;
    spawnSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${user}:F`], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  fs.chmodSync(filePath, 0o600);
}

/**
 * Tighten a secret file readable by others. Returns true when the mode had to be changed.
 */
export function enforcePrivateFile(filePath: string): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode & 0o077) {
    fs.chmodSync(filePath, 0o600);
    return true;
  }
  return false;
}

/**
 * Write through a temporary file so a crash never leaves a partial file behind.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  fs.closeSync(fd);

  try {
    restrictPermissions(tmpPath);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  // Make the rename itself durable (directories cannot be opened on Windows)
  if (process.platform !== "win32") {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}

/**
 * Fail before a one-time secret is requested from the server, not after it is lost.
 */
export function assertWritableDirectory(filePath: string): void {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
  const probePath = path.join(dir, `.allevitas-write-test.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.closeSync(fs.openSync(probePath, "wx", 0o600));
  fs.rmSync(probePath, { force: true });
}

/**
 * Serialize key changes between processes sharing a credentials file.
 * Returns null without running `fn` when another process holds the lock past the wait.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  waitMs: number = LOCK_WAIT_MS
): Promise<{ result: T } | null> {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(path.resolve(lockPath)), { recursive: true });

  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") {
        throw err;
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // Released between the two calls
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  try {
    return { result: await fn() };
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export function readJsonFile(filePath: string): Record<string, any> | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export function readRecoveryKeyFile(filePath: string): RecoveryKeyFile | null {
  const data = readJsonFile(filePath);
  return data && typeof data.recoveryKey === "string" ? (data as RecoveryKeyFile) : null;
}

export function writeRecoveryKeyFile(filePath: string, data: RecoveryKeyFile): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

/**
 * Returns false when there was no file to delete.
 */
export function deleteRecoveryKeyFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.rmSync(filePath, { force: true });
  return true;
}

export function detectRecoveryKeyFormat(recoveryKey: string): RecoveryKeyFormat {
  return recoveryKey.startsWith("alv_rk_") ? "alv_rk" : "legacy_rc";
}
